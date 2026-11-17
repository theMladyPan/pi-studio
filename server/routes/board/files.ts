/**
 * The Explorer's backend: one listing of the human's own folder, and the five narrow changes an explorer
 * asks of it — a new empty file or folder, a rename, a move, a copy and a delete.
 *
 * It is not `/browse`. That route answers the composer's path pickers, including a thread's own worktree
 * for a `!` line, and it is the completion a command is written from; its answer is a flat list of
 * absolute paths and a rename there would move a child's tree. An explorer edits the workspace itself, so
 * this file reads `board.folder` and nothing else: never a thread's tree, never a card's file, never a
 * path a request names above the root.
 *
 * What keeps the folder safe is one rule at the door and one at the disk. `normalizeRel` folds a request
 * into a relative POSIX path or refuses it, so `..`, an absolute path, a control character and the
 * repository's own `.git` never become a target. `physicalDir` then resolves the folder a write lands in
 * with `realpath`, so a directory link pointing out of the workspace is a refusal rather than a way to
 * write elsewhere. A link that points inside the workspace is allowed, and `canonical` in the listing
 * tells the client which directory a link really is, so it can refuse to expand a loop.
 *
 * Every change is no-overwrite. A file or a link is placed with a call that fails when the name is taken
 * (`link`, `symlink`, `open` with `wx`, `copyFile` with `COPYFILE_EXCL`); a folder is moved after a check
 * and the check is not a lock, so an outside writer can still win that window. The code says that in one
 * place rather than pretending a guarantee it does not have.
 *
 * Deleting goes through the system's Trash with `gio`, one spawn per path, no shell. A path that cannot
 * be trashed is reported back for the human to confirm, and confirmation is a second request that names
 * `permanent: true`; a failed trash never turns into a permanent delete behind their back. A `gio` that
 * fails is not taken as proof nothing happened: the path is checked, and a path that is gone is named as
 * deleted whatever the exit code said.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
	closeSync,
	constants as fsConstants,
	copyFileSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	linkSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, sep } from "node:path";
import { runGit } from "../../git/exec.ts";
import { answer, fail, readJson } from "../../http.ts";
import { CONTROL_CHARS } from "../../limits.ts";

/** The board's folder is the whole of this surface's world; nothing else is read from a board. */
type BoardFolder = { folder: string };

/** A name the explorer draws. `git` is the porcelain status of that path when the listing asked for it. */
type Entry = { name: string; path: string; dir: boolean; size: number; mtime: number; link: boolean; git?: string };

/** One path a batch could not carry, and the sentence a human can act on. */
type Failure = { path: string; error: string };

/** One source a validated batch will move or copy, already resolved on disk. */
type Source = { rel: string; abs: string; name: string; dir: boolean };

/** A page of a folder. Two hundred is the same ceiling the path picker has, and the cursor is a name. */
const MAX_PAGE = 200;

/** One request may carry this many paths. Beyond it the request is a script, not a press. */
const MAX_BATCH = 500;

/** A name on this filesystem, in bytes. */
const MAX_NAME_BYTES = 255;

/** The dirty folders a listing reports. A tree with more changed folders than this says so. */
const MAX_DIRTY = 2000;

/** `gio trash` either answers, or the request has waited long enough for a Trash that is not coming. */
const GIO_TIMEOUT_MS = 10_000;

/** How much porcelain is worth keeping: enough for a real checkout, not for a runaway `status`. */
const STATUS_BYTES = 8 * 1024 * 1024;

// ---------- words the routes and the listing share ----------

/** Why a call on the disk failed, in a sentence a card can show. */
function say(error: unknown): string {
	const held = error as NodeJS.ErrnoException;
	return held?.message || String(error);
}

/** A resolved path is inside the root, or it is the root itself. */
function inside(root: string, target: string): boolean {
	const edge = root.endsWith(sep) ? root : `${root}${sep}`;
	return target === root || target.startsWith(edge);
}

/** The workspace root as the disk spells it, or null when the folder is gone or is a link to nowhere. */
function realRoot(board: BoardFolder): string | null {
	try {
		return realpathSync(board.folder);
	} catch {
		return null;
	}
}

/** A path below the root, spelled the way the contract spells paths: relative and with forward slashes. */
function relativeRel(root: string, abs: string): string {
	const rel = relative(root, abs);
	return rel === "" ? "" : rel.split(sep).join("/");
}

/**
 * The requested path as the listing and the batch routes understand it: relative, `.` and empty segments
 * folded away, and every way out refused. `..` is refused wherever it appears rather than resolved,
 * because a request that climbed and came back is still a request that meant to leave.
 */
