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

test("a branch only half of whose commits landed is kept", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		writeFileSync(join(tree.path, "child2.txt"), "child two\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "child change, second half");
		git(repo, "merge", "--no-ff", "feat/parent", "-m", "merge the parent");
		commitDev(repo);
		// Only the first of the two, so a `+` line is left and the patch proof cannot clear the branch.
		git(repo, "cherry-pick", `${git(repo, "rev-parse", childBranch)}~1`);
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a partly landed branch was removed: ${JSON.stringify(retired)}`);
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a reindented copy on dev is no proof, so the branch is kept", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--no-ff", "feat/parent", "-m", "merge the parent");
		commitDev(repo);
		// The same word, a different patch: neither the patch proof nor the content proof may read this as
		// the branch's work having arrived. git cherry alone would, because it forgives whitespace.
		git(repo, "cherry-pick", "--no-commit", git(repo, "rev-parse", childBranch));
		writeFileSync(join(repo, "child.txt"), "  child\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "the child's file, indented");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a reindented copy was taken for the branch's work: ${JSON.stringify(retired)}`);
		assert.match(retired.kept, /not in dev/, `the reason does not fall back to a count: ${retired.kept}`);
		assert.ok(existsSync(tree.path));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch with an unmerged commit is kept, and the reason names dev", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
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

test("a child's commit cherry-picked into the caller's own branch is spent once that branch is offered", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		// The parent never merges its child: it cherry-picks the commit into a branch of its own, which is
		// what a boss that collects its children's work looks like. The child was cut from the parent's
		// HEAD, so the parent's branch carries that work and dev sees neither of the two commits.
		git(repo, "checkout", "-b", "feat/boss-1", "feat/parent");
		// A commit of the parent's own first, so the cherry-pick is a real replay: onto the child's own base
		// it would fast-forward and leave the very commit the tree stands on inside the branch.
		writeFileSync(join(repo, "boss.txt"), "boss\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "the parent's own work");
		git(repo, "cherry-pick", git(repo, "rev-parse", childBranch));
		git(repo, "checkout", "dev");
		assert.notEqual(git(repo, "rev-parse", "feat/boss-1"), git(repo, "rev-parse", childBranch), "the ids should differ");
		const alone = retireWorktree(board, tree);
		assert.ok(alone, "the tree was not read at all");
		assert.equal(alone.removed, undefined, `a tree proved against dev alone was removed: ${JSON.stringify(alone)}`);
		assert.match(alone.kept, /commit/, `the reason says nothing about commits: ${alone.kept}`);
		assert.ok(existsSync(tree.path));
		const offered = retireWorktree(board, tree, { alsoUp: ["feat/boss-1"] });
		assert.ok(offered, "the tree was not read at all");
		assert.equal(offered.removed, true, `a tree its parent's branch holds was kept: ${JSON.stringify(offered)}`);
		const proof = (offered as any).proof;
		assert.match(proof, /feat\/boss-1/, `the proof does not name the branch it used: ${proof}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", childBranch), "");
		assert.notEqual(git(repo, "branch", "--list", "feat/boss-1"), "", "the caller's branch was deleted");
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
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, true, `a branch held by side was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
		assert.equal(git(repo, "branch", "--list", childBranch), "");
		assert.notEqual(git(repo, "branch", "--list", "side"), "", "dev was not supposed to move");
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(side, { recursive: true, force: true });
	}
});

test("a tree standing on dev itself is kept, and dev keeps its name", () => {
	const repo = scratchRepo();
	try {
		const board = { folder: repo, name: "scratch", children: new Map(), threads: new Map(), trees: [] as any[] };
		const tree = ensureWorktree(board, { id: "thread-on-dev-1", title: "a change", folder: repo });
		assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
		// The main checkout lets go of dev so the tree can stand on it, as a child that checks the base
		// out to work on it does; the board then reads the branch off the tree and records it.
		git(repo, "checkout", "-q", "--detach");
		git(tree.path, "checkout", "-q", "dev");
		tree.branch = "dev";
		// Another local branch holds dev's tip, which is the containment proof the sweep trusted.
		git(repo, "branch", "side", "dev");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a tree standing on dev was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /standing on dev/, `the reason does not name dev: ${retired.kept}`);
		assert.ok(existsSync(tree.path), "the folder of the tree standing on dev is gone");
		assert.notEqual(git(repo, "branch", "--list", "dev"), "", "the integration branch lost its name");
		assert.ok(board.trees.some((record: any) => record.path === tree.path), "the record went while the tree stayed");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a tree with an uncommitted edit is kept, and the reason says so", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		git(repo, "merge", "--no-ff", childBranch, "-m", "merge the child");
		writeFileSync(join(tree.path, "half-done.txt"), "half\n");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
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
		const first = retireWorktree(board, tree);
		assert.ok(first, "the tree was not read at all");
		assert.equal(first.kept, "1 commit(s) not in dev");
		git(repo, "branch", "somewhere", git(tree.path, "rev-parse", "HEAD"));
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, true, `a detached tree a branch holds was kept: ${JSON.stringify(retired)}`);
		assert.equal(existsSync(tree.path), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch whose only unaccounted commit is a merge is kept", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		// Cut before dev gets the child's patch, so merging side brings nothing equivalent into the child.
		git(repo, "branch", "side");
		git(repo, "merge", "--no-ff", "feat/parent", "-m", "merge the parent");
		// The child's own commit arrives on dev as an equivalent patch, so git cherry prints it with `-`.
		git(repo, "cherry-pick", git(repo, "rev-parse", childBranch));
		// A side branch dev already holds by id, so its commit is not one the child's branch adds.
		git(repo, "checkout", "-q", "side");
		writeFileSync(join(repo, "readme.md"), "side\n");
		git(repo, "commit", "-am", "side edits the readme");
		git(repo, "checkout", "-q", "dev");
		git(repo, "merge", "--no-ff", "side", "-m", "merge side");
		// The child merges side and writes the readme by hand: that content lives in the merge commit alone,
		// and git cherry never looks at a merge commit.
		git(tree.path, "merge", "--no-ff", "--no-commit", "side");
		writeFileSync(join(tree.path, "readme.md"), "resolved by hand\n");
		git(tree.path, "add", ".");
		git(tree.path, "commit", "-m", "merge side, readme resolved by hand");
		assert.equal(git(repo, "cherry", "dev", childBranch).split("\n").filter((line) => line.startsWith("+")).length, 0);
		assert.equal(git(repo, "rev-list", "--count", `dev..${childBranch}`), "2");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a branch holding a merge commit was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /commit\(s\) not in dev/, `the reason does not name the count: ${retired.kept}`);
		assert.ok(existsSync(tree.path));
		assert.ok(git(repo, "branch", "--list", childBranch).includes(childBranch), "the branch holding the merge is gone");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch whose name is also a tag, held by no other local branch, is kept", () => {
	const repo = scratchRepo();
	try {
		const { board, tree } = treeWithChildCommit(repo);
		// With a tag of the same name, `%(refname:short)` prints the branch itself as `heads/feat/child`.
		git(repo, "tag", childBranch, "dev");
		const retired = retireWorktree(board, tree);
		assert.ok(retired, "the tree was not read at all");
		assert.equal(retired.removed, undefined, `a branch shadowed by a tag was removed: ${JSON.stringify(retired)}`);
		assert.match(String(retired.kept), /commit\(s\) not in dev/);
		assert.ok(existsSync(tree.path));
		assert.ok(git(repo, "branch", "--list", childBranch).includes(childBranch), "the branch shadowed by a tag is gone");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
