#!/usr/bin/env node
/**
 * Boots daemons against scratch state folders and hits the routes a change is most likely to break.
 *
 * The point is isolation: with the state folder moved, this runs beside the human's own daemon without
 * touching its token, its workspaces, its boards or its sessions, and picks a free port because a
 * fresh folder holds no port to reuse. Nothing is spawned here: no thread is prompted, so no `pi` child
 * starts and no model is called.
 *
 * What it proves is that the server starts, serves the page, opens a workspace, writes that workspace
 * down, and answers for its board — and that two of them can run at once, which is what a development
 * instance beside a stable one is. A refactor that breaks a route fails here in about a second.
 *
 *   node bin/smoke.mjs          # one line per check, exit 1 on the first failure
 *   node bin/smoke.mjs --keep   # leave the scratch folders behind, named in the output
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const keep = process.argv.includes("--keep");
const scratches = [];
const children = new Set();

function said(ok, what, note = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? ` — ${note}` : ""}`);
	if (!ok) throw new Error(`smoke: ${what}`);
}

function scratchFolder() {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-smoke-"));
	scratches.push(folder);
	return folder;
}

/** The daemon answers on an ephemeral port and says so; that line is the only address there is. */
function waitForUrl(child, noise) {
	return new Promise((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(() => reject(new Error(`no listening line in 20s: ${seen.slice(-400)} ${noise.join("")}`)), 20_000);
		const onData = (chunk) => {
			seen += String(chunk);
			const match = seen.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/);
			if (!match) return;
			clearTimeout(timer);
			child.stdout.off("data", onData);
			resolve(match[1]);
		};
		child.stdout.on("data", onData);
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`the daemon exited with ${code} before listening: ${seen.slice(-400)} ${noise.join("")}`));
		});
	});
}

/**
 * One daemon. `via` picks how it is told where its state goes: the environment, which is what a couple
 * of scratch commands use, or the flag, which is what a human types to run a second instance.
 */
async function boot(folder, via) {
	const args = [join(repo, "server.ts"), "--no-open"];
	const env = { ...process.env, PI_STUDIO_STATE: "", PI_STUDIO_PORT: "" };
	if (via === "flag") args.push(`--state=${folder}`);
	else env.PI_STUDIO_STATE = folder;
	const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
	children.add(child);
	const noise = [];
	child.stderr.on("data", (chunk) => noise.push(String(chunk)));
	const url = await waitForUrl(child, noise);
	return { child, noise, url, token: new URL(url).searchParams.get("token"), base: url.replace(/\?.*$/, ""), folder };
}

// Joined by hand rather than with `new URL`, so a path that starts with `//` stays a path instead of
// turning into a host.
async function get(daemon, path, init) {
	const res = await fetch(daemon.base + path, init);
	const body = await res.text();
	return { status: res.status, type: res.headers.get("content-type") ?? "", body };
}