function normalizeRel(raw: unknown): { rel: string } | { error: string } {
	if (raw === undefined || raw === null) return { rel: "" };
	if (typeof raw !== "string") return { error: "a path is a string" };
	if (CONTROL_CHARS.test(raw)) return { error: "a path holds a control character" };
	const kept: string[] = [];
	for (const part of raw.replace(/^\/+/, "").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") return { error: `${raw} is outside the workspace` };
		if (part === ".git") return { error: "the repository's own folder is not part of the explorer" };
		kept.push(part);
	}
	return { rel: kept.join("/") };
}

/** One name in one folder: no separator, no `.`, no `..`, no control character, not `.git`. */
function normalizeName(raw: unknown): { name: string } | { error: string } {
	if (typeof raw !== "string" || !raw) return { error: "a name is required" };
	if (CONTROL_CHARS.test(raw)) return { error: "a name holds a control character" };
	if (raw.includes("/") || raw.includes("\\")) return { error: "a name is one path segment" };
	if (raw === "." || raw === "..") return { error: `${raw} is not a name` };
	if (raw === ".git") return { error: "the repository's own folder is not part of the explorer" };
	if (Buffer.byteLength(raw) > MAX_NAME_BYTES) return { error: `a name holds at most ${MAX_NAME_BYTES} bytes` };
	return { name: raw };
}

/** A folder a request may read or write in, resolved physically so a link out of the workspace is refused. */
function physicalDir(root: string, rel: string): { dir: string } | { error: string } {
	const wanted = rel ? join(root, ...rel.split("/")) : root;
	let real: string;
	try {
		real = realpathSync(wanted);
	} catch {
		return { error: `no such folder: ${rel || "."}` };
	}
	if (!inside(root, real)) return { error: `${rel} is outside the workspace` };
	let stat: Stats;
	try {
		stat = statSync(real);
	} catch (error) {
		return { error: `${rel || "."}: ${say(error)}` };
	}
	if (!stat.isDirectory()) return { error: `${rel || "."} is not a folder` };
	return { dir: real };
}

/**
 * The entry a relative path names, with its parent resolved physically and its own name left alone. The
 * leaf is never resolved: a rename or a delete of a link acts on the link, so a `realpath` here would
 * quietly make it act on the target instead.
 */
function leafOf(root: string, rel: string): { abs: string; name: string } | { error: string } {
	const cut = rel.lastIndexOf("/");
	const dirRel = cut === -1 ? "" : rel.slice(0, cut);
	const name = cut === -1 ? rel : rel.slice(cut + 1);
	if (!name) return { error: `${rel} names no entry` };
	const parent = physicalDir(root, dirRel);
	if ("error" in parent) return parent;
	return { abs: join(parent.dir, name), name };
}

/**
 * Whether something already stands at this path. Only a missing entry is a free place to write; a folder
 * that cannot be read is treated as taken, so an operation that cannot see it does not write over it.
 */
function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * One entry of a listing. `dir` follows a link, because an icon and an expansion arrow are drawn from it;
 * nothing under an outside link is ever read — expansion of one is refused by `physicalDir`.
 */
function entryOf(path: string, name: string, abs: string, git?: string): Entry {
	const stat = lstatSync(abs);
	const link = stat.isSymbolicLink();
	let dir = stat.isDirectory();
	if (link) {
		try {
			dir = statSync(abs).isDirectory();
		} catch {
			// A link to nothing (or to a loop) is still an entry, and it is not a folder to expand.
			dir = false;
		}
	}
	return { name, path, dir, size: stat.size, mtime: Math.floor(stat.mtimeMs), link, ...(git ? { git } : {}) };
}

/** Dirs first by name, which is the sort the cursor is resumed by. */
function byName(a: Entry, b: Entry): number {
	if (a.dir !== b.dir) return a.dir ? -1 : 1;
	return a.name.localeCompare(b.name);
}

/**
 * Where a page resumes. A name that is still there resumes right after it, which is exact. A name that
 * went away since the last page is resumed as if it were a folder, the group that sorts first: that can
 * repeat an entry on the next page, and it can never hide one behind the cursor.
 */
function resumeAt(entries: Entry[], after: string): number {
	if (!after) return 0;
	const exact = entries.findIndex((one) => one.name === after);
	if (exact !== -1) return exact + 1;
	let at = 0;
	while (at < entries.length) {
		const one = entries[at];
		const before = one.dir ? one.name.localeCompare(after) < 0 : false;
		if (!before) break;
		at++;
	}
	return at;
}

