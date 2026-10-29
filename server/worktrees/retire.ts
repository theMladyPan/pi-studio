// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Retiring one: removing the worktree, deleting the branch it left behind, and refusing when the tree
 * still holds work nobody has seen.
 */
import { existsSync, realpathSync, rmdirSync } from "node:fs";
import { gitIn, mainRepoOf, repoOf } from "../git/repo.ts";
import { basename, dirname, resolve } from "node:path";
import { AGENTS_DIR } from "./make.ts";



/**
 * Let a tree go, but only one with nothing worth keeping: uncommitted changes or a commit the base
 * does not have are reported, never deleted. `clean` is the only caller, so a tree outlives its thread
 * until the human asks for the sweep.
 */
export function retireWorktree(board, tree) {
	if (!tree?.path) return null;
	const repo = (existsSync(tree.path) ? mainRepoOf(tree.path) : "") || tree.repo || repoOf(board.folder);
	// A tree still on its detached base has no branch yet, so what it holds is asked of HEAD inside the
	// tree. `tree.branch` is only filled in once the child cut one or the board cut one for it.
	const branch = typeof tree.branch === "string" ? tree.branch : "";
	const label = branch || `detached at ${tree.base}`;
	if (!repo) return { path: tree.path, branch: label, kept: "not a repository any more" };
	if (existsSync(tree.path)) {
		const dirty = gitIn(tree.path, ["status", "--porcelain"]);
		if (!dirty.ok) return { path: tree.path, branch: label, kept: "git could not read it" };
		if (dirty.out) {
			return { path: tree.path, branch: label, kept: `${dirty.out.split("\n").length} uncommitted change(s)` };
		}
	} else {
		// A tree somebody deleted by hand is already gone; its registration in .git/worktrees is not.
		gitIn(repo, ["worktree", "prune"]);
	}
	// A branch deleted by hand takes the tree with it in every real case, so the record has nothing left
	// to protect. Without this check the unreadable count below would report a phantom tree for ever.
	if (branch && !gitIn(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
		const gone = board.trees.findIndex((candidate) => candidate.path === tree.path);
		if (gone !== -1) board.trees.splice(gone, 1);
		return { path: tree.path, branch: label, removed: true, note: "the branch is already gone" };
	}
	// The branch is what holds the work, and a count git cannot read is not a zero: a renamed or
	// deleted base made `rev-list` fail here once and the branch was deleted with commits on it.
	const ahead = branch
		? gitIn(repo, ["rev-list", "--count", `${tree.base}..${branch}`])
		: existsSync(tree.path)
			? gitIn(tree.path, ["rev-list", "--count", `${tree.base}..HEAD`])
			: { ok: false, out: "" };
	if (!ahead.ok) {
		return { path: tree.path, branch: label, kept: `could not read ${tree.base}..${branch || "HEAD"}` };
	}
	const commits = Number(ahead.out) || 0;
	if (commits > 0) return { path: tree.path, branch: label, kept: `${commits} commit(s) not in ${tree.base}` };
	if (existsSync(tree.path)) {
		const removed = gitIn(repo, ["worktree", "remove", tree.path], 10_000);
		if (!removed.ok) {
			return { path: tree.path, branch: label, kept: removed.err.split("\n")[0] || "could not be removed" };
		}
		// A tree made by the older `<agent>/<slug>` layout leaves an empty folder behind; one made by the
 		// current layout sits directly in `.agents` and must not take that folder with it. `rmdir`
		// refuses a folder that still holds another thread's tree, which is the answer wanted.
		if (basename(dirname(tree.path)) !== AGENTS_DIR) {
			try {
				rmdirSync(dirname(tree.path));
			} catch {
				// Something else lives there, or it is already gone.
			}
		}
	}
	// Nothing is ahead of the base, so the branch holds no work of its own. A detached tree has no branch
	// to delete: its commits were never given a name, and there were none.
	const branchGone = branch ? gitIn(repo, ["branch", "-D", branch]) : { ok: true, out: "" };
	const at = board.trees.findIndex((candidate) => candidate.path === tree.path);
	if (at !== -1) board.trees.splice(at, 1);
	return {
		path: tree.path,
		branch: label,
		removed: true,
		...(branchGone.ok ? {} : { branchKept: branchGone.err.split("\n")[0] || "git refused" }),
	};
}



/** Two folders naming the same place: a worktree reached through a symlink is still the same worktree. */
export function sameFolder(one, other) {
	if (!one || !other) return false;
	const real = (path) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return real(one) === real(other);
}
