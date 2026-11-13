import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitGraph } from "../server/git/graph.ts";
import { refName } from "../server/git/graph.ts";
import { repoOf } from "../server/git/repo.ts";
import { ensureWorktree, slugOf, workType } from "../server/worktrees/make.ts";
import { retireWorktree, sameFolder } from "../server/worktrees/retire.ts";
import { git, scratchRepo, childBranch, treeWithChildCommit, commitDev } from "../test-support/git.ts";

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

test("a branch merged into dev is spent, so its tree goes", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--no-ff", childBranch, "-m", "merge the child");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
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
		assert.ok(retired, "the tree was not read at all");
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
		assert.ok(retired, "the tree was not read at all");
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
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, true, `the cherry-picked tree was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", childBranch), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch squashed into one commit on dev is spent, because dev already holds its content", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		// Two commits, so the squash's single patch is equivalent to neither of them: only the content
		// proof sees that merging the branch into dev would change nothing.
		writeFileSync(join(tree.path, "child2.txt"), "child two\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "child change, second half");
		commitDev(repo);
		git(repo, "merge", "--squash", childBranch);
		git(repo, "commit", "-m", "the child, squashed");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, true, `a squashed branch was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", childBranch), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch whose patch landed and was rewritten afterwards is spent, because the patch is the proof", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		// The parent's own work goes into dev too, so the child's branch carries nothing else unmerged.
		git(repo, "merge", "--no-ff", "feat/parent", "-m", "merge the parent");
		commitDev(repo);
		git(repo, "cherry-pick", git(repo, "rev-parse", childBranch));
		// Dev goes on working in the very file the copy landed in, so merging the branch now clashes and
		// the content proof can say nothing. The patch that arrived is still there to be matched.
		writeFileSync(join(repo, "child.txt"), "child, reworked on dev\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "rework the child's change");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, true, `a branch whose patch landed was kept: ${JSON.stringify(retired)}`);
		assert.match(String((retired as any).proof), /same patch/, `the proof is not the patch: ${(retired as any).proof}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", childBranch), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch whose work landed with a hand edit is kept, because no proof can see it", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--no-ff", "feat/parent", "-m", "merge the parent");
		commitDev(repo);
		// The copy arrived, but not as the patch the branch carries: nothing on disk can tell this apart
		// from work nobody has seen, so the tree stays and the human decides.
		git(repo, "cherry-pick", "--no-commit", git(repo, "rev-parse", childBranch));
		writeFileSync(join(repo, "child.txt"), "child, settled by hand\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "the child's work, resolved against dev");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a hand-edited landing was taken for a spent branch: ${JSON.stringify(retired)}`);
		assert.match(retired.kept, /commit/, `the reason says nothing about commits: ${retired.kept}`);
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
