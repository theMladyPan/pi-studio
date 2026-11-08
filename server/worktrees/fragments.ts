/**
 * What a trash action would take, and what earlier ones left behind: the leftovers a board can still see
 * are folders and branches that belonged to threads nothing answers for any more.
 */
import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { baseRefSoon, gitIn, gitSoon, repoOf, repoOfSoon } from "../git/repo.ts";
import { AGENTS_DIR, DEFAULT_WORK_TYPE, WORK_TYPES } from "./make.ts";
import {
	branchRefusal,
	discardBranch,
	discardTree,
	registrationsSoon,
	sameFolder,
	treeBranch,
	treeRepo,
} from "./retire.ts";



/** How much of a diff the preview hands the browser: enough to read, small enough to draw at once. */
export const PREVIEW_DIFF_CHARS = 8000;

/** How many of a folder's new files the preview names, one per line: past this its count is the answer. */
export const PREVIEW_NEW_FILES = 20;

/** How many of a folder's ignored files the preview names, one per line, on the same rule. */
export const PREVIEW_IGNORED_FILES = 20;



/** The tree record a board keeps for a thread's folder: its own pointer, or the board's record for it. */
type TreeRecord = { path: string; branch?: string; base?: string; repo?: string; thread?: string };

/** A thread as these reads see it: its id, the title a sheet shows, and the folder it works in. */
type ThreadLike = { id: string; title?: string; worktree?: TreeRecord };

/** The board as these reads see it: its folder, the threads it answers for, its trees and its trash. */
type BoardLike = {
	folder: string;
	threads: Map<string, unknown>;
	trees: TreeRecord[];
	trash?: { kind?: string; thread?: ThreadLike | null }[];
};

/** One step of a removal, as the receipt the client draws reads it. */
type Step = { what: string; ok: boolean; note?: string };

/** One thing the board can still clear away, and what clearing it would take. */
type Fragment = {
	kind: string;
	label: string;
	note: string;
	path: string | null;
	branch: string | null;
	work: boolean;
};



const TYPES = [...WORK_TYPES.map(([type]) => type), DEFAULT_WORK_TYPE].join("|");

/**
 * A branch in the shape a thread's branches take: `<type>/<slug>-<8hex>`, the eight hex being the start of
 * the thread's own id. Anything else is a branch a human made, which no sweep of this board touches. The
 * types are the ones a branch is given, the default among them, because a title with no keyword of its own
 * is given that one and its branches are as real as any other.
 */
const THREAD_BRANCH = new RegExp(`^(?:${TYPES})/[a-z0-9-]+-([0-9a-f]{8})$`);



/** A number and the word beside it, in the wording the board's sheets already count with. */
function counted(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}



/** The tree record a thread works in: its own pointer, or the board's record for it. */
export function treeOf(board: BoardLike, thread?: ThreadLike | null): TreeRecord | undefined {
	if (thread?.worktree?.path) return thread.worktree;
	return board.trees.find((tree) => tree.thread === thread?.id);
}



/** What a step that failed says, as one sentence for the caller: null when every step went through. */
export function stepsNote(steps: Step[]): string | null {
	const failed = steps.filter((step) => !step.ok);
	return failed.length ? failed.map((step) => `${step.what}: ${step.note}`).join("; ") : null;
}



/** How many git commands a scan runs at once: a wide board must not start a hundred programs in one breath. */
const GIT_AT_ONCE = 8;



/** Run one promise per item, a few at a time, and answer in the order the items came in. */
async function atMost<T, R>(items: T[], atOnce: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const hands = Array.from({ length: Math.min(atOnce, items.length) }, async () => {
		while (next < items.length) {
			const at = next++;
			out[at] = await work(items[at]);
		}
	});
	await Promise.all(hands);
	return out;
}



/** How many paths a folder holds uncommitted, untracked ones among them: `git status` counts both. */
async function changesIn(path: string): Promise<number> {
	if (!existsSync(path)) return 0;
	const status = await gitSoon(path, ["status", "--porcelain"], 10_000);
	return status.ok ? status.out.split("\n").filter(Boolean).length : 0;
}



/** How many commits a ref holds past a base, read in a folder that can see both. */
async function commitsPast(at: string, base: string, ref: string): Promise<number> {
	if (!base) return 0;
	const read = await gitSoon(at, ["rev-list", "--count", `${base}..${ref}`], 10_000);
	return read.ok ? Number(read.out) || 0 : 0;
}



