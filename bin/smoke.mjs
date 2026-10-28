#!/usr/bin/env node
/**
 * Boots a daemon against a scratch state folder and hits the routes a change is most likely to break.
 *
 * The point is isolation: with `PI_STUDIO_STATE` pointing into a temporary folder, this runs beside
 * the human's own daemon without touching its token, its workspaces, its boards or its sessions, and
 * picks a free port because a fresh state folder holds no port to reuse. Nothing is spawned here: no
 * thread is prompted, so no `pi` child starts and no model is called.
 *
 * What it proves is that the server starts, serves the page, opens a workspace, writes that workspace
 * down, and answers for its board. A refactor that breaks a route fails here in about a second.
 *
 *   node bin/smoke.mjs          # one line per check, exit 1 on the first failure
 *   node bin/smoke.mjs --keep   # leave the scratch folder behind, named in the output
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const keep = process.argv.includes("--keep");
const scratch = mkdtempSync(join(tmpdir(), "pi-studio-smoke-"));
const children = new Set();

function said(ok, what, note = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? ` — ${note}` : ""}`);
	if (!ok) throw new Error(`smoke: ${what}`);
}

/** The daemon answers on an ephemeral port and says so; that line is the only address there is. */
function waitForUrl(child) {
	return new Promise((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(() => reject(new Error(`no listening line in 20s: ${seen.slice(-400)}`)), 20_000);
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
			reject(new Error(`the daemon exited with ${code} before listening: ${seen.slice(-400)}`));
		});
	});
}

async function get(base, path, init) {
	const res = await fetch(new URL(path, base), init);
	const body = await res.text();
	return { status: res.status, type: res.headers.get("content-type") ?? "", body };
}

async function main() {
	const child = spawn(process.execPath, [join(repo, "server.mjs"), "--no-open"], {
		cwd: repo,
		env: { ...process.env, PI_STUDIO_STATE: scratch, PI_STUDIO_PORT: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	const noise = [];
	child.stderr.on("data", (chunk) => noise.push(String(chunk)));

	const url = await waitForUrl(child);
	const token = new URL(url).searchParams.get("token");
	const base = url.replace(/\?.*$/, "");
	said(Boolean(token), "the daemon boots against a scratch folder", scratch);

	const page = await get(base, "/");
	said(
		page.status === 200 && page.type.includes("text/html") && page.body.includes("pi-studio"),
		"GET / serves the crossroads",
		`${page.status} ${page.type}`,
	);

	// Every route past the statics is behind the token, and it travels in the query, not the body.
	const opened = await get(base, `/workspace?token=${token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ folder: scratch }),
	});
	const workspace = JSON.parse(opened.body || "{}");
	said(
		opened.status === 200 && Boolean(workspace.board?.id),
		"POST /workspace opens one",
		`${opened.status} board ${String(workspace.board?.id ?? "").slice(0, 8)}`,
	);
	said(existsSync(join(scratch, "workspaces.json")), "the workspace is written down inside the scratch folder");

	const state = await get(base, `/state?token=${token}&workspace=${workspace.board.id}`);
	const board = JSON.parse(state.body || "{}");
	said(
		state.status === 200 && Array.isArray(board.threads) && board.workspace?.id === workspace.board.id,
		"GET /state answers for that board",
		`${state.status} ${board.threads?.length ?? "?"} threads`,
	);
	// Read back through the API rather than the file: a board is only written down when it changes, so
	// what a fresh boot proves is that the workspace it was told about is the one it serves.
	const list = await get(base, `/workspaces?token=${token}`);
	const saved = JSON.parse(readFileSync(join(scratch, "workspaces.json"), "utf8"));
	said(
		list.status === 200 && list.body.includes(workspace.board.id) && saved.workspaces?.some((one) => one.id === workspace.board.id),
		"GET /workspaces reads it back from the scratch folder",
		`${list.status}`,
	);

	const script = await get(base, "/board.js");
	said(script.status === 200 && script.type.includes("javascript"), "GET /board.js serves the client", `${script.status} ${script.type}`);

	const refused = await get(base, "/state");
	said(refused.status === 403, "a route without the token is refused", `${refused.status}`);
	said(existsSync(join(scratch, "daemon.json")), "the token and port are recorded in the scratch folder");

	// The scratch folder is all it touched: the token and the port are its own, and the human's daemon
	// keeps its own file, so a check can run beside a live board without appending to it.
	const daemon = JSON.parse(readFileSync(join(scratch, "daemon.json"), "utf8"));
	said(daemon.token === token && Number(daemon.port) > 0, "the scratch daemon used its own token and port", `port ${daemon.port}`);
	if (noise.length) console.log(`     stderr: ${noise.join("").trim().split("\n").slice(-1)[0]}`);
}

main()
	.then(() => {
		console.log(`all checks passed${keep ? `, scratch kept at ${scratch}` : ""}`);
	})
	.catch((error) => {
		console.error(String(error?.message ?? error));
		console.log(`scratch was ${scratch}${keep ? "" : " (removed)"}`);
		process.exitCode = 1;
	})
	.finally(async () => {
		for (const child of children) child.kill();
		if (!keep) rmSync(scratch, { recursive: true, force: true });
	});
