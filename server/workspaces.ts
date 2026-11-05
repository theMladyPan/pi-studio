// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The workspaces on disk: the list the crossroads shows, the defaults a new board starts with, and the
 * one line of facts each one is described by.
 */
import { SCRATCH_DIR, STATE_VERSION, WORKSPACES_FILE, boardFile, readJsonFile, workspaceId, writeJsonFile } from "./paths.ts";
import { boards } from "./store.ts";
import { sessionFacts } from "./session.ts";
import { basename, join } from "node:path";
import { BUILTIN_TOOLS, CHILD_EXTENSIONS, MODEL, PROVIDER, THINKING_LEVELS, run } from "./models.ts";
import { CARD_AUDIENCE, CARD_LEVELS, CARD_SHOWS, CARD_VERBOSITY, cardSettings } from "./card-settings.ts";
import { CHILD_INTEGRATION, integrationOf } from "./integration.ts";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { PATH_NAMES } from "./child/modes.ts";
import { spawnSync } from "node:child_process";



/**
 * One exchange with a thread. The card shows the words typed in and the answer once it lands.
 * @typedef {object} Turn
 * @property {string} text
 * @property {"queued"|"sent"|"answered"|"stopped"} status
 * @property {"queue"|"steer"} mode
 * @property {number} at
 * @property {string} [reply] the answer: the last message of the run, and nothing else
 * @property {string[]} [interim] what the run said before it called a tool, one paragraph a message
 */

/**
 * A thread is one card on a board and one child process on demand.
 * @typedef {object} Thread
 * @property {string} id
 * @property {string} title
 * @property {string|null} sessionId
 * @property {"idle"|"running"|"dead"} status
 * @property {string} provider
 * @property {string} model
 * @property {string} [thinking]
 * @property {number} at
 * @property {Turn[]} turns
 * @property {(string|{message: string, text: string, target?: {cardId?: string, turn: number}})[]} queued
 * @property {{cardId: string, turn: number}|{turn: number}|null} [answering] the turn the run in flight
 *   writes its answer into: `cardId` names the card when a hidden child answers for one, and a bare
 *   `turn` is the index of one of the thread's own turns.
 * @property {{x:number,y:number,w:number,h:number}} [rect]
 * @property {boolean} [mini]
 * @property {number} [runStartedAt]
 * @property {string} [stderrTail]
 * @property {string} [threadRoot]
 * @property {boolean} [hidden] the thread is not drawn as a card of its own; the cards it answers for
 *   are where it is read. The child a card nobody answers for starts hidden, and a thread whose own card
 *   is closed while it still owns cards becomes hidden rather than dying.
 */

/**
 * A card with no child behind it: markdown a note carries, or a file a source card shows. The daemon
 * keeps them beside the threads and the client draws them by `type`.
 * @typedef {object} PlainCard
 * @property {string} id
 * @property {"note"|"source"|"question"} type
 * @property {string} title
 * @property {string} [question]
 * @property {string[]} [options]
 * @property {boolean} [allowFreeText]
 * @property {boolean} [multiple] the question takes several answers: the human ticks boxes and sends
 *   them together, and `answers` is what they ticked
 * @property {string[]} [answers] the picks of a question that takes several answers
 * @property {"open"|"answered"|"expired"} [status]
 * @property {string} [answer]
 * @property {number} [expiresAt]
 * @property {string} [markdown]
 * @property {string} [path]
 * @property {string} [content]
 * @property {number} [line]
 * @property {string} [key]
 * @property {string} [threadRoot] where the card cascades
 * @property {string} [ownerThread] the thread that answers comments on it
 * @property {Turn[]} [turns] what was asked about this card, and what came back
 * @property {number} at
 * @property {number} [updatedAt]
 * @property {{x:number,y:number,w:number,h:number}} [rect]
 * @property {boolean} [mini]
 * @property {string[]} [after] the cards this one builds on, one arrow drawn from each
 * @property {"compact"|"normal"|"wide"|"tall"} [size] the form the card is drawn in, which is a
 *   shape rather than emphasis: a wide card holds a chart, a compact one a three-line answer
 * @property {boolean} [pinned] the human keeps this card in sight, so eviction passes it over
 */

/**
 * A live board: the workspace it belongs to, what is on it, and who is watching.
 * @typedef {object} Board
 * @property {string} id
 * @property {string} folder
 * @property {string} name
 * @property {Map<string, Thread>} threads
 * @property {Map<string, PlainCard>} cards
 * @property {Map<string, {resolve: (value: {status: string, answer?: string, answers?: string[]}) => void}>} askers
 * @property {object[]} activity
 * @property {Map<string, import("node:child_process").ChildProcess>} children
 * @property {Set<import("node:http").ServerResponse>} clients
 * @property {NodeJS.Timeout|null} saveTimer
 */

