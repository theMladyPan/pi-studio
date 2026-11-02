import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitGraph } from "../server/git/graph.ts";
import { refName } from "../server/git/graph.ts";
import { repoOf } from "../server/git/repo.ts";
import { ensureWorktree, slugOf, workType } from "../server/worktrees/make.ts";
import { retireWorktree, sameFolder } from "../server/worktrees/retire.ts";

const git = (folder: string, ...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();

/** A throwaway repository with one commit on `dev`. Never the human's. */
function scratchRepo() {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-git-"));
	git(folder, "init", "-b", "dev");
	git(folder, "config", "user.email", "test@example.invalid");
	git(folder, "config", "user.name", "test");
	writeFileSync(join(folder, "readme.md"), "hello\n");
	git(folder, "add", ".");
	git(folder, "commit", "-m", "first");
	return folder;
}

test("a ref is shortened to the name a human uses, and told apart by kind", () => {
	assert.deepEqual(refName("HEAD -> dev", []), { name: "dev", kind: "head" });
	assert.deepEqual(refName("HEAD", []), { name: "HEAD", kind: "head" });
	assert.deepEqual(refName("tag: v1", []), { name: "v1", kind: "tag" });
	assert.deepEqual(refName("origin/main", ["origin"]), { name: "origin/main", kind: "remote" });
	assert.deepEqual(refName("feature", []), { name: "feature", kind: "branch" });
});

test("a remote branch is drawn with its remote's name", () => {
	// The pill is what a human reads, so it says where the branch came from rather than a ref path.
	assert.deepEqual(refName("origin/dev", ["origin", "fork"]), { name: "origin/dev", kind: "remote" });
});

test("the repository is found from a folder inside it", () => {
	const repo = scratchRepo();
	try {
		mkdirSync(join(repo, "deep", "deeper"), { recursive: true });
		assert.equal(repoOf(join(repo, "deep", "deeper")), repo);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("the graph is one row per commit, newest first, with the refs as pills", () => {
	const repo = scratchRepo();
	try {
		const graph = gitGraph(repo, []);
		assert.equal(graph.length, 1);
		assert.match(graph[0].hash, /^[0-9a-f]{40}$/);
		assert.equal(graph[0].subject, "first");
		assert.deepEqual(graph[0].parents, []);
		assert.deepEqual(graph[0].refs, [{ name: "dev", kind: "head" }]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a folder that is not a repository has no graph to draw", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-nograph-"));
	try {
		assert.deepEqual(gitGraph(folder, []), []);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a worktree is made for a thread and retired again", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), trees: [] };
		const thread = { id: "thread-1", title: "a thread", folder: repo };
		const tree = ensureWorktree(board, thread);
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		assert.equal(tree.skipped, undefined);
		assert.ok(existsSync(tree.path));
		assert.equal(tree.repo, repo);

		const again = ensureWorktree(board, thread);
		assert.equal(again.path, tree.path, "a second call made a second tree");

		const retired = retireWorktree(board, tree);
		assert.ok(retired?.removed !== false, `retire refused: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a folder that is not a repository is skipped rather than made into one", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-norepo-"));
	try {
		const board = { folder, name: "plain", children: new Map(), trees: [] };
		const tree = ensureWorktree(board, { id: "t", title: "x", folder });
		assert.ok(tree.skipped, "a folder without git should say so");
		assert.equal(tree.path, undefined);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a branch name is a slug a human would type", () => {
	assert.equal(slugOf("Fix the parser, now!"), "fix-the-parser-now");
	assert.equal(slugOf("   "), "work", "an empty title still has to name a folder");
	assert.equal(workType("a new feature", undefined), "feat");
	assert.equal(workType("fix the bug", undefined), "fix");
	assert.equal(workType("anything", "chore"), "chore");
});

test("two paths are the same folder even through a symlink", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-same-"));
	try {
		assert.equal(sameFolder(folder, folder), true);
		assert.equal(sameFolder(folder, join(folder, "nope")), false);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

const childBranch = "feat/child";

/**
 * A made tree standing on a branch of its own with one commit, and the board that owns its record. The
 * tree is made for a child spawned from a thread that already has one, which is the case that made the
 * sweep blind: the child's base is the parent's HEAD commit id, and a commit id never moves with dev.
 * The board learns the branch from the tree after a run settles; the sweep takes it from `tree.branch`.
 */
function treeWithChildCommit(repo: string) {
	const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] };
	const parent = { id: "thread-parent-1", title: "the parent", folder: repo };
	board.threads.set(parent.id, parent);
	const parentTree = ensureWorktree(board, parent);
	assert.ok(parentTree.path, `no parent worktree made: ${JSON.stringify(parentTree)}`);
	git(parentTree.path, "checkout", "-b", "feat/parent");
	writeFileSync(join(parentTree.path, "parent.txt"), "parent\n");
	git(parentTree.path, "add", ".");
	git(parentTree.path, "commit", "-m", "parent work");
	const tree = ensureWorktree(board, { id: "thread-child-1", title: "a child change", folder: repo, parentThread: parent.id });
	assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
	assert.match(tree.base, /^[0-9a-f]{40}$/, `the child should be cut from a commit id: ${tree.base}`);
	git(tree.path, "checkout", "-b", childBranch);
	writeFileSync(join(tree.path, "child.txt"), "child\n");
	git(tree.path, "add", ".");
	git(tree.path, "commit", "-m", "child change");
	tree.branch = childBranch;
	return { board, tree };
}

/** A commit on dev in the main checkout, so the child's branch has to be carried onto a dev that moved. */
function commitDev(repo: string) {
	writeFileSync(join(repo, "dev.txt"), "dev\n");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "dev moves on");
}

test("a branch merged into dev is spent, so its tree goes", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--no-ff", childBranch, "-m", "merge the child");
		const retired = retireWorktree(board, tree);
		assert.equal(retired.removed, true, `the merged tree was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
		assert.ok(!git(repo, "branch", "--list", childBranch).includes(childBranch), "the merged branch is still there");
		assert.equal(board.trees.some((record: any) => record.path === tree.path), false, "the record outlived the tree");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch fast-forwarded into dev is spent, so its tree goes", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--ff-only", childBranch);
		const retired = retireWorktree(board, tree);
		assert.equal(retired.removed, true, `the fast-forwarded tree was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", childBranch), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch dev was rebased onto is spent, so its tree goes", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		commitDev(repo);
		// The board's own strategy: dev's commits are replayed on top of the child's branch, which leaves
		// the branch inside dev under the same ids.
		git(repo, "rebase", childBranch);
		const retired = retireWorktree(board, tree);
		assert.equal(retired.removed, true, `the rebased tree was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", childBranch), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch cherry-picked onto a dev that moved on is spent, so its tree goes", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		// The parent's own work goes into dev too, so the child's branch carries nothing else unmerged.
		git(repo, "merge", "--no-ff", "feat/parent", "-m", "merge the parent");
		commitDev(repo);
		// Different commit id, same patch: only git cherry can see that the work already arrived.
		git(repo, "cherry-pick", git(repo, "rev-parse", childBranch));
		assert.notEqual(git(repo, "rev-parse", childBranch), git(repo, "rev-parse", "dev"), "the ids should differ");
		const retired = retireWorktree(board, tree);
		assert.equal(retired.removed, true, `the cherry-picked tree was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", childBranch), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch squashed into one commit on dev is kept, because no proof covers it", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		// Two commits, so the squash's single patch is equivalent to neither of them and no proof holds.
		writeFileSync(join(tree.path, "child2.txt"), "child two\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "child change, second half");
		commitDev(repo);
		git(repo, "merge", "--squash", childBranch);
		git(repo, "commit", "-m", "the child, squashed");
		const retired = retireWorktree(board, tree);
		assert.equal(retired.removed, undefined, `a squashed branch was removed: ${JSON.stringify(retired)}`);
		assert.equal(retired.kept, "2 commit(s) not in dev");
		assert.ok(existsSync(tree.path));
		assert.ok(git(repo, "branch", "--list", childBranch).includes(childBranch), "the squash lost the branch");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch with an unmerged commit is kept, and the reason names dev", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		const retired = retireWorktree(board, tree);
		assert.equal(retired.removed, undefined, `an unmerged branch was removed: ${JSON.stringify(retired)}`);
		assert.match(retired.kept, /commit/, `the reason says nothing about commits: ${retired.kept}`);
		assert.match(retired.kept, /dev/, `the reason does not name dev: ${retired.kept}`);
		assert.ok(existsSync(tree.path));
		// A branch checked out in the tree is listed with a `+` in front, so only the name is asked for.
		assert.ok(git(repo, "branch", "--list", childBranch).includes(childBranch), "the kept branch is gone");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch another local branch holds, with dev untouched, is spent", () => {
	const repo = scratchRepo();
	const side = mkdtempSync(join(tmpdir(), "pi-studio-side-"));
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "worktree", "add", "-b", "side", side, "dev");
		git(side, "merge", "--no-ff", childBranch, "-m", "merge the child into side");
		const retired = retireWorktree(board, tree);
		assert.equal(retired.removed, true, `a branch held by side was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", childBranch), "");
		assert.notEqual(git(repo, "branch", "--list", "side"), "", "dev was not supposed to move");
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(side, { recursive: true, force: true });
	}
});

test("a tree with an uncommitted edit is kept, and the reason says so", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--no-ff", childBranch, "-m", "merge the child");
		writeFileSync(join(tree.path, "half-done.txt"), "half\n");
		const retired = retireWorktree(board, tree);
		assert.equal(retired.removed, undefined, `a dirty tree was removed: ${JSON.stringify(retired)}`);
		assert.match(retired.kept, /uncommitted change/, `the reason does not name the edit: ${retired.kept}`);
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a detached tree whose commit a local branch holds is spent, one whose commit is in no branch is not", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), trees: [] };
		const tree = ensureWorktree(board, { id: "thread-detached-1", title: "no branch", folder: repo });
		writeFileSync(join(tree.path, "loose.txt"), "loose\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "a commit without a branch");
		assert.equal(retireWorktree(board, tree).kept, "1 commit(s) not in dev");
		git(repo, "branch", "somewhere", git(tree.path, "rev-parse", "HEAD"));
		const retired = retireWorktree(board, tree);
		assert.equal(retired.removed, true, `a detached tree a branch holds was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
