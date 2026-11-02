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
 * fast-forwarded, rebased, cherry-picked or squashed is already integrated, so counting commits against
 * the snapshot the tree started from would keep such a tree for ever.
 */
export function retireWorktree(board, tree) {
	if (!tree?.path) return null;
	const present = existsSync(tree.path);
	const repo = (present ? mainRepoOf(tree.path) : "") || tree.repo || repoOf(board.folder);
	// A tree still on its detached base has no branch yet, so what it holds is asked of HEAD inside the
	// tree. `tree.branch` is only filled in once the child cut one or the board cut one for it.
	let branch = typeof tree.branch === "string" ? tree.branch : "";
	let label = branch || `detached at ${tree.base}`;
	if (!repo) return { path: tree.path, branch: label, kept: "not a repository any more" };
	if (present) {
		const dirty = gitIn(tree.path, ["status", "--porcelain"]);
		if (!dirty.ok) return { path: tree.path, branch: label, kept: "git could not read it" };
		if (dirty.out) {
			return { path: tree.path, branch: label, kept: `${dirty.out.split("\n").length} uncommitted change(s)` };
		}
	}
	// The branch and the commit the tree stands on are read from the disk, so the record's branch is
	// advisory: a tree that left the recorded branch, renamed it or went detached and committed holds its
	// work on whatever HEAD is now, and a proof about the recorded name says nothing about that work while
	// the removal below takes it with the tree. A tree whose folder was deleted by hand still has its
	// registration in .git/worktrees, and that registration's HEAD is what keeps its commits reachable:
	// nothing here prunes, because a prune is repository-wide and takes every other stale registration
	// with it, a human's moved worktree included.
	let recorded = null;
	let head = "";
	let registered = false;
	if (present) {
		const on = branchOn(tree.path);
		if (on !== branch) {
			recorded = branch;
			branch = on;
		}
		const read = gitIn(tree.path, ["rev-parse", "--verify", "HEAD"]);
		if (!read.ok || !read.out) return { path: tree.path, branch: label, kept: "could not read the commit the tree stands on" };
		head = read.out;
	} else {
		const entry = registration(repo, tree.path);
		if (!entry) return { path: tree.path, branch: label, kept: "could not read git worktree list" };
		if (entry.path) {
			registered = true;
			if (entry.branch !== branch) {
				recorded = branch;
				branch = entry.branch;
			}
			if (!entry.head) return { path: tree.path, branch: label, kept: "its registration names no commit" };
			head = entry.head;
		} else if (branch && (head = gitIn(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).out)) {
			// Folder and registration are both gone, so the recorded branch is all that is left; it goes
			// only on the proofs below, and there is no tree to remove.
		} else {
			// Folder, registration and branch are all gone: no ref this sweep could delete holds anything,
			// and without this the record would be reported as a phantom tree for ever.
			forget(board, tree);
			const note = branch ? "the branch is already gone" : "the folder and its registration are already gone";
			return { path: tree.path, branch: label, removed: true, note };
		}
	}
	label = branch || `detached at ${tree.base}`;
	// Every reason below names the branch the tree really stands on when the record says otherwise.
	const why = (reason) =>
		recorded === null ? reason : `${reason}; the tree is on ${branch || "a detached HEAD"}, recorded as ${recorded || "detached"}`;
	const firstLine = (result) => result.err.split("\n")[0] || "no reason given";
	// The branch the work would have been integrated into, named in every sentence below.
	const up = baseRef(repo);
	// Said ahead of every proof and of the deletion below, so no reason text and no renamed branch can
	// reach the deletion with a trunk's name.
	const trunk = branch ? trunkReason(repo, up, branch) : "";
	if (trunk) return { path: tree.path, branch: label, kept: why(trunk) };
	// The work is integrated when one of two proofs holds, and the tree then holds nothing of its own.
	// Both are asked of the main checkout, which sees every ref, about the commit read above, and a read
	// that fails is not a proof: the tree stays.
	// Containment: a merge, a fast-forward or a rebase put the commit into another local branch. The
	// branch always contains itself, so only another name is proof; full names are compared, because a
	// tag of the same name makes the short form of the branch itself read `heads/<name>`.
	const held = gitIn(repo, ["for-each-ref", "--contains", head, "refs/heads", "--format=%(refname)"], 10_000);
	if (!held.ok) return { path: tree.path, branch: label, kept: why(`could not read which local branches hold ${label}: ${firstLine(held)}`) };
	const holder = held.out
		.split("\n")
		.map((name) => name.trim())
		.find((name) => name && name !== `refs/heads/${branch}`);
	let proof = holder ? `held by ${holder.slice("refs/heads/".length)}` : "";
	// Content: merging the branch into the integration branch changes nothing, which covers a cherry-pick
	// and a squash. Whitespace counts, so a reindented copy on dev is no proof; a merge that does not go
	// through cleanly is none either. A detached tree never goes on this proof: its commit has no name
	// but the tree's HEAD, so only another branch holding that very commit keeps it reachable.
	if (!proof && branch) {
		const merged = gitIn(repo, ["merge-tree", "--write-tree", `refs/heads/${up}`, head], 10_000);
		const result = merged.out.split("\n")[0].trim();
		// A clean merge exits 0 and a conflicted one exits 1, both printing the tree first; anything else
		// means the proof did not run, an old git without `--write-tree` included.
		if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(result)) return { path: tree.path, branch: label, kept: why(`could not run git merge-tree ${up} ${branch}: ${firstLine(merged)}`) };
		if (merged.ok) {
			const ours = gitIn(repo, ["rev-parse", "--verify", `refs/heads/${up}^{tree}`]);
			if (!ours.ok) return { path: tree.path, branch: label, kept: why(`could not read the tree of ${up}`) };
			if (result === ours.out) proof = `merging it into ${up} changes nothing`;
		}
	}
	if (!proof) {
		// Nothing proves the work is somewhere else, so what the tree holds is counted and reported. The
		// count only words the reason; a zero is no proof, because a tree on its base may be the only ref
		// naming the commit it stands on, as a spawned child's is once its parent amended that commit away.
		// A base that is a name is read as a branch, never as a tag that shares it.
		const base = /^[0-9a-f]{40}$/.test(tree.base) ? tree.base : `refs/heads/${tree.base}`;
		const ahead = gitIn(repo, ["rev-list", "--count", `${base}..${head}`]);
		if (!ahead.ok) return { path: tree.path, branch: label, kept: why(`could not read ${tree.base}..${branch || "HEAD"}`) };
		const commits = Number(ahead.out) || 0;
		if (commits > 0) return { path: tree.path, branch: label, kept: why(`${commits} commit(s) not in ${up && up !== branch ? up : "any local branch"}`) };
		return { path: tree.path, branch: label, kept: why(`0 commit(s) past ${tree.base}, and ${branch ? `no other local branch holds ${branch}` : "no local branch holds the commit it is detached at"}`) };
	}
	// A process the closed child left behind (a tool in its own process group outlives SIGKILL) may still
	// commit in the tree while this runs. The HEAD is read once more right before the removal, and the
	// branch is deleted only while it still names the commit the proof saw. That closes the window from
	// the proof to the removal; a commit landing in the instant between this read and `git worktree
	// remove`, or one made in a detached tree during the removal itself, is still lost with the tree.
	const stillAt = () => {
		if (present) return gitIn(tree.path, ["rev-parse", "--verify", "HEAD"]).out;
		return registration(repo, tree.path)?.head ?? "";
	};
	let ignoredPaths = 0;
	if (present) {
		// `git worktree remove` deletes ignored files without asking, and `status --porcelain` above never
		// lists them. They do not keep the tree: this repository's own trees carry installed dependencies,
		// which are ignored, and a rule that kept them would leave every tree standing. The count goes on
		// the entry instead, so the human reads what went with the tree.
		const ignored = gitIn(tree.path, ["status", "--porcelain", "--ignored=matching"], 10_000);
		if (ignored.ok) ignoredPaths = ignored.out.split("\n").filter((line) => line.startsWith("!!")).length;
	}
	if (present || registered) {
		const now = stillAt();
		if (now !== head) return { path: tree.path, branch: label, kept: why(`its HEAD moved to ${now || "an unreadable commit"} after ${head} was proved integrated`) };
		// Only this tree's registration goes, folder or no folder.
		const removed = gitIn(repo, ["worktree", "remove", tree.path], 10_000);
		if (!removed.ok) return { path: tree.path, branch: label, kept: why(removed.err.split("\n")[0] || "could not be removed") };
	}
	if (present) {
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
	// The work is integrated, so the name goes with the tree, and only while it still names the commit
	// the proof was about. A detached tree has no branch to delete.
	const branchGone = branch ? gitIn(repo, ["update-ref", "-d", `refs/heads/${branch}`, head]) : { ok: true, out: "" };
	forget(board, tree);
	return {
		path: tree.path,
		branch: label,
		removed: true,
		proof,
		...(present ? {} : { note: "the folder was already gone" }),
		...(ignoredPaths ? { ignoredPaths } : {}),
		...(branchGone.ok ? {} : { branchKept: branchGone.err.split("\n")[0] || "git refused" }),
	};
}



/**
 * The registration of the worktree at `path`, read from `git worktree list --porcelain`: its path, the
 * commit its HEAD names and the branch it stands on ("" when detached). A registration outlives a folder
 * deleted by hand, so this is what a missing tree is judged by. Answers `{}` when no registration names
 * the path and null when the list cannot be read.
 */
function registration(repo, path) {
	const list = gitIn(repo, ["worktree", "list", "--porcelain", "-z"]);
	if (!list.ok) return null;
	let entry = null;
	for (const field of list.out.split("\0")) {
		if (field.startsWith("worktree ")) {
			if (entry && sameFolder(entry.path, path)) return entry;
			entry = { path: field.slice("worktree ".length), head: "", branch: "" };
		} else if (entry && field.startsWith("HEAD ")) {
			entry.head = /^0+$/.test(field.slice(5)) ? "" : field.slice(5);
		} else if (entry && field.startsWith("branch refs/heads/")) {
			entry.branch = field.slice("branch refs/heads/".length);
		}
	}
	return entry && sameFolder(entry.path, path) ? entry : {};
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