/**
 * Every local branch, and how many commits each holds past `from`. One `for-each-ref` answers both halves
 * when git can count `ahead` itself; a git too old for that names the branches in one call and then counts
 * only the ones holding anything, a few at a time, instead of once per branch on the board.
 */
async function branchFacts(repo: string, from: string): Promise<{ names: string[]; ahead: Map<string, number> }> {
	const ahead = new Map<string, number>();
	const ascend = (out: string) => out.split("\n").map((line) => line.trim()).filter(Boolean);
	if (!from) {
		const plain = await gitSoon(repo, ["for-each-ref", "refs/heads", "--format=%(refname:short)"], 10_000);
		return { names: plain.ok ? ascend(plain.out) : [], ahead };
	}
	const one = await gitSoon(repo, ["for-each-ref", "refs/heads", `--format=%(refname:short)\t%(ahead-behind:${from})`], 10_000);
	if (one.ok && one.out) {
		let read = true;
		const names: string[] = [];
		for (const line of one.out.split("\n")) {
			const [name, counts] = line.split("\t");
			const [up] = (counts ?? "").split(" ");
			if (!name) continue;
			if (!/^\d+$/.test(up ?? "")) {
				read = false;
				break;
			}
			names.push(name.trim());
			ahead.set(name.trim(), Number(up));
		}
		if (read) return { names, ahead };
		ahead.clear();
	}
	const [plain, merged] = await Promise.all([
		gitSoon(repo, ["for-each-ref", "refs/heads", "--format=%(refname:short)"], 10_000),
		gitSoon(repo, ["for-each-ref", `--no-merged=${from}`, "refs/heads", "--format=%(refname:short)"], 10_000),
	]);
	const holders = merged.ok ? ascend(merged.out) : [];
	const counts = await atMost(holders, GIT_AT_ONCE, async (name: string) => [name, await commitsPast(repo, from, name)] as const);
	for (const [name, count] of counts) ahead.set(name, count);
	return { names: plain.ok ? ascend(plain.out) : [], ahead };
}



/**
 * What removing a thread would take, so the human reads the work before it goes: the branch, the folder,
 * how much is uncommitted in it, how much is on the branch alone, and the patch itself. Nothing is touched.
 */
export function removePreview(board: BoardLike, thread: ThreadLike) {
	const tree = treeOf(board, thread);
	const repo = tree ? treeRepo(board, tree) : repoOf(board.folder);
	const path = tree?.path ?? "";
	const present = path ? existsSync(path) : false;
	// Read from the disk, because a record's own branch is written when the child settles and may be stale.
	const branch = (tree ? treeBranch(repo, tree) : "") || tree?.branch || "";
	const base = tree?.base ?? "";
	let dirty = 0;
	let fresh: string[] = [];
	let ignored = 0;
	let ignoredNames: string[] = [];
	let commits = 0;
	let raw = "";
	if (present) {
		// `-z` is the only form that hands a name back as it is on disk: the line form quotes one holding a
		// space and escapes one outside ascii, and the sheet draws what it is given.
		const status = gitIn(path, ["status", "--porcelain", "-z"], 10_000);
		const fields = status.ok ? status.out.split("\0").filter(Boolean) : [];
		const lines: string[] = [];
		for (let at = 0; at < fields.length; at += 1) {
			lines.push(fields[at]);
			// A rename or a copy names its source in the field after it, which is no change of its own.
			if (/[RC]/.test(fields[at].slice(0, 2))) at += 1;
		}
		dirty = lines.length;
		// A file git has never seen is a change `git diff HEAD` cannot draw, so its name is what the sheet
		// has to say: a count of changes with an empty diff under it reads as a folder holding nothing.
		fresh = lines.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
		// `--ignored=matching` is the only place git lists the files its own removal deletes without asking.
		// `-z` for the same reason as above: the sheet draws the name it is given, and the line form would
		// hand it the quoting git puts around one holding a space. An ignored entry names no source, so no
		// field is skipped here.
		const also = gitIn(path, ["status", "--porcelain", "-z", "--ignored=matching"], 10_000);
		const gone = also.ok ? also.out.split("\0").filter((field) => field.startsWith("!! ")) : [];
		ignored = gone.length;
		ignoredNames = gone.map((field) => field.slice(3));
	}
	if (base) {
		// The tree's own HEAD is what its commits hang on while it is on disk; a deleted folder leaves only
		// the branch. A run that answered a question never cut one, and then there is nothing to count.
		const ref = present ? "HEAD" : branch ? `refs/heads/${branch}` : "";
		const read = ref ? gitIn(present ? path : repo, ["rev-list", "--count", `${base}..${ref}`]) : null;
		commits = read?.ok ? Number(read.out) || 0 : 0;
	}
	// A dirty room is what the human is about to lose, so its working tree is the diff; a clean one shows the
	// commits of its own that the base does not have.
	if (present && dirty) raw = gitIn(path, ["diff", "HEAD"], 10_000).out;
	else if (present && commits) raw = gitIn(path, ["diff", `${base}..HEAD`], 10_000).out;
	const note = !path
		? "this thread has no folder of its own"
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
		// The new files the diff above cannot show: each name alone while they fit, their count when not.
		new: fresh.length > PREVIEW_NEW_FILES ? fresh.length : fresh,
		ignored,
		// The wildcard files the folder's removal takes without asking, named while they fit.
		ignoredNames: ignoredNames.length > PREVIEW_IGNORED_FILES ? [] : ignoredNames,
		diff: raw.slice(0, PREVIEW_DIFF_CHARS),
		trunc: raw.length > PREVIEW_DIFF_CHARS,
		note,
	};
}



