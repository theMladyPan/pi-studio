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

/** A commit in a tree, so what the tree holds is something only it has. */
function commitIn(path: string, file: string, subject: string) {
	writeFileSync(join(path, file), `${file}\n`);
	git(path, "add", ".");
	git(path, "commit", "-m", subject);
}

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

/** True when `git fsck` reports the commit as reachable from nothing. */
const unreachable = (repo: string, commit: string) => git(repo, "fsck", "--unreachable", "--no-progress").includes(commit);

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

/**
 * Run `work` with a `git` on PATH that makes one late commit in `tree` the first time it sees `trigger`
 * in its arguments, as a tool the killed child left running would. Answers the late commit's id.
 */
function withLateCommit(tree: string, trigger: string, work: () => void) {
	const bin = mkdtempSync(join(tmpdir(), "pi-studio-late-"));
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const mark = join(bin, "late");
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh\ncase " $* " in *"${trigger}"*) if [ ! -e "${mark}" ]; then "${real}" -C "${tree}" commit -q --allow-empty -m late && "${real}" -C "${tree}" rev-parse HEAD > "${mark}"; fi;; esac\nexec "${real}" "$@"\n`,
	);
	chmodSync(join(bin, "git"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	try {
		work();
		assert.ok(existsSync(mark), `the late commit was never made on "${trigger}"`);
		return readFileSync(mark, "utf8").trim();
	} finally {
		process.env.PATH = path;
		rmSync(bin, { recursive: true, force: true });
	}
}

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
