import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { cleanBoard, sweepTrees } from "../server/cards.ts";
import { closeThread, onClose, onUndo } from "../server/routes/board/lifecycle.ts";
import { ensureWorktree } from "../server/worktrees/make.ts";

const git = (folder: string, ...args: string[]) =>
	execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A throwaway repository with one commit on `dev`. Never the human's. */
function scratchRepo() {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-sweep-"));
	git(folder, "init", "-b", "dev");
	git(folder, "config", "user.email", "test@example.invalid");
	git(folder, "config", "user.name", "test");
	writeFileSync(join(folder, "readme.md"), "hello\n");
	git(folder, "add", ".");
	git(folder, "commit", "-m", "first");
	return folder;
}

/** A board no file backs, so nothing a sweep writes has a place to land. */
function scratchBoard(repo: string) {
	return {
		id: "scratch",
		folder: repo,
		name: "scratch",
		children: new Map(),
		threads: new Map(),
		cards: new Map(),
		activity: [],
		askers: new Map(),
		trees: [] as any[],
		trash: [],
		saveTimer: null as any,
		// No tab is listening: a route's broadcast goes to nobody rather than to undefined.
		clients: new Set(),
	};
}

/** A response a route can answer on, holding what it said so a test can read the status back. */
function scratchRes() {
	const res: { status: number; body: string; writeHead: (status: number) => void; end: (body: string) => void } = {
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

/** A request carrying the JSON body a route reads, as the wire would hand it over. */
const jsonRequest = (body: unknown) => Readable.from([Buffer.from(JSON.stringify(body))]);

/** The save a sweep schedules is dropped: this board is a literal, not a folder of JSON. */
function unschedule(board: { saveTimer: any }) {
	if (board.saveTimer) clearTimeout(board.saveTimer);
	board.saveTimer = null;
}

/** A thread working in its own tree, with a commit of its own on a branch of its own. */
function treeWithBranch(board: any, id: string, branch: string) {
	const thread = { id, title: `a thread ${id}`, folder: board.folder };
	const tree = ensureWorktree(board, thread);
	assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
	git(tree.path, "checkout", "-b", branch);
	writeFileSync(join(tree.path, `${id}.md`), `${id}\n`);
	git(tree.path, "add", ".");
	git(tree.path, "commit", "-m", `${id} work`);
	tree.branch = branch;
	return { thread, tree };
}

test("a fresh tree for one thread leaves a worktree a human moved by hand registered", () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const gone = { id: "stale-1", title: "a thread stale-1", folder: repo };
		const hand = { id: "moved-by-hand-2", title: "a thread moved-by-hand-2", folder: repo };
		const stale = ensureWorktree(board, gone);
		const moved = ensureWorktree(board, hand);
		assert.ok(stale.path, `no worktree made: ${JSON.stringify(stale)}`);
		assert.ok(moved.path, `no worktree made: ${JSON.stringify(moved)}`);
		// One folder deleted by hand, the other moved by hand. The move leaves git's registration naming
		// the path the tree came from, and that registration is the only thing keeping its commit reachable.
		rmSync(stale.path, { recursive: true, force: true });
		const elsewhere = join(dirname(moved.path), "moved-by-hand");
		execFileSync("mv", [moved.path, elsewhere]);

		// The thread whose folder is gone asks for its tree again, at that same path.
		const fresh = ensureWorktree(board, gone);
		assert.equal(fresh.skipped, undefined, `the tree could not be made: ${fresh.skipped}`);
		assert.ok(existsSync(fresh.path), "no fresh tree was made");

		// The moved tree is still a git worktree standing where the human put it, and git still holds the
		// registration of it that makes the commit it stands on reachable.
		assert.ok(git(elsewhere, "rev-parse", "--show-toplevel").endsWith("/moved-by-hand"), "the moved tree is no git worktree any more");
		assert.match(git(elsewhere, "rev-parse", "HEAD"), /^[0-9a-f]{40}$/, "the commit the moved tree stands on could not be read");
		const listed = git(repo, "worktree", "list", "--porcelain")
			.split("\n")
			.filter((line) => line.startsWith("worktree "));
		assert.ok(listed.includes(`worktree ${moved.path}`), `the moved tree lost its registration:\n${listed.join("\n")}`);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});


test("a tree whose thread is still on the board is left alone", () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = treeWithBranch(board, "live-1", "feat/live");
		board.threads.set(thread.id, { id: thread.id, title: thread.title, at: Date.now(), turns: [], status: "idle" });
		// Merged and clean, so the only thing standing between it and the sweep is the live thread.
		git(repo, "merge", "--no-ff", "-m", "merge feat/live", "feat/live");

		assert.deepEqual(sweepTrees(board), []);
		assert.ok(existsSync(tree.path), "a live thread's tree was retired out from under it");
		assert.equal(board.trees.length, 1);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a tree whose record lost its thread is left alone while a live thread works in it", () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = treeWithBranch(board, "live-2", "feat/live-2");
		// A saved record can lose the field that names its thread; the loader takes it and still links it
		// to the restored thread, so the thread's own worktree is what the sweep has to trust.
		delete (tree as any).thread;
		board.threads.set(thread.id, { ...thread, worktree: tree, at: Date.now(), turns: [], status: "idle" });
		// Merged and clean, so nothing but the live thread stands between it and the sweep.
		git(repo, "merge", "--no-ff", "-m", "merge feat/live-2", "feat/live-2");

		assert.deepEqual(sweepTrees(board), []);
		assert.ok(existsSync(tree.path), "a live thread's tree was retired out from under it");
		assert.equal(board.trees.length, 1, "the board forgot a tree a live thread is working in");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});