// ---------- small filesystem helpers ---------------------------------------

// ---------- workspaces -----------------------------------------------------

/**
 * What the human has opened before. A workspace is a folder; its board lives in its own file, and
 * the pi sessions behind its threads are the app's own, referenced by id and never copied here.
 * @typedef {object} Workspace
 * @property {string} id
 * @property {string} folder
 * @property {string} name
 * @property {number} openedAt
 */

/** @type {Workspace[]} newest first, because that is the order the crossroads shows. */
export const workspaces = (() => {
	const saved = readJsonFile(WORKSPACES_FILE, null);
	if (!saved || saved.version !== STATE_VERSION || !Array.isArray(saved.workspaces)) return [];
	return saved.workspaces
		.filter((workspace) => typeof workspace?.folder === "string" && workspace.folder)
		.map((workspace) => ({
			id: typeof workspace.id === "string" && workspace.id ? workspace.id : workspaceId(workspace.folder),
			folder: workspace.folder,
			name: typeof workspace.name === "string" && workspace.name ? workspace.name : basename(workspace.folder),
			openedAt: Number.isFinite(workspace.openedAt) ? workspace.openedAt : 0,
		}));
})();



/** What a new board is born with, set on the crossroads and shared by every workspace opened after it. */
export let homeDefaults = (() => {
	const saved = readJsonFile(WORKSPACES_FILE, null);
	const held = saved?.defaults;
	if (!held || typeof held !== "object") return {};
	const known = {};
	if (typeof held.provider === "string" && held.provider) known.provider = held.provider;
	if (typeof held.model === "string" && held.model) known.model = held.model;
	if (THINKING_LEVELS.includes(held.thinking)) known.thinking = held.thinking;
	if (typeof held.dimOthers === "boolean") known.dimOthers = held.dimOthers;
	// The card settings: two ids checked against the list they belong to, and four levels. A file written
	// before these existed has none of them, and one from the first build holds booleans, which
	// `cardSettings()` still reads.
	if (CARD_VERBOSITY.includes(held.cardsVerbosity)) known.cardsVerbosity = held.cardsVerbosity;
	if (CARD_AUDIENCE.includes(held.cardsAudience)) known.cardsAudience = held.cardsAudience;
	for (const key of CARD_SHOWS) {
		const value = held[key];
		if (CARD_LEVELS.includes(value) || typeof value === "boolean") known[key] = value;
	}
	// How a new board brings a child's work back: an id checked against its list, so a restart does not drop it.
	if (CHILD_INTEGRATION.includes(held.childIntegration)) known.childIntegration = held.childIntegration;
	// The built-in tools and the extensions a new board's threads do not get, filtered the way `activeConfig`
	// reads them: a name this pi no longer ships is dropped rather than carried into every new board.
	if (Array.isArray(held.toolsOff)) known.toolsOff = held.toolsOff.filter((name) => BUILTIN_TOOLS.includes(name));
	if (Array.isArray(held.extensionsOff))
		known.extensionsOff = held.extensionsOff.filter((name) => CHILD_EXTENSIONS.some((one) => one.name === name));
	// The flow a new board's boss starts on: an id checked against its list, as `path` is everywhere else.
	if (PATH_NAMES.includes(held.path)) known.path = held.path;
	// The program a code card's file opens in. A name found on PATH, or the path to the binary; empty is
	// "nobody chose one yet", so an empty string is dropped rather than carried around.
	if (typeof held.editor === "string" && held.editor) known.editor = held.editor;
	return known;
})();



export function saveWorkspaces() {
	writeJsonFile(WORKSPACES_FILE, { version: STATE_VERSION, workspaces, defaults: homeDefaults });
}



/**
 * The one place `homeDefaults` is written. An `import` is a constant binding, so a route that assigned to
 * it threw `Assignment to constant variable` and answered 500 on every save; the write belongs here, with
 * the file it has to reach.
 */
export function setHomeDefaults(next) {
	homeDefaults = next;
	saveWorkspaces();
}



