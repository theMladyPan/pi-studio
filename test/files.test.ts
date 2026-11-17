import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The daemon's state folder is resolved when `server/paths.ts` loads, so this file moves it before the
 * daemon's code is imported and only what is below is read from it. Every daemon these tests start gets
 * a state folder of its own under `tmpdir()`, and no test touches a folder a human works in.
 */
const guardState = mkdtempSync(join(tmpdir(), "pi-studio-files-guard-"));
process.env.PI_STUDIO_STATE = guardState;
const { THREAD_ROUTES, threadRefusal } = await import("../server/main.ts");
after(() => rmSync(guardState, { recursive: true, force: true }));

/** One daemon on its own state folder, started the way a human starts it. No child and no model runs. */
async function boot(state: string, env: Record<string, string> = {}) {
	const child = spawn(process.execPath, [join(repo, "server.ts"), "--no-open"], {
		cwd: repo,
		env: { ...process.env, PI_STUDIO_STATE: state, PI_STUDIO_PORT: "", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const noise: string[] = [];
	child.stderr.on("data", (chunk) => noise.push(String(chunk)));
	const url = await new Promise<string>((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(() => reject(new Error(`no listening line in 20s: ${noise.join("")}`)), 20_000);
		child.stdout.on("data", (chunk) => {
			seen += String(chunk);
			const match = seen.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/);
			if (!match) return;
			clearTimeout(timer);
			resolve(match[1]);
		});
		child.on("exit", (code) => reject(new Error(`the daemon exited with ${code}: ${noise.join("").slice(-400)}`)));
	});
	const parsed = new URL(url);
	return { child, noise, base: parsed.origin, token: parsed.searchParams.get("token") ?? "" };
}

type Daemon = { child: { kill: () => void }; noise: string[]; base: string; token: string };

const get = async (daemon: Daemon, path: string) => {
	const res = await fetch(daemon.base + path);
	return { status: res.status, body: await res.text() };
};
const postJson = (daemon: Daemon, board: string, path: string, body?: unknown) =>
	fetch(`${daemon.base}${path}?token=${daemon.token}&workspace=${board}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	}).then(async (res) => ({ status: res.status, body: await res.text() }));
const list = (daemon: Daemon, board: string, query = "") =>
	get(daemon, `/files?token=${daemon.token}&workspace=${board}${query}`);
const listed = async (daemon: Daemon, board: string, query = "") => {
	const res = await list(daemon, board, query);
	return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
};
const json = (res: { status: number; body: string }) => ({ status: res.status, body: JSON.parse(res.body) });

/** A workspace opened on a temporary folder, the way a board is opened from the crossroads. */
async function openWorkspace(daemon: Daemon, folder: string): Promise<string> {
	const opened = await fetch(`${daemon.base}/workspace?token=${daemon.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ folder }),
	});
	assert.equal(opened.status, 200);
	const board = JSON.parse(await opened.text()).board;
	assert.ok(board?.id, "no board came back");
	return board.id;
}

