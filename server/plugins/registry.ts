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
import { accessSync, constants, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { APP_VERSION, REPO_DIR, STATE_DIR, readJsonFile } from "../paths.ts";
import { PROTOCOL_MINOR, PROTOCOL_VERSION } from "./protocol.ts";

/** Where the daemon's own registration lives: beside its token and its workspaces. */
export const PLUGINS_FILE = join(STATE_DIR, "plugins.json");

/**
 * Where a human installs plugins: one folder per plugin under the state folder, beside `plugins.json`.
 * It lives in state rather than beside the app because an uninstall deletes the app and keeps state,
 * so an installed plugin survives an update and an uninstall — the folder is the user's, not the
 * release's.
 */
export const PLUGINS_DIR = join(STATE_DIR, "plugins");

/**
 * The plugins a release ships: one folder per plugin under the app's own root, holding a `plugin.json`, the
 * panel's files, and an executable built for each platform the release was packaged on. A source checkout
 * has the same folder, so the same registration works there with a binary built in place.
 */
export const BUNDLED_DIR = join(REPO_DIR, "plugins");

/** The edges a drawer panel may sit on, as a plugin may declare them: one side, or any of the four. */
export const PLUGIN_VISUAL_POSITIONS = ["any", "bottom", "top", "left", "right"] as const;
export type PluginVisualPosition = (typeof PLUGIN_VISUAL_POSITIONS)[number];

/** The four concrete edges a drawer can be drawn on. The pick a human saves in settings is always one of these. */
export const PLUGIN_VISUAL_SIDES = ["bottom", "top", "left", "right"] as const;
export type PluginVisualSide = (typeof PLUGIN_VISUAL_SIDES)[number];

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
	 * puts it in a drawer behind a door in the header. A drawer sits on `position`, or on the left when
	 * `position` is not written, which is what every drawer panel written before `position` did.
	 */
	place?: "drawer";
	/**
	 * Which edge the drawer sits on. `undefined` means the left, as a drawer panel always has; `none` of
	 * the values is read without `place: "drawer"`, and a value the board cannot draw is a problem on
	 * the row rather than a move to another edge. `"any"` says the plugin takes any edge, and the edge
	 * is the one its registration's `position` names, or the left when that is not written either.
	 */
	position?: PluginVisualPosition;
};


/**
 * The plain letters the board's own keys already answer to, from `SHORTCUTS` in `public/client/board.js`
 * (`f` files, `a` activity, `c` cards, `d` source control, `m` map, `n` next new, `o` order, `t` new
 * thread, `r` reply, `p` pin, `q` close, `g` git graph, `x` terminal, `k` kontainer, `l` logs, `0` real size,
 * `1`–`4` on a question). A plugin shortcut is one lowercase letter A plugin takes, and never one of these: a key
 * that belongs to the board is never also a plugin's, whichever side asks first. Keep this list beside
 * that one, so the two agree.
 */
export const PLUGIN_SHORTCUT_TAKEN = ["f", "a", "c", "d", "m", "n", "o", "t", "r", "p", "q", "g", "x", "k", "l", "0", "1", "2", "3", "4"];

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
	/** The folder name of the plugin the human installed, when the row named one instead of a path. */
	installed?: string;
	/** One plain letter that opens this plugin's panel, when the human assigned one in settings. */
	shortcut?: string;
	/**
	 * The edge the human picked for this plugin in settings, when they picked one. It wins over the
	 * manifest's `visual.position`, and it is the whole point of a plugin that says `"any"`: the plugin
	 * names no edge, and settings names one of the four.
	 */
	position?: PluginVisualSide;
	/** The plugin's own version, from its manifest; for display before its process has ever run. */
	version?: string;
	/**
	 * When the daemon starts the process: at boot with the roster (`"eager"`, the default, the only
	 * choice for a plugin that watches the world or listens for events), or on the first panel request
	 * (`"lazy"`, for a plugin that only answers a door).
	 */
	start?: "eager" | "lazy";
};

