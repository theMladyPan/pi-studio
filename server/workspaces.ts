// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The workspaces on disk: the list the crossroads shows, the defaults a new board starts with, and the
 * one line of facts each one is described by.
 */
import { STATE_VERSION, WORKSPACES_FILE, boardFile, readJsonFile, workspaceId, writeJsonFile } from "./paths.ts";
import { boards } from "./store.ts";
import { sessionFacts } from "./session.ts";
import { basename } from "node:path";
import { BUILTIN_TOOLS, CHILD_EXTENSIONS, MODEL, PROVIDER, THINKING_LEVELS, run } from "./models.ts";
import { existsSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";



/**
 * One exchange with a thread. The card shows the words typed in and the answer once it lands.
 * @typedef {object} Turn
 * @property {string} text
 * @property {"queued"|"sent"|"answered"|"stopped"} status
 * @property {"queue"|"steer"} mode
 * @property {number} at
 * @property {string} [reply]
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
 * @property {(string|{message: string, text: string, target?: {cardId: string, turn: number}})[]} queued
 * @property {{cardId: string, turn: number}|null} [answering]
 * @property {{x:number,y:number,w:number,h:number}} [rect]
 * @property {boolean} [mini]
 * @property {number} [runStartedAt]
 * @property {string} [stderrTail]
 * @property {string} [threadRoot]
 * @property {boolean} [hidden] the thread is not drawn as a card of its own; the cards it answers for
 *   are where it is read. A child forked onto a card starts hidden, and a thread whose own card is closed
 *   while it still owns cards becomes hidden rather than dying.
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
 */

/**
 * A live board: the workspace it belongs to, what is on it, and who is watching.
 * @typedef {object} Board
 * @property {string} id
 * @property {string} folder
 * @property {string} name
 * @property {Map<string, Thread>} threads
 * @property {Map<string, PlainCard>} cards
 * @property {Map<string, {resolve: (value: {status: string, answer?: string}) => void}>} askers
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
	return known;
})();



export function saveWorkspaces() {
	writeJsonFile(WORKSPACES_FILE, { version: STATE_VERSION, workspaces, defaults: homeDefaults });
}



/** The crossroads' defaults with the daemon's own model filled in, so the page can show them. */
export function activeHomeDefaults() {
	return {
		provider: homeDefaults.provider ?? PROVIDER,
		model: homeDefaults.model ?? MODEL,
		...(homeDefaults.thinking ? { thinking: homeDefaults.thinking } : {}),
		dimOthers: homeDefaults.dimOthers !== false,
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
		// Which tools a new thread is not given: built-in ones by name, extensions by folder. The panel
		// draws a checkbox per entry from these two lists, so they are always readable, never absent.
		toolsOff: Array.isArray(chosen.toolsOff) ? chosen.toolsOff.filter((name) => BUILTIN_TOOLS.includes(name)) : [],
		extensionsOff: Array.isArray(chosen.extensionsOff)
			? chosen.extensionsOff.filter((name) => CHILD_EXTENSIONS.some((one) => one.name === name))
			: [],
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
