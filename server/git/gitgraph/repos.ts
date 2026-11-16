/**
 * Which repositories the Git Graph view is allowed to show: the board's own folder, and the trees its
 * threads work in when those trees belong to the same repository.
 *
 * The list is what the view's repository dropdown is drawn from, so it is also the list of folders a
 * page can name in a command. That is why a tree is checked rather than trusted: `board.trees` holds
 * records written by earlier runs, a tree can be moved or deleted by hand, and one record can point at
 * somebody else's repository. Only a folder that is its own git top level and shares the board folder's
 * common directory is listed, so every path in the map is a checkout of the repository the human opened.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { runGit } from "../exec.ts";

// ---------- shapes ----------

/** One repository the view can be pointed at, and the words the dropdown shows for it. */
export type RepoEntry = {
	path: string;
	kind: "folder" | "tree";
	label: string;
	threadId?: string;
	live: boolean;
	branch?: string;
};

/**
 * What `reposFor` reads off a board: its folder, the trees it made, the threads that own them, and the
 * children running now. Structural rather than the board itself, so a test can hand it a plain object.
 */
export type RepoBoardLike = {
	folder: string;
	trees: Array<{ path: string; branch?: string; thread?: string }>;
	threads: Map<string, { id?: string; title?: string }>;
	children: Map<string, unknown>;
};

// ---------- reading one folder ----------

/** A path as the kernel sees it, or "" when it has gone since it was named. */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return "";
	}
}

/** The top level of the checkout a folder sits in, which is the folder itself for a checkout's root. */
async function topLevel(folder: string): Promise<string> {
	if (!folder || !existsSync(folder)) return "";
	const found = await runGit(folder, ["rev-parse", "--show-toplevel"], { kind: "read" });
	const text = found.ok ? found.stdout.toString("utf8").trim() : "";
	return text ? realPath(text) : "";
}

/**
 * The `.git` a checkout shares with the rest of its repository, as a real path. A linked worktree has
 * one of its own and points at the main one here, which is how a tree is told apart from a repository
 * that merely happens to sit somewhere nearby.
 */
async function commonDir(folder: string): Promise<string> {
	const found = await runGit(folder, ["rev-parse", "--git-common-dir"], { kind: "read" });
	const text = found.ok ? found.stdout.toString("utf8").trim() : "";
	// git prints this path relative to the folder it ran in, so it is resolved from there and not from
	// the daemon's own working directory.
	return text ? realPath(resolve(folder, text)) : "";
}

/** The branch a checkout stands on, or `detached`, which is what `HEAD` means when no branch names it. */
async function currentBranch(path: string): Promise<string> {
	const head = await runGit(path, ["rev-parse", "--abbrev-ref", "HEAD"], { kind: "read" });
	const name = head.ok ? head.stdout.toString("utf8").trim() : "";
	return name && name !== "HEAD" ? name : "detached";
}

// ---------- the list ----------

/**
 * Every repository the view may show, the board's folder first and its trees after it, keyed by real
 * path so two records pointing at one checkout appear once.
 *
 * A folder that is not a repository answers an empty map rather than a list of trees: a tree is only
 * ever a checkout of the repository the workspace opened, and no repository means nothing to compare.
 */
export async function reposFor(board: RepoBoardLike): Promise<Map<string, RepoEntry>> {
	const repos = new Map<string, RepoEntry>();
	const folderRoot = await topLevel(board.folder);
	if (!folderRoot) return repos;
	const folderCommon = await commonDir(board.folder);
	repos.set(folderRoot, { path: folderRoot, kind: "folder", label: basename(folderRoot), live: false });
	for (const tree of board.trees) {
		if (!tree?.path || !existsSync(tree.path)) continue;
		const treeRoot = await topLevel(tree.path);
		// A tree record pointing at a subfolder of a checkout would otherwise be drawn as a second
		// repository for one branch of one repository.
		if (!treeRoot || treeRoot !== realPath(tree.path)) continue;
		if (repos.has(treeRoot)) continue;
		const treeCommon = await commonDir(tree.path);
		// A folder that is a repository of its own is somebody else's work, and nothing here may point
		// a command at it.
		if (!treeCommon || treeCommon !== folderCommon) continue;
		const branch = tree.branch || (await currentBranch(tree.path));
		const thread = tree.thread ? board.threads.get(tree.thread) : undefined;
		repos.set(treeRoot, {
			path: treeRoot,
			kind: "tree",
			label: thread?.title ? `${branch} · ${thread.title}` : branch,
			...(tree.thread ? { threadId: tree.thread } : {}),
			// A tree whose thread has a child running is the one being written to, which is what the
			// dropdown marks. The strip reads the same fact the same way.
			live: Boolean(tree.thread && board.children.has(tree.thread)),
			branch,
		});
	}
	return repos;
}
