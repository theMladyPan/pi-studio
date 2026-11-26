/**
 * The Explorer's backend: one listing of the human's own folder, and the six narrow changes an explorer
 * asks of it — a new empty file or folder, a rename, a move, a copy, a delete and a save.
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
 * The editor is the one pair that writes over an existing name, because that is what a save is. It reads
 * one file as text and reports the line endings and the byte order mark that file carries, and the save
 * puts them back through an exclusive sibling temp file renamed over the file, so the name never holds
 * half a save and the mode is the file's own. A file past 512 KiB is not one an editor opens, and a save
 * is refused when the file it was read from is no longer the one on disk.
 *
 * Those changes run one at a time per workspace, and a folder copy yields between entries, so a bulk copy
 * does not hold the daemon's event loop while another board waits. What that cannot fix is said in
 * `moveNoClobber`: a folder is still checked and renamed, and an outside writer can win that window.
 *
 * The name search (`/files/find`) walks the whole workspace for names holding the query, in chunks, under
 * the same exclusions the listing shows, and keeps its answer for two seconds so the pages that follow
 * it are slices of one walk rather than walks of their own. Dot names are in it only when the drawer
 * asks for hidden files; `.git` is never in it.
 *
 * What the listing shows is the workspace's own decision. The standard VS Code exclusions, this machine's
 * user settings and the board's own `.vscode/settings.json` are merged, and what they hide is gone before
 * a page is cut, so `total` and `next` count only what a human can see. Only the settings this surface
 * acts on are read, and one that cannot be parsed leaves the layers below it standing with a warning.
 *
 * Deleting goes through the system's Trash with `gio`, one spawn per path, no shell. A path that cannot
 * be trashed is reported back for the human to confirm, and confirmation is a second request that names
 * `permanent: true`; a failed trash never turns into a permanent delete behind their back. A `gio` that
 * fails is not taken as proof nothing happened: the path is checked, and a path that is gone is named as
 * deleted whatever the exit code said.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	createReadStream,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, readlink, rename, rm, symlink, unlink } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import { runGit } from "../../git/exec.ts";
import { answer, fail, readBytes, readJson } from "../../http.ts";
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

/** The editor holds one file at a time, and a file past this is not one an editor should open. */
const MAX_FILE_BYTES = 512 * 1024;

/** How many name matches one find walk keeps. Past it the walk stops keeping and says so, rather than holding a runaway list. */
const MAX_FIND_MATCHES = 5000;

/** How many entries one find walk scans before it stops and says so. A workspace past it is still searched, up to here. */
const MAX_FIND_SCAN = 100_000;

/** How long a find walk's answer is kept for the pages that follow it, in milliseconds. Two seconds covers a paged read and no longer. */
const FIND_CACHE_MS = 2000;

/** Entries between yields in a find walk, so a bulk walk never holds the daemon's event loop. */
const FIND_YIELD_EVERY = 512;

/**
 * The file kinds the browser itself can draw, by extension and nothing else: pictures, the one vector
 * format browsers draw, documents and sound. A name not in this table is not served raw at all, so a
 * file renamed to one of these names is decoded as the type named here and never sniffed into another.
 */
const PREVIEW_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
};

/** The preview type a path names, or null when the browser has no drawing for it here. */
function previewType(rel: string): string | null {
	const name = rel.split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return null;
	return PREVIEW_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * One `Range` header against a file of `size` bytes: the slice to send, or a refusal. A single range
 * is the only kind a player or a document viewer asks for, so a list of ranges is refused rather than
 * guessed at. No header at all is the whole file, which is also what a request that cannot be read gets.
 */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | { error: string } | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || (!match[1] && !match[2])) return { error: "bad range" };
	if (size === 0) return { error: "the file is empty" };
	if (!match[1]) {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return { error: "bad range" };
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(match[1]);
	if (!Number.isSafeInteger(start) || start >= size) return { error: "range starts past the end of the file" };
	const end = match[2] ? Number(match[2]) : size - 1;
	if (!Number.isSafeInteger(end) || end < start) return { error: "bad range" };
	return { start, end: Math.min(end, size - 1) };
}

/**
 * A save carries the whole file as a JSON string, so its body is larger than the file: a control character
 * costs six bytes once escaped. The limit is set above the worst case so a legal file is never refused for
 * the shape of the envelope, and the global body cap is left where every other route expects it.
 */
const MAX_SAVE_BODY = 4 * 1024 * 1024;

/** A NUL in the opening bytes of a file is a binary file: text does not carry one. */
const BINARY_PROBE_BYTES = 8 * 1024;

/** The bytes a UTF-8 file may start with and still be the same text. */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

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

// ---------- what an explorer shows ----------

/** One `files.exclude` key's value: hidden, shown, or hidden while a sibling matches `when`. */
type ExcludeRule = boolean | { when: string };

/** The settings an explorer acts on, every one of them defaulted so a client never has to guess. */
type ExplorerSettings = {
	compactFolders: boolean;
	nesting: { enabled: boolean; expand: boolean; patterns: Record<string, string> };
	exclude: Record<string, ExcludeRule>;
	excludeGitIgnore: boolean;
};

/** One settings file's contribution: only the keys this surface acts on, and only the ones it named. */
type SettingsLayer = {
	exclude?: Record<string, ExcludeRule>;
	compactFolders?: boolean;
	excludeGitIgnore?: boolean;
	nesting?: { enabled?: boolean; expand?: boolean; patterns?: Record<string, string> };
};

/**
 * The exclusions VS Code ships with. `node_modules` and `.agents` are deliberately absent: they are a
 * workspace's own to hide, and a listing that hid the folder a workspace keeps its agents' notes in would
 * be lying about the folder a human opened.
 */
const DEFAULT_EXCLUDE: Record<string, ExcludeRule> = {
	"**/.git": true,
	"**/.svn": true,
	"**/.hg": true,
	"**/CVS": true,
	"**/.DS_Store": true,
	"**/Thumbs.db": true,
};

/**
 * The file nesting VS Code's explorer ships with, in VS Code's own `${capture}` spelling. This is the
 * common half of its table: that list grows with each release, and a workspace that wants more sets its
 * own keys on top of these.
 */