const git = (folder: string, ...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();

/** A stub `gio` on the daemon's search path: it reads what to do from a control file, so one daemon covers every branch. */
function stubGio(bin: string) {
	writeFileSync(
		join(bin, "gio"),
		[
			"#!/bin/sh",
			'# argv is: trash -- <path>',
			'mode=$(cat "$PI_STUDIO_TEST_GIO_MODE" 2>/dev/null)',
			'target="$3"',
			'case "$mode" in',
			'  partial) case "$(basename "$target")" in keep*) echo "cannot trash $target" >&2; exit 1 ;; esac ;;',
			'  vanish) rm -rf -- "$target"; exit 1 ;;',
			'  noop) exit 0 ;;',
			'  broken) echo "gio: no trash here" >&2; exit 1 ;;',
			'esac',
			'mv -- "$target" "$PI_STUDIO_TEST_TRASH/"',
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
}

describe("the explorer's routes belong to the human", () => {
	const child = { human: false, board: { id: "board-a" }, thread: { id: "t1" } };

	test("none of them is a route a thread may reach, and the human is refused nothing", () => {
		const routes = ["/files", "/files/new", "/files/rename", "/files/move", "/files/copy", "/files/delete"];
		for (const path of routes) assert.equal(THREAD_ROUTES.has(path), false, `${path} is in THREAD_ROUTES`);
		// The list is compared whole too: a route added to THREAD_ROUTES widens what a child may reach.
		assert.equal(THREAD_ROUTES.size, 7);
		for (const path of routes.slice(1)) assert.equal(threadRefusal(child, "POST", path, "board-a"), "a thread may not use that", path);
		assert.equal(threadRefusal(child, "GET", "/files", "board-a"), "a thread may not use that");
		assert.equal(threadRefusal({ human: true }, "GET", "/files", ""), null);
		for (const path of routes.slice(1)) assert.equal(threadRefusal({ human: true }, "POST", path, "board-a"), null, path);
	});
});

describe("listing a workspace", () => {
	test("dot entries are listed, .git is not, and a link is listed by what it is", async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-files-list-"));
		const folder = join(state, "proj");
		const outside = join(state, "outside");
		mkdirSync(join(folder, "docs"), { recursive: true });
		mkdirSync(join(folder, ".agents"));
		mkdirSync(join(folder, ".git"));
		mkdirSync(outside);
		writeFileSync(join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(folder, ".env"), "A=1\n");
		writeFileSync(join(folder, "docs", "note.md"), "# note\n");
		writeFileSync(join(folder, "ünï cödé.txt"), "unicode\n");
		writeFileSync(join(folder, "bad\u0001name"), "control\n");
		writeFileSync(join(outside, "secret.txt"), "secret\n");
		symlinkSync("docs", join(folder, "docs-link"));
		symlinkSync(outside, join(folder, "escape"));
		const daemon = await boot(state);
		try {
			const board = await openWorkspace(daemon, folder);
			const root = realpathSync(folder);
			const page = await listed(daemon, board);
			assert.equal(page.status, 200, JSON.stringify(page.body));
			assert.equal(page.body.root, root);
			assert.equal(page.body.path, "");
			assert.equal(page.body.parent, null);
			assert.equal(page.body.canonical, "");
			assert.equal(page.body.repo, false);
			assert.deepEqual(page.body.dirty, []);
			assert.equal(page.body.truncated, false);
			assert.equal(page.body.next, null);
			const names = page.body.entries.map((one: any) => one.name);
			assert.ok(names.includes(".env"), "a dot file is part of an explorer");
			assert.ok(names.includes(".agents"), "a dot folder is part of an explorer");
			assert.equal(names.includes(".git"), false, ".git is git's own folder");
			assert.equal(names.some((one: string) => one.startsWith("bad")), false, "a control name is skipped");
			assert.equal(names.includes("ünï cödé.txt"), true);
			// Dirs first, then names: the first four of this folder are the four folders.
			const firstFour = page.body.entries.slice(0, 4).map((one: any) => one.name);
			assert.deepEqual(new Set(firstFour), new Set([".agents", "docs", "docs-link", "escape"]));
			assert.equal(page.body.entries.slice(4).every((one: any) => one.dir === false), true);
			for (const one of page.body.entries) {
				assert.equal(typeof one.size, "number");
				assert.equal(typeof one.mtime, "number");
				assert.equal(typeof one.link, "boolean");
			}
			const link = page.body.entries.find((one: any) => one.name === "docs-link");
			assert.deepEqual({ dir: link.dir, link: link.link, path: link.path }, { dir: true, link: true, path: "docs-link" });
			const escape = page.body.entries.find((one: any) => one.name === "escape");
			assert.equal(escape.link, true);
			assert.equal(escape.dir, true, "the entry is drawn as the folder it points at");

			// A link that stays inside the workspace is a folder to walk into, and the answer says which one.
			const inside = await listed(daemon, board, "&path=docs-link");
			assert.equal(inside.status, 200, JSON.stringify(inside.body));
			assert.equal(inside.body.canonical, "docs");
			assert.deepEqual(inside.body.entries.map((one: any) => one.path), ["docs-link/note.md"]);

			const sub = await listed(daemon, board, "&path=/docs/");
			assert.equal(sub.body.path, "docs");
			assert.equal(sub.body.parent, "");
			assert.equal(sub.body.canonical, "docs");

			// A link that leaves the workspace is listed, and its target is never read.
			const away = await list(daemon, board, "&path=escape");
			assert.equal(away.status, 409, away.body);
			assert.match(away.body, /outside the workspace/);
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	});

	test("invalid paths, the repo's own folder, a missing folder and a file are refused", async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-files-refuse-"));
		const folder = join(state, "proj");
		mkdirSync(join(folder, ".git"), { recursive: true });
		writeFileSync(join(folder, "readme.md"), "readme\n");
		const daemon = await boot(state);
		try {
			const board = await openWorkspace(daemon, folder);
			for (const path of ["..", "../", "../../etc", ".git", ".git/HEAD", "docs/.git", "a\u0000b"]) {
				const answer = await list(daemon, board, `&path=${encodeURIComponent(path)}`);
				assert.equal(answer.status, 400, `${path} answered ${answer.status}: ${answer.body}`);
			}
			const missing = await list(daemon, board, "&path=nope");
			assert.equal(missing.status, 409);
			assert.match(missing.body, /no such folder: nope/);
			const file = await list(daemon, board, "&path=readme.md");
			assert.equal(file.status, 409);
			assert.match(file.body, /not a folder/);
			const noBoard = await get(daemon, `/files?token=${daemon.token}&workspace=nope`);
			assert.equal(noBoard.status, 409);
			assert.match(noBoard.body, /no such workspace/);
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	});

	test("a page of more than 200 entries resumes on the name it was handed, dirs first", async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-files-page-"));
		const folder = join(state, "proj");
		mkdirSync(join(folder, "many"), { recursive: true });
		for (let at = 0; at < 150; at++) mkdirSync(join(folder, "many", `d${String(at).padStart(3, "0")}`));
		for (let at = 0; at < 150; at++) writeFileSync(join(folder, "many", `f${String(at).padStart(3, "0")}.txt`), "x");
		const daemon = await boot(state);
		try {
			const board = await openWorkspace(daemon, folder);
			const first = await listed(daemon, board, "&path=many");
			assert.equal(first.status, 200);
			assert.equal(first.body.total, 300);
			assert.equal(first.body.truncated, true);
			assert.equal(first.body.entries.length, 200);
			assert.equal(first.body.entries.slice(0, 150).every((one: any) => one.dir), true);
			assert.equal(first.body.entries[150].name, "f000.txt");
			assert.equal(first.body.next, "f049.txt");
			// A limit past the cap is still the cap, and the second page finishes the folder exactly once.
			const capped = await listed(daemon, board, "&path=many&limit=999");
			assert.equal(capped.body.entries.length, 200);
			assert.equal(capped.body.next, "f049.txt");
			const second = await listed(daemon, board, `&path=many&after=${encodeURIComponent(first.body.next)}`);
			assert.equal(second.body.truncated, false);
			assert.equal(second.body.next, null);
			assert.equal(second.body.entries.length, 100);
			const all = [...first.body.entries, ...second.body.entries].map((one: any) => one.name);
			assert.equal(new Set(all).size, 300);
			assert.equal(all.length, 300);
			// The sort is the same one a page boundary is taken from.
			const sorted = [...all].sort((a, b) => {
				const aDir = a.startsWith("d");
				const bDir = b.startsWith("d");
				if (aDir !== bDir) return aDir ? -1 : 1;
				return a.localeCompare(b);
			});
			assert.deepEqual(all, sorted);
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	});

	test("the board's folder is listed even when a thread of it has a tree of its own", async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-files-tree-"));
		const folder = join(state, "proj");
		const tree = join(state, "tree");
		mkdirSync(folder);
		mkdirSync(tree);
		writeFileSync(join(folder, "here.txt"), "the folder\n");
		writeFileSync(join(tree, "only-in-worktree.txt"), "the tree\n");
		const id = "aaaaaaaabbbbcccc";
		const real = realpathSync(folder);
		writeFileSync(join(state, "workspaces.json"), JSON.stringify({ version: 1, workspaces: [{ id, folder: real, name: "proj", openedAt: 1 }] }));
		mkdirSync(join(state, "boards"), { recursive: true });
		writeFileSync(
			join(state, "boards", `${id}.json`),
			JSON.stringify({
				version: 1,
				workspace: { id, folder: real, name: "proj" },
				savedAt: 1,
				threads: [{ id: "t1", title: "a thread", at: 1, turns: [], worktree: { path: tree, branch: "dev", base: "dev" } }],
				cards: [],
			}),
		);
		const daemon = await boot(state);
		try {
			// The thread really does point at that tree: the sibling picker follows it when a card is named.
			const browsed = JSON.parse((await get(daemon, `/browse?token=${daemon.token}&workspace=${id}&card=t1&path=`)).body);
			assert.equal(browsed.path, realpathSync(tree));
			assert.ok(browsed.entries.some((one: any) => one.name === "only-in-worktree.txt"));
			// The explorer does not: it lists the folder the human opened.
			const page = await listed(daemon, id);
			assert.equal(page.status, 200, JSON.stringify(page.body));
			assert.equal(page.body.root, real);
			const names = page.body.entries.map((one: any) => one.name);
			assert.deepEqual(names, ["here.txt"]);
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	});

	test("git marks a changed file and the folders above it, and a folder that is not a repository says so", async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-files-git-"));
		const folder = join(state, "repo");
		mkdirSync(join(folder, "sub"), { recursive: true });
		git(folder, "init", "-b", "dev");
		git(folder, "config", "user.email", "test@example.invalid");
		git(folder, "config", "user.name", "test");
		writeFileSync(join(folder, "changed.txt"), "one\n");
		writeFileSync(join(folder, "sub", "held.txt"), "one\n");
		git(folder, "add", ".");
		git(folder, "commit", "-m", "first");
		writeFileSync(join(folder, "changed.txt"), "two\n");
		writeFileSync(join(folder, "sub", "held.txt"), "two\n");
		writeFileSync(join(folder, "new file.txt"), "new\n");
		writeFileSync(join(folder, "ünï.txt"), "new\n");
		const plain = join(state, "plain");
		mkdirSync(plain);
		const daemon = await boot(state);
		try {
			const board = await openWorkspace(daemon, folder);
			const page = await listed(daemon, board, "&git=1");
			assert.equal(page.status, 200, JSON.stringify(page.body));
			assert.equal(page.body.repo, true);
			const byName = new Map(page.body.entries.map((one: any) => [one.name, one]));
			assert.equal((byName.get("changed.txt") as any).git, "M");
			assert.equal((byName.get("new file.txt") as any).git, "??");
			assert.equal((byName.get("ünï.txt") as any).git, "??");
			assert.equal((byName.get("sub") as any).git, undefined);
			// The changed file in `sub` marks the folder it is in, and the root every change is under.
			assert.ok(page.body.dirty.includes("sub"), JSON.stringify(page.body.dirty));
			assert.ok(page.body.dirty.includes(""));

			// A listing that did not ask for status still answers whether this is a repository.
			const quiet = await listed(daemon, board);
			assert.equal(quiet.body.repo, true);
			assert.deepEqual(quiet.body.dirty, []);

			// A folder that is no repository is not an error: it simply has nothing to draw.
			const other = await openWorkspace(daemon, plain);
			const none = await listed(daemon, other, "&git=1");
			assert.equal(none.status, 200);
			assert.equal(none.body.repo, false);
			assert.deepEqual(none.body.dirty, []);
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	});
});

describe("changing a workspace", () => {
	test("new, rename, move and copy land on disk, and a name that is taken is refused", async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-files-change-"));
		const folder = join(state, "proj");
		const outside = join(state, "outside");
		mkdirSync(join(folder, "docs"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "secret\n");
		writeFileSync(join(folder, "a.txt"), "A");
		writeFileSync(join(folder, "keep.txt"), "KEEP");
		writeFileSync(join(folder, "target.txt"), "TARGET");
		writeFileSync(join(folder, "docs", "inner.txt"), "INNER");
		symlinkSync("target.txt", join(folder, "ln"));
		symlinkSync(outside, join(folder, "hop"));
		const daemon = await boot(state);
		try {
			const board = await openWorkspace(daemon, folder);

			// An empty file and an empty folder, each named back with its entry.
			const made = json(await postJson(daemon, board, "/files/new", { path: "", name: "made.txt", dir: false }));
			assert.equal(made.status, 200, made.body);
			assert.deepEqual([made.body.entry.path, made.body.entry.dir], ["made.txt", false]);
			assert.equal(readFileSync(join(folder, "made.txt"), "utf8"), "");
			const madeDir = json(await postJson(daemon, board, "/files/new", { path: "docs", name: "sub", dir: true }));
			assert.deepEqual([madeDir.body.entry.path, madeDir.body.entry.dir], ["docs/sub", true]);
			assert.equal(lstatSync(join(folder, "docs", "sub")).isDirectory(), true);

			// A name that is taken, a name that is a path and the repo's folder are all refused.
			for (const body of [
				{ path: "", name: "made.txt", dir: false },
				{ path: "", name: "docs", dir: true },
				{ path: "", name: "../escape.txt", dir: false },
				{ path: "", name: ".git", dir: false },
				{ path: ".git", name: "x", dir: false },
				{ path: "..", name: "x", dir: false },
			]) {
				const refused = await postJson(daemon, board, "/files/new", body);
				assert.ok([400, 409].includes(refused.status), `${JSON.stringify(body)} answered ${refused.status}`);
			}
			assert.equal(existsSync(join(state, "escape.txt")), false);

			// A write through a link that leaves the workspace is refused, and the outside folder is untouched.
			const hopped = await postJson(daemon, board, "/files/new", { path: "hop", name: "evil.txt", dir: false });
			assert.equal(hopped.status, 409, hopped.body);
			assert.equal(existsSync(join(outside, "evil.txt")), false);

			// A rename, and a rename that would overwrite.
			const renamed = json(await postJson(daemon, board, "/files/rename", { path: "a.txt", name: "b.txt" }));
			assert.deepEqual([renamed.status, renamed.body.from, renamed.body.to], [200, "a.txt", "b.txt"]);
			assert.equal(existsSync(join(folder, "a.txt")), false);
			assert.equal(readFileSync(join(folder, "b.txt"), "utf8"), "A");
			const clash = await postJson(daemon, board, "/files/rename", { path: "keep.txt", name: "b.txt" });
			assert.equal(clash.status, 409, clash.body);
			assert.equal(readFileSync(join(folder, "keep.txt"), "utf8"), "KEEP");
			assert.equal(readFileSync(join(folder, "b.txt"), "utf8"), "A");

			// A link is renamed as a link: its target is the same file it always was.
			assert.equal((await postJson(daemon, board, "/files/rename", { path: "ln", name: "ln2" })).status, 200);
			assert.equal(lstatSync(join(folder, "ln2")).isSymbolicLink(), true);
			assert.equal(readlinkSync(join(folder, "ln2")), "target.txt");
			assert.equal(readFileSync(join(folder, "target.txt"), "utf8"), "TARGET");

			// A batch move, and a selection where one item is inside another: the folder carries its child.
			writeFileSync(join(folder, "m1.txt"), "1");
			writeFileSync(join(folder, "m2.txt"), "2");
			mkdirSync(join(folder, "nest"));
			writeFileSync(join(folder, "nest", "child.txt"), "c");
			const moved = json(await postJson(daemon, board, "/files/move", { paths: ["m1.txt", "m2.txt"], to: "docs" }));
			assert.equal(moved.status, 200, moved.body);
			assert.deepEqual(moved.body.moved, [
				{ from: "m1.txt", to: "docs/m1.txt" },
				{ from: "m2.txt", to: "docs/m2.txt" },
			]);
			const nested = json(await postJson(daemon, board, "/files/move", { paths: ["nest", "nest/child.txt"], to: "docs" }));
			assert.equal(nested.status, 200, nested.body);
			assert.deepEqual(nested.body.moved, [{ from: "nest", to: "docs/nest" }]);
			assert.equal(readFileSync(join(folder, "docs", "nest", "child.txt"), "utf8"), "c");

			// Back to the root, then a copy that must not overwrite the file already there.
			const up = json(await postJson(daemon, board, "/files/move", { paths: ["docs/nest"], to: "" }));
			assert.deepEqual(up.body.moved, [{ from: "docs/nest", to: "nest" }]);
			writeFileSync(join(folder, "docs", "keep.txt"), "DOCS");
			const collided = await postJson(daemon, board, "/files/copy", { paths: ["keep.txt"], to: "docs" });
			assert.equal(collided.status, 409, collided.body);
			assert.equal(readFileSync(join(folder, "docs", "keep.txt"), "utf8"), "DOCS");
			const copied = json(await postJson(daemon, board, "/files/copy", { paths: ["keep.txt"], to: "docs/sub" }));
			assert.equal(copied.status, 200, copied.body);
			assert.deepEqual(copied.body.copied, [{ from: "keep.txt", to: "docs/sub/keep.txt" }]);
			assert.equal(readFileSync(join(folder, "keep.txt"), "utf8"), "KEEP");

			// A folder cannot be carried into itself, and a batch says nothing was done before it starts.
			const intoSelf = await postJson(daemon, board, "/files/copy", { paths: ["docs"], to: "docs/sub" });
			assert.equal(intoSelf.status, 409, intoSelf.body);
			assert.equal(existsSync(join(folder, "docs", "sub", "docs")), false);
			const outsideBatch = await postJson(daemon, board, "/files/move", { paths: ["../nothing.txt"], to: "" });
			assert.equal(outsideBatch.status, 409);
			const gone = await postJson(daemon, board, "/files/move", { paths: ["nowhere.txt"], to: "" });
			assert.equal(gone.status, 409);
			assert.match(gone.body, /no such entry any more/);
			// A move of a link moves the link, not what it points at.
			const linkMoved = json(await postJson(daemon, board, "/files/move", { paths: ["ln2"], to: "docs/sub" }));
			assert.equal(linkMoved.status, 200, linkMoved.body);
			assert.equal(lstatSync(join(folder, "docs", "sub", "ln2")).isSymbolicLink(), true);
			assert.equal(readFileSync(join(folder, "target.txt"), "utf8"), "TARGET");

			// A move onto a name already in the destination is refused as a copy is.
			const moveClash = await postJson(daemon, board, "/files/move", { paths: ["keep.txt"], to: "docs" });
			assert.equal(moveClash.status, 409, moveClash.body);
			assert.equal(readFileSync(join(folder, "keep.txt"), "utf8"), "KEEP");

			// A permanent delete of a link to a folder takes the link and leaves the folder alone.
			symlinkSync("docs", join(folder, "dir-link"));
			const linkDeleted = json(await postJson(daemon, board, "/files/delete", { paths: ["dir-link"], permanent: true }));
			assert.equal(linkDeleted.status, 200, linkDeleted.body);
			assert.deepEqual(linkDeleted.body.deleted, ["dir-link"]);
			assert.equal(existsSync(join(folder, "dir-link")), false);
			assert.equal(existsSync(join(folder, "docs", "inner.txt")), true);

			// The root and the repo's own folder are not things an explorer changes.
			assert.equal((await postJson(daemon, board, "/files/rename", { path: "", name: "x" })).status, 409);
			assert.equal((await postJson(daemon, board, "/files/move", { paths: [""], to: "docs" })).status, 409);
			mkdirSync(join(folder, ".git"));
			const gitDelete = await postJson(daemon, board, "/files/delete", { paths: [".git"], permanent: true });
			assert.equal(gitDelete.status, 409, gitDelete.body);
			assert.equal(existsSync(join(folder, ".git")), true);
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	});

	test("five requests for one name make one file and four refusals", async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-files-race-"));
		const folder = join(state, "proj");
		mkdirSync(folder);
		const daemon = await boot(state);
		try {
			const board = await openWorkspace(daemon, folder);
			const answers = await Promise.all(
				Array.from({ length: 5 }, () => postJson(daemon, board, "/files/new", { path: "", name: "race.txt", dir: false })),
			);
			const statuses = answers.map((one) => one.status).sort();
			assert.deepEqual(statuses, [200, 409, 409, 409, 409]);
			assert.equal(readFileSync(join(folder, "race.txt"), "utf8"), "");
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	});
});

describe("deleting", () => {
	test("a machine with no gio answers the normal shape and deletes nothing until a permanent press", async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-files-nogio-"));
		const bin = join(state, "bin");
		const folder = join(state, "proj");
		mkdirSync(bin);
		mkdirSync(folder);
		writeFileSync(join(folder, "trash-me.txt"), "x");
		writeFileSync(join(folder, "keep-me.txt"), "y");
		const daemon = await boot(state, { PATH: bin });
		try {
			const board = await openWorkspace(daemon, folder);
			const attempted = json(await postJson(daemon, board, "/files/delete", { paths: ["trash-me.txt"] }));
			assert.equal(attempted.status, 207, attempted.body);
			assert.deepEqual(attempted.body.deleted, []);
			assert.equal(attempted.body.trashed, true);
			assert.deepEqual(attempted.body.needsPermanent, ["trash-me.txt"]);
			assert.deepEqual(attempted.body.failed, []);
			assert.equal(existsSync(join(folder, "trash-me.txt")), true, "a failed trash is still there");

			// `permanent: false` is not a confirmation either.
			const refused = json(await postJson(daemon, board, "/files/delete", { paths: ["keep-me.txt"], permanent: false }));
			assert.equal(refused.status, 207);
			assert.deepEqual(refused.body.needsPermanent, ["keep-me.txt"]);
			assert.equal(existsSync(join(folder, "keep-me.txt")), true);

			// The confirmation the UI sends: only the paths it was handed.
			const confirmed = json(await postJson(daemon, board, "/files/delete", { paths: ["trash-me.txt"], permanent: true }));
			assert.deepEqual([confirmed.status, confirmed.body.deleted, confirmed.body.trashed, confirmed.body.needsPermanent, confirmed.body.failed], [200, ["trash-me.txt"], false, [], []]);
			assert.equal(existsSync(join(folder, "trash-me.txt")), false);
			assert.equal(existsSync(join(folder, "keep-me.txt")), true);
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	});

	test("gio trashes what it can and a failure is offered back instead of deleted", async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-files-gio-"));
		const bin = join(state, "bin");
		const trash = join(state, "trash");
		const mode = join(state, "gio-mode");
		const folder = join(state, "proj");
		const outside = join(state, "outside");
		mkdirSync(bin);
		mkdirSync(trash);
		mkdirSync(folder);
		mkdirSync(outside);
		stubGio(bin);
		for (const name of ["ok1.txt", "keep1.txt", "gone1.txt", "stays.txt", "keep2.txt"]) writeFileSync(join(folder, name), name);
		writeFileSync(join(outside, "secret.txt"), "secret\n");
		symlinkSync(outside, join(folder, "link-away"));
		// The stub comes first, and the shell tools it leans on are still reachable behind it.
		const search = [bin, "/usr/bin", "/bin"].join(":");
		const daemon = await boot(state, { PATH: search, PI_STUDIO_TEST_GIO_MODE: mode, PI_STUDIO_TEST_TRASH: trash });
		try {
			const board = await openWorkspace(daemon, folder);

			// Half the batch can be trashed and half cannot: each path is answered for itself.
			writeFileSync(mode, "partial\n");
			const partial = json(await postJson(daemon, board, "/files/delete", { paths: ["ok1.txt", "keep1.txt"] }));
			assert.equal(partial.status, 207, partial.body);
			assert.deepEqual(partial.body.deleted, ["ok1.txt"]);
			assert.deepEqual(partial.body.needsPermanent, ["keep1.txt"]);
			assert.equal(partial.body.trashed, true);
			assert.equal(existsSync(join(folder, "ok1.txt")), false);
			assert.equal(existsSync(join(trash, "ok1.txt")), true, "it is in the Trash, not gone for good");
			assert.equal(existsSync(join(folder, "keep1.txt")), true, "a failed trash is never deleted");

			// A tool that moved the entry and then failed still moved it, and the answer says so.
			writeFileSync(mode, "vanish\n");
			const vanished = json(await postJson(daemon, board, "/files/delete", { paths: ["gone1.txt"] }));
			assert.equal(vanished.status, 200, vanished.body);
			assert.deepEqual([vanished.body.deleted, vanished.body.needsPermanent], [["gone1.txt"], []]);

			// A tool that says yes and moved nothing is a failure, not a delete.
			writeFileSync(mode, "noop\n");
			const noop = json(await postJson(daemon, board, "/files/delete", { paths: ["stays.txt"] }));
			assert.equal(noop.status, 207, noop.body);
			assert.deepEqual(noop.body.deleted, []);
			assert.deepEqual(noop.body.needsPermanent, []);
			assert.equal(noop.body.failed.length, 1);
			assert.equal(noop.body.failed[0].path, "stays.txt");
			assert.equal(existsSync(join(folder, "stays.txt")), true);

			// The Trash's own refusal is the ordinary fallback: the path is named back for a confirmation.
			writeFileSync(mode, "broken\n");
			const broken = json(await postJson(daemon, board, "/files/delete", { paths: ["keep2.txt"] }));
			assert.equal(broken.status, 207, broken.body);
			assert.deepEqual(broken.body.needsPermanent, ["keep2.txt"]);
			assert.equal(existsSync(join(folder, "keep2.txt")), true);

			// A link is deleted as a link: the folder it points at keeps its file.
			writeFileSync(mode, "ok\n");
			const deletedLink = json(await postJson(daemon, board, "/files/delete", { paths: ["link-away"] }));
			assert.equal(deletedLink.status, 200, deletedLink.body);
			assert.deepEqual(deletedLink.body.deleted, ["link-away"]);
			assert.equal(existsSync(join(folder, "link-away")), false);
			assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret\n");
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	});
});
