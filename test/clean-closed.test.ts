import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

// The transcript a clean deletes is the one `sessionFile` names, and that folder is resolved once, when the
// modules below load. A throwaway state folder is set first, so the test never touches a real board.
process.env.PI_STUDIO_STATE = mkdtempSync(join(tmpdir(), "pi-studio-clean-closed-state-"));

const { onCleanClosed, onThreadCollect } = await import("../server/routes/board/lifecycle.ts");
const { ensureWorktree } = await import("../server/worktrees/make.ts");
const { sessionFile } = await import("../server/session.ts");

const git = (folder: string, ...args: string[]) =>
	execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A throwaway repository with one commit on `dev`. Never the human's. */
function scratchRepo() {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-clean-closed-"));
	git(folder, "init", "-b", "dev");
	git(folder, "config", "user.email", "test@example.invalid");
	git(folder, "config", "user.name", "test");
	writeFileSync(join(folder, "readme.md"), "hello\n");
	git(folder, "add", ".");
	git(folder, "commit", "-m", "first");
	return folder;
}

/** A board no file backs, so nothing a route writes has a place to land. */
function scratchBoard(repo: string) {
	return {
		id: "scratch",
		folder: repo,
		name: "scratch",
		children: new Map(),
		threads: new Map(),
		cards: new Map(),
		activity: [] as any[],
		askers: new Map(),
		trees: [] as any[],
		trash: [] as any[],
		saveTimer: null as any,
		clients: new Set(),
	};
}

/** A response a route can answer on, holding what it said so a test can read the status back. */
function scratchRes() {
	const res: { status: number; body: string; writeHead: (status: number, headers?: unknown) => void; end: (body: string) => void } = {
		status: 0,
		body: "",
		writeHead(status) {
			res.status = status;
		},
		end(body) {
			res.body = body;
		},
	};
	return res;
}

const jsonRequest = (body: unknown) => Readable.from([Buffer.from(JSON.stringify(body))]);

const answered = (res: { body: string }) => JSON.parse(res.body);

/** The save a route schedules is dropped: this board is a literal, not a folder of JSON. */
function unschedule(board: { saveTimer: any }) {
	if (board.saveTimer) clearTimeout(board.saveTimer);
	board.saveTimer = null;
}

/** Whether the repository still holds this branch, by full name rather than by what `git branch` draws. */
function hasBranch(repo: string, name: string) {
	return git(repo, "for-each-ref", "refs/heads", "--format=%(refname:short)")
		.split("\n")
		.includes(name);
}

/** The transcript pi would have written for a thread, so a clean has one to delete. */
function transcript(board: any, thread: any) {
	const dir = join(process.env.PI_STUDIO_STATE as string, "sessions", board.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `1700000000000_${thread.sessionId}.jsonl`), `${JSON.stringify({ type: "message" })}\n`);
}

/** A thread in a tree of its own on a branch of its own, with one commit on it. */
function treeThread(board: any, id: string, branch: string, extra: any = {}) {
	const thread: any = { id, title: `a thread ${id}`, folder: board.folder, at: Date.now(), turns: [], status: "idle", sessionId: `sess-${id}`, ...extra };
	board.threads.set(thread.id, thread);
	const tree = ensureWorktree(board, thread);
	assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
	git(tree.path, "checkout", "-b", branch);
	writeFileSync(join(tree.path, `${id}.md`), `${id}\n`);
	git(tree.path, "add", ".");
	git(tree.path, "commit", "-m", `${id} work`);
	tree.branch = branch;
	transcript(board, thread);
	unschedule(board);
	return { thread, tree };
}

/** The same, put away the way the human puts a card away: hidden, and carrying when it was closed. */
function closedThread(board: any, id: string, branch: string, extra: any = {}) {
	const made = treeThread(board, id, branch, extra);
	made.thread.hidden = true;
	made.thread.closedAt = Date.now();
	return made;
}

