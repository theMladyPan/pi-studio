// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * What a trash action would take, and what earlier ones left behind: the leftovers a board can still see
 * are worktrees, folders and branches that belonged to threads nothing answers for any more.
 */
import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { gitIn, repoOf } from "../git/repo.ts";
import { AGENTS_DIR, WORK_TYPES } from "./make.ts";
import { branchRefusal, discardBranch, discardTree, registrations, sameFolder, treeBranch, treeRepo } from "./retire.ts";



/** How much of a diff the preview hands the browser: enough to read, small enough to draw at once. */
export const PREVIEW_DIFF_CHARS = 8000;


const TYPES = WORK_TYPES.map(([type]) => type).join("|");

/**
 * A branch in the shape a thread's branches take: `<type>/<slug>-<8hex>`, the eight hex being the start of
 * the thread's own id. Anything else is a branch a human made, which no sweep of this board touches.
 */
const THREAD_BRANCH = new RegExp(`^(?:${TYPES})/[a-z0-9-]+-([0-9a-f]{8})$`);



/** The tree record a thread works in: its own pointer, or the board's record for it. */
export function treeOf(board, thread) {
	if (thread?.worktree?.path) return thread.worktree;
	return board.trees.find((tree) => tree.thread === thread?.id);
}



/** What a step that failed says, as one sentence for the caller: "" when every step went through. */
export function stepsNote(steps) {
	const failed = steps.filter((step) => !step.ok);
	return failed.length ? failed.map((step) => `${step.what}: ${step.note}`).join("; ") : null;
}



/**
 * What removing a thread would take, so the human reads the work before it goes: the branch, the folder,
 * how much is uncommitted in it, how much is on the branch alone, and the patch itself. Nothing is touched.
 */
export function removePreview(board, thread) {
	const tree = treeOf(board, thread);
	const repo = tree ? treeRepo(board, tree) : repoOf(board.folder);
	const path = tree?.path ?? "";
	const present = path ? existsSync(path) : false;
	// Read from the disk, because a record's own branch is written when the child settles and may be stale.
	const branch = (tree ? treeBranch(repo, tree) : "") || tree?.branch || "";
	const base = tree?.base ?? "";
	let dirty = 0;
	let commits = 0;
	let raw = "";
	if (present) {
		const status = gitIn(path, ["status", "--porcelain"], 10_000);
		dirty = status.ok ? status.out.split("\n").filter(Boolean).length : 0;
	}
	if (base) {
		// The tree's own HEAD is what its commits hang on while it is on disk; a deleted folder leaves only
		// the branch. A run that answered a question never cut one, and then there is nothing to count.
		const ref = present ? "HEAD" : branch ? `refs/heads/${branch}` : "";
		const read = ref ? gitIn(present ? path : repo, ["rev-list", "--count", `${base}..${ref}`]) : null;
		commits = read?.ok ? Number(read.out) || 0 : 0;
	}
	// A dirty room is what the human is about to lose, so its working tree is the diff; a clean one shows the
	// commits of its own that the base does not have. `git diff` never lists an untracked file, which is why
	// the count above is the number the human goes by.
	if (present && dirty) raw = gitIn(path, ["diff", "HEAD"], 10_000).out;
	else if (present && commits) raw = gitIn(path, ["diff", `${base}..HEAD`], 10_000).out;
	const note = !path
		? "this thread has no worktree of its own"
		: !present
			? "the folder is already gone, so only its record and its branch would go"
			: branchRefusal(repo, branch) || null;
	return {
		thread: { id: thread.id, title: thread.title },
		branch: branch || null,
		base: base || null,
		path: path || null,
		dirty,
		commits,
		diff: raw.slice(0, PREVIEW_DIFF_CHARS),
		trunc: raw.length > PREVIEW_DIFF_CHARS,
		note,
	};
}



/**
 * What the board can still clear away: a record whose thread is gone and whose tree git still has, a folder
 * under `.agents` that git has as a worktree and the board never recorded, and a thread's branch with no
 * thread left to hold it. A trunk is never one of them, and neither is a branch a human named.
 */