/** The crossroads' defaults with the daemon's own model filled in, so the page can show them. */
export function activeHomeDefaults() {
	return {
		provider: homeDefaults.provider ?? PROVIDER,
		model: homeDefaults.model ?? MODEL,
		...(homeDefaults.thinking ? { thinking: homeDefaults.thinking } : {}),
		dimOthers: homeDefaults.dimOthers !== false,
		// A new board is born with the six card settings, chosen or default: the settings page draws every
		// leaf it is given and a missing value would draw an empty control.
		...cardSettings(homeDefaults),
		childIntegration: integrationOf(homeDefaults),
		// What a new board's threads may touch and which flow its boss starts on: the three the board's own
		// settings page draws, so they are the three the crossroads' page draws too.
		toolsOff: homeDefaults.toolsOff ?? [],
		extensionsOff: homeDefaults.extensionsOff ?? [],
		path: homeDefaults.path ?? "auto",
		// Studio-wide rather than per board: every board opens a code card's file in the same program. Trimmed
		// here, where both pages read it, because a hand-edited state file may carry the spaces a save drops.
		editor: (homeDefaults.editor ?? "").trim(),
	};
}


/** Tabs sitting on the crossroads, so the counts there stay honest without a reload. */
export const welcomeClients = new Set();



/** Remember a folder the human opened, newest first. */
export function rememberWorkspace(folder) {
	const resolved = realpathSync(folder);
	let workspace = workspaces.find((candidate) => candidate.folder === resolved);
	if (!workspace) {
		workspace = {
			id: workspaceId(resolved),
			folder: resolved,
			name: basename(resolved) || resolved,
			openedAt: Date.now(),
		};
		workspaces.unshift(workspace);
	} else {
		workspace.openedAt = Date.now();
		workspaces.sort((a, b) => b.openedAt - a.openedAt);
	}
	saveWorkspaces();
	return workspace;
}



export function workspaceById(id) {
	return workspaces.find((workspace) => workspace.id === id);
}



// ---------- the scratch workspace ------------------------------------------

/**
 * Where the scratch folder really is, made the first time anything asks. The real path is the one kept,
 * because that is what `rememberWorkspace` stores for every other folder: two spellings of one folder would
 * be two rows, and `/tmp` is a symlink on some machines.
 *
 * A symlink or a plain file standing at that path is neither followed nor trusted. The temp area is writable
 * by everyone on the machine, so a link planted at that name would make "delete everything in the scratch
 * folder" delete somebody else's folder. It is unlinked — the link, never its target — and replaced by a
 * directory only this account can write. A path that cannot be made at all answers `""`, which every caller
 * reads as "there is no scratch row right now" rather than as an empty folder to delete into.
 */
let scratchFolder = "";

export function scratchFolderPath() {
	if (scratchFolder) return scratchFolder;
	try {
		const held = lstatSync(SCRATCH_DIR);
		if (held.isSymbolicLink() || !held.isDirectory()) rmSync(SCRATCH_DIR, { force: true });
	} catch {
		// Nothing there yet, which is the ordinary case: the folder is made below either way.
	}
	try {
		mkdirSync(SCRATCH_DIR, { recursive: true, mode: 0o700 });
		scratchFolder = realpathSync(SCRATCH_DIR);
	} catch {
		// Not remembered as a failure: the next read tries again, which is how a full or read-only temp area
		// stops being a problem without a restart.
	}
	return scratchFolder;
}



/** Whether a folder is the scratch one. Compared by path, so an older workspaces file needs no field. */
export function isScratch(folder) {
	return Boolean(folder) && folder === scratchFolderPath();
}



/**
 * The scratch workspace itself: made and written down the first time the crossroads is read, so the list
 * has one row that is always there and no state file can lose it.
 */
export function ensureScratch() {
	const folder = scratchFolderPath();
	if (!folder) return null;
	// Made on every read, not only at boot: a temp cleaner or a `rm -rf /tmp/*` takes the folder of a daemon
	// that is still running, and a row whose folder is gone is a row nobody can open.
	try {
		mkdirSync(folder, { recursive: true, mode: 0o700 });
	} catch {
		return null;
	}
	const id = workspaceId(folder);
	const at = workspaces.findIndex((workspace) => workspace.folder === folder);
	if (at !== -1) {
		const held = workspaces[at];
		// The id is this folder's, always. A hand-edited file could name another board's id here, and the empty
		// press clears whatever board that id opens.
		if (held.id !== id) {
			held.id = id;
			saveWorkspaces();
		}
		return held;
	}
	// `openedAt` of 0 keeps it out of the age order every other row is sorted by: the list puts it first.
	const workspace = { id, folder, name: "scratch", openedAt: 0 };
	workspaces.push(workspace);
	saveWorkspaces();
	return workspace;
}



/** The crossroads' rows: the scratch one first, then the folders newest first, which is the list order. */
export function workspaceList() {
	const scratch = ensureScratch();
	// A saved row for the scratch folder is dropped here and put back by `ensureScratch`, so the list can hold
	// one of them however the state file was written.
	const folders = workspaces.filter((workspace) => !isScratch(workspace.folder));
	return scratch ? [scratch, ...folders] : folders;
}



