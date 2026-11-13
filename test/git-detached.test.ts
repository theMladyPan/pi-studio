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
import { git, scratchRepo, childBranch, treeWithChildCommit, commitIn, unreachable, withLateCommit } from "../test-support/git.ts";

test("a tree standing on main in a repository that also has dev is kept, and main keeps its name", () => {
	const repo = scratchRepo();
	try {
		git(repo, "branch", "main");
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-on-main-1", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		git(tree.path, "checkout", "-q", "main");
		tree.branch = "main";
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.notEqual(git(repo, "branch", "--list", "main"), "", "main lost its name");
		assert.equal(retired.removed, undefined, `a tree standing on main was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /main/, `the reason does not name main: ${retired.kept}`);
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a tree standing on main in a repository with no dev and a detached main checkout is kept", () => {
	const repo = scratchRepo();
	try {
		git(repo, "branch", "-m", "dev", "main");
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-on-main-2", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		git(repo, "checkout", "-q", "--detach");
		git(tree.path, "checkout", "-q", "main");
		tree.branch = "main";
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.notEqual(git(repo, "branch", "--list", "main"), "", "main lost its name");
		assert.equal(retired.removed, undefined, `a tree standing on main was removed: ${JSON.stringify(retired)}`);
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a detached tree with a commit, whose folder was deleted by hand, is kept and its commit stays reachable", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-gone-detached-1", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		commitIn(tree.path, "loose.txt", "a commit without a branch");
		const head = git(tree.path, "rev-parse", "HEAD");
		rmSync(tree.path, { recursive: true, force: true });
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(unreachable(repo, head), false, `the tree's commit ${head} became unreachable`);
		assert.equal(retired.removed, undefined, `a vanished tree holding a commit was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /1 commit\(s\) not in dev/, `the reason does not name the commit: ${retired.kept}`);
		assert.ok(board.trees.includes(tree), "the record went while its commit is held by nothing else");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a detached tree with a commit, whose folder was deleted by hand and whose record names a merged branch, is kept", () => {
	const repo = scratchRepo();
	try {
		git(repo, "checkout", "-q", "-b", "feat/merged");
		commitIn(repo, "merged.txt", "work that was merged");
		git(repo, "checkout", "-q", "dev");
		git(repo, "merge", "--no-ff", "feat/merged", "-m", "merge feat/merged");
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-gone-detached-2", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		commitIn(tree.path, "loose.txt", "a commit without a branch");
		const head = git(tree.path, "rev-parse", "HEAD");
		tree.branch = "feat/merged";
		rmSync(tree.path, { recursive: true, force: true });
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(unreachable(repo, head), false, `the tree's commit ${head} became unreachable`);
		assert.equal(retired.removed, undefined, `a vanished tree holding a commit was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /feat\/merged/, `the reason does not name the recorded branch: ${retired.kept}`);
		assert.notEqual(git(repo, "branch", "--list", "feat/merged"), "", "the recorded branch was deleted");
		assert.ok(board.trees.includes(tree), "the record went while its commit is held by nothing else");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("somebody else's worktree moved by hand survives the sweep of a tree whose folder is gone", () => {
	const repo = scratchRepo();
	const elsewhere = mkdtempSync(join(tmpdir(), "pi-studio-moved-"));
	try {
		// A human's own worktree, committed in and then moved with `mv`: its registration still names the
		// old path, so git calls it prunable, and only the registration keeps its commit and its `.git` alive.
		const theirs = join(elsewhere, "theirs");
		const moved = join(elsewhere, "moved");
		git(repo, "worktree", "add", "-q", "--detach", theirs, "dev");
		commitIn(theirs, "theirs.txt", "the human's own work");
		const head = git(theirs, "rev-parse", "HEAD");
		renameSync(theirs, moved);
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-gone-3", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		rmSync(tree.path, { recursive: true, force: true });
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, true, `a vanished tree on dev was kept: ${JSON.stringify(retired)}`);
		assert.equal(unreachable(repo, head), false, `the moved tree's commit ${head} became unreachable`);
		assert.equal(git(moved, "rev-parse", "HEAD"), head, "the moved tree no longer reads its own HEAD");
		assert.equal(git(moved, "status", "--porcelain"), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test("a branch whose change dev holds in a different indentation is kept", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-makefile-1", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		git(tree.path, "checkout", "-q", "-b", "fix/mk");
		writeFileSync(join(tree.path, "Makefile"), "all:\n\techo hi\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "a Makefile with a tab");
		tree.branch = "fix/mk";
		// The same change on dev with spaces, which make refuses and git cherry cannot tell apart.
		writeFileSync(join(repo, "Makefile"), "all:\n    echo hi\n");
		git(repo, "add", "Makefile");
		git(repo, "commit", "-m", "a Makefile with spaces");
		assert.match(git(repo, "cherry", "dev", "fix/mk"), /^- /, "git cherry should take the two for one patch");
		const head = git(tree.path, "rev-parse", "HEAD");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a branch dev holds only in other whitespace was removed: ${JSON.stringify(retired)}`);
		assert.equal(retired.kept, "1 commit(s) not in dev");
		assert.ok(existsSync(tree.path));
		assert.equal(git(repo, "rev-parse", "refs/heads/fix/mk"), head);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a detached tree on a commit no branch holds any more is kept", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const parent = { id: "thread-parent-3", title: "the parent", folder: repo };
		board.threads.set(parent.id, parent);
		const parentTree = ensureWorktree(board, parent);
		assert.ok(parentTree.path, `no parent worktree made: ${JSON.stringify(parentTree)}`);
		git(parentTree.path, "checkout", "-q", "-b", "feat/parent");
		commitIn(parentTree.path, "parent.txt", "parent work");
		const tree = ensureWorktree(board, { id: "thread-child-3", title: "a child change", folder: repo, parentThread: parent.id });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		const head = git(tree.path, "rev-parse", "HEAD");
		assert.equal(tree.base, head);
		// The parent amends its commit away, so only the child's detached HEAD still names the old one,
		// and the child has nothing past its base for a count to see.
		git(parentTree.path, "commit", "-q", "--amend", "-m", "parent work, amended");
		assert.equal(git(repo, "for-each-ref", "--contains", head, "refs/heads"), "");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(unreachable(repo, head), false, `the commit ${head} became unreachable`);
		assert.equal(retired.removed, undefined, `a detached tree on a commit no branch holds was removed: ${JSON.stringify(retired)}`);
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a commit landing after the proof and before the removal keeps the tree", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--no-ff", childBranch, "-m", "merge the child");
		let retired: any;
		const late = withLateCommit(tree.path, "--ignored=matching", () => {
			retired = retireWorktree(board, tree);
		});
		assert.equal(unreachable(repo, late), false, `the late commit ${late} became unreachable`);
		assert.equal(retired.removed, undefined, `a tree that moved after its proof was removed: ${JSON.stringify(retired)}`);
		assert.ok(existsSync(tree.path));
		assert.equal(git(repo, "rev-parse", `refs/heads/${childBranch}`), late);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a commit landing during the removal keeps the branch", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--no-ff", childBranch, "-m", "merge the child");
		let retired: any;
		const late = withLateCommit(tree.path, "worktree remove", () => {
			retired = retireWorktree(board, tree);
		});
		assert.equal(unreachable(repo, late), false, `the late commit ${late} became unreachable`);
		assert.equal(git(repo, "rev-parse", `refs/heads/${childBranch}`), late, "the branch that moved was deleted");
		assert.ok(retired.branchKept, `the entry does not say the branch stayed: ${JSON.stringify(retired)}`);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