test("a closed thread whose work is in dev goes with its folder, its branch, its transcript and its trash entry", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = closedThread(board, "aaaa1111", "feat/aaaa-work-aaaa1111");
		const file = sessionFile({ id: board.id }, thread.sessionId);
		assert.ok(file && existsSync(file), "the transcript was never written");
		// An undo entry and a row are what a removal of this kind leaves behind if it is not careful.
		board.trash.push({ kind: "thread", thread });
		board.activity.push({ id: "row-1", thread: { id: thread.id } });
		git(repo, "merge", "--ff-only", "feat/aaaa-work-aaaa1111");

		const res = scratchRes();
		await onCleanClosed(jsonRequest({}), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(said.kept, [], `nothing was expected to stay: ${res.body}`);
		assert.equal(said.removed.length, 1, res.body);
		assert.equal(said.removed[0].id, thread.id);
		assert.equal(said.removed[0].path, tree.path);
		assert.equal(said.removed[0].branch, "feat/aaaa-work-aaaa1111");
		assert.match(said.removed[0].note ?? "", /dev/, `the note says nothing about the proof: ${said.removed[0].note}`);

		assert.equal(board.threads.has(thread.id), false, "the thread is still on the board");
		assert.equal(board.trees.length, 0, "the board kept the record of a tree it retired");
		assert.equal(board.trash.length, 0, "the clean left an undo entry that puts the thread back");
		assert.equal(board.activity.length, 0, "the clean left the row of a thread that is gone");
		assert.equal(existsSync(tree.path), false, "the folder is still on disk");
		assert.equal(existsSync(file), false, "the transcript outlived the thread");
		assert.equal(hasBranch(repo, "feat/aaaa-work-aaaa1111"), false, "the branch outlived the folder");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a closed thread with uncommitted work stays on the board, with its folder and its branch", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = closedThread(board, "bbbb2222", "feat/bbbb-work-bbbb2222");
		writeFileSync(join(tree.path, "draft.md"), "not committed yet\n");

		const res = scratchRes();
		await onCleanClosed(jsonRequest({}), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(said.removed, [], `a dirty tree was removed: ${res.body}`);
		assert.equal(said.kept.length, 1, res.body);
		assert.equal(said.kept[0].id, thread.id);
		assert.match(said.kept[0].reason, /uncommitted/, `the reason says nothing about the work: ${said.kept[0].reason}`);
		assert.equal(board.threads.has(thread.id), true, "a tree that was kept lost its row");
		assert.ok(existsSync(tree.path), "the folder of a kept tree is gone");
		assert.equal(hasBranch(repo, "feat/bbbb-work-bbbb2222"), true, "the branch of a kept tree is gone");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a closed thread with a commit no branch holds stays, and the reason names dev", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = closedThread(board, "cccc3333", "feat/cccc-work-cccc3333");
		// The parent's own work goes into dev, so only the child's commit is unmerged.
		git(repo, "checkout", "-b", "feat/cccc-parent");
		writeFileSync(join(repo, "parent.txt"), "parent\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "parent work");
		git(repo, "checkout", "dev");
		git(repo, "merge", "--ff-only", "feat/cccc-parent");

		const res = scratchRes();
		await onCleanClosed(jsonRequest({}), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(said.removed, [], `an unmerged tree was removed: ${res.body}`);
		assert.equal(said.kept.length, 1, res.body);
		assert.match(said.kept[0].reason, /commit/, `the reason says nothing about commits: ${said.kept[0].reason}`);
		assert.match(said.kept[0].reason, /dev/, `the reason does not name dev: ${said.kept[0].reason}`);
		assert.equal(board.threads.has(thread.id), true);
		assert.ok(existsSync(tree.path), "the folder of a kept tree is gone");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a closed thread whose child is still running is left alone, however spent its work is", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = closedThread(board, "dddd4444", "feat/dddd-work-dddd4444");
		git(repo, "merge", "--ff-only", "feat/dddd-work-dddd4444");
		// A child still holds the thread: its tree is where that child is writing, so a sweep stays away.
		board.children.set(thread.id, { stdin: { end() {} }, kill() {} });

		const res = scratchRes();
		await onCleanClosed(jsonRequest({}), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(said.removed, [], `the tree of a running child was retired: ${res.body}`);
		assert.equal(said.kept.length, 1, res.body);
		assert.match(said.kept[0].reason, /child is still running/, said.kept[0].reason);
		assert.equal(board.threads.has(thread.id), true);
		assert.ok(existsSync(tree.path), "the folder of a running child is gone");
		assert.equal(hasBranch(repo, "feat/dddd-work-dddd4444"), true);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a closed thread whose tree holds only ignored files goes, and the answer names them", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = closedThread(board, "1f1f0001", "feat/ignored-work-1f1f0001");
		// An ignored folder is something `git worktree remove` deletes without asking and no diff can show, so
		// the answer has to name it: nothing else on the board says it went.
		writeFileSync(join(tree.path, ".gitignore"), "node_modules/\n");
		git(tree.path, "add", ".gitignore");
		git(tree.path, "commit", "-m", "ignore the installed deps");
		mkdirSync(join(tree.path, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(tree.path, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
		git(repo, "merge", "--ff-only", "feat/ignored-work-1f1f0001");

		const res = scratchRes();
		await onCleanClosed(jsonRequest({}), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(said.kept, [], `nothing was expected to stay: ${res.body}`);
		assert.equal(said.removed.length, 1, res.body);
		assert.equal(said.removed[0].id, thread.id);
		assert.ok(said.removed[0].ignoredPaths > 0, `the answer does not name the ignored files that went: ${res.body}`);
		assert.equal(existsSync(tree.path), false, "the folder is still on disk");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a closed thread that owns cards goes, and the answer carries how many went with it", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread } = closedThread(board, "2a2a0002", "feat/owned-work-2a2a0002");
		// A thread closed while it owns cards is only hidden, so its cards are still on the board and still
		// readable. The removal deletes them, and the answer has to say how many went with the thread.
		for (const id of ["card-one", "card-two"]) board.cards.set(id, { id, title: id, ownerThread: thread.id });
		git(repo, "merge", "--ff-only", "feat/owned-work-2a2a0002");

		const res = scratchRes();
		await onCleanClosed(jsonRequest({}), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(said.kept, [], `nothing was expected to stay: ${res.body}`);
		assert.equal(said.removed.length, 1, res.body);
		assert.equal(said.removed[0].cards, 2, `the answer does not say the cards went with the thread: ${res.body}`);
		assert.equal(board.cards.size, 0, "a card of the removed thread is still on the board");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a closed thread that never had a tree is simply dropped", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const thread: any = { id: "eeee5555", title: "a thread eeee5555", folder: repo, at: Date.now(), turns: [], status: "idle", hidden: true, closedAt: Date.now() };
		board.threads.set(thread.id, thread);

		const res = scratchRes();
		await onCleanClosed(jsonRequest({}), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(said.kept, [], res.body);
		assert.equal(said.removed.length, 1);
		assert.equal(said.removed[0].path, null);
		assert.equal(board.threads.has(thread.id), false, "a thread with nothing to retire stayed on the board");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("collect refuses a thread whose own card is in the closed list", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		// A thread whose own card the human closed while it still owned cards is hidden, closed and still
		// running: the thread that would come back from this clean is the one asking for it.
		const { thread, tree } = treeThread(board, "ffff6666", "feat/ffff-work-ffff6666");
		thread.hidden = true;
		thread.closedAt = Date.now();

		const caller: any = { human: false, board, thread };
		const res = scratchRes();
		await onThreadCollect(jsonRequest({}), res, board, caller);
		assert.equal(res.status, 409, res.body);
		assert.match(res.body, /a thread cannot clean its own card/, res.body);
		assert.equal(board.threads.has(thread.id), true, "a refused collect removed the thread anyway");
		assert.ok(existsSync(tree.path), "a refused collect removed the folder anyway");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("collect frees the caller's own spent children and leaves everyone else's alone", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		// The boss works on a branch of its own and never merges into dev, which is the shape that made a
		// cherry-picked child read as unmerged for ever.
		const boss = treeThread(board, "1a1a7777", "feat/boss-work");
		// A child of the boss, whose commit the boss cherry-picked onto its own branch.
		const mine = closedThread(board, "2b2b8888", "feat/child-work-2b2b8888", { parentThread: boss.thread.id });
		git(boss.tree.path, "cherry-pick", git(mine.tree.path, "rev-parse", "HEAD"));
		// A second child of the boss, whose commit is nowhere but its own branch.
		const unmerged = closedThread(board, "3c3c9999", "feat/child-two-3c3c9999", { parentThread: boss.thread.id });
		// A closed child of another thread, which this collect must not touch.
		const other = closedThread(board, "4d4daaaa", "feat/other-work-4d4daaaa", { parentThread: "someone-else" });

		const caller: any = { human: false, board, thread: boss.thread };
		const res = scratchRes();
		await onThreadCollect(jsonRequest({}), res, board, caller);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(said.removed.map((entry: any) => entry.id), [mine.thread.id], `only the cherry-picked child was expected to go: ${res.body}`);
		assert.match(said.removed[0].note ?? "", /feat\/boss-work/, `the proof does not name the caller's branch: ${said.removed[0].note}`);
		assert.deepEqual(said.kept.map((entry: any) => entry.id), [unmerged.thread.id], res.body);
		assert.match(said.kept[0].reason, /commit/, said.kept[0].reason);

		assert.equal(board.threads.has(mine.thread.id), false, "the cherry-picked child stayed on the board");
		assert.equal(existsSync(mine.tree.path), false, "the folder of the collected child is still there");
		assert.equal(hasBranch(repo, "feat/child-work-2b2b8888"), false, "the branch of the collected child is still there");
		assert.equal(board.threads.has(unmerged.thread.id), true, "a kept child lost its row");
		assert.ok(existsSync(unmerged.tree.path), "a kept child lost its folder");
		assert.equal(board.threads.has(other.thread.id), true, "another thread's child was collected");
		assert.ok(existsSync(other.tree.path), "another thread's child lost its folder");
		assert.equal(hasBranch(repo, "feat/boss-work"), true, "the caller's own branch was deleted");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