/** The page size a request may ask for, never past the cap. */
function pageLimit(raw: string | null): number {
	const wanted = Number(raw);
	if (!Number.isInteger(wanted) || wanted <= 0) return MAX_PAGE;
	return Math.min(wanted, MAX_PAGE);
}

// ---------- git ----------

/** The top of the repository the folder belongs to, as the disk spells it, or "" when it is not one. */
async function gitToplevel(root: string): Promise<string> {
	const found = await runGit(root, ["rev-parse", "--show-toplevel"], { kind: "read", timeoutMs: 5000 });
	if (!found.ok) return "";
	const text = found.stdout.toString("utf8").trim();
	if (!text) return "";
	try {
		return realpathSync(text);
	} catch {
		return text;
	}
}

/**
 * One `git status` for the whole listing. The porcelain is read with `-z`, so a name holding a space, a
 * quote or a non-ASCII character is the name and not an escaped form, and the original half of a rename
 * record is skipped rather than counted as a second change.
 */
async function gitStatus(root: string, toplevel: string): Promise<{ statuses: Map<string, string>; dirty: string[]; dirtyTruncated: boolean }> {
	const statuses = new Map<string, string>();
	const prefix = toplevel === root ? "" : `${relativeRel(toplevel, root)}/`;
	if (prefix.startsWith("../")) return { statuses, dirty: [], dirtyTruncated: false };
	const result = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"], {
		kind: "read",
		timeoutMs: 10_000,
		maxBytes: STATUS_BYTES,
	});
	// A status that could not be read is not a clean tree, and saying so is better than drawing one.
	if (!result.ok && !result.stdout.length) return { statuses, dirty: [], dirtyTruncated: true };
	const records = result.stdout.toString("utf8").split("\0");
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		const named = record.slice(3);
		// The record after a rename is where the path came from, and it is not a second change.
		if (code.includes("R") || code.includes("C")) index++;
		if (prefix && !named.startsWith(prefix)) continue;
		const rel = prefix ? named.slice(prefix.length) : named;
		if (rel) statuses.set(rel, code.trim());
	}
	const dirty = dirtyFolders(statuses);
	return { statuses, dirty: dirty.folders, dirtyTruncated: dirty.truncated || result.truncated };
}

/** Every folder above a changed path, the workspace root included, so a collapsed row can be marked. */
function dirtyFolders(statuses: Map<string, string>): { folders: string[]; truncated: boolean } {
	const folders = new Set<string>();
	for (const path of statuses.keys()) {
		let at = path;
		for (;;) {
			const cut = at.lastIndexOf("/");
			at = cut === -1 ? "" : at.slice(0, cut);
			if (folders.has(at)) break;
			folders.add(at);
			if (at === "") break;
		}
	}
	const sorted = [...folders].sort((a, b) => a.localeCompare(b));
	return { folders: sorted.slice(0, MAX_DIRTY), truncated: sorted.length > MAX_DIRTY };
}

// ---------- copying and moving ----------

/**
 * Place one entry at a name that is free, and fail when it is not. Files and links are placed by a call
 * that the kernel makes refuse an existing name, so two requests racing for one name cannot both win.
 */
function copyNoClobber(src: string, dst: string): void {
	const stat = lstatSync(src);
	if (stat.isSymbolicLink()) {
		// A link is copied as a link: its target is not read and nothing outside the workspace is visited.
		symlinkSync(readlinkSync(src), dst);
		return;
	}
	if (stat.isDirectory()) {
		mkdirSync(dst);
		try {
			for (const name of readdirSync(src)) copyNoClobber(join(src, name), join(dst, name));
		} catch (error) {
			// What was made here is this call's own, so it goes rather than leaving half a folder behind.
			try {
				rmSync(dst, { recursive: true, force: true });
			} catch {}
			throw error;
		}
		return;
	}
	if (!stat.isFile()) throw new Error("only files, folders and links can be copied");
	copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
}

/**
 * Move one entry, never over an existing name.
 *
 * A file or a link is placed with an atomic no-clobber call and then removed, which is same-filesystem
 * only and refuses to overwrite. A folder is checked and then renamed: `rename` has no portable
 * no-replace form here, so another program that creates the destination in that window can still be
 * overwritten. That is the one race this file cannot close, and it is stated rather than papered over.
 * An entry on another device is copied no-clobber and its source removed, which is not atomic.
 */
