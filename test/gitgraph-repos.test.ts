import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reposFor } from "../server/git/gitgraph/repos.ts";
import type { RepoBoardLike } from "../server/git/gitgraph/repos.ts";
import { childBranch, scratchRepo, treeWithChildCommit } from "../test-support/git.ts";

/** A board as `reposFor` reads one: the folder, its trees, the threads that own them and the children. */
function boardOf(folder: string): RepoBoardLike {
	return { folder, trees: [], threads: new Map(), children: new Map() };
}

test("the workspace folder comes first, and the trees made from it after it", async () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		// A board knows the thread that owns each tree; `treeWithChildCommit` only files the parent's.
		board.threads.set("thread-child-1", { id: "thread-child-1", title: "a child change" });
		const repos = await reposFor(board as unknown as RepoBoardLike);
		const paths = [...repos.keys()];
		assert.equal(paths[0], realpathSync(repo), "the folder the workspace opened is the first repository");
		assert.equal(paths.length, 3, `expected the folder and two trees, got ${paths.join(", ")}`);
		const folder = repos.get(realpathSync(repo));
		assert.equal(folder?.kind, "folder");
		assert.equal(folder?.live, false);
		assert.equal(folder?.label, repo.split("/").pop());
		const child = repos.get(realpathSync(tree.path));
		assert.equal(child?.kind, "tree");
		assert.equal(child?.threadId, "thread-child-1");
		// The branch the tree stands on, then the thread's title, which is what the dropdown shows.
		assert.equal(child?.label, `${childBranch} · a child change`);
		assert.equal(child?.branch, childBranch);
		const parent = [...repos.values()].find((entry) => entry.threadId === "thread-parent-1");
		assert.equal(parent?.label, "feat/parent · the parent", "a tree with no branch on its record reads its own HEAD");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a tree whose thread has a child running is the live one", async () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		assert.equal((await reposFor(board as unknown as RepoBoardLike)).get(realpathSync(tree.path))?.live, false);
		(board.children as Map<string, unknown>).set("thread-child-1", { id: "child" });
		const repos = await reposFor(board as unknown as RepoBoardLike);
		assert.equal(repos.get(realpathSync(tree.path))?.live, true);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a tree that is no longer on disk is not offered", async () => {
	const repo = scratchRepo();
	try {
		const board = boardOf(repo);
		board.trees.push({ path: join(repo, ".agents", "gone"), thread: "thread-gone" });
		board.threads.set("thread-gone", { id: "thread-gone", title: "a thread whose tree was deleted" });
		const repos = await reposFor(board);
		assert.deepEqual([...repos.keys()], [realpathSync(repo)]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a record pointing at somebody else's repository is refused", async () => {
	const repo = scratchRepo();
	const foreign = scratchRepo();
	try {
		const board = boardOf(repo);
		board.trees.push({ path: foreign, thread: "thread-foreign" });
		board.threads.set("thread-foreign", { id: "thread-foreign", title: "not ours" });
		const repos = await reposFor(board);
		assert.deepEqual([...repos.keys()], [realpathSync(repo)], "a foreign checkout must never reach the dropdown");
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(foreign, { recursive: true, force: true });
	}
});

test("a record pointing at a subfolder of the checkout is not a repository of its own", async () => {
	const repo = scratchRepo();
	try {
		mkdirSync(join(repo, "src", "deep"), { recursive: true });
		const board = boardOf(repo);
		board.trees.push({ path: join(repo, "src", "deep"), thread: "thread-inside" });
		const repos = await reposFor(board);
		assert.deepEqual([...repos.keys()], [realpathSync(repo)]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("two records for one checkout are one entry", async () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		const asRead = board as unknown as RepoBoardLike;
		asRead.trees.push({ ...tree });
		const repos = await reposFor(asRead);
		assert.equal([...repos.keys()].filter((path) => path === realpathSync(tree.path)).length, 1);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a folder that is not a repository has nothing to show", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-repos-plain-"));
	try {
		const repos = await reposFor(boardOf(folder));
		assert.equal(repos.size, 0);
		const missing = await reposFor(boardOf(join(folder, "not-there")));
		assert.equal(missing.size, 0);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
