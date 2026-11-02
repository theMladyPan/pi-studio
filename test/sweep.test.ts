import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanBoard, sweepTrees } from "../server/cards.ts";
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
	};
}

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