/** What `ctrl+z` would still put back whole, folder and branch with it: nothing the trash holds is left over. */
function restorable(board: BoardLike): Set<string> {
	const back = new Set<string>();
	for (const entry of Array.isArray(board.trash) ? board.trash : []) {
		if (entry?.kind === "thread" && entry.thread?.id) back.add(String(entry.thread.id));
	}
	return back;
}



/** How long one scan stands: long enough for the sheet and the clear pressed under it to share one answer. */
export const SCAN_FRESH_MS = 10_000;

/** The last scan of each board, so the sheet and a press under it do not make git answer the same twice. */
const scans = new WeakMap<object, { at: number; items: Fragment[] }>();



/**
 * What the board can still clear away: a record whose thread is gone and whose folder git still has, a folder
 * in `.agents` that git holds and the board never recorded, and a thread's branch with no thread left to hold
 * it. A trunk is never one of them, and neither is a branch a human named. A scan is kept for a few seconds,
 * because the sheet that lists the leftovers and the press that clears one ask the same question twice.
 */
export async function fragmentsOf(board: BoardLike): Promise<Fragment[]> {
	const held = scans.get(board);
	if (held && Date.now() - held.at < SCAN_FRESH_MS) return held.items;
	const items = await scanFragments(board);
	scans.set(board, { at: Date.now(), items });
	return items;
}



/** Drop the scan held for a board: the next read is the disk's, not an answer older than the last removal. */
export function forgetFragments(board: BoardLike): void {
	scans.delete(board);
}



