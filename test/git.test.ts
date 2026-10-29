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
