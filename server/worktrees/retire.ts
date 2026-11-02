// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Retiring one: removing the worktree, deleting the branch it left behind, and refusing when the tree
 * still holds work nobody has seen.
 */
import { existsSync, realpathSync, rmdirSync } from "node:fs";
import { baseRef, gitIn, mainRepoOf, repoOf } from "../git/repo.ts";
import { basename, dirname, resolve } from "node:path";
import { AGENTS_DIR } from "./make.ts";



/**
 * Let a tree go, but only one whose work is already somewhere else: uncommitted changes, or commits no
 * other branch holds, are reported and never deleted. `clean` is the only caller. Work that was merged,
 * fast-forwarded, rebased or cherry-picked is already integrated, so counting commits against the
 * snapshot the tree started from would keep such a tree for ever.
 */
export function retireWorktree(board, tree) {
	if (!tree?.path) return null;
	const repo = (existsSync(tree.path) ? mainRepoOf(tree.path) : "") || tree.repo || repoOf(board.folder);
	// A tree still on its detached base has no branch yet, so what it holds is asked of HEAD inside the
	// tree. `tree.branch` is only filled in once the child cut one or the board cut one for it.
	let branch = typeof tree.branch === "string" ? tree.branch : "";
	let label = branch || `detached at ${tree.base}`;
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
	// The branch the tree stands on is read from the disk whenever the folder is there, so the record's
	// branch is advisory: a tree that left the recorded branch, renamed it or went detached and committed
	// holds its work on whatever HEAD is now, and a proof about the recorded name says nothing about that
	// work while the folder removal below takes it with the tree. With the folder gone the record is all
	// that is left, and a recorded branch that is gone too has nothing left to protect; without this check
	// the unreadable count below would report a phantom tree for ever.
	let recorded = null;
	if (existsSync(tree.path)) {
		const head = branchOn(tree.path);
		if (head !== branch) {
			recorded = branch;
			branch = head;
			label = branch || `detached at ${tree.base}`;
		}
	} else if (branch && !gitIn(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
		forget(board, tree);
		return { path: tree.path, branch: label, removed: true, note: "the branch is already gone" };
	}
	// A detached tree whose folder is gone has no name and no HEAD left to ask about, so its commits are
	// already beyond reach and the record is all that remains of it.
	if (!branch && !existsSync(tree.path)) {
		forget(board, tree);
		return { path: tree.path, branch: label, removed: true, note: "the folder is already gone" };
	}
	// Every reason below names the branch the tree really stands on when the record says otherwise.
	const why = (reason) =>
		recorded === null ? reason : `${reason}; the tree is on ${branch || "a detached HEAD"}, recorded as ${recorded || "detached"}`;
	// The branch the work would have been integrated into, named in every sentence below.
	const up = baseRef(repo);
	// Said ahead of every proof and of the deletion below, so no reason text and no renamed branch can
	// reach `git branch -D` with a trunk's name.
	const trunk = branch ? trunkReason(repo, up, branch) : "";
	if (trunk) return { path: tree.path, branch: label, kept: why(trunk) };
	// The work is integrated when one of two proofs holds, and the tree then holds nothing of its own. A
	// branch a merge, a fast-forward or a rebase put into another branch is contained in it; a branch
	// cherry-picked in carries the same patches under other ids. Both are asked of the main checkout,
	// which sees every ref, and a read that fails is not a proof: the tree stays.
	let integrated = false;
	if (branch) {
		// The branch always contains itself, so only another name in the list is proof. Full ref names are
		// compared: a tag of the same name makes the short form of the branch itself read `heads/<name>`.
		const held = gitIn(repo, ["for-each-ref", "--contains", `refs/heads/${branch}`, "refs/heads", "--format=%(refname)"], 10_000);
		if (!held.ok) {
			return { path: tree.path, branch: label, kept: why(`could not read which local branches hold ${branch}: ${held.err.split("\n")[0] || "no reason given"}`) };
		}
		integrated = held.out.split("\n").some((name) => name.trim() && name.trim() !== `refs/heads/${branch}`);
		// Commits cherry-picked into the integration branch have no id in common with it, so a "+" line
		// is the only thing that says the work is missing. A squashed branch leaves no equivalent commit
		// at all, which is why such a tree keeps rather than guessed away.
		if (!integrated) {
			const equivalent = gitIn(repo, ["cherry", `refs/heads/${up}`, `refs/heads/${branch}`], 10_000);
			if (!equivalent.ok) {
				return { path: tree.path, branch: label, kept: why(`could not read git cherry ${up} ${branch}: ${equivalent.err.split("\n")[0] || "no reason given"}`) };
			}
			const lines = equivalent.out.split("\n").filter((line) => line.trim());
			if (!lines.some((line) => line.startsWith("+"))) {
				// git cherry skips merge commits, so a merge holding a hand-resolved file prints no line at
				// all. Silence is a proof only when every commit the branch adds is on a line.
				const between = gitIn(repo, ["rev-list", "--count", `refs/heads/${up}..refs/heads/${branch}`], 10_000);
				if (!between.ok) return { path: tree.path, branch: label, kept: why(`could not read ${up}..${branch}`) };
				const count = Number(between.out);
				if (count !== lines.length) {
					return { path: tree.path, branch: label, kept: why(`${between.out} commit(s) not in ${up}, of which git cherry compared ${lines.length}`) };
				}
				// No commit compared is no proof: a branch standing on its base prints no line either, and it
				// may be the only ref naming the commit it stands on.
				integrated = count > 0;
			}
		}
	} else if (existsSync(tree.path)) {
		// A detached tree has no name to look up, so its own HEAD is asked about instead — inside the
		// tree, because HEAD is per worktree and the main checkout's HEAD says nothing about this one.
		const held = gitIn(tree.path, ["for-each-ref", "--contains", "HEAD", "refs/heads", "--format=%(refname:short)"], 10_000);
		if (!held.ok) {
			return { path: tree.path, branch: label, kept: why(`could not read which local branches hold ${label}: ${held.err.split("\n")[0] || "no reason given"}`) };
		}
		integrated = held.out.split("\n").some((name) => name.trim());
	}
	if (!integrated) {
		// Nothing proves the work is somewhere else, so what the tree holds is counted and reported. A
		// count git cannot read is not a zero: a renamed or deleted base made `rev-list` fail here once
		// and the branch was deleted with commits on it.
		// A base that is a name is read as a branch, never as a tag that shares it.
		const base = /^[0-9a-f]{40}$/.test(tree.base) ? tree.base : `refs/heads/${tree.base}`;
		const ahead = branch
			? gitIn(repo, ["rev-list", "--count", `${base}..refs/heads/${branch}`])
			: gitIn(tree.path, ["rev-list", "--count", `${base}..HEAD`]);
		if (!ahead.ok) {
			return { path: tree.path, branch: label, kept: why(`could not read ${tree.base}..${branch || "HEAD"}`) };
		}
		const commits = Number(ahead.out) || 0;
		if (commits > 0) {
			const where = up && up !== branch ? up : "any local branch";
			return { path: tree.path, branch: label, kept: why(`${commits} commit(s) not in ${where}`) };
		}
		// A named branch goes only on a proof. One with nothing past its base may still be the only ref
		// naming the commit it stands on, as a spawned child's branch on its parent's commit is. A detached
		// tree on its base goes on: no commit of its own exists, and it has no name to delete.
		if (branch) {
			return { path: tree.path, branch: label, kept: why(`0 commit(s) past ${tree.base}, and no other local branch holds ${branch}`) };
		}
	}
	let ignoredPaths = 0;
	if (existsSync(tree.path)) {
		// `git worktree remove` deletes ignored files without asking, and `status --porcelain` above never
		// lists them. They do not keep the tree: this repository's own trees carry installed dependencies,
		// which are ignored, and a rule that kept them would leave every tree standing. The count goes on
		// the entry instead, so the human reads what went with the tree.
		const ignored = gitIn(tree.path, ["status", "--porcelain", "--ignored=matching"], 10_000);
		if (ignored.ok) ignoredPaths = ignored.out.split("\n").filter((line) => line.startsWith("!!")).length;
		const removed = gitIn(repo, ["worktree", "remove", tree.path], 10_000);
		if (!removed.ok) {
			return { path: tree.path, branch: label, kept: why(removed.err.split("\n")[0] || "could not be removed") };
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
	// The work is integrated or the branch holds none of its own, so the name goes with the tree. A
	// detached tree has no branch to delete: its commits were never given a name, and there were none.
	const branchGone = branch ? gitIn(repo, ["branch", "-D", branch]) : { ok: true, out: "" };
	const at = board.trees.findIndex((candidate) => candidate.path === tree.path);
	if (at !== -1) board.trees.splice(at, 1);
	return {
		path: tree.path,
		branch: label,
		removed: true,
		...(ignoredPaths ? { ignoredPaths } : {}),
		...(branchGone.ok ? {} : { branchKept: branchGone.err.split("\n")[0] || "git refused" }),
	};
}



/**
 * The branch a checkout stands on, or "" while it is detached or unreadable. Read as the full ref:
 * `rev-parse --abbrev-ref` answers `heads/<name>` when a tag shares the name, which is no branch at all.
 */
function branchOn(path) {
	const head = gitIn(path, ["symbolic-ref", "--quiet", "HEAD"]);
	return head.ok && head.out.startsWith("refs/heads/") ? head.out.slice("refs/heads/".length) : "";
}



/** Names a repository's trunk goes by, which no sweep deletes whatever a proof says about them. */
const TRUNK_NAMES = new Set(["dev", "main", "master", "trunk", "develop", "default"]);



/**
 * Why a branch is a trunk the sweep must keep, or "" when it is a thread's branch. The sweep takes a
 * thread's branch, never a trunk: every proof is measured against the integration branch, so the branch
 * itself, a branch carrying its tip, or the one the main checkout stands on always reads as spent. With
 * no integration branch at all nothing can be measured, so nothing named is deleted.
 */
function trunkReason(repo, up, branch) {
	if (!up) return `no integration branch to measure ${branch} against`;
	if (branch === up) return `standing on ${up}, which is the branch its work is measured against`;
	if (TRUNK_NAMES.has(branch)) return `standing on ${branch}, a trunk name the sweep never deletes`;
	if (branch === branchOn(repo)) return `standing on ${branch}, which the main checkout has checked out`;
	return "";
}



/** Drop the record of a tree that has nothing left on disk to protect. */
function forget(board, tree) {
	const gone = board.trees.findIndex((candidate) => candidate.path === tree.path);
	if (gone !== -1) board.trees.splice(gone, 1);
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