const DEFAULT_NESTING_PATTERNS: Record<string, string> = {
	"*.ts": "${capture}.js, ${capture}.js.map, ${capture}.ts.map, ${capture}.d.ts",
	"*.js": "${capture}.js.map, ${capture}.min.js, ${capture}.min.js.map",
	"*.jsx": "${capture}.js",
	"*.tsx": "${capture}.js",
	"package.json": ".nvmrc, .node-version, .npmrc, package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb",
	"tsconfig.json": "tsconfig.*.json",
};

/** One settings file is read up to this much: a config that outgrew it is a mistyped path, not a config. */
const SETTINGS_MAX_BYTES = 256 * 1024;

/** One string literal, as it stands, from its opening quote to its closing one. Comments are not in it. */
function quoted(text: string, at: number): { text: string; next: number } {
	let out = text[at];
	let index = at + 1;
	while (index < text.length) {
		const char = text[index];
		out += char;
		index++;
		if (char === "\\") {
			if (index < text.length) out += text[index++];
			continue;
		}
		if (char === '"') break;
	}
	return { text: out, next: index };
}

/**
 * A VS Code settings file is JSONC: it may carry line and block comments and a trailing comma. Both are
 * taken out by a scan that knows what a string is, because a pattern holding `//` is a value and not a
 * comment, and a regular expression that forgot this would corrupt it.
 */
function stripJsonc(source: string): string {
	let withoutComments = "";
	let at = 0;
	while (at < source.length) {
		const char = source[at];
		if (char === '"') {
			const one = quoted(source, at);
			withoutComments += one.text;
			at = one.next;
			continue;
		}
		if (char === "/" && source[at + 1] === "/") {
			while (at < source.length && source[at] !== "\n") at++;
			continue;
		}
		if (char === "/" && source[at + 1] === "*") {
			at += 2;
			while (at < source.length && !(source[at] === "*" && source[at + 1] === "/")) at++;
			at = Math.min(at + 2, source.length);
			continue;
		}
		withoutComments += char;
		at++;
	}
	let tidy = "";
	at = 0;
	while (at < withoutComments.length) {
		const char = withoutComments[at];
		if (char === '"') {
			const one = quoted(withoutComments, at);
			tidy += one.text;
			at = one.next;
			continue;
		}
		if (char === ",") {
			let ahead = at + 1;
			while (ahead < withoutComments.length && /\s/.test(withoutComments[ahead])) ahead++;
			if (withoutComments[ahead] === "}" || withoutComments[ahead] === "]") {
				at++;
				continue;
			}
		}
		tidy += char;
		at++;
	}
	return tidy;
}

/** A parsed settings file, or the sentence saying why it could not be one. */
type SettingsFileAnswer = { parsed: Record<string, unknown> | null; warning: string | null };

/** Parsed settings by mtime and size, so a listing stats two files and re-reads one only when it changed. */
const settingsCache = new Map<string, { mtimeMs: number; size: number; answer: SettingsFileAnswer }>();

/** One settings file up to the ceiling, without its comments. A file that is not there is `null`, not a warning. */
function readSettingsFile(file: string): SettingsFileAnswer | null {
	let stat: Stats;
	try {
		stat = statSync(file);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;
	const cached = settingsCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.answer;
	const answer = parseSettingsFile(file, stat);
	settingsCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, answer });
	return answer;
}

function parseSettingsFile(file: string, stat: Stats): SettingsFileAnswer {
	const size = Math.min(stat.size, SETTINGS_MAX_BYTES);
	const buffer = Buffer.alloc(size);
	let read = 0;
	try {
		const handle = openSync(file, "r");
		try {
			read = readSync(handle, buffer, 0, size, 0);
		} finally {
			closeSync(handle);
		}
	} catch (error) {
		return { parsed: null, warning: `${file} could not be read: ${say(error)}` };
	}
	let warning: string | null = stat.size > SETTINGS_MAX_BYTES ? `${file} is longer than ${SETTINGS_MAX_BYTES} bytes, so only its beginning was read` : null;
	let parsed: Record<string, unknown> | null = null;
	try {
		const value: unknown = JSON.parse(stripJsonc(buffer.subarray(0, read).toString("utf8")).replace(/^\uFEFF/, ""));
		if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
		else warning ??= `${file} is not a settings object`;
	} catch (error) {
		warning ??= `${file} is not readable JSON: ${say(error)}`;
	}
	return { parsed, warning };
}

/** The settings this surface acts on. Everything else in a settings file is somebody else's. */
function relevantSettings(parsed: Record<string, unknown>): SettingsLayer {
	const kept: SettingsLayer = {};
	const exclude = parsed["files.exclude"];
	if (exclude && typeof exclude === "object" && !Array.isArray(exclude)) {
		const rules: Record<string, ExcludeRule> = {};
		for (const [pattern, value] of Object.entries(exclude as Record<string, unknown>)) {
			if (typeof value === "boolean") rules[pattern] = value;
			else if (value && typeof value === "object" && typeof (value as { when?: unknown }).when === "string") {
				rules[pattern] = { when: (value as { when: string }).when };
			}
		}
		kept.exclude = rules;
	}
	if (typeof parsed["explorer.compactFolders"] === "boolean") kept.compactFolders = parsed["explorer.compactFolders"] as boolean;
	if (typeof parsed["explorer.excludeGitIgnore"] === "boolean") kept.excludeGitIgnore = parsed["explorer.excludeGitIgnore"] as boolean;
	const nesting: { enabled?: boolean; expand?: boolean; patterns?: Record<string, string> } = {};
	if (typeof parsed["explorer.fileNesting.enabled"] === "boolean") nesting.enabled = parsed["explorer.fileNesting.enabled"] as boolean;
	if (typeof parsed["explorer.fileNesting.expand"] === "boolean") nesting.expand = parsed["explorer.fileNesting.expand"] as boolean;
	const patterns = parsed["explorer.fileNesting.patterns"];
	if (patterns && typeof patterns === "object" && !Array.isArray(patterns)) {
		const table: Record<string, string> = {};
		for (const [glob, value] of Object.entries(patterns as Record<string, unknown>)) if (typeof value === "string") table[glob] = value;
		nesting.patterns = table;
	}
	if (Object.keys(nesting).length) kept.nesting = nesting;
	return kept;
}

