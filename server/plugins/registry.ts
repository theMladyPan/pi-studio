/**
 * The plugins this daemon trusts, read from its own state folder and from nowhere else.
 *
 * A plugin is a program the human named in `plugins.json` by the absolute path of an executable, so
 * registering one is a deliberate act on this machine and not something a workspace can do to whoever
 * opens it. Nothing a board, a thread or a drop says is read here.
 *
 * The file is read at startup and whenever a caller asks, never watched: a plugin that is added while
 * the daemon runs is picked up by the next read, and one that is broken is reported beside the ones
 * that work instead of failing the whole list.
 */
import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { STATE_DIR, readJsonFile } from "../paths.ts";

/** Where the daemon's own registration lives: beside its token and its workspaces. */
export const PLUGINS_FILE = join(STATE_DIR, "plugins.json");

/**
 * The panel a plugin may put on a board: the document a frame loads, and every file that frame may
 * fetch, each named relative to the plugin's own folder — the one its executable sits in.
 */
export type PluginVisual = {
	/** What the board calls the panel. One line, shown on its door and in its bar. */
	title: string;
	/** The document the frame loads. It has to be one of `files`. */
	entry: string;
	/** Every file this daemon will serve for the panel, and nothing beside them. */
	files: string[];
};

/** One executable the daemon starts: what it is called, and what to run. */
export type PluginEntry = {
	name: string;
	/** An absolute path to an executable. It is spawned directly, never through a shell. */
	command: string;
	args: string[];
	/** The panel this plugin offers the board, when it offered one. */
	visual?: PluginVisual;
};

/** One row of the file that is not a plugin the daemon can start, and why. */
export type PluginProblem = { name: string; problem: string };

/** Everything the file said: the plugins that can start, and the rows that cannot. */
export type PluginRegistry = { plugins: PluginEntry[]; problems: PluginProblem[] };

/**
 * The registration as it stands. A missing file is no plugins at all, which is the normal state of a
 * new daemon; a file that cannot be read or holds the wrong shape is one problem and no plugins.
 *
 * Unknown keys on a row are ignored: a row may carry what it likes. `visual` is the one optional key
 * this daemon reads, and a `visual` it cannot use is a problem on that row rather than a row it half
 * accepts: a panel whose files are not where it says would be a door onto a page that never loads.
 */
export function loadPluginRegistry(file: string = PLUGINS_FILE): PluginRegistry {
	if (!existsSync(file)) return { plugins: [], problems: [] };
	const document = readJsonFile<unknown>(file, undefined);
	if (document === undefined) return { plugins: [], problems: [{ name: "", problem: "the file could not be read as JSON" }] };
	const rows = typeof document === "object" && document !== null ? (document as { plugins?: unknown }).plugins : undefined;
	if (!Array.isArray(rows)) return { plugins: [], problems: [{ name: "", problem: 'the file must hold { "plugins": [ … ] }' }] };
	const plugins: PluginEntry[] = [];
	const problems: PluginProblem[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			problems.push({ name: "", problem: "one row is not an object" });
			continue;
		}
		const bag = row as Record<string, unknown>;
		const name = typeof bag.name === "string" ? bag.name.trim() : "";
		if (name === "") {
			problems.push({ name: "", problem: "one row has no name" });
			continue;
		}
		if (seen.has(name)) {
			problems.push({ name, problem: "the name is used twice" });
			continue;
		}
		seen.add(name);
		const command = bag.command;
		// A relative path would be resolved against whatever folder the daemon happens to be in, and a
		// bare name would be looked up on a PATH someone else may own. Both are refused here.
		if (typeof command !== "string" || !isAbsolute(command)) {
			problems.push({ name, problem: "command must be an absolute path to an executable" });
			continue;
		}
		const args = bag.args ?? [];
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
			problems.push({ name, problem: "args must be a list of strings" });
			continue;
		}
		if (!isExecutableFile(command)) {
			problems.push({ name, problem: `${command} is not an executable file` });
			continue;
		}
		const visual = visualOf(command, bag.visual);
		if (visual.problem !== undefined) {
			problems.push({ name, problem: visual.problem });
			continue;
		}
		plugins.push({ name, command, args: [...(args as string[])], ...(visual.visual ? { visual: visual.visual } : {}) });
	}
	return { plugins, problems };
}

/** How long a panel's title may be, because it is drawn on one line of a menu and of a bar. */
const MAX_VISUAL_TITLE = 80;

/**
 * The panel a row declared, no panel when it declared none, or the reason its declaration cannot be used.
 *
 * Every file is resolved here rather than on the first request that asks for it, so a plugin whose panel
 * points at nothing is reported when the daemon starts and not when a human presses its door.
 */
function visualOf(command: string, value: unknown): { visual?: PluginVisual; problem?: string } {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) return { problem: "visual must be one object" };
	const bag = value as Record<string, unknown>;
	const title = typeof bag.title === "string" ? bag.title.trim() : "";
	if (title === "" || title.length > MAX_VISUAL_TITLE) return { problem: `visual.title must be one line of 1 to ${MAX_VISUAL_TITLE} characters` };
	const entry = visualPath(bag.entry);
	if (entry === null) return { problem: "visual.entry must be a relative path inside the plugin's own folder" };
	const rows = bag.files;
	if (!Array.isArray(rows) || rows.length === 0) return { problem: "visual.files must name at least one file" };
	const files: string[] = [];
	for (const row of rows) {
		const path = visualPath(row);
		if (path === null) return { problem: `${JSON.stringify(row)} is not a relative path inside the plugin's own folder` };
		if (!files.includes(path)) files.push(path);
	}
	if (!files.includes(entry)) return { problem: "visual.entry has to be one of visual.files" };
	const root = dirname(command);
	for (const path of files) {
		if (resolvePluginFile(root, path) === null) return { problem: `visual file ${path} is not a file inside ${root}` };
	}
	return { visual: { title, entry, files } };
}

/**
 * A path a panel may name: relative, inside the plugin's folder, and free of everything a path can use
 * to leave it. An absolute path, a `..` segment, a backslash or an empty segment is not one of these.
 */
function visualPath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const path = value.trim();
	if (path === "" || path.length > 200 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return null;
	const segments = path.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
	return segments.join("/");
}

/**
 * Where one declared panel file really is, or null when it is not a plain file inside the plugin's folder.
 *
 * A declared path is relative and already free of `..`, so the traversal a request could attempt is
 * refused before this is called. What is left is the filesystem's own answer: a file that has since been
 * replaced by a link is refused even when the link points inside, because a panel is served from the
 * folder the human installed and from nothing it did not name. A folder that is itself a link is fine —
 * both ends are resolved before they are compared.
 */
export function resolvePluginFile(root: string, path: string): string | null {
	try {
		const realRoot = realpathSync(root);
		const asked = join(realRoot, path);
		// The path as it stands, before anything is followed: a link where the panel's file should be is
		// not the file the human installed, so it is refused whatever it points at.
		if (!lstatSync(asked).isFile()) return null;
		const real = realpathSync(asked);
		const inside = relative(realRoot, real);
		if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
		return real;
	} catch {
		return null;
	}
}

function isExecutableFile(command: string): boolean {
	try {
		if (!statSync(command).isFile()) return false;
		accessSync(command, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