/** A POST with a JSON body, answered as text like every other call here. */
async function post(daemon, path, body) {
	return get(daemon, path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** The workspace both daemons open: the same folder, which is the case that has to stay separate. */
async function openWorkspace(daemon, folder) {
	const opened = await get(daemon, `/workspace?token=${daemon.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ folder }),
	});
	return { status: opened.status, ...JSON.parse(opened.body || "{}") };
}

/** `daemon.json` exists as soon as a daemon listens; `workspaces.json` only once one was opened. */
function daemonFile(folder) {
	return JSON.parse(readFileSync(join(folder, "daemon.json"), "utf8"));
}

function recorded(folder) {
	return { daemon: daemonFile(folder), workspaces: JSON.parse(readFileSync(join(folder, "workspaces.json"), "utf8")) };
}

async function main() {
	const first = scratchFolder();
	const second = scratchFolder();
	const one = await boot(first, "env");
	said(Boolean(one.token), "the daemon boots against a scratch folder", first);

	const page = await get(one, "/");
	said(
		page.status === 200 && page.type.includes("text/html") && page.body.includes("pi-studio"),
		"GET / serves the crossroads",
		`${page.status} ${page.type}`,
	);

	const opened = await openWorkspace(one, first);
	said(
		opened.status === 200 && Boolean(opened.board?.id),
		"POST /workspace opens one",
		`${opened.status} board ${String(opened.board?.id ?? "").slice(0, 8)}`,
	);
	said(existsSync(join(first, "workspaces.json")), "the workspace is written down inside the scratch folder");

	const state = JSON.parse((await get(one, `/state?token=${one.token}&workspace=${opened.board.id}`)).body || "{}");
	said(
		Array.isArray(state.threads) && state.workspace?.id === opened.board.id,
		"GET /state answers for that board",
		`${state.threads?.length ?? "?"} threads`,
	);
	// Read back through the API rather than the file: a board is only written down when it changes, so
	// what a fresh boot proves is that the workspace it was told about is the one it serves.
	const list = await get(one, `/workspaces?token=${one.token}`);
	const saved = recorded(first);
	said(
		list.status === 200 && list.body.includes(opened.board.id) && saved.workspaces.workspaces?.some((each) => each.id === opened.board.id),
		"GET /workspaces reads it back from the scratch folder",
		`${list.status}`,
	);
	said(
		saved.daemon.token === one.token && Number(saved.daemon.port) > 0,
		"the token and port are its own",
		`port ${saved.daemon.port}`,
	);
	said(
		state.meta?.instance === basename(first),
		"a daemon off the usual folder names itself",
		`instance ${state.meta?.instance}`,
	);

	// A path with a doubled or a trailing slash is what a hand typed URL looks like, and it used to fall
	// through the route table into an answer that was neither.
	const doubled = await get(one, `//state/?token=${one.token}&workspace=${opened.board.id}`);
	said(doubled.status === 200 && doubled.body.includes(opened.board.id), "a doubled or trailing slash still finds its route", `${doubled.status}`);
	const root = await get(one, "//");
	said(root.status === 200 && root.type.includes("text/html"), "and the crossroads answers at //", `${root.status}`);

	const script = await get(one, "/client/board.js");
	said(script.status === 200 && script.type.includes("javascript"), "GET /client/board.js serves the client", `${script.status} ${script.type}`);
	// The mermaid bundle a diagram fence fetches. Its name has no dot in it because the static rule
	// only takes /client/[a-z0-9/_-]+\.js, and a 404 here is a card that silently stays empty.
	const diagram = await get(one, "/client/mermaid-min.js");
	said(diagram.status === 200 && diagram.type.includes("javascript"), "GET /client/mermaid-min.js serves the diagram renderer", `${diagram.status} ${diagram.type}`);
	const refused = await get(one, "/state");
	said(refused.status === 403, "a route without the token is refused", `${refused.status}`);
	const forged = await get(one, `/state?token=deadbeef&workspace=${opened.board.id}`);
	said(forged.status === 403, "and so is a token nobody minted", `${forged.status}`);

	// A spawned thread on the board. The row says who made it, the card says what arrow is drawn, and a
	// child of a child is refused: the rule is one level, and it lives on the row rather than the body.
	const board = `?token=${one.token}&workspace=${opened.board.id}`;
	const parent = JSON.parse((await post(one, `/thread${board}`, { title: "master" })).body || "{}");
	const child = await post(one, `/thread${board}`, { title: "child", parentThread: parent.threadId, after: [parent.threadId], role: "scout" });
	const spawned = JSON.parse(child.body || "{}");
	said(
		child.status === 200 && spawned.card?.threadRoot === parent.threadId && spawned.card?.after?.[0] === parent.threadId,
		"a child thread cascades under its master and carries its arrow",
		`${child.status} root ${String(spawned.card?.threadRoot ?? "").slice(0, 8)}`,
	);
	const grandchild = await post(one, `/thread${board}`, { title: "grandchild", parentThread: spawned.threadId });
	said(grandchild.status === 409, "a child of a child is refused", `${grandchild.status} ${grandchild.body.slice(0, 60)}`);
	const stray = await post(one, `/thread${board}`, { title: "stray", after: ["no-such-card"] });
	said(stray.status === 409, "an unknown predecessor is refused rather than dropped", `${stray.status}`);
	const noTask = await post(one, `/thread/spawn${board}`, { title: "nothing" });
	said(noTask.status === 409, "a spawned thread without a task is refused", `${noTask.status}`);
	const afterState = JSON.parse((await get(one, `/state${board}`)).body || "{}");
	const childRow = afterState.threads?.find((thread) => thread.id === spawned.threadId);
	said(
		childRow?.depth === 1 && childRow?.parentThread === parent.threadId && childRow?.role === "scout",
		"the child row keeps its depth, parent and role",
		`depth ${childRow?.depth} role ${childRow?.role}`,
	);
	said(!afterState.threads?.some((thread) => "token" in thread), "and /state does not spread a child's token");

	// The point of the whole exercise: a second daemon answering at the same time, told where to put
	// its state by the flag, on the same workspace folder.
	const two = await boot(second, "flag");
	said(Boolean(two.token) && two.base !== one.base, "a second daemon boots beside the first", two.base);
	said(two.token !== one.token, "each instance has its own token");
	said(daemonFile(second).port !== saved.daemon.port, "and its own port", `${saved.daemon.port} and ${daemonFile(second).port}`);

	const alsoOpened = await openWorkspace(two, first);
	const theirs = JSON.parse((await get(two, `/state?token=${two.token}&workspace=${alsoOpened.board.id}`)).body || "{}");
	said(
		alsoOpened.status === 200 && alsoOpened.board.id === opened.board.id && Array.isArray(theirs.threads) && theirs.threads.length === 0,
		"the same folder is two boards, one per instance",
		`board ${String(alsoOpened.board?.id ?? "").slice(0, 8)}, ${theirs.threads?.length} threads on the second`,
	);
	said(theirs.meta?.instance !== state.meta?.instance, "and each board says which instance it is", `${state.meta?.instance} | ${theirs.meta?.instance}`);
	const stillThere = await get(one, `/state?token=${one.token}&workspace=${opened.board.id}`);
	said(stillThere.status === 200, "the first instance is still answering");
	// Nothing of the second daemon leaked into the first one's folder: its token file is the one it
	// wrote, and the only workspace recorded there is the one its own board was opened with.
	const again = recorded(first);
	said(
		again.daemon.token === one.token && again.workspaces.workspaces.length === 1,
		"the second instance left the first one's folder alone",
	);
	for (const daemon of [one, two]) {
		if (daemon.noise.length) console.log(`     stderr: ${daemon.noise.join("").trim().split("\n").slice(-1)[0]}`);
	}
}

main()
	.then(() => {
		console.log(`all checks passed${keep ? `, scratch folders kept at ${scratches.join(" ")}` : ""}`);
	})
	.catch((error) => {
		console.error(String(error?.message ?? error));
		console.log(`scratch folders were ${scratches.join(" ")}${keep ? "" : " (removed)"}`);
		process.exitCode = 1;
	})
	.finally(async () => {
		for (const child of children) child.kill();
		if (!keep) for (const folder of scratches) rmSync(folder, { recursive: true, force: true });
	});
