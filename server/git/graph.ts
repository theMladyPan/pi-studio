// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The picture the strip draws: the branches, where they sit relative to the checked out one, and what
 * the working tree looks like. Polled, so it is also the module that decides when the picture changed.
 */
import { gitIn } from "./repo.ts";
import { existsSync } from "node:fs";
import { broadcast } from "../bus.ts";



/** How many commits the strip has to draw with, and how often a watched board looks for a change. */
export const GIT_ROWS = 40;


export const GIT_TICK = 3000;



/**
 * A ref as the strip draws it: the name on the pill, and what kind of name it is. `HEAD -> dev` is
 * the branch this checkout stands on, a bare `HEAD` is a detached one, `tag: v1` is a tag, and
 * anything under a remote's name is remote.
 */
export function refName(raw, remotes) {
	const head = raw === "HEAD" || raw.startsWith("HEAD -> ");
	const tag = raw.startsWith("tag: ");
	const name = raw === "HEAD" ? "HEAD" : head ? raw.slice(8) : tag ? raw.slice(5) : raw;
	const kind = head
		? "head"
		: tag
			? "tag"
			: remotes.some((remote) => name.startsWith(`${remote}/`))
				? "remote"
				: "branch";
	return { name, kind };
}



/**
 * The commits the strip draws, newest first over every ref, with the parents it needs for its lanes
 * and the refs it draws as pills. One `git log`, about 6 ms in a repository of this size.
 *
 * Hashes are the full ones, on both sides: `%h` is as long as `core.abbrev` says, so a repository
 * that shortens nothing and a checkout reporting seven characters would never match a commit.
 */
export function gitGraph(repo, remotes) {
	const log = gitIn(
		repo,
		["log", "--all", "--topo-order", "-n", String(GIT_ROWS), "--pretty=format:%H\u001f%P\u001f%D\u001f%s"],
		3000,
	);
	if (!log.ok) return [];
	return log.out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, parents, refs, subject] = line.split("\u001f");
			return {
				hash: hash ?? "",
				parents: (parents ?? "").split(" ").filter(Boolean),
				refs: (refs ?? "")
					.split(", ")
					.filter(Boolean)
					.map((ref) => refName(ref, remotes)),
				subject: subject ?? "",
			};
		});
}



/**
 * What one checkout holds: the branch it is on, how far it is from its upstream, and how much is
 * uncommitted, in the four states the strip colours apart. `head` is the commit, so a lane's tip can
 * be found even when the tree is detached and has no branch to name it by.
 */
export function gitStatusOf(path) {
	const out = gitIn(path, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"], 3000);
	if (!out.ok) return null;
	const state = { head: "", branch: "", detached: true, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
	for (const line of out.out.split("\n")) {
		if (!line) continue;
		// The whole oid, because that is what `gitGraph` puts on a commit and what a strip matches on.
		if (line.startsWith("# branch.oid ")) state.head = line.slice(13).trim();
		else if (line.startsWith("# branch.head ")) {
			const name = line.slice(14).trim();
			state.detached = name === "(detached)";
			state.branch = state.detached ? "" : name;
		} else if (line.startsWith("# branch.ab ")) {
			const counts = /\+(\d+) -(\d+)/.exec(line);
			if (counts) {
				state.ahead = Number(counts[1]);
				state.behind = Number(counts[2]);
			}
		} else if (line.startsWith("? ")) state.untracked += 1;
		else if (line.startsWith("u ")) state.conflicts += 1;
		else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			// A porcelain=v2 row carries the two status letters: staged in X, unstaged in Y.
			const xy = line.slice(2, 4);
			if (xy[0] !== ".") state.staged += 1;
			if (xy[1] !== ".") state.unstaged += 1;
		}
	}
	state.dirty = state.staged + state.unstaged + state.untracked + state.conflicts;
	return state;
}



/**
 * Everything the strip draws, in one payload: the commit graph, the refs on it as pills, and one
 * row per worktree with its own dirt and whether a child is working in it. Null when the workspace
 * is not a repository, which is the strip's way of saying it has nothing to show.
 */
export function gitPicture(board) {
	const top = gitIn(board.folder, ["rev-parse", "--show-toplevel"], 2000);
	const repo = top.ok ? top.out : "";
	if (!repo) return null;
	const remotes = gitIn(repo, ["remote"], 2000).out.split("\n").filter(Boolean);
	const root = gitStatusOf(repo);
	if (!root) return null;
	const trees = board.trees.map((tree) => {
		const status = existsSync(tree.path) ? gitStatusOf(tree.path) : null;
		const thread = tree.thread ? board.threads.get(tree.thread) : null;
		return {
			thread: tree.thread ?? "",
			title: thread?.title ?? "",
			path: tree.path,
			base: tree.base,
			branch: tree.branch ?? status?.branch ?? "",
			head: status?.head ?? "",
			live: Boolean(tree.thread && board.children.has(tree.thread)),
			dirty: status?.dirty ?? 0,
			staged: status?.staged ?? 0,
			unstaged: status?.unstaged ?? 0,
			untracked: status?.untracked ?? 0,
			conflicts: status?.conflicts ?? 0,
		};
	});
	return { repo, root, trees, graph: gitGraph(repo, remotes), at: Date.now() };
}



/**
 * What the picture says, without the moment it was read. The clock is in the payload so a tab can say
 * how old it is, and it must not be part of the change test: a repository nobody touched is not news.
 */
export function gitFingerprint(picture) {
	if (!picture) return "";
	const { at, ...said } = picture;
	return JSON.stringify(said);
}



/** Rebuild the picture and tell the open tabs, but only when something really changed. */
export function refreshGit(board, force = false) {
	if (!force && !board.clients.size) return null;
	const picture = gitPicture(board);
	const stamp = gitFingerprint(picture);
	if (!force && stamp === board.gitStamp) return board.git;
	board.gitStamp = stamp;
	board.git = picture;
	if (board.clients.size) broadcast(board, { type: "git", git: picture });
	return picture;
}



/**
 * Look again shortly after something that almost certainly changed the disk, so the strip answers the
 * turn that dirtied it rather than the tick three seconds later.
 */
export function noteGit(board) {
	if (board.gitSoon) return;
	board.gitSoon = setTimeout(() => {
		board.gitSoon = null;
		refreshGit(board);
	}, 400);
	if (typeof board.gitSoon.unref === "function") board.gitSoon.unref();
}



/** Watching costs a `git status` per worktree every tick, so it runs only while a tab is open. */
export function watchGit(board) {
	if (board.gitTimer) return;
	board.gitTimer = setInterval(() => refreshGit(board), GIT_TICK);
	if (typeof board.gitTimer.unref === "function") board.gitTimer.unref();
}



export function unwatchGit(board) {
	if (board.clients.size || !board.gitTimer) return;
	clearInterval(board.gitTimer);
	board.gitTimer = null;
}