function moveNoClobber(src: string, dst: string): void {
	const stat = lstatSync(src);
	if (stat.isSymbolicLink()) {
		try {
			symlinkSync(readlinkSync(src), dst);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
			copyNoClobber(src, dst);
			unlinkSync(src);
			return;
		}
		unlinkSync(src);
		return;
	}
	if (stat.isDirectory()) {
		if (present(dst)) throw Object.assign(new Error(`${dst} already exists`), { code: "EEXIST" });
		try {
			renameSync(src, dst);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		}
		copyNoClobber(src, dst);
		rmSync(src, { recursive: true, force: false });
		return;
	}
	if (!stat.isFile()) throw new Error("only files, folders and links can be moved");
	try {
		linkSync(src, dst);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") throw error;
		// A filesystem with no hard links, or a name already taken by a directory: copy and remove.
		copyNoClobber(src, dst);
		unlinkSync(src);
		return;
	}
	unlinkSync(src);
}

// ---------- the listing ----------

/**
 * One folder of the workspace, in pages. The board's folder is the root, so this lists a workspace the
 * same way whether or not any thread of it has cut a tree.
 */
export async function onFilesList(url: URL, res: ServerResponse, board: BoardFolder): Promise<void> {
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const wanted = normalizeRel(url.searchParams.get("path"));
	if ("error" in wanted) return void fail(res, 400, wanted.error);
	const listed = physicalDir(root, wanted.rel);
	if ("error" in listed) return void fail(res, 409, listed.error);
	const canonical = relativeRel(root, listed.dir);
	let dirents: Dirent[];
	try {
		dirents = readdirSync(listed.dir, { withFileTypes: true });
	} catch (error) {
		return void fail(res, 409, `cannot list ${listed.dir}: ${say(error)}`);
	}
	const entries: Entry[] = [];
	for (const dirent of dirents) {
		const name = dirent.name;
		// Dot entries are part of an explorer. The repository's own folder is not: it is git's, and a
		// delete offered beside it is a foot aimed at a checkout.
		if (name === ".git") continue;
		if (CONTROL_CHARS.test(name)) continue;
		const path = wanted.rel ? `${wanted.rel}/${name}` : name;
		try {
			entries.push(entryOf(path, name, join(listed.dir, name)));
		} catch {
			// An entry that went between `readdir` and `lstat` is not a listing's business.
		}
	}
	entries.sort(byName);
	const gitWanted = url.searchParams.get("git") === "1";
	const toplevel = await gitToplevel(root);
	const status = gitWanted && toplevel ? await gitStatus(root, toplevel) : { statuses: new Map<string, string>(), dirty: [], dirtyTruncated: false };
	if (status.statuses.size) {
		for (const entry of entries) {
			// The status is keyed by the path on disk, which differs from the path the client drew when the
			// listing came through a link inside the workspace.
			const code = status.statuses.get(relativeRel(root, join(listed.dir, entry.name)));
			if (code) entry.git = code;
		}
	}
	const start = resumeAt(entries, url.searchParams.get("after") ?? "");
	const page = entries.slice(start, start + pageLimit(url.searchParams.get("limit")));
	const truncated = start + page.length < entries.length;
	answer(res, 200, {
		root,
		path: wanted.rel,
		parent: wanted.rel ? wanted.rel.split("/").slice(0, -1).join("/") : null,
		canonical,
		entries: page,
		total: entries.length,
		truncated,
		next: truncated && page.length ? page[page.length - 1].name : null,
		repo: toplevel !== "",
		dirty: status.dirty,
		...(status.dirtyTruncated ? { dirtyTruncated: true } : {}),
	});
}

// ---------- the changes ----------

/**
 * An empty file, or an empty folder. The file is opened with `wx` and the folder made without
 * `recursive`, so a name that is taken is a refusal from the kernel rather than from a check that a
 * second request can walk past.
 */
