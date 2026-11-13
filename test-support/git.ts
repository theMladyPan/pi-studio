import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorktree } from "../server/worktrees/make.ts";

export const git = (folder: string, ...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();

/** A throwaway repository with one commit on `dev`. Never the human's. */
export function scratchRepo() {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-git-"));
	git(folder, "init", "-b", "dev");
	git(folder, "config", "user.email", "test@example.invalid");
	git(folder, "config", "user.name", "test");
	writeFileSync(join(folder, "readme.md"), "hello\n");
	git(folder, "add", ".");
	git(folder, "commit", "-m", "first");
	return folder;
}

export const childBranch = "feat/child";

/**
 * A made tree standing on a branch of its own with one commit, and the board that owns its record. The
 * tree is made for a child spawned from a thread that already has one, which is the case that made the
 * sweep blind: the child's base is the parent's HEAD commit id, and a commit id never moves with dev.
 * The board learns the branch from the tree after a run settles; the sweep takes it from `tree.branch`.
 */
export function treeWithChildCommit(repo: string) {
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
export function commitDev(repo: string) {
	writeFileSync(join(repo, "dev.txt"), "dev\n");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "dev moves on");
}

/** A commit in a tree, so what the tree holds is something only it has. */
export function commitIn(path: string, file: string, subject: string) {
	writeFileSync(join(path, file), `${file}\n`);
	git(path, "add", ".");
	git(path, "commit", "-m", subject);
}

/** True when `git fsck` reports the commit as reachable from nothing. */
export const unreachable = (repo: string, commit: string) => git(repo, "fsck", "--unreachable", "--no-progress").includes(commit);

/**
 * Run `work` with a `git` on PATH that makes one late commit in `tree` the first time it sees `trigger`
 * in its arguments, as a tool the killed child left running would. Answers the late commit's id.
 */
export function withLateCommit(tree: string, trigger: string, work: () => void) {
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