/**
 * A plugin's own account of itself: one `plugin.json` in its folder. The daemon reads it rather than
 * being told — name, command defaults, panel, version floor — so an installed folder is one unit a
 * human copies in, and a market in one sentence later.
 */
export type PluginManifest = {
	name?: string;
	version?: string;
	protocol?: number;
	protocolMinor?: number;
	minPiStudio?: string;
	title?: string;
	description?: string;
	command?: string;
	args?: string[];
	start?: "eager" | "lazy";
	shortcut?: string;
	visual?: PluginVisual;
};

/** What the settings page offers a human to enable: a folder with a usable manifest, and its defaults. */
export type AvailablePlugin = {
	name: string;
	folder: string;
	source: "installed" | "bundled";
	version: string;
	title: string;
	description: string;
	start: "eager" | "lazy";
	defaults: { args: string[]; shortcut?: string; place?: "drawer"; position?: PluginVisualPosition };
};

/** A folder the settings page shows but cannot offer, and why. */
export type UnavailablePlugin = { folder: string; source: "installed" | "bundled"; problem: string };

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
export function loadPluginRegistry(file: string = PLUGINS_FILE, bundledDir: string = BUNDLED_DIR, installedDir: string = PLUGINS_DIR): PluginRegistry {
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
		// The edge a human picked for this plugin in settings. It is a pick, so it is one of the four
		// sides and never `"any"`: a plugin that says `"any"` names no edge, and this is the one that
		// does. It is kept on the row so a settings page can show what was picked, and it wins over
		// the manifest's `visual.position` below and beside a command row's `visual.position`.
		const pick = positionPickOf(bag.position);
		if (pick.problem !== undefined) {
			problems.push({ name, problem: pick.problem });
			continue;
		}
		// A bundled row names a plugin this install ships, and takes its program and its panel from that
		// folder, so one word is the whole registration. An installed row is the same one word for the
		// folder the human put in `~/.local/state/pi-studio/plugins/`.
		const named = bag.bundled !== undefined ? { kind: "bundled" as const, value: bag.bundled } : bag.installed !== undefined ? { kind: "installed" as const, value: bag.installed } : null;
		if (named !== null) {
			if (bag.command !== undefined) {
				problems.push({ name, problem: `a row names either command or ${named.kind}, not both` });
				continue;
			}
			if (bag.visual !== undefined) {
				problems.push({ name, problem: `a ${named.kind} row takes its panel from the plugin's own plugin.json; drop visual` });
				continue;
			}
			const folder = named.value;
			const found = manifestOf(folder, named.kind === "bundled" ? bundledDir : installedDir);
			if (found.problem !== undefined) {
				problems.push({ name, problem: found.problem });
				continue;
			}
			// The pick sits on a drawer panel and nowhere else: a position with no drawer place is a
			// problem on the row, the same as a `visual.position` without its place is on a manifest. It
			// is kept beside the manifest's ask rather than folded into it, so settings can keep
			// showing what the plugin asked (often `"any"`) beside the pick that wins, and only the
			// board's list merges the two.
			if (pick.position !== undefined && found.visual?.place !== "drawer") {
				problems.push({ name, problem: 'position needs a panel with visual.place "drawer"' });
				continue;
			}
			plugins.push({
				name,
				command: found.command as string,
				// A row that says nothing about args takes the manifest's: `args: []` written on purpose
				// is still args: [], because a reader cannot tell the two apart afterwards and must not guess.
				args: bag.args === undefined ? [...(found.manifest?.args ?? [])] : [...(args as string[])],
				...(found.visual ? { visual: found.visual } : {}),
				...(shortcut !== undefined ? { shortcut: shortcut as string } : {}),
				...(pick.position !== undefined ? { position: pick.position } : {}),
				...(found.version ? { version: found.version } : {}),
				...(found.start === "lazy" ? { start: "lazy" as const } : {}),
				[named.kind]: (folder as string).trim(),
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
		if (pick.position !== undefined && visual.visual?.place !== "drawer") {
			problems.push({ name, problem: 'position needs a panel with visual.place "drawer"' });
			continue;
		}
		plugins.push({ name, command, args: [...(args as string[])], ...(visual.visual ? { visual: visual.visual } : {}), ...(shortcut !== undefined ? { shortcut: shortcut as string } : {}), ...(pick.position !== undefined ? { position: pick.position } : {}) });
	}
	return { plugins, problems };
}

/**
 * One row that names a plugin by its folder: the executable this platform runs, and the panel its own
 * manifest declares, both read from that plugin's folder and from nothing else.
 *
 * The manifest is the plugin's own account of itself, and the daemon serves a panel from its registration,
 * so the panel is taken from the manifest here rather than copied by hand into `plugins.json` and left to
 * drift. A panel the manifest declares badly is a problem on the row, the same as a hand-written one.
 */
function manifestOf(value: unknown, dir: string): { command?: string; visual?: PluginVisual; version?: string; start?: "eager" | "lazy"; manifest?: PluginManifest; problem?: string } {
	const folder = typeof value === "string" ? value.trim() : "";
	// One folder name, not a path: the registration may name a plugin this folder holds and nothing else.
	if (folder === "" || folder.length > 64 || folder.startsWith(".") || /[\\/\0]/.test(folder)) {
		return { problem: "the row must name one folder inside the plugins folder" };
	}
	const root = join(dir, folder);
	if (!isDirectory(root)) return { problem: `${dir} carries no plugin folder ${folder}` };
	const document = readManifestFile(root, folder);
	if ("problem" in document) return { problem: document.problem };
	const manifest = document.manifest;
	if (manifest.name !== undefined && manifest.name !== folder) {
		return { problem: `plugin.json says its name is ${manifest.name}, not ${folder}` };
	}
	const command = executableOfManifest(root, folder, manifest.command);
	if (command.problem !== undefined) return { problem: command.problem };
	// The panel's title falls back to the manifest's, then to the folder's name.
	const visualInput = manifest.visual !== undefined
		? {
				...(manifest.visual as unknown as Record<string, unknown>),
				title: typeof (manifest.visual as unknown as Record<string, unknown>).title === "string" && ((manifest.visual as unknown as Record<string, unknown>).title as string).trim() !== "" ? (manifest.visual as unknown as Record<string, unknown>).title : manifest.title?.trim() ? manifest.title : folder,
			}
		: undefined;
	const visual = visualOf(command.command as string, visualInput);
	if (visual.problem !== undefined) return { problem: visual.problem };
	if (manifest.start === "lazy" && visual.visual === undefined) {
		return { problem: "a plugin that starts lazily needs a panel to start it; declare start as eager, or give it a visual" };
	}
	return {
		command: command.command,
		...(visual.visual ? { visual: visual.visual } : {}),
		...(manifest.version ? { version: manifest.version } : {}),
		...(manifest.start === "lazy" ? { start: "lazy" as const } : {}),
		manifest,
	};
}


/** One folder's `plugin.json` as the manifest it is, or the reason it cannot be read as one. */
function readManifestFile(root: string, folder: string): { manifest: PluginManifest } | { problem: string } {
	const document = readJsonFile<unknown>(join(root, "plugin.json"), undefined);
	if (typeof document !== "object" || document === null || Array.isArray(document)) {
		return { problem: `${join(root, "plugin.json")} could not be read as one JSON object` };
	}
	const bag = document as Record<string, unknown>;
	const manifest: PluginManifest = {};
	if (bag.name !== undefined) manifest.name = typeof bag.name === "string" ? bag.name.trim() : "";
	if (bag.version !== undefined) manifest.version = typeof bag.version === "string" ? bag.version.trim() : "";
	if (bag.protocol !== undefined) manifest.protocol = typeof bag.protocol === "number" ? bag.protocol : NaN;
	if (bag.protocolMinor !== undefined) manifest.protocolMinor = typeof bag.protocolMinor === "number" ? bag.protocolMinor : NaN;
	if (bag.minPiStudio !== undefined) manifest.minPiStudio = typeof bag.minPiStudio === "string" ? bag.minPiStudio.trim() : "";
	if (bag.title !== undefined) manifest.title = typeof bag.title === "string" ? bag.title.trim() : "";
	if (bag.description !== undefined) manifest.description = typeof bag.description === "string" ? bag.description.trim() : "";
	if (bag.command !== undefined) manifest.command = typeof bag.command === "string" ? bag.command.trim() : "";
	if (bag.args !== undefined) manifest.args = Array.isArray(bag.args) && bag.args.every((one) => typeof one === "string") ? [...(bag.args as string[])] : undefined;
	if (bag.start !== undefined) manifest.start = bag.start === "lazy" ? "lazy" : "eager";
	if (bag.shortcut !== undefined) manifest.shortcut = typeof bag.shortcut === "string" ? bag.shortcut.trim().toLowerCase() : "";
	if (bag.visual !== undefined) manifest.visual = bag.visual as PluginVisual;
	if (manifest.version !== undefined && !isSemVer(manifest.version)) {
		return { problem: `plugin.json version ${JSON.stringify(manifest.version)} is not a version` };
	}
	// A manifest written before protocol was a thing still works: it is refused only when it says the
	// wrong number, never for saying nothing.
	if (manifest.protocol !== undefined && manifest.protocol !== PROTOCOL_VERSION) {
		return { problem: `plugin.json speaks protocol ${manifest.protocol}; this daemon speaks ${PROTOCOL_VERSION}` };
	}
	if (manifest.protocolMinor !== undefined && (!Number.isInteger(manifest.protocolMinor) || manifest.protocolMinor < 0 || manifest.protocolMinor > PROTOCOL_MINOR)) {
		return { problem: `plugin.json asks for protocol minor ${manifest.protocolMinor}, which this daemon does not carry` };
	}
	if (manifest.minPiStudio !== undefined && (!isSemVer(manifest.minPiStudio) || compareSemVer(APP_VERSION, manifest.minPiStudio) < 0)) {
		return { problem: `plugin.json asks for pi-studio ${manifest.minPiStudio} or newer; this daemon is ${APP_VERSION}` };
	}
	if (manifest.start !== undefined && bag.start !== "eager" && bag.start !== "lazy") {
		return { problem: 'plugin.json start must be "eager" or "lazy"' };
	}
	if (manifest.shortcut !== undefined && !/^[a-z]$/.test(manifest.shortcut)) {
		return { problem: "plugin.json shortcut must be one lowercase letter" };
	}
	return { manifest };
}


function isSemVer(value: string): boolean {
	return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

function compareSemVer(a: string, b: string): number {
	const split = (value: string) => value.split(".").map((part) => Number(part));
	const [a0, a1, a2] = split(a);
	const [b0, b1, b2] = split(b);
	return a0 - b0 || a1 - b1 || a2 - b2;
}

/**
 * The executable a plugin in its folder runs: the one its manifest named (a relative path inside the
 * folder), else the one this release built for this platform when it shipped one, and otherwise a binary
 * built in the plugin's own folder, which is how a checkout is used.
 */
function executableOfManifest(root: string, folder: string, named: string | undefined): { command?: string; problem?: string } {
	if (named !== undefined) {
		const path = visualPath(named);
		if (path === null) return { problem: `plugin.json command ${JSON.stringify(named)} is not a relative path inside the plugin's own folder` };
		const full = join(root, path);
		if (!isExecutableFile(full)) return { problem: `${full} is not an executable file` };
		return { command: full };
	}
	for (const file of [`${folder}-${process.platform}-${process.arch}`, folder]) {
		const path = join(root, file);
		if (isExecutableFile(path)) return { command: path };
	}
	return { problem: executableProblem(root, folder) };
}

function executableOf(root: string, folder: string): string | null {
	const found = executableOfManifest(root, folder, undefined);
	return found.command ?? null;
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
	const position = positionOf(bag.position);
	if (position.problem !== undefined) return { problem: position.problem };
	if (position.position !== undefined && place !== "drawer") return { problem: 'visual.position needs visual.place "drawer"' };
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
	return { visual: { title, entry, files, ...(place === "drawer" ? { place: "drawer" as const } : {}), ...(position.position !== undefined ? { position: position.position } : {}) } };
}

/**
 * The edge a panel declared, no edge when it declared none, or the reason its word cannot be used.
 *
 * The list is the whole of what the board can draw: a side outside it is a problem on the row rather
 * than a move to an edge a plugin did not ask for, so a plugin never learns of a newer side by being
 * silently put somewhere else.
 */
function positionOf(value: unknown): { position?: PluginVisualPosition; problem?: string } {
	if (value === undefined) return {};
	if (typeof value !== "string" || !(PLUGIN_VISUAL_POSITIONS as readonly string[]).includes(value))
		return { problem: 'visual.position must be "any", "bottom", "top", "left" or "right" when it is given' };
	return { position: value as PluginVisualPosition };
}

/**
 * The edge a human picked in settings as a row-level `position`: always one of the four concrete
 * sides, so `"any"` — a plugin saying it takes any edge — is not a pick and is refused here.
 */
function positionPickOf(value: unknown): { position?: PluginVisualSide; problem?: string } {
	if (value === undefined) return {};
	if (typeof value !== "string" || !(PLUGIN_VISUAL_SIDES as readonly string[]).includes(value))
		return { problem: 'position must be "bottom", "top", "left" or "right" when it is given' };
	return { position: value as PluginVisualSide };
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

/**
 * The plugins on disk that nobody registered, offered to the settings page to enable, and the folders it
 * cannot offer and why. Every folder in the plugins folder and the shipped one is read once, its manifest
 * proved without starting anything — a folder broken at install time is shown broken rather than offered
 * as if it worked. A name a registration already holds is not offered twice.
 */
export function loadAvailablePlugins(registered: Iterable<string>, installedDir: string = PLUGINS_DIR, bundledDir: string = BUNDLED_DIR): { available: AvailablePlugin[]; unavailable: UnavailablePlugin[] } {
	const held = new Set(registered);
	const available: AvailablePlugin[] = [];
	const unavailable: UnavailablePlugin[] = [];
	const offered = new Set<string>();
	const scan = (dir: string, source: "installed" | "bundled") => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const folder of names) {
			if (folder.startsWith(".") || folder.length > 64 || /[\\/\0]/.test(folder)) continue;
			const root = join(dir, folder);
			let isFolder = false;
			try {
				// A link where a plugin folder should be is not a plugin the human installed.
				if (lstatSync(root).isSymbolicLink()) continue;
				isFolder = isDirectory(root);
			} catch {
				continue;
			}
			if (!isFolder) continue;
			// The scan proves a folder the same way a registration does, through the same reader, so
			// what it offers is exactly what enabling it registers — no hand-rolled second proof.
			const found = manifestOf(folder, dir);
			if (found.problem !== undefined) {
				unavailable.push({ folder, source, problem: found.problem });
				continue;
			}
			const manifest = found.manifest as PluginManifest;
			const name = manifest.name ?? folder;
			if (held.has(name) || offered.has(name)) continue;
			offered.add(name);
			available.push({
				name,
				folder,
				source,
				version: manifest.version ?? "0.0.0",
				title: manifest.title ?? name,
				description: manifest.description ?? "",
				start: found.start ?? "eager",
				defaults: {
					args: manifest.args ?? [],
					...(manifest.shortcut ? { shortcut: manifest.shortcut } : {}),
					...(found.visual?.place === "drawer" ? { place: "drawer" as const } : {}),
					...(found.visual?.position !== undefined ? { position: found.visual.position } : {}),
				},
			});
		}
	};
	// The human's own folder first: where both hold one name, theirs is the one offered.
	scan(installedDir, "installed");
	scan(bundledDir, "bundled");
	return { available, unavailable };
}