export async function onFileNew(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readJson(req, res);
	if (!body) return;
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const parent = normalizeRel(body.path);
	if ("error" in parent) return void fail(res, 400, parent.error);
	const named = normalizeName(body.name);
	if ("error" in named) return void fail(res, 400, named.error);
	const folder = physicalDir(root, parent.rel);
	if ("error" in folder) return void fail(res, 409, folder.error);
	const dir = body.dir === true;
	const target = join(folder.dir, named.name);
	const path = parent.rel ? `${parent.rel}/${named.name}` : named.name;
	if (present(target)) return void fail(res, 409, `${path} already exists`);
	try {
		if (dir) mkdirSync(target);
		else closeSync(openSync(target, "wx"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return void fail(res, 409, `${path} already exists`);
		return void fail(res, 409, say(error));
	}
	answer(res, 200, { entry: entryOf(path, named.name, target) });
}

/** One name changed in place. A link is renamed as a link; its target is not touched. */
export async function onFileRename(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readJson(req, res);
	if (!body) return;
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const source = normalizeRel(body.path);
	if ("error" in source) return void fail(res, 400, source.error);
	if (!source.rel) return void fail(res, 409, "the workspace root cannot be renamed");
	const named = normalizeName(body.name);
	if ("error" in named) return void fail(res, 400, named.error);
	const leaf = leafOf(root, source.rel);
	if ("error" in leaf) return void fail(res, 409, leaf.error);
	if (!present(leaf.abs)) return void fail(res, 409, `no such entry: ${source.rel}`);
	const target = join(leaf.abs.slice(0, leaf.abs.length - leaf.name.length), named.name);
	const to = relativeRel(root, target);
	if (target === leaf.abs) {
		answer(res, 200, { from: source.rel, to: source.rel, entry: entryOf(source.rel, leaf.name, leaf.abs) });
		return;
	}
	if (present(target)) return void fail(res, 409, `${to} already exists`);
	try {
		moveNoClobber(leaf.abs, target);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return void fail(res, 409, `${to} already exists`);
		return void fail(res, 409, say(error));
	}
	answer(res, 200, { from: source.rel, to, entry: entryOf(to, named.name, target) });
}

/**
 * The sources of a batch, all of them checked before any of them is touched. A source inside another
 * source of the same batch is dropped: the folder carries it, and moving it twice is not a request any
 * explorer meant to make.
 */
function sourcesOf(root: string, raw: unknown): { sources: Source[] } | { failed: Failure[] } {
	if (!Array.isArray(raw)) return { failed: [{ path: "", error: "paths must be a list" }] };
	if (!raw.length) return { failed: [{ path: "", error: "nothing was named" }] };
	if (raw.length > MAX_BATCH) return { failed: [{ path: "", error: `at most ${MAX_BATCH} paths at once` }] };
	const failed: Failure[] = [];
	const sources: Source[] = [];
	for (const one of raw) {
		const path = typeof one === "string" ? one : "";
		const rel = normalizeRel(one);
		if ("error" in rel) {
			failed.push({ path, error: rel.error });
			continue;
		}
		if (!rel.rel) {
			failed.push({ path, error: "the workspace root cannot be changed" });
			continue;
		}
		const leaf = leafOf(root, rel.rel);
		if ("error" in leaf) {
			failed.push({ path, error: leaf.error });
			continue;
		}
		const stat = lstatSync(leaf.abs, { throwIfNoEntry: false });
		if (!stat) {
			failed.push({ path, error: "no such entry any more" });
			continue;
		}
		sources.push({ rel: rel.rel, abs: leaf.abs, name: leaf.name, dir: stat.isDirectory() });
	}
	if (failed.length) return { failed };
	const kept: Source[] = [];
	for (const source of [...sources].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
		if (kept.some((one) => source.rel === one.rel || source.rel.startsWith(`${one.rel}/`))) continue;
		kept.push(source);
	}
	return { sources: kept };
}

/** One batch of moves or copies: validated whole, then executed item by item with what each one did. */
async function batchRoute(req: IncomingMessage, res: ServerResponse, board: BoardFolder, mode: "move" | "copy"): Promise<void> {
	const body = await readJson(req, res);
	if (!body) return;
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const word = mode === "move" ? "moved" : "copied";
	const dest = normalizeRel(body.to);
	if ("error" in dest) return void fail(res, 400, dest.error);
	const folder = physicalDir(root, dest.rel);
	if ("error" in folder) return void fail(res, 409, folder.error);
	const found = sourcesOf(root, body.paths);
	if ("failed" in found) return void answer(res, 409, { error: `nothing was ${word}: the batch did not validate`, failed: found.failed });
	const steps: { source: Source; to: string; toRel: string }[] = [];
	const failed: Failure[] = [];
	const taken = new Set<string>();
	for (const source of found.sources) {
		const target = join(folder.dir, source.name);
		const toRel = relativeRel(root, target);
		if (target === source.abs) {
			failed.push({ path: source.rel, error: "it is already there" });
			continue;
		}
		// A folder cannot be carried into itself: the copy would descend forever and the move would
		// unmake the place it is going.
		if (source.dir && target.startsWith(`${source.abs}${sep}`)) {
			failed.push({ path: source.rel, error: "a folder cannot be carried into itself" });
			continue;
		}
		if (taken.has(target)) {
			failed.push({ path: source.rel, error: "another item of this batch lands on the same name" });
			continue;
		}
		if (present(target)) {
			failed.push({ path: source.rel, error: `${toRel} already exists` });
			continue;
		}
		taken.add(target);
		steps.push({ source, to: target, toRel });
	}
	if (failed.length) return void answer(res, 409, { error: `nothing was ${word}: the batch did not validate`, failed });
	const done: { from: string; to: string }[] = [];
	const later: Failure[] = [];
	for (const step of steps) {
		try {
			if (mode === "move") moveNoClobber(step.source.abs, step.to);
			else copyNoClobber(step.source.abs, step.to);
			done.push({ from: step.source.rel, to: step.toRel });
		} catch (error) {
			later.push({ path: step.source.rel, error: say(error) });
		}
	}
	// A batch is not a transaction: what was done is reported as done, and nothing is claimed or retried.
	answer(res, later.length ? 207 : 200, { [word]: done, ...(later.length ? { failed: later } : {}) });
}

export function onFileMove(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	return batchRoute(req, res, board, "move");
}

export function onFileCopy(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	return batchRoute(req, res, board, "copy");
}

/**
 * One `gio trash` for one path: no shell, a bounded wait, and the words the tool said rather than a
 * guess. `ok` is what the exit code said; whether the entry is gone is checked separately, because a
 * tool that failed after moving the file is not a file that is still there.
 */
function gioTrash(path: string): Promise<{ ok: boolean; error: string }> {
	return new Promise<{ ok: boolean; error: string }>((done) => {
		let child: ChildProcess;
		try {
			child = spawn("gio", ["trash", "--", path], { stdio: ["ignore", "ignore", "pipe"] });
		} catch (error) {
			done({ ok: false, error: say(error) });
			return;
		}
		const noise: Buffer[] = [];
		let settled = false;
		const finish = (ok: boolean, error: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			done({ ok, error });
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish(false, "gio trash did not answer");
		}, GIO_TIMEOUT_MS);
		timer.unref();
		child.stderr?.on("data", (chunk: Buffer) => {
			if (noise.length < 20) noise.push(chunk);
		});
		child.stderr?.on("error", () => {});
		child.on("error", (error: Error) => finish(false, error.message));
		child.on("close", (code: number | null) => {
			const said = Buffer.concat(noise).toString("utf8").trim();
			finish(code === 0, said || `gio trash answered ${code}`);
		});
	});
}

/**
 * Delete, or offer to. Normal deletion asks the system's Trash for each path and nothing else happens
 * to one it could not take: it is named back, and only a second request that says `permanent: true` —
 * the human's confirmation — removes it. The answer is the same shape in every case, because a machine
 * with no `gio` is a normal machine to an explorer, not an error page.
 */
export async function onFileDelete(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readJson(req, res);
	if (!body) return;
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const found = sourcesOf(root, body.paths);
	if ("failed" in found) return void answer(res, 409, { error: "nothing was deleted: the batch did not validate", failed: found.failed });
	const permanent = body.permanent === true;
	const deleted: string[] = [];
	const needsPermanent: string[] = [];
	const failed: Failure[] = [];
	if (permanent) {
		for (const source of found.sources) {
			try {
				// `rm` removes a link and not what it points at, which is the entry the human selected.
				rmSync(source.abs, { recursive: true, force: false });
				deleted.push(source.rel);
			} catch (error) {
				failed.push({ path: source.rel, error: say(error) });
			}
		}
		// The shape does not change with the outcome: a client reads `deleted`, `needsPermanent` and
		// `failed` in every answer instead of knowing which keys a particular press happens to bring.
		answer(res, failed.length ? 207 : 200, { deleted, trashed: false, needsPermanent, failed });
		return;
	}
	for (const source of found.sources) {
		const outcome = await gioTrash(source.abs);
		// The path decides, not the exit code: a Trash that moved the file and then complained still moved it.
		const gone = !present(source.abs);
		if (gone) {
			deleted.push(source.rel);
			continue;
		}
		if (outcome.ok) {
			failed.push({ path: source.rel, error: "gio reported the entry trashed but it is still in the folder" });
			continue;
		}
		needsPermanent.push(source.rel);
	}
	answer(res, needsPermanent.length || failed.length ? 207 : 200, { deleted, trashed: true, needsPermanent, failed });
}
