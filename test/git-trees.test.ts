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
import { git, scratchRepo, childBranch, treeWithChildCommit, commitIn, unreachable } from "../test-support/git.ts";

test("a tag named like the base branch does not stand in for it", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] };
		const tree = ensureWorktree(board, { id: "thread-tagged-dev", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		assert.equal(tree.base, "dev");
		git(tree.path, "checkout", "-b", "feat/tagged");
		writeFileSync(join(tree.path, "tagged.txt"), "tagged\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "work dev never got");
		tree.branch = "feat/tagged";
		// A tag `dev` on the branch's tip makes a bare `dev` mean the branch itself to git cherry and rev-list.
		git(repo, "tag", "dev", "refs/heads/feat/tagged");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a tag named dev let the branch go: ${JSON.stringify(retired)}`);
		assert.equal(retired.kept, "1 commit(s) not in dev");
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a tree whose recorded branch was renamed is kept, and the reason names the branch it is on", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(tree.path, "branch", "-m", childBranch, "feat/renamed");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a renamed branch's tree was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /feat\/renamed/, `the reason does not name the branch: ${retired.kept}`);
		assert.ok(existsSync(tree.path));
		assert.ok(board.trees.some((record: any) => record.path === tree.path), "the record went while the tree stayed");
		assert.ok(git(repo, "branch", "--list", "feat/renamed").includes("feat/renamed"), "the renamed branch is gone");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a merged tree with ignored files is removed, and the entry counts them", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--no-ff", childBranch, "-m", "merge the child");
		writeFileSync(join(repo, ".git", "info", "exclude"), "*.log\n");
		writeFileSync(join(tree.path, "one.log"), "one\n");
		writeFileSync(join(tree.path, "two.log"), "two\n");
		assert.equal(git(tree.path, "status", "--porcelain"), "", "ignored files should not read as changes");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, true, `ignored files kept the tree: ${JSON.stringify(retired)}`);
		assert.ok("ignoredPaths" in retired, `the entry does not count the ignored files: ${JSON.stringify(retired)}`);
		assert.equal(retired.ignoredPaths, 2);
		assert.equal(existsSync(tree.path), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a detached tree whose folder is gone drops its record", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] };
		const tree = ensureWorktree(board, { id: "thread-detached-gone", title: "no branch", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		rmSync(tree.path, { recursive: true, force: true });
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, true, `a vanished detached tree was kept: ${JSON.stringify(retired)}`);
		assert.match(String(retired.note), /folder/);
		assert.equal(board.trees.length, 0, "the record of a vanished tree stayed");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a thread whose tree was deleted by hand gets a fresh one, and the stale record goes", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const thread = { id: "thread-restored-1", title: "a restored thread", folder: repo };
		const stale = ensureWorktree(board, thread);
		assert.ok(stale.path, `no worktree made: ${JSON.stringify(stale)}`);
		rmSync(stale.path, { recursive: true, force: true });
		const fresh = ensureWorktree(board, thread);
		assert.notEqual(fresh, stale, "the stale record came back");
		assert.ok(fresh.path, `no fresh worktree made: ${JSON.stringify(fresh)}`);
		assert.ok(existsSync(fresh.path), "the fresh tree is not on disk");
		assert.equal(board.trees.includes(stale), false, "the stale record is still on the board");
		assert.deepEqual(board.trees, [fresh]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a record naming a merged branch while the tree holds an unmerged commit is kept, and the commit stays reachable", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-stale-record-1", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		git(tree.path, "checkout", "-q", "-b", "feat/cln1");
		commitIn(tree.path, "cln1.txt", "work that was merged");
		tree.branch = "feat/cln1";
		git(repo, "merge", "--no-ff", "feat/cln1", "-m", "merge feat/cln1");
		// The tree lets go of the merged branch and goes on committing: the record still names feat/cln1.
		git(tree.path, "checkout", "-q", "--detach");
		commitIn(tree.path, "later.txt", "work after the merge");
		const head = git(tree.path, "rev-parse", "HEAD");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.ok(!git(repo, "fsck", "--unreachable", "--no-progress").includes(head), `the tree's commit ${head} became unreachable`);
		assert.equal(retired.removed, undefined, `a tree holding an unmerged commit was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /feat\/cln1/, `the reason does not name the recorded branch: ${retired.kept}`);
		assert.ok(existsSync(tree.path), "the folder holding the commit is gone");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a record naming a merged branch while the tree is detached on its base and has committed is kept", () => {
	const repo = scratchRepo();
	try {
		git(repo, "checkout", "-q", "-b", "feat/merged");
		commitIn(repo, "merged.txt", "work that was merged");
		git(repo, "checkout", "-q", "dev");
		git(repo, "merge", "--no-ff", "feat/merged", "-m", "merge feat/merged");
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-stale-record-2", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		commitIn(tree.path, "loose.txt", "a commit without a branch");
		tree.branch = "feat/merged";
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a detached tree with a commit was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /1 commit\(s\) not in dev/, `the reason does not name the count: ${retired.kept}`);
		assert.match(String(retired.kept), /feat\/merged/, `the reason does not name the recorded branch: ${retired.kept}`);
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a spawned branch standing on its base, held by no other ref, is kept with the parent's commit", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const parent = { id: "thread-parent-2", title: "the parent", folder: repo };
		board.threads.set(parent.id, parent);
		const parentTree = ensureWorktree(board, parent);
		assert.ok(parentTree.path, `no parent worktree made: ${JSON.stringify(parentTree)}`);
		git(parentTree.path, "checkout", "-q", "-b", "feat/parent");
		commitIn(parentTree.path, "parent.txt", "parent work");
		const parentCommit = git(parentTree.path, "rev-parse", "HEAD");
		const tree = ensureWorktree(board, { id: "thread-child-2", title: "a child change", folder: repo, parentThread: parent.id });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		assert.equal(tree.base, parentCommit);
		git(tree.path, "checkout", "-q", "-b", childBranch);
		tree.branch = childBranch;
		// The parent's tree and branch go, so the child's branch is the only ref naming the parent's commit.
		git(repo, "worktree", "remove", parentTree.path);
		git(repo, "branch", "-D", "feat/parent");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.notEqual(git(repo, "for-each-ref", "--contains", parentCommit, "--format=%(refname)"), "", "no ref names the parent's commit");
		assert.equal(retired.removed, undefined, `the only ref naming a commit was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /\b0 commit/, `the reason does not name the count: ${retired.kept}`);
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("an empty branch dev already contains is spent, so its tree goes", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-empty-1", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		git(tree.path, "checkout", "-q", "-b", "feat/empty");
		tree.branch = "feat/empty";
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, true, `an empty branch dev holds was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", "feat/empty"), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