export function fragmentsOf(board) {
	const repo = repoOf(board.folder);
	if (!repo) return [];
	const registered = registrations(repo) ?? [];
	// A branch belongs to a folder item when that folder is still standing: the folder goes first and takes
	// its branch with it, so listing the name again would offer to remove a thing twice.
	const covered = new Set(board.trees.map((tree) => tree.branch).filter(Boolean));
	for (const entry of registered) if (entry.branch && existsSync(entry.path)) covered.add(entry.branch);
	const live = new Set([...board.threads.keys()].map((id) => String(id).slice(0, 8)));
	const items = [];
	for (const tree of board.trees) {
		if (tree.thread && board.threads.has(tree.thread)) continue;
		if (!registered.some((entry) => sameFolder(entry.path, tree.path))) continue;
		const branch = treeBranch(repo, tree) || tree.branch || "";
		// The name the disk answers with is the one that goes with the folder, recorded or not.
		if (branch) covered.add(branch);
		const why = whyKept(tree);
		items.push({
			kind: "tree",
			label: branch || basename(tree.path),
			note: `the worktree of a thread the board no longer has${why ? `, and ${why}` : ", which no sweep has taken yet"}`,
			path: tree.path,
			branch: branch || null,
		});
	}
	const kept = join(repo, AGENTS_DIR) + sep;
	for (const entry of registered) {
		// The main checkout is a registration of its own, and a tree outside `.agents` is where a human put it.
		if (sameFolder(entry.path, repo) || !resolve(entry.path).startsWith(kept)) continue;
		if (board.trees.some((tree) => sameFolder(tree.path, entry.path))) continue;
		items.push({
			kind: "orphan",
			label: entry.branch || basename(entry.path),
			note: "a folder under .agents that git has as a worktree and the board has no record of",
			path: entry.path,
			branch: entry.branch || null,
		});
	}
	const named = gitIn(repo, ["for-each-ref", "refs/heads", "--format=%(refname:short)"], 10_000);
	for (const name of (named.ok ? named.out.split("\n") : []).map((line) => line.trim()).filter(Boolean)) {
		const suffix = name.match(THREAD_BRANCH)?.[1];
		if (!suffix || live.has(suffix) || covered.has(name)) continue;
		items.push({
			kind: "branch",
			label: name,
			note: "a branch named after a thread the board no longer has",
			path: null,
			branch: name,
		});
	}
	return items;
}



/**
 * Remove one item of that list, and only that one. A folder goes with the branch it stands on, in that
 * order, so a failed removal still leaves the name where the human can find it.
 */
export function removeFragment(board, asked) {
	const item = fragmentsOf(board).find((candidate) => sameFragment(candidate, asked));
	if (!item) return null;
	const repo = repoOf(board.folder);
	const steps = [];
	if (item.kind === "branch") {
		steps.push({ what: "branch", ...discardBranch(repo, item.branch) });
	} else {
		const tree = { path: item.path, branch: item.branch ?? "", repo };
		const record = board.trees.find((held) => sameFolder(held.path, item.path)) ?? tree;
		steps.push({ what: "tree", ...discardTree(board, record) });
		steps.push({ what: "branch", ...discardBranch(repo, item.branch) });
	}
	return { branch: item.branch, path: item.path, steps, note: stepsNote(steps) };
}



/** The item a request names: by the folder when it has one, else by the branch. */
function sameFragment(item, asked) {
	if (item.kind !== asked.kind) return false;
	if (asked.path) return sameFolder(item.path, asked.path);
	return Boolean(asked.branch) && item.branch === asked.branch;
}



/** Why a sweep left this tree standing: the work in it nobody has merged, said as one short phrase. */
function whyKept(tree) {
	if (!existsSync(tree.path)) return "";
	const status = gitIn(tree.path, ["status", "--porcelain"], 10_000);
	const changes = status.ok ? status.out.split("\n").filter(Boolean).length : 0;
	if (changes) return `it holds ${changes} uncommitted change(s)`;
	if (!tree.base) return "";
	const ahead = gitIn(tree.path, ["rev-list", "--count", `${tree.base}..HEAD`]);
	const commits = ahead.ok ? Number(ahead.out) || 0 : 0;
	return commits ? `${commits} commit(s) are not in ${tree.base}` : "";
}