/** VS Code's user settings on Linux: `$XDG_CONFIG_HOME/Code/User/settings.json`, else under the home folder. */
function userSettingsFile(): string {
	const configured = process.env.XDG_CONFIG_HOME;
	const base = configured && isAbsolute(configured) ? configured : join(homedir(), ".config");
	return join(base, "Code", "User", "settings.json");
}

/**
 * The board's own `.vscode/settings.json`, resolved so a link out of the workspace is not read. A folder
 * with no settings file is `null`; one that is a link outside is a sentence the client can show.
 */
function workspaceSettingsFile(root: string): { file: string } | { warning: string } | null {
	const wanted = join(root, ".vscode", "settings.json");
	try {
		const real = realpathSync(wanted);
		if (!inside(root, real)) return { warning: `${relativeRel(root, wanted)} leads out of the workspace, so its settings were not read` };
		return { file: real };
	} catch (error) {
		// A workspace with no settings file is the ordinary case; another failure is reported by the reader.
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : { file: wanted };
	}
}

/**
 * The settings this workspace's explorer runs with: VS Code's defaults, then this machine's user settings,
 * then the board's own `.vscode/settings.json`, the later layer winning key by key. Two files are stat'ed
 * per listing and read only when they changed; one that cannot be parsed leaves the layers below it
 * standing and adds a sentence to `settingsWarnings`.
 */
function explorerSettings(root: string): { settings: ExplorerSettings; warnings: string[] } {
	const warnings: string[] = [];
	const layers: SettingsLayer[] = [];
	const user = readSettingsFile(userSettingsFile());
	if (user?.warning) warnings.push(user.warning);
	if (user?.parsed) layers.push(relevantSettings(user.parsed));
	const workspace = workspaceSettingsFile(root);
	if (workspace && "warning" in workspace) warnings.push(workspace.warning);
	const own = workspace && "file" in workspace ? readSettingsFile(workspace.file) : null;
	if (own?.warning) warnings.push(own.warning);
	if (own?.parsed) layers.push(relevantSettings(own.parsed));
	const exclude: Record<string, ExcludeRule> = { ...DEFAULT_EXCLUDE };
	const patterns: Record<string, string> = { ...DEFAULT_NESTING_PATTERNS };
	let compactFolders = true;
	let excludeGitIgnore = false;
	let enabled = false;
	let expand = true;
	for (const layer of layers) {
		if (layer.exclude) Object.assign(exclude, layer.exclude);
		if (layer.compactFolders !== undefined) compactFolders = layer.compactFolders;
		if (layer.excludeGitIgnore !== undefined) excludeGitIgnore = layer.excludeGitIgnore;
		if (layer.nesting?.enabled !== undefined) enabled = layer.nesting.enabled;
		if (layer.nesting?.expand !== undefined) expand = layer.nesting.expand;
		if (layer.nesting?.patterns) Object.assign(patterns, layer.nesting.patterns);
	}
	return { settings: { compactFolders, nesting: { enabled, expand, patterns }, exclude, excludeGitIgnore }, warnings };
}

/** A `files.exclude` key, matched against the entry's path and, for a bare `*.ts`, against its name too. */
function patternMatches(pattern: string, rel: string, name: string): boolean {
	try {
		return matchesGlob(rel, pattern) || (!pattern.includes("/") && matchesGlob(name, pattern));
	} catch {
		// An unusable pattern hides nothing rather than emptying the listing.
		return false;
	}
}

/**
 * A key that carries `when: "$(basename).ts"` reads "hide this file while a `.ts` of the same name stands
 * beside it", and `$(basename)` is the entry's name without its extension. The siblings are the names the
 * folder already answered with, so a listing reads each folder once.
 */
function siblingPresent(name: string, siblings: string[], when: string): boolean {
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const wanted = when.split("$(basename)").join(base);
	try {
		return siblings.some((one) => one !== name && matchesGlob(one, wanted));
	} catch {
		return false;
	}
}

/**
 * Whether `files.exclude` hides one entry. The merged table is read in its own order and the last key that
 * matches decides, which is how a `false` in a workspace brings back a file the user's own file hid.
 */
