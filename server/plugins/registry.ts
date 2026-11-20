/**
 * The plugins this daemon trusts, read from its own state folder and from nowhere else.
 *
 * A plugin is a program the human named in `plugins.json`: either by the absolute path of an executable, so
 * registering one is a deliberate act on this machine and not something a workspace can do to whoever
 * opens it, or by the name of a plugin this install ships, which is the same act in one word. Nothing a
 * board, a thread or a drop says is read here, and a plugin nobody registered never starts.
 *
 * The file is read at startup and whenever a caller asks, never watched: a plugin that is added while
 * the daemon runs is picked up by the next read, and one that is broken is reported beside the ones
 * that work instead of failing the whole list.
 */
import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { REPO_DIR, STATE_DIR, readJsonFile } from "../paths.ts";

/** Where the daemon's own registration lives: beside its token and its workspaces. */
export const PLUGINS_FILE = join(STATE_DIR, "plugins.json");

/**
 * The plugins a release ships: one folder per plugin under the app's own root, holding a `plugin.json`, the
 * panel's files, and an executable built for each platform the release was packaged on. A source checkout
 * has the same folder, so the same registration works there with a binary built in place.
 */
export const BUNDLED_DIR = join(REPO_DIR, "plugins");

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
	/**
	 * Where the board puts the panel: `undefined` puts it behind a door in the toolbox, and `"drawer"`
	 * puts it in the left drawers' column, beside files, activity and cards, behind a door in the header.
	 */
	place?: "drawer";
};

/**
 * The plain letters the board's own keys already answer to, from `SHORTCUTS` in `public/client/board.js`
 * (`f` files, `a` activity, `c` cards, `d` source control, `m` map, `n` next new, `o` order, `t` new
 * thread, `r` reply, `p` pin, `q` close, `g` git graph, `x` terminal, `0` real size, `1`–`4` on a
 * question). A plugin shortcut is one lowercase letter A plugin takes, and never one of these: a key
 * that belongs to the board is never also a plugin's, whichever side asks first. Keep this list beside
 * that one, so the two agree.
 */
export const PLUGIN_SHORTCUT_TAKEN = ["f", "a", "c", "d", "m", "n", "o", "t", "r", "p", "q", "g", "x", "0", "1", "2", "3", "4"];

/** One executable the daemon starts: what it is called, and what to run. */
export type PluginEntry = {
	name: string;
	/** An absolute path to an executable. It is spawned directly, never through a shell. */
	command: string;
	args: string[];
	/** The panel this plugin offers the board, when it offered one. */
	visual?: PluginVisual;
	/** The folder name of the plugin this install ships, when the row named one instead of a path. */
	bundled?: string;
	/** One plain letter that opens this plugin's panel, when the human assigned one in settings. */
	shortcut?: string;
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
export function loadPluginRegistry(file: string = PLUGINS_FILE, bundledDir: string = BUNDLED_DIR): PluginRegistry {
	if (!existsSync(file)) return { plugins: [], problems: [] };
	const document = readJsonFile<unknown>(file, undefined);
	if (document === undefined) return { plugins: [], problems: [{ name: "", problem: "the file could not be read as JSON" }] };
	const rows = typeof document === "object" && document !== null ? (document as { plugins?: unknown }).plugins : undefined;
	if (!Array.isArray(rows)) return { plugins: [], problems: [{ name: "", problem: 'the file must hold { "plugins": [ … ] }' }] };
	const plugins: PluginEntry[] = [];
	const problems: PluginProblem[] = [];
	const seen = new Set<string>();
	const usedShortcuts = new Set<string>();
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
		const args = bag.args ?? [];
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
			problems.push({ name, problem: "args must be a list of strings" });
			continue;
		}
		// One shortcut answers to one plugin, and a letter the board answers to is never also a plugin's.
		const shortcut = bag.shortcut;
		if (shortcut !== undefined) {
			if (typeof shortcut !== "string" || !/^[a-z]$/.test(shortcut)) {
				problems.push({ name, problem: "shortcut must be one lowercase letter" });
				continue;
			}
			if (PLUGIN_SHORTCUT_TAKEN.includes(shortcut)) {
				problems.push({ name, problem: `shortcut ${shortcut} already belongs to the board` });
				continue;
			}
			if (usedShortcuts.has(shortcut)) {
				problems.push({ name, problem: `shortcut ${shortcut} is already assigned` });
				continue;
			}
			usedShortcuts.add(shortcut);
		}
		// A bundled row names a plugin this install ships, and takes its program and its panel from that
		// folder, so one word is the whole registration.
		if (bag.bundled !== undefined) {
			if (bag.command !== undefined) {
				problems.push({ name, problem: "a row names either command or bundled, not both" });
				continue;
			}
			if (bag.visual !== undefined) {
				problems.push({ name, problem: "a bundled row takes its panel from the plugin's own plugin.json; drop visual" });
				continue;
			}
			const found = bundledOf(bag.bundled, bundledDir);
			if (found.problem !== undefined) {
				problems.push({ name, problem: found.problem });
				continue;
			}
			plugins.push({
				name,
				command: found.command as string,
				args: [...(args as string[])],
				...(found.visual ? { visual: found.visual } : {}),
				...(shortcut !== undefined ? { shortcut: shortcut as string } : {}),
				bundled: (bag.bundled as string).trim(),
			});
			continue;
		}
		const command = bag.command;
		// A relative path would be resolved against whatever folder the daemon happens to be in, and a
		// bare name would be looked up on a PATH someone else may own. Both are refused here.
		if (typeof command !== "string" || !isAbsolute(command)) {
			problems.push({ name, problem: "command must be an absolute path to an executable, or bundled must name a plugin this install ships" });
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
		plugins.push({ name, command, args: [...(args as string[])], ...(visual.visual ? { visual: visual.visual } : {}), ...(shortcut !== undefined ? { shortcut: shortcut as string } : {}) });
	}
	return { plugins, problems };
}