/**
 * Everything inside the scratch folder and never the folder itself: a missing folder is a row nobody can
 * open, and the row is the one thing about the scratch that is meant to last.
 */
export function emptyScratchFolder() {
	const folder = scratchFolderPath();
	if (!folder) throw new Error("the scratch folder could not be made");
	let removed = 0;
	for (const entry of readdirSync(folder)) {
		rmSync(join(folder, entry), { recursive: true, force: true });
		removed += 1;
	}
	return removed;
}



// ---------- what the crossroads needs to know ------------------------------

/** A short, honest answer about a folder, cheap enough to run for every row. */
export function folderFacts(folder) {
	if (!existsSync(folder) || !statSync(folder).isDirectory()) return { missing: true };
	return { missing: false };
}



/** Branch and dirty count, read from git when it is a repository. Never runs a long command. */
export function gitFacts(folder) {
	const run = (args) => {
		try {
			const out = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", timeout: 1500 });
			return out.status === 0 ? out.stdout.trim() : "";
		} catch {
			return "";
		}
	};
	const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch) return null;
	const dirty = run(["status", "--porcelain"]);
	return { branch, modified: dirty ? dirty.split("\n").length : 0 };
}



/** The one workspace that matters to a tab: what is on it, and the last thing that happened. */
export function describeWorkspace(workspace) {
	const board = boards.get(workspace.id);
	// A thread that serves a card is not a thread anyone can open: counting it would report more
	// threads than the board has cards.
	const threads = [...(board?.threads.values() ?? [])].filter((thread) => !thread.hidden);
	const rows = board?.activity ?? readJsonFile(boardFile(workspace), null)?.activity ?? [];
	const last = [...rows].reverse().find((row) => row?.startedAt || row?.at);
	const facts = folderFacts(workspace.folder);
	return {
		...workspace,
		...facts,
		// The crossroads draws this row as the throwaway one: it is not counted with the projects and it has
		// a press that empties it.
		scratch: isScratch(workspace.folder),
		running: threads.filter((thread) => thread.status === "running").length,
		threads: threads
			.slice()
			.sort((a, b) => b.at - a.at)
			.slice(0, 6)
			.map((thread) => ({
				id: thread.id,
				title: thread.title,
				status: thread.status,
				turns: thread.turns.length,
				last: thread.turns[thread.turns.length - 1]?.at ?? thread.at,
			})),
		threadCount: threads.length || countSavedThreads(workspace),
		lastActivity: last ? { label: last.label || last.text || "activity", at: last.startedAt || last.at } : null,
		git: facts.missing ? null : gitFacts(workspace.folder),
		sessions: sessionFacts(workspace),
	};
}



export function countSavedThreads(workspace) {
	const saved = readJsonFile(boardFile(workspace), null);
	return saved && Array.isArray(saved.threads) ? saved.threads.length : 0;
}



/** A board's configuration as the browser reads it, with the daemon's own model filled in. */
export function activeConfig(board) {
	const chosen = board.config ?? {};
	return {
		...runtimeDefaults(board),
		dimOthers: chosen.dimOthers !== false,
		// How often a thread here opens a card, who reads it, and what may be inside one. A board file from
		// before these settings reads as the defaults, which is what `cardSettings` is for.
		...cardSettings(chosen),
		// Which tools a new thread is not given: built-in ones by name, extensions by folder. The panel
		// draws a checkbox per entry from these two lists, so they are always readable, never absent.
		toolsOff: Array.isArray(chosen.toolsOff) ? chosen.toolsOff.filter((name) => BUILTIN_TOOLS.includes(name)) : [],
		extensionsOff: Array.isArray(chosen.extensionsOff)
			? chosen.extensionsOff.filter((name) => CHILD_EXTENSIONS.some((one) => one.name === name))
			: [],
		// The flow a boss starts on: `auto` unless the board prefers one.
		path: PATH_NAMES.includes(chosen.path) ? chosen.path : "auto",
		// How this board brings a child's work back onto its own branch, which is what a boss is told.
		childIntegration: integrationOf(chosen),
	};
}



/** What a new thread starts with: the last choice made on this board, else the daemon's own. */
export function runtimeDefaults(board) {
	const chosen = board.config ?? {};
	return {
		provider: typeof chosen.provider === "string" && chosen.provider ? chosen.provider : PROVIDER,
		model: typeof chosen.model === "string" && chosen.model ? chosen.model : MODEL,
		...(THINKING_LEVELS.includes(chosen.thinking) ? { thinking: chosen.thinking } : {}),
	};
}
