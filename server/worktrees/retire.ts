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
 * other branch holds, are reported and never deleted. The sweep behind `clean`, the Closed panel's clean
 * and the collect a thread asks for are the callers. Work that was merged, fast-forwarded, rebased,
 * cherry-picked or squashed is already integrated, so counting commits against the snapshot the tree
 * started from would keep such a tree for ever.
 *
 * `alsoUp` names more branches the caller knows the work may have landed in, a parent's own feature branch
 * among them: each is asked the content proof in turn, after the integration branch. Without a candidate
 * that holds the work, a tree whose commit sits in a branch nobody named is reported and kept.
 */
export function retireWorktree(board, tree, options = {}) {
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
	// The integration branch is asked first, then each branch the caller offered in `alsoUp`, which is how a
	// parent that cherry-picked its child's commit into its own branch proves the tree spent. The branch the
	// tree stands on is never a candidate: it contains itself, so it would always prove its own work.
	if (!proof && branch) {
		const names = (options.alsoUp ?? []).map((name) => (String(name).startsWith("refs/") ? String(name) : `refs/heads/${name}`));
		const base = `refs/heads/${up}`;
		const into = [...new Set([base, ...names])].filter((ref) => ref !== `refs/heads/${branch}`);
		for (const target of into) {
			const merged = gitIn(repo, ["merge-tree", "--write-tree", target, head], 10_000);
			const result = merged.out.split("\n")[0].trim();
			// A clean merge exits 0 and a conflicted one exits 1, both printing the tree first; anything else
			// means the proof did not run, an old git without `--write-tree` included. A branch the caller
			// offered may simply be gone, which is no proof and no failure: the next one is tried. The
			// integration branch is the proof every tree is judged by, so a read of it that did not run is
			// reported rather than skipped.
			const ran = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(result);
			if (!ran) {
				if (target === base) return { path: tree.path, branch: label, kept: why(`could not run git merge-tree ${up} ${branch}: ${firstLine(merged)}`) };
				continue;
			}
			if (!merged.ok) continue;
			const ours = gitIn(repo, ["rev-parse", "--verify", `${target}^{tree}`]);
			if (!ours.ok) {
				if (target === base) return { path: tree.path, branch: label, kept: why(`could not read the tree of ${up}`) };
				continue;
			}
			if (result === ours.out) {
				proof = `merging it into ${target.slice("refs/heads/".length)} changes nothing`;
				break;
			}
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
 * Every worktree git has registered, read from `git worktree list --porcelain`: each one's path, the commit
 * its HEAD names and the branch it stands on ("" when detached). The main checkout is one of them. A
 * registration outlives a folder deleted by hand, so this is what a missing tree is judged by. Null when
 * the list cannot be read.
 */
export function registrations(repo) {
	const list = gitIn(repo, ["worktree", "list", "--porcelain", "-z"]);
	if (!list.ok) return null;
	const entries = [];
	let entry = null;
	for (const field of list.out.split("\0")) {
		if (field.startsWith("worktree ")) {
			if (entry) entries.push(entry);
			entry = { path: field.slice("worktree ".length), head: "", branch: "" };
		} else if (entry && field.startsWith("HEAD ")) {
			entry.head = /^0+$/.test(field.slice(5)) ? "" : field.slice(5);
		} else if (entry && field.startsWith("branch refs/heads/")) {
			entry.branch = field.slice("branch refs/heads/".length);
		}
	}
	if (entry) entries.push(entry);
	return entries;
}



/**
 * The registration of the worktree at `path`, or `{}` when no registration names it, or null when the list
 * cannot be read.
 */
function registration(repo, path) {
	const entries = registrations(repo);
	if (!entries) return null;
	return entries.find((entry) => sameFolder(entry.path, path)) ?? {};
}



/** The repository a tree record belongs to, or "" when there is none to act in any more. */
export function treeRepo(board, tree) {
	if (!tree?.path) return "";
	return (existsSync(tree.path) ? mainRepoOf(tree.path) : "") || tree.repo || repoOf(board.folder);
}



/** The branch a tree really stands on, read from the disk: the record's own name may be stale. */
export function treeBranch(repo, tree) {
	if (!tree?.path || !repo) return "";
	if (existsSync(tree.path)) return branchOn(tree.path);
	return registration(repo, tree.path)?.branch ?? "";
}



/**
 * A tree gone whatever it holds: the trash action keeps nothing, so no proof is asked for here. `--force`
 * is what tells git to drop a folder that still holds uncommitted or untracked work. The record goes only
 * when the folder and its registration are gone, so a failed removal stays where the human can see it.
 */
export function discardTree(board, tree) {
	if (!tree?.path) return { ok: true, note: "there was no folder to remove" };
	const present = existsSync(tree.path);
	const repo = treeRepo(board, tree);
	if (!repo) return { ok: false, note: "that folder belongs to no repository any more" };
	if (present || registration(repo, tree.path)?.path) {
		const removed = gitIn(repo, ["worktree", "remove", "--force", tree.path], 10_000);
		if (!removed.ok) return { ok: false, note: removed.err.split("\n")[0] || "git refused to remove the folder" };
	}
	if (present && basename(dirname(tree.path)) !== AGENTS_DIR) {
		// The older `<agent>/<slug>` layout leaves an empty folder behind; `rmdir` refuses one that still holds
		// another thread's tree, which is the answer wanted here too.
		try {
			rmdirSync(dirname(tree.path));
		} catch {
			// Something else lives there, or it is already gone.
		}
	}
	forget(board, tree);
	return { ok: true, note: present ? "the folder was removed" : "the folder was already gone" };
}



/**
 * Why a branch may not be deleted by a forced removal, or "" when it may. A trunk's name is never deleted:
 * every proof the sweep makes is measured against the integration branch, so `dev`, `main` and the one the
 * main checkout stands on would always read as spent.
 */
export function branchRefusal(repo, branch) {
	if (!branch) return "";
	if (!repo) return "that folder belongs to no repository any more";
	return trunkReason(repo, baseRef(repo), branch);
}



/** The same, acted on: the ref goes whatever it points at, and a trunk is still reported rather than taken. */
export function discardBranch(repo, branch) {
	if (!branch) return { ok: true, note: "there was no branch to delete" };
	const refused = branchRefusal(repo, branch);
	if (refused) return { ok: false, note: refused };
	const gone = gitIn(repo, ["update-ref", "-d", `refs/heads/${branch}`], 10_000);
	if (!gone.ok) return { ok: false, note: gone.err.split("\n")[0] || "git refused to delete the branch" };
	return { ok: true, note: "the branch was deleted" };
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