/** One pass over the disk: one question per folder, and one for every branch at once. */
async function scanFragments(board: BoardLike): Promise<Fragment[]> {
	const repo = await repoOfSoon(board.folder);
	if (!repo) return [];
	const [listed, from] = await Promise.all([registrationsSoon(repo), baseRefSoon(repo)]);
	const registered = listed ?? [];
	// Every branch and its own count, started now and read at the end: the folders below are the slow part,
	// and this answer is ready long before they are.
	const branchesHeld = branchFacts(repo, from);
	// A branch belongs to a folder item when that folder is still standing: the folder goes first and takes
	// its branch with it, so listing the name again would offer to remove a thing twice.
	const covered = new Set<string>(board.trees.map((tree) => tree.branch).filter((name): name is string => Boolean(name)));
	for (const entry of registered) if (entry.branch && existsSync(entry.path)) covered.add(entry.branch);
	const back = restorable(board);
	// A thread the trash still holds keeps its branch off this list as well as its folder: a child that cut
	// its own branch never taught the tree record the name, so this loop is the last place a branch the undo
	// has promised back could still be offered for removal.
	const live = new Set([...board.threads.keys(), ...back].map((id) => String(id).slice(0, 8)));
	// Every folder this scan will name, read at once: its branch off the disk, and what it still holds. A
	// thread the trash still holds comes back whole on `ctrl+z`, and its folder with it, so it is no leftover
	// at all — only its branch's name is read, because that name keeps the folder's own off the list.
	const chased = board.trees.filter(
		(tree) => !(tree.thread && board.threads.has(tree.thread)) && registered.some((entry) => sameFolder(entry.path, tree.path)),
	);
	const facts = await atMost(chased, GIT_AT_ONCE, async (tree) => {
		const entry = registered.find((one) => sameFolder(one.path, tree.path));
		// The name the disk answers with is the one that goes with the folder, recorded or not: `worktree list`
		// read it off every folder in one call, so no folder is asked for its own HEAD here.
		const branch: string = entry?.branch || tree.branch || "";
		const promised = Boolean(tree.thread && back.has(String(tree.thread)));
		return { tree, branch, promised, why: promised ? "" : await whyKept(tree) };
	});
	const items: Fragment[] = [];
	for (const { tree, branch, promised, why } of facts) {
		if (branch) covered.add(branch);
		if (promised) continue;
		items.push({
			kind: "tree",
			label: branch || basename(tree.path),
			note: `the folder of a thread the board no longer has${why ? `, and ${why}` : ", which no sweep has taken yet"}`,
			path: tree.path,
			branch: branch || null,
			work: Boolean(why),
		});
	}
	const kept = join(repo, AGENTS_DIR) + sep;
	// The main checkout is a registration of its own, and a tree outside `.agents` is where a human put it.
	const orphaned = registered.filter(
		(entry) =>
			!sameFolder(entry.path, repo) &&
			resolve(entry.path).startsWith(kept) &&
			!board.trees.some((tree) => sameFolder(tree.path, entry.path)),
	);
	// The folder's commits are counted past the base its work would merge into. A repository that cannot name
	// one leaves the count unreadable, and unreadable is not a folder holding nothing.
	const orphanWhy = await atMost(orphaned, GIT_AT_ONCE, (entry) => whyKept({ path: entry.path, base: from }));
	for (const [at, entry] of orphaned.entries()) {
		const why = orphanWhy[at] || (from ? "" : "whose commits the board cannot count");
		items.push({
			kind: "orphan",
			label: entry.branch || basename(entry.path),
			note: `a folder the board has no record of${why ? `, and ${why}` : ", which no sweep has taken yet"}`,
			path: entry.path,
			branch: entry.branch || null,
			work: Boolean(why),
		});
	}
	const { names, ahead } = await branchesHeld;
	for (const name of names) {
		const suffix = name.match(THREAD_BRANCH)?.[1];
		if (!suffix || live.has(suffix) || covered.has(name)) continue;
		const aheadOf = ahead.get(name) ?? 0;
		const why = aheadOf ? `it holds ${counted(aheadOf, "commit")} that ${aheadOf === 1 ? "is" : "are"} not in ${from}` : "";
		items.push({
			kind: "branch",
			label: name,
			note: `a branch named after a thread the board no longer has${why ? `, and ${why}` : ""}`,
			path: null,
			branch: name,
			work: Boolean(aheadOf),
		});
	}
	return items;
}



/**
 * Remove one item of that list, and only that one. A folder goes with the branch it stands on, in that
 * order, so a failed removal still leaves the name where the human can find it. The branch is only asked
 * for once the folder is really gone: a branch deleted under a folder git would not remove leaves the work
 * with no name to reach it by.
 */
export async function removeFragment(board: BoardLike, asked: { kind: string; path: string; branch: string }) {
	const item = (await fragmentsOf(board)).find((candidate) => sameFragment(candidate, asked));
	if (!item) return null;
	// The list held for the board is the one from before this removal, so the next read asks the disk again.
	forgetFragments(board);
	const repo = repoOf(board.folder);
	const steps: Step[] = [];
	if (item.kind === "branch") {
		steps.push({ what: "branch", ...discardBranch(repo, item.branch) });
	} else {
		const tree = { path: item.path, branch: item.branch ?? "", repo };
		const record = board.trees.find((held) => sameFolder(held.path, item.path)) ?? tree;
		steps.push({ what: "tree", ...discardTree(board, record) });
		if (steps[0].ok) steps.push({ what: "branch", ...discardBranch(repo, item.branch) });
	}
	return { branch: item.branch, path: item.path, steps, note: stepsNote(steps) };
}



/** The item a request names: by the folder when it has one, else by the branch. */
function sameFragment(item: Fragment, asked: { kind: string; path: string; branch: string }): boolean {
	if (item.kind !== asked.kind) return false;
	if (asked.path) return sameFolder(item.path, asked.path);
	return Boolean(asked.branch) && item.branch === asked.branch;
}



/** Why a sweep left this folder standing: the work nobody has merged, said as one short phrase. */
async function whyKept(tree: TreeRecord): Promise<string> {
	const changes = await changesIn(tree.path);
	if (changes) return `it holds ${counted(changes, "uncommitted change")}`;
	const commits = await commitsPast(tree.path, tree.base ?? "", "HEAD");
	return commits ? `it holds ${counted(commits, "commit")} that ${commits === 1 ? "is" : "are"} not in ${tree.base}` : "";
}