test("a tree whose thread is gone and whose branch is merged is retired", () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = treeWithBranch(board, "merged-1", "feat/merged");
		board.threads.set(thread.id, { id: thread.id, title: thread.title, at: Date.now(), turns: [], status: "idle" });
		// The work is in `dev` through a merge commit, so nothing of it lives only in this tree.
		git(repo, "merge", "--no-ff", "-m", "merge feat/merged", "feat/merged");
		board.threads.delete(thread.id);

		const swept = sweepTrees(board);
		assert.equal(swept.length, 1, `no tree reported: ${JSON.stringify(swept)}`);
		assert.equal(swept[0].removed, true, `the merged tree was kept: ${JSON.stringify(swept[0])}`);
		assert.equal(existsSync(tree.path), false, "the folder is still on disk");
		assert.equal(board.trees.length, 0, "the board still holds the tree it retired");
		assert.equal(git(repo, "branch", "--list", "feat/merged"), "", "the merged branch outlived its tree");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a tree with an unmerged commit is kept, and says why", () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = treeWithBranch(board, "unmerged-1", "feat/unmerged");
		board.threads.set(thread.id, { id: thread.id, title: thread.title, at: Date.now(), turns: [], status: "idle" });
		board.threads.delete(thread.id);

		const swept = sweepTrees(board);
		assert.equal(swept.length, 1);
		assert.equal(swept[0].removed, undefined, `unmerged work was removed: ${JSON.stringify(swept[0])}`);
		assert.match(String(swept[0].kept), /1 commit\(s\) not in dev/);
		assert.ok(existsSync(tree.path), "a tree holding unmerged work was deleted");
		assert.equal(board.trees.length, 1);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a thread closed while its tree is on a branch the record does not name keeps the tree, named", () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const thread = { id: "moved-1", title: "a thread moved-1", folder: repo, at: Date.now(), turns: [], status: "running" };
		const tree = ensureWorktree(board, thread);
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		// The first branch the child cut, merged into `dev` while the thread was still running.
		git(tree.path, "checkout", "-b", "feat/first");
		writeFileSync(join(tree.path, "first.md"), "first\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "feat: first work");
		git(repo, "merge", "--no-ff", "-m", "merge feat/first", "feat/first");
		// The branch the child moved to next, which nothing but the tree knows about.
		git(tree.path, "checkout", "-b", "fix/second");
		writeFileSync(join(tree.path, "second.md"), "second\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "fix: second work");
		// What the record said when `agent_settled` last ran: the merged branch, not this one.
		tree.branch = "feat/first";
		board.threads.set(thread.id, { ...thread });

		closeThread(board, thread);

		assert.ok(existsSync(tree.path), "the tree holding the child's branch was removed");
		assert.equal(board.trees.length, 1, "the board forgot a tree it kept");
		assert.equal(board.trees[0].branch, "fix/second", `the record names ${board.trees[0].branch}`);
		assert.notEqual(git(repo, "branch", "--list", "fix/second"), "", "the branch the work is on was deleted");
		unschedule(board);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});


test("a thread whose tree folder is gone comes back from undo with no worktree record", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const thread = { id: "gone-1", title: "a thread gone-1", at: Date.now(), turns: [], status: "idle" };
		const tree = ensureWorktree(board, thread);
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		git(tree.path, "checkout", "-b", "feat/gone");
		writeFileSync(join(tree.path, "gone.md"), "gone\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "feat: gone work");
		tree.branch = "feat/gone";
		board.threads.set(thread.id, thread);
		// The folder is deleted by hand, so the record the close puts in the trash points at nothing.
		rmSync(tree.path, { recursive: true, force: true });

		const closed = scratchRes();
		await onClose(jsonRequest({ cardId: thread.id }), closed, board, { human: true });
		assert.equal(closed.status, 200, `the close was refused: ${closed.body}`);
		assert.equal(board.threads.has(thread.id), false, "the closed thread is still on the board");
		assert.equal(board.trash.length, 1, `nothing was remembered for undo: ${JSON.stringify(board.trash)}`);

		const undone = scratchRes();
		await onUndo({ resume() {} }, undone, board);
		assert.equal(undone.status, 200, `the undo was refused: ${undone.body}`);
		const back = board.threads.get(thread.id);
		assert.ok(back, "the closed thread did not come back");
		assert.equal(back.worktree, undefined, `the restored thread still points at ${JSON.stringify(back.worktree)}`);
		unschedule(board);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});


test("clean still answers with the same three fields, and sweeps a dead thread's tree", () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = treeWithBranch(board, "dead-1", "feat/dead");
		git(repo, "merge", "--no-ff", "-m", "merge feat/dead", "feat/dead");
		board.threads.set(thread.id, { id: thread.id, title: thread.title, at: Date.now(), turns: [], status: "dead" });

		const result = cleanBoard(board);
		assert.deepEqual(Object.keys(result).sort(), ["removed", "rows", "trees"]);
		assert.deepEqual(result.removed, [thread.id]);
		assert.equal(result.rows, 0);
		assert.equal(result.trees.length, 1, `the dead thread's tree was not swept: ${JSON.stringify(result.trees)}`);
		assert.equal(result.trees[0].removed, true);
		assert.equal(existsSync(tree.path), false);
		unschedule(board);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