function excluded(rel: string, name: string, siblings: string[], rules: Record<string, ExcludeRule>): boolean {
	let hidden = false;
	for (const [pattern, rule] of Object.entries(rules)) {
		if (!patternMatches(pattern, rel, name)) continue;
		hidden = typeof rule === "boolean" ? rule : siblingPresent(name, siblings, rule.when);
	}
	return hidden;
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

/** How many names one listing hands `git check-ignore` before it stops asking and says so. */
const MAX_IGNORE_PATHS = 5000;

/** One `check-ignore` call carries this many paths, so a folder of long names stays inside an argument list. */
const IGNORE_CHUNK = 200;

/**
 * Which of these workspace-relative paths git ignores, asked in chunks for the whole folder rather than
 * once per entry. `explorer.excludeGitIgnore` is off by default; a folder that is not a checkout, or one
 * too large to ask about, is answered with a sentence rather than with an empty set, because the two are
 * different things.
 */
async function gitIgnored(root: string, toplevel: string, rels: string[]): Promise<{ ignored: Set<string>; warning: string | null }> {
	const ignored = new Set<string>();
	if (!rels.length) return { ignored, warning: null };
	if (rels.length > MAX_IGNORE_PATHS) return { ignored, warning: `more than ${MAX_IGNORE_PATHS} entries here: git's ignore rules were not applied` };
	const prefix = toplevel === root ? "" : `${relativeRel(toplevel, root)}/`;
	if (prefix.startsWith("../")) return { ignored, warning: `${root} is outside ${toplevel}` };
	for (let at = 0; at < rels.length; at += IGNORE_CHUNK) {
		const chunk = rels.slice(at, at + IGNORE_CHUNK).map((rel) => `${prefix}${rel}`);
		// One path per line and no `-z`: `-z` is only accepted with `--stdin`, and a name holding a newline
		// never reaches here because the listing drops control characters first.
		const result = await runGit(toplevel, ["check-ignore", "--", ...chunk], { kind: "read", timeoutMs: 5000, maxBytes: 4 * 1024 * 1024 });
		// `check-ignore` exits 1 when nothing matched and 128 when it could not run; the first is no news.
		if (result.code !== 0 && result.code !== 1) {
			return { ignored, warning: `git could not say what it ignores: ${result.stderr || "no reply"}` };
		}
		for (const one of result.stdout.toString("utf8").split("\n")) {
			if (!one) continue;
			ignored.add(prefix && one.startsWith(prefix) ? one.slice(prefix.length) : one);
		}
	}
	return { ignored, warning: null };
}

// ---------- copying and moving ----------

/**
 * One workspace's changes run one at a time. A folder copy yields between entries, so without this a
 * second press could read a half-copied tree as a finished one; the queue is per workspace root, so two
 * boards wait for nothing of each other's.
 */
const queues = new Map<string, Promise<void>>();

function serialised<T>(root: string, work: () => Promise<T>): Promise<T> {
	const before = queues.get(root) ?? Promise.resolve();
	const run = before.then(work, work);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	queues.set(root, tail);
	void tail.then(() => {
		if (queues.get(root) === tail) queues.delete(root);
	});
	return run;
}

/**
 * Place one entry at a name that is free, and fail when it is not. Files and links are placed by a call
 * that the kernel makes refuse an existing name, so two requests racing for one name cannot both win.
 * A folder is walked entry by entry: the copy yields between them, so a bulk copy never holds the event
 * loop, and a failure removes only the folder this call made rather than a name that was already there.
 */
async function copyNoClobber(src: string, dst: string): Promise<void> {
	const stat = await lstat(src);
	if (stat.isSymbolicLink()) {
		// A link is copied as a link: its target is not read and nothing outside the workspace is visited.
		await symlink(await readlink(src), dst);
		return;
	}
	if (stat.isDirectory()) {
		await mkdir(dst);
		try {
			for (const name of await readdir(src)) await copyNoClobber(join(src, name), join(dst, name));
		} catch (error) {
			// What was made here is this call's own, so it goes rather than leaving half a folder behind.
			await rm(dst, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
		return;
	}
	if (!stat.isFile()) throw new Error("only files, folders and links can be copied");
	await copyFile(src, dst, fsConstants.COPYFILE_EXCL);
}

/**
 * Move one entry, never over an existing name.
 *
 * A file is placed with an atomic no-clobber call and then removed, which is same-filesystem only and
 * refuses to overwrite. A link is made again and the old name removed. A folder is checked and then
 * renamed: `rename` has no portable no-replace form here, so another program that creates the destination
 * in that window can still be overwritten. That is the one race this file cannot close, and it is stated
 * rather than papered over. An entry on another device is copied no-clobber, and its source is removed
 * only once that copy has finished.
 */
async function moveNoClobber(src: string, dst: string): Promise<void> {
	const stat = await lstat(src);
	if (stat.isSymbolicLink()) {
		// A failure here is reported as it came: a copy of what the link points at is a different entry, so
		// there is nothing safe to fall back to.
		await symlink(await readlink(src), dst);
		await unlink(src);
		return;
	}
	if (stat.isDirectory()) {
		if (present(dst)) throw Object.assign(new Error(`${dst} already exists`), { code: "EEXIST" });
		try {
			await rename(src, dst);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		}
		await copyNoClobber(src, dst);
		await removeSource(src, dst);
		return;
	}
	if (!stat.isFile()) throw new Error("only files, folders and links can be moved");
	try {
		await link(src, dst);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") throw error;
		// A filesystem with no hard links: copy the file no-clobber first, then take the original.
		await copyNoClobber(src, dst);
		await removeSource(src, dst);
		return;
	}
	await unlink(src);
}

/**
 * The original of a moved entry goes only once its copy is on disk. A removal that fails says so in those
 * words, because the copy really is there and "move failed" alone would hide that.
 */
async function removeSource(src: string, dst: string): Promise<void> {
	try {
		await rm(src, { recursive: true, force: false });
	} catch (error) {
		throw new Error(`copied to ${dst}, but its source could not be removed: ${say(error)}`);
	}
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
	const siblings = dirents.map((dirent) => dirent.name);
	const found: Entry[] = [];
	for (const dirent of dirents) {
		const name = dirent.name;
		// Dot entries are part of an explorer. The repository's own folder is not: it is git's, and a
		// delete offered beside it is a foot aimed at a checkout.
		if (name === ".git") continue;
		if (CONTROL_CHARS.test(name)) continue;
		const path = wanted.rel ? `${wanted.rel}/${name}` : name;
		try {
			found.push(entryOf(path, name, join(listed.dir, name)));
		} catch {
			// An entry that went between `readdir` and `lstat` is not a listing's business.
		}
	}
	// What the workspace asked an explorer to hide is gone before a page is cut, so `total`, `next` and
	// `truncated` describe the entries a human can see rather than the ones on the disk.
	const { settings, warnings } = explorerSettings(root);
	let entries = found.filter((entry) => !excluded(entry.path, entry.name, siblings, settings.exclude));
	entries.sort(byName);
	const gitWanted = url.searchParams.get("git") === "1";
	const toplevel = await gitToplevel(root);
	if (settings.excludeGitIgnore) {
		if (toplevel) {
			const checks = await gitIgnored(root, toplevel, entries.map((entry) => entry.path));
			if (checks.warning) warnings.push(checks.warning);
			entries = entries.filter((entry) => !checks.ignored.has(entry.path));
		} else {
			warnings.push("explorer.excludeGitIgnore is on, but this folder is not a git checkout");
		}
	}
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
		home: homedir(),
		path: wanted.rel,
		parent: wanted.rel ? wanted.rel.split("/").slice(0, -1).join("/") : null,
		canonical,
		entries: page,
		total: entries.length,
		truncated,
		next: truncated && page.length ? page[page.length - 1].name : null,
		repo: toplevel !== "",
		dirty: status.dirty,
		settings,
		...(status.dirtyTruncated ? { dirtyTruncated: true } : {}),
		...(warnings.length ? { settingsWarnings: warnings } : {}),
	});
}

// ---------- finding names in every folder ----------

/** One find walk's kept answer, so the pages after the first are slices and not walks of their own. */
type FindCache = { at: number; matches: Entry[]; scanned: number; truncated: boolean; warnings: string[] };

const findCache = new Map<string, FindCache>();

/** Folders first, then names, then paths: one order for every page, so a page never re-sorts the last. */
function byFind(a: Entry, b: Entry): number {
	const named = byName(a, b);
	return named !== 0 ? named : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Whether git ignores this path or a folder above it, once `check-ignore` has named the ignored ones. */
function ignoredPath(path: string, ignored: Set<string>): boolean {
	let at = path;
	for (;;) {
		if (ignored.has(at)) return true;
		const cut = at.lastIndexOf("/");
		if (cut === -1) return false;
		at = at.slice(0, cut);
	}
}

/**
 * Every name in the workspace holding `needle`, walked from the root in chunks. `.git` is never entered,
 * a link out of the workspace is listed but never walked into, a folder already walked through its real
 * path is not walked again, and the walk yields every few hundred entries so it never holds the loop.
 * What `files.exclude` hides is not walked into, and dot names are walked into only when hidden files
 * were asked for. Git's own ignore rules, when the workspace asks for them, are applied to the matches.
 */
async function walkFind(root: string, needle: string, showHidden: boolean): Promise<FindCache> {
	const { settings, warnings } = explorerSettings(root);
	const matches: Entry[] = [];
	const visited = new Set<string>([root]);
	const stack: { rel: string; abs: string }[] = [{ rel: "", abs: root }];
	let scanned = 0;
	let truncated = false;
	let sinceYield = 0;
	while (stack.length && !truncated) {
		const { rel, abs } = stack.pop() as { rel: string; abs: string };
		let dirents: Dirent[];
		try {
			dirents = await readdir(abs, { withFileTypes: true });
		} catch {
			continue;
		}
		const siblings = dirents.map((dirent) => dirent.name);
		for (const dirent of dirents) {
			const name = dirent.name;
			if (name === ".git" || CONTROL_CHARS.test(name)) continue;
			if (!showHidden && name.startsWith(".")) continue;
			const path = rel ? `${rel}/${name}` : name;
			if (excluded(path, name, siblings, settings.exclude)) continue;
			let entry: Entry;
			try {
				entry = entryOf(path, name, join(abs, name));
			} catch {
				continue;
			}
			scanned++;
			if (++sinceYield >= FIND_YIELD_EVERY) {
				sinceYield = 0;
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (scanned > MAX_FIND_SCAN) {
				truncated = true;
				break;
			}
			if (name.toLowerCase().includes(needle)) {
				if (matches.length < MAX_FIND_MATCHES) matches.push(entry);
				else truncated = true;
			}
			if (!entry.dir) continue;
			let real: string;
			try {
				real = realpathSync(join(abs, name));
			} catch {
				continue;
			}
			if (!inside(root, real) || visited.has(real)) continue;
			visited.add(real);
			stack.push({ rel: path, abs: real });
		}
	}
	matches.sort(byFind);
	const kept = warnings.slice();
	let found = matches;
	if (settings.excludeGitIgnore) {
		const toplevel = await gitToplevel(root);
		if (toplevel) {
			const checks = await gitIgnored(root, toplevel, matches.map((entry) => entry.path));
			if (checks.warning) kept.push(checks.warning);
			found = matches.filter((entry) => !ignoredPath(entry.path, checks.ignored));
		} else {
			kept.push("explorer.excludeGitIgnore is on, but this folder is not a git checkout");
		}
	}
	return { at: Date.now(), matches: found, scanned, truncated, warnings: kept };
}

/**
 * Names holding `q` in every folder, in pages. `from` is how many matches the drawer already holds;
 * `hidden=1` asks for dot names too. The first page walks, and the walk is kept for two seconds, so
 * the pages after it are slices of one answer rather than walks of their own.
 */
export async function onFilesFind(url: URL, res: ServerResponse, board: BoardFolder): Promise<void> {
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const needle = (url.searchParams.get("q") ?? "").trim().toLowerCase();
	if (!needle) return void fail(res, 400, "a name to search for is required");
	const showHidden = url.searchParams.get("hidden") !== "0";
	if (Buffer.byteLength(needle) > MAX_NAME_BYTES) {
		answer(res, 200, { root, q: needle, hidden: showHidden, entries: [], total: 0, truncated: false, next: null, scanTruncated: false, scanned: 0 });
		return;
	}
	const key = `${root}\u0000${needle}\u0000${showHidden ? "1" : "0"}`;
	let held = findCache.get(key);
	if (held && Date.now() - held.at >= FIND_CACHE_MS) {
		findCache.delete(key);
		held = undefined;
	}
	if (!held) {
		held = await walkFind(root, needle, showHidden);
		findCache.set(key, held);
		for (const [name, one] of findCache) if (Date.now() - one.at >= FIND_CACHE_MS) findCache.delete(name);
		while (findCache.size > 32) findCache.delete(findCache.keys().next().value as string);
	}
	const wanted = Number(url.searchParams.get("from"));
	const from = Number.isInteger(wanted) && wanted > 0 ? Math.min(wanted, held.matches.length) : 0;
	const page = held.matches.slice(from, from + pageLimit(url.searchParams.get("limit")));
	const truncated = from + page.length < held.matches.length;
	answer(res, 200, {
		root,
		q: needle,
		hidden: showHidden,
		entries: page,
		total: held.matches.length,
		truncated,
		next: truncated && page.length ? String(from + page.length) : null,
		scanTruncated: held.truncated,
		scanned: held.scanned,
		...(held.warnings.length ? { settingsWarnings: held.warnings } : {}),
	});
}

// ---------- one file, read and written ----------

/**
 * A file's bytes, at most `limit` of them, or null when it holds more. The read stops at the cap rather
 * than measuring the file first, so a file that grows while it is read cannot outrun the buffer.
 */
function readCapped(abs: string, limit: number): Buffer | null {
	const fd = openSync(abs, "r");
	try {
		const buffer = Buffer.alloc(limit + 1);
		let held = 0;
		while (held < buffer.length) {
			const got = readSync(fd, buffer, held, buffer.length - held, held);
			if (!got) break;
			held += got;
		}
		return held > limit ? null : buffer.subarray(0, held);
	} finally {
		closeSync(fd);
	}
}

/** Whether these bytes are text an editor can show: no NUL up front, and valid UTF-8 throughout. */
function binaryBytes(bytes: Buffer): boolean {
	if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return false;
	} catch {
		return true;
	}
}

/**
 * The line endings and the byte order mark a file already carries, so a save can put them back. The client
 * sends folded text, and a file that is written back with the endings of another system is a diff nobody
 * asked for.
 */
function shapeOf(bytes: Buffer): { bom: boolean; eol: "lf" | "crlf" } {
	const bom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
	const text = (bom ? bytes.subarray(UTF8_BOM.length) : bytes).toString("utf8");
	return { bom, eol: text.includes("\r\n") ? "crlf" : "lf" };
}

/**
 * One file of the workspace, as text an editor can hold. The path is resolved physically, so a link that
 * leaves the workspace is refused rather than read; a link that stays inside is read through its target and
 * reported as not editable, because a save would land on a file the human did not open.
 */
export async function onFileRead(url: URL, res: ServerResponse, board: BoardFolder): Promise<void> {
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const wanted = normalizeRel(url.searchParams.get("path"));
	if ("error" in wanted) return void fail(res, 400, wanted.error);
	const leaf = leafOf(root, wanted.rel);
	if ("error" in leaf) return void fail(res, 409, leaf.error);
	let link = false;
	try {
		link = lstatSync(leaf.abs).isSymbolicLink();
	} catch {
		return void fail(res, 404, `no such file: ${wanted.rel}`);
	}
	let real: string;
	try {
		real = realpathSync(leaf.abs);
	} catch {
		return void fail(res, 404, `no such file: ${wanted.rel}`);
	}
	if (!inside(root, real)) return void fail(res, 409, `${wanted.rel} is outside the workspace`);
	let stat: Stats;
	try {
		stat = statSync(real);
	} catch {
		return void fail(res, 404, `no such file: ${wanted.rel}`);
	}
	if (!stat.isFile()) return void fail(res, 404, `${wanted.rel} is not a file`);
	if (stat.size > MAX_FILE_BYTES) return void fail(res, 413, `${wanted.rel} is larger than ${MAX_FILE_BYTES} bytes`);
	const bytes = readCapped(real, MAX_FILE_BYTES);
	if (!bytes) return void fail(res, 413, `${wanted.rel} is larger than ${MAX_FILE_BYTES} bytes`);
	if (binaryBytes(bytes)) return void fail(res, 415, `${wanted.rel} is not text`);
	const { bom, eol } = shapeOf(bytes);
	const text = (bom ? bytes.subarray(UTF8_BOM.length) : bytes).toString("utf8");
	answer(res, 200, {
		path: wanted.rel,
		content: eol === "crlf" ? text.replace(/\r\n/g, "\n") : text,
		// The size and the mtime are what a save compares against, so they describe the file on disk rather
		// than the folded text the client is handed.
		size: bytes.length,
		mtime: Math.floor(stat.mtimeMs),
		eol,
		bom,
		editable: !link,
	});
}

/**
 * One file of the workspace, as itself: the bytes a browser can draw, under the type its name claims.
 * The path is resolved exactly as the editor's read resolves it, so a link that leaves the workspace
 * is refused here too, and nothing outside the root is ever served. The bytes are streamed rather than
 * held, because a picture, a document or a recording is not held to the editor's ceiling, and a
 * `Range` is answered with the slice it asked for, which is what lets a player seek and a viewer page
 * through a file larger than the screen. A `HEAD` answers the same headers with no body, so the client
 * can ask whether the file is there before it draws anything.
 *
 * The type comes from the name and is pinned with `nosniff`: a file called `page.png` that holds HTML
 * is decoded as a picture and fails as one, rather than being sniffed into a page. Vector graphics get
 * a sandbox of their own, because an SVG opened as a document can carry a script and this one is only
 * ever meant to be drawn.
 */
export async function onFileRaw(req: IncomingMessage, url: URL, res: ServerResponse, board: BoardFolder): Promise<void> {
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const wanted = normalizeRel(url.searchParams.get("path"));
	if ("error" in wanted) return void fail(res, 400, wanted.error);
	const type = previewType(wanted.rel);
	if (!type) return void fail(res, 415, `${wanted.rel} cannot be previewed here`);
	const leaf = leafOf(root, wanted.rel);
	if ("error" in leaf) return void fail(res, 409, leaf.error);
	try {
		lstatSync(leaf.abs);
	} catch {
		return void fail(res, 404, `no such file: ${wanted.rel}`);
	}
	let real: string;
	try {
		real = realpathSync(leaf.abs);
	} catch {
		return void fail(res, 404, `no such file: ${wanted.rel}`);
	}
	if (!inside(root, real)) return void fail(res, 409, `${wanted.rel} is outside the workspace`);
	let stat: Stats;
	try {
		stat = statSync(real);
	} catch {
		return void fail(res, 404, `no such file: ${wanted.rel}`);
	}
	if (!stat.isFile()) return void fail(res, 404, `${wanted.rel} is not a file`);
	const headers: Record<string, string> = {
		"Content-Type": type,
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Accept-Ranges": "bytes",
	};
	if (type === "image/svg+xml") headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
	if (req.method === "HEAD") {
		res.writeHead(200, { ...headers, "Content-Length": stat.size });
		res.end();
		return;
	}
	const range = parseRange(req.headers.range, stat.size);
	if (range && "error" in range) {
		res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}`, "Content-Type": "text/plain" });
		res.end(range.error);
		return;
	}
	const start = range?.start ?? 0;
	const end = range?.end ?? stat.size - 1;
	const length = stat.size === 0 ? 0 : end - start + 1;
	res.writeHead(range ? 206 : 200, {
		...headers,
		"Content-Length": length,
		...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
	});
	if (stat.size === 0) {
		res.end();
		return;
	}
	const stream = createReadStream(real, { start, end });
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}

/**
 * The body of a save, read with its own ceiling. `readJson` caps every body at the daemon's own limit, and
 * a file at the editor's ceiling can outgrow it once its text is escaped; the shape of the answer is the
 * one `readJson` gives, so a client reads one kind of refusal.
 */
async function readSave(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
	const bytes = (await readBytes(req, MAX_SAVE_BODY)) as Buffer | undefined;
	if (bytes === undefined) {
		fail(res, 413, "body too large");
		return null;
	}
	const text = bytes.toString("utf8");
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		fail(res, 400, "bad json");
		return null;
	}
}

/**
 * One file saved over itself. The client sends folded text and the numbers it read the file with; the route
 * restores the file's own byte order mark and line endings, refuses a file that changed underneath, and
 * places the new bytes through an exclusive sibling temp file so the name never holds half a file.
 *
 * A save never creates: a path with nothing at it is a 404, because an editor that opened a file is saving
 * a file and not making one.
 */
export async function onFileWrite(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readSave(req, res);
	if (!body) return;
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const wanted = normalizeRel(body.path);
	if ("error" in wanted) return void fail(res, 400, wanted.error);
	if (!wanted.rel) return void fail(res, 404, "the workspace root is not a file");
	if (typeof body.content !== "string") return void fail(res, 400, "content is a string");
	if (!Number.isFinite(body.mtime) || !Number.isFinite(body.size)) {
		return void fail(res, 400, "mtime and size are the numbers the file was read with");
	}
	const content = body.content;
	const encoded = Buffer.from(content, "utf8");
	if (encoded.length > MAX_FILE_BYTES) return void fail(res, 413, `the text is larger than ${MAX_FILE_BYTES} bytes`);
	// A lone surrogate encodes as a replacement character, so the round trip says the text is not UTF-8.
	if (content.includes("\u0000") || encoded.toString("utf8") !== content) return void fail(res, 415, "the text is not UTF-8");
	const outcome = await serialised(root, async (): Promise<Outcome> => {
		const leaf = leafOf(root, wanted.rel);
		if ("error" in leaf) return { status: 409, error: leaf.error };
		let stat: Stats;
		try {
			stat = lstatSync(leaf.abs);
		} catch {
			return { status: 404, error: `no such file: ${wanted.rel}` };
		}
		// A link is reported as not editable, and a save that lands on its target is a write the human did
		// not name. The link is refused rather than followed.
		if (stat.isSymbolicLink()) return { status: 409, error: `${wanted.rel} is a link, and a link is not edited` };
		if (!stat.isFile()) return { status: 404, error: `${wanted.rel} is not a file` };
		if (stat.size > MAX_FILE_BYTES) return { status: 413, error: `${wanted.rel} is larger than ${MAX_FILE_BYTES} bytes` };
		if (stat.size !== body.size || Math.floor(stat.mtimeMs) !== body.mtime) {
			return { status: 409, error: "the file changed on disk since it was opened" };
		}
		const current = readCapped(leaf.abs, MAX_FILE_BYTES);
		if (!current) return { status: 413, error: `${wanted.rel} is larger than ${MAX_FILE_BYTES} bytes` };
		const { bom, eol } = shapeOf(current);
		const folded = content.replace(/\r\n/g, "\n");
		const bytes = Buffer.concat([
			bom ? UTF8_BOM : Buffer.alloc(0),
			Buffer.from(eol === "crlf" ? folded.replace(/\n/g, "\r\n") : folded, "utf8"),
		]);
		// The ceiling is on the text, and a file whose own endings double its newlines is still one the
		// editor has to be able to open again.
		if (bytes.length > MAX_FILE_BYTES) return { status: 413, error: `${wanted.rel} would be larger than ${MAX_FILE_BYTES} bytes with its own line endings` };
		const dir = leaf.abs.slice(0, leaf.abs.length - leaf.name.length);
		// The temp file is a sibling with a name of its own rather than the file's name again: the filesystem
		// stops at 255 bytes, and a long name repeated here would make a save fail with ENAMETOOLONG.
		const temp = join(dir, `.pi-studio-${randomUUID()}.tmp`);
		const mode = stat.mode & 0o7777;
		try {
			const fd = openSync(temp, "wx", mode);
			try {
				// The umask has no say in a mode the file already had.
				fchmodSync(fd, mode);
				let at = 0;
				while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at, at);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temp, leaf.abs);
		} catch (error) {
			try {
				unlinkSync(temp);
			} catch {}
			return { status: 409, error: say(error) };
		}
		const after = statSync(leaf.abs);
		return { status: 200, payload: { path: wanted.rel, size: after.size, mtime: Math.floor(after.mtimeMs) } };
	});
	if ("error" in outcome) return void fail(res, outcome.status, outcome.error);
	answer(res, outcome.status, outcome.payload);
}

// ---------- the changes ----------

/**
 * An empty file, or an empty folder. The file is opened with `wx` and the folder made without
 * `recursive`, so a name that is taken is a refusal from the kernel rather than from a check that a
 * second request can walk past.
 */
/** One queued change's answer: a body the client parses, or a sentence it shows. */
type Outcome = { status: number; payload: unknown } | { status: number; error: string };

export async function onFileNew(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readJson(req, res);
	if (!body) return;
	const root = realRoot(board);
	if (!root) return void fail(res, 409, `no such folder: ${board.folder}`);
	const parent = normalizeRel(body.path);
	if ("error" in parent) return void fail(res, 400, parent.error);
	const named = normalizeName(body.name);
	if ("error" in named) return void fail(res, 400, named.error);
	const dir = body.dir === true;
	const path = parent.rel ? `${parent.rel}/${named.name}` : named.name;
	const outcome = await serialised(root, async (): Promise<Outcome> => {
		const folder = physicalDir(root, parent.rel);
		if ("error" in folder) return { status: 409, error: folder.error };
		const target = join(folder.dir, named.name);
		if (present(target)) return { status: 409, error: `${path} already exists` };
		try {
			if (dir) mkdirSync(target);
			else closeSync(openSync(target, "wx"));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return { status: 409, error: code === "EEXIST" ? `${path} already exists` : say(error) };
		}
		return { status: 200, payload: { entry: entryOf(path, named.name, target) } };
	});
	if ("error" in outcome) return void fail(res, outcome.status, outcome.error);
	answer(res, outcome.status, outcome.payload);
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
	const cut = source.rel.lastIndexOf("/");
	const parentRel = cut === -1 ? "" : source.rel.slice(0, cut);
	// The answer names the paths the request named: a parent that is a link inside the workspace is still
	// the folder the client drew, and the disk is resolved separately.
	const to = parentRel ? `${parentRel}/${named.name}` : named.name;
	const outcome = await serialised(root, async (): Promise<Outcome> => {
		const leaf = leafOf(root, source.rel);
		if ("error" in leaf) return { status: 409, error: leaf.error };
		if (!present(leaf.abs)) return { status: 409, error: `no such entry: ${source.rel}` };
		const target = join(leaf.abs.slice(0, leaf.abs.length - leaf.name.length), named.name);
		if (target === leaf.abs) {
			return { status: 200, payload: { from: source.rel, to: source.rel, entry: entryOf(source.rel, leaf.name, leaf.abs) } };
		}
		if (present(target)) return { status: 409, error: `${to} already exists` };
		try {
			await moveNoClobber(leaf.abs, target);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return { status: 409, error: code === "EEXIST" ? `${to} already exists` : say(error) };
		}
		return { status: 200, payload: { from: source.rel, to, entry: entryOf(to, named.name, target) } };
	});
	if ("error" in outcome) return void fail(res, outcome.status, outcome.error);
	answer(res, outcome.status, outcome.payload);
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

/**
 * The name a copy takes when its own name is already in the folder: "copy of notes.txt" the first time,
 * "copy 2 of notes.txt" beside that, and so on. A dot file keeps its whole name as the base, because
 * `.env` has no extension to keep apart from it.
 */
function copyOf(name: string, round: number): string {
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	return `${round === 1 ? "copy of" : `copy ${round} of`} ${base}${ext}`;
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
	const outcome = await serialised(root, async (): Promise<Outcome> => {
		// The destination is resolved here, in the same turn as the writes that follow it, so a link
		// retargeted by another program cannot turn a checked folder into a different one mid-batch.
		const folder = physicalDir(root, dest.rel);
		if ("error" in folder) return { status: 409, error: folder.error };
		const found = sourcesOf(root, body.paths);
		if ("failed" in found) return { status: 409, payload: { error: `nothing was ${word}: the batch did not validate`, failed: found.failed } };
		const steps: { source: Source; to: string; toRel: string }[] = [];
		const failed: Failure[] = [];
		const taken = new Set<string>();
		// A copy asked for the paste habit never refuses a taken name: it lands beside it as "copy of ...".
		const alongside = mode === "copy" && body.onCollision === "copy";
		for (const source of found.sources) {
			let name = source.name;
			let target = join(folder.dir, name);
			// The answer names the destination the way the request named it; the checks below use the disk.
			let toRel = dest.rel ? `${dest.rel}/${name}` : name;
			if (alongside) {
				for (let round = 1; present(target) || taken.has(target); round += 1) {
					name = copyOf(source.name, round);
					target = join(folder.dir, name);
					toRel = dest.rel ? `${dest.rel}/${name}` : name;
				}
			}
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
		if (failed.length) return { status: 409, payload: { error: `nothing was ${word}: the batch did not validate`, failed } };
		const done: { from: string; to: string }[] = [];
		const later: Failure[] = [];
		for (const step of steps) {
			try {
				if (mode === "move") await moveNoClobber(step.source.abs, step.to);
				else await copyNoClobber(step.source.abs, step.to);
				done.push({ from: step.source.rel, to: step.toRel });
			} catch (error) {
				later.push({ path: step.source.rel, error: say(error) });
			}
		}
		// A batch is not a transaction: what was done is reported as done, and nothing is claimed or retried.
		return { status: later.length ? 207 : 200, payload: { [word]: done, ...(later.length ? { failed: later } : {}) } };
	});
	if ("error" in outcome) return void fail(res, outcome.status, outcome.error);
	answer(res, outcome.status, outcome.payload);
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
	const outcome = await serialised(root, async (): Promise<Outcome> => {
		const found = sourcesOf(root, body.paths);
		if ("failed" in found) return { status: 409, payload: { error: "nothing was deleted: the batch did not validate", failed: found.failed } };
		const permanent = body.permanent === true;
		const deleted: string[] = [];
		const needsPermanent: string[] = [];
		const failed: Failure[] = [];
		if (permanent) {
			for (const source of found.sources) {
				try {
					// `rm` removes a link and not what it points at, which is the entry the human selected.
					await rm(source.abs, { recursive: true, force: false });
					deleted.push(source.rel);
				} catch (error) {
					failed.push({ path: source.rel, error: say(error) });
				}
			}
			// The shape does not change with the outcome: a client reads `deleted`, `needsPermanent` and
			// `failed` in every answer instead of knowing which keys a particular press happens to bring.
			return { status: failed.length ? 207 : 200, payload: { deleted, trashed: false, needsPermanent, failed } };
		}
		for (const source of found.sources) {
			const trashed = await gioTrash(source.abs);
			// The path decides, not the exit code: a Trash that moved the file and then complained still moved it.
			const gone = !present(source.abs);
			if (gone) {
				deleted.push(source.rel);
				continue;
			}
			if (trashed.ok) {
				failed.push({ path: source.rel, error: "gio reported the entry trashed but it is still in the folder" });
				continue;
			}
			needsPermanent.push(source.rel);
		}
		return { status: needsPermanent.length || failed.length ? 207 : 200, payload: { deleted, trashed: true, needsPermanent, failed } };
	});
	if ("error" in outcome) return void fail(res, outcome.status, outcome.error);
	answer(res, outcome.status, outcome.payload);
}
