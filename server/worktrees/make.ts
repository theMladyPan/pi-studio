// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Making a worktree for a thread: the branch name it gets, the folder under `.agents/`, and the branch
 * it is cut from.
 */
import { baseRef, gitIn, repoOf } from "../git/repo.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";



// ---------- the git picture the strip draws -------------------------------

/** Where a board keeps the trees it makes, inside the repository the workspace is. */
export const AGENTS_DIR = ".agents";



// ---------- worktrees ------------------------------------------------------

/** The kinds of branch a thread can be given, and the words in a title that pick one. */
export const WORK_TYPES = [
	["fix", /\b(fix|fixed|bug|broken|breaks|repair|wrong|fails?|failing|regression)\b/],
	["refactor", /\b(refactor|rename|extract|split|move|tidy|simplif(y|ies)|clean ?up)\b/],
	["docs", /\b(docs?|readme|document|documentation|comment|comments)\b/],
	["test", /\b(tests?|spec|specs|coverage)\b/],
	["chore", /\b(chore|bump|upgrade|deps?|dependencies|lint)\b/],
];



/** The kind of change a title reads like, so a branch says what it carries. */
export function workType(title, wanted) {
	if (WORK_TYPES.some(([type]) => type === wanted)) return wanted;
	const words = String(title ?? "").toLowerCase();
	return WORK_TYPES.find(([, pattern]) => pattern.test(words))?.[0] ?? "feat";
}



/** A title as a branch and folder segment: lowercase words with hyphens between them. */
export function slugOf(text) {
	return (
		String(text ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40) || "work"
	);
}



/**
 * What a thread's branch and folder are told apart by: the first eight hex of its own id.
 * `8c53f1d7` is unique without a counter and without a suffix for two threads that share a title,
 * and it is short enough to read in a path.
 */
export function shortId(thread) {
	return String(thread.id).slice(0, 8);
}



/**
 * The tree a thread works in, made the first time it is asked to do something. A board runs several
 * threads against one folder; a tree of its own is what keeps two of them out of the same file, and
 * what the card can point at when the human wants to see the work.
 */
export function ensureWorktree(board, thread) {
	if (thread.worktree) return thread.worktree;
	const repo = repoOf(thread.folder ?? board.folder);
	if (!repo) {
		thread.worktree = { skipped: "this folder is not a git repository" };
		return thread.worktree;
	}
	const base = baseRef(repo);
	if (!base) {
		thread.worktree = { skipped: "the repository has no branch to cut from" };
		return thread.worktree;
	}
	const short = shortId(thread);
	const path = join(repo, AGENTS_DIR, short);
	// Detached on purpose. A branch is a name for work, and the work is not known until the child has
	// read the code: a name invented from the request is one the work has to be renamed out of later,
	// and a request that is only a question never earns a branch at all.
	const added = gitIn(repo, ["worktree", "add", "--detach", path, base], 10_000);
	if (!added.ok) {
		thread.worktree = { skipped: `git worktree add failed: ${added.err.split("\n")[0] || "no reason given"}` };
		return thread.worktree;
	}
	const tree = {
		path,
		base,
		repo,
		// A tree git can see is a tree in `git status` of the main checkout, which is what the human
		// reads. Said on the card rather than fixed behind their back.
		ignored: gitIn(repo, ["check-ignore", "--quiet", join(AGENTS_DIR, short)]).ok,
		thread: thread.id,
		title: thread.title,
		at: Date.now(),
	};
	// The board keeps the record, not only the thread: a thread that is closed or cleared would
	// otherwise leave a tree on disk that nothing knows about, and no later `clean` could retire it.
	board.trees.push(tree);
	thread.worktree = tree;
	return tree;
}



/** Where a thread works: its own tree while that is still on disk, else the workspace folder. */
export function workdirOf(board, thread) {
	const tree = thread.worktree;
	return tree?.path && existsSync(tree.path) ? tree.path : board.folder;
}



/** The branch a tree is standing on, or "" while it is detached or unreadable. */
export function headBranch(path) {
	const head = gitIn(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return head.ok && head.out && head.out !== "HEAD" ? head.out : "";
}