/**
 * One row that names a bundled plugin: the executable this platform runs, and the panel its own manifest
 * declares, both read from that plugin's folder and from nothing else.
 *
 * The manifest is the plugin's own account of itself, and the daemon serves a panel from its registration,
 * so the panel is taken from the manifest here rather than copied by hand into `plugins.json` and left to
 * drift. A panel the manifest declares badly is a problem on the row, the same as a hand-written one.
 */
function bundledOf(value: unknown, bundledDir: string): { command?: string; visual?: PluginVisual; problem?: string } {
	const folder = typeof value === "string" ? value.trim() : "";
	// One folder name, not a path: the registration may name a plugin this install carries and nothing else.
	if (folder === "" || folder.length > 64 || folder.startsWith(".") || /[\\/\0]/.test(folder)) {
		return { problem: "bundled must name one folder inside this install's plugins folder" };
	}
	const root = join(bundledDir, folder);
	if (!isDirectory(root)) return { problem: `this install carries no plugin folder ${folder} in ${bundledDir}` };
	const manifest = readJsonFile<unknown>(join(root, "plugin.json"), undefined);
	if (typeof manifest !== "object" || manifest === null) return { problem: `plugins/${folder}/plugin.json could not be read as one JSON object` };
	const command = executableOf(root, folder);
	if (command === null) return { problem: executableProblem(root, folder) };
	const visual = visualOf(command, (manifest as { visual?: unknown }).visual);
	if (visual.problem !== undefined) return { problem: visual.problem };
	return { command, ...(visual.visual ? { visual: visual.visual } : {}) };
}

/**
 * The executable a bundled plugin runs: the one this release built for this platform when it shipped one,
 * and otherwise a binary built in the plugin's own folder, which is how a checkout is used.
 */
function executableOf(root: string, folder: string): string | null {
	for (const file of [`${folder}-${process.platform}-${process.arch}`, folder]) {
		const path = join(root, file);
		if (isExecutableFile(path)) return path;
	}
	return null;
}

/** Why a bundled plugin cannot run here, naming the file a release of this platform would have shipped. */
function executableProblem(root: string, folder: string): string {
	const wanted = `${folder}-${process.platform}-${process.arch}`;
	return `${root} holds no executable for ${process.platform}-${process.arch}: it needs ${wanted}, or ${folder} built in place`;
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
	const place = bag.place;
	if (place !== undefined && place !== "drawer") return { problem: "visual.place must be \"drawer\" when it is given" };
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
	return { visual: { title, entry, files, ...(place === "drawer" ? { place: "drawer" as const } : {}) } };
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

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
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
