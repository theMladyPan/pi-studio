/**
 * What a plugin may ask of this daemon: four fixed methods, none of them a route, and no credential.
 *
 * A plugin runs beside the daemon as a trusted executable, so it is not handed the daemon's token, its
 * URL, or any other way in through the HTTP surface: the browser's token would let it act as the human,
 * and a route a plugin names would let it use whatever that route does. What it gets instead is this
 * adapter, called over the pipe it already has, and each method is a call into the daemon's own services
 * — the same board, the same card and the same broadcast a tab's request reaches.
 *
 * The workspace is always one the daemon already knows, resolved from its own list by id, so a plugin
 * never names a folder and never receives one it asked for by path. A read never opens a workspace for
 * real: opening one makes a `.pi-studio` folder in somebody's project, and reading is not worth that.
 * `cards.note` is the one method that writes, and it writes what the human's own note route writes.
 *
 * The methods, with their params and their answers:
 *
 *   workspace.list     {}                → { workspaces: [ { id, name, folder, missing, scratch } ] }
 *   workspace.read     { workspace }     → { workspace, open, cards: [ …the board as a tab draws it… ] }
 *   cards.note         { workspace, markdown, title?, key?, size?, after? }
 *                                        → { cardId, card, updated?, report? }
 *   events.subscribe   { types: [ … ] }  → { types: [ … ] }
 *
 * A refusal is a JSON-RPC error with a code a plugin can act on: `-32601` for a method this daemon does
 * not answer, `-32602` for params it cannot use, a workspace it does not know or an event it never sends,
 * and `-32603` for anything that went wrong while answering.
 *
 * Events are the daemon's own notifications, sent only to the plugins that asked for that type:
 *
 *   event  { type: "thread.settled", workspace, at, thread: { id, title, status, answered, error? } }
 *
 * `thread.settled` is a run that has ended, however it ended; `answered` says whether the turn it ended
 * on was an answer rather than a stop or a failure, and `error` carries pi's reason when there was one.
 * `workspace` is the identifier the same plugin uses in `workspace.read`.
 */
import { onThreadSettled } from "../bus.ts";
import { cardsFor } from "../cards.ts";
import { notifyPlugin } from "./manager.ts";
import { INVALID_PARAMS, INTERNAL_ERROR, METHOD_NOT_FOUND } from "./protocol.ts";
import { noteOnBoard } from "../routes/board/content.ts";
import { boardFor, boards, restoredPlainCard, restoredThread } from "../store.ts";
import { folderFacts, isScratch, savedBoardFor, workspaceById, workspaceList } from "../workspaces.ts";
import type { PluginCall } from "./host.ts";

/** The methods this daemon answers a plugin with, and the events it will send one. */
export const PLUGIN_METHODS = ["workspace.list", "workspace.read", "cards.note", "events.subscribe"];
export const PLUGIN_EVENTS = ["thread.settled"];

/** What the host asks: one call a plugin made, answered with what the daemon offers or with why not. */
export type PluginService = { handle: (call: PluginCall) => unknown | Promise<unknown> };

/** A call this daemon refuses, carrying the JSON-RPC code the plugin is refused with. */
class ServiceRefusal extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "ServiceRefusal";
		this.code = code;
	}
}

function refuse(code: number, message: string): never {
	throw new ServiceRefusal(code, message);
}

/**
 * The adapter one daemon offers its plugins. It holds the subscriptions the plugins asked for, and it is
 * created once where the daemon starts them; a caller that creates another gets an adapter of its own
 * with no subscriptions, which is what a test wants.
 */
export function createPluginService(): PluginService {
	/** The event types each plugin asked for, by the name the plugin was registered under. */
	const subscriptions = new Map<string, Set<string>>();
	/** The listener this adapter holds on the board's settle seam, while anybody is subscribed. */
	let unwatch: (() => void) | null = null;

	/**
	 * A run has ended. Every plugin that asked for `thread.settled` is told, with the workspace it belongs
	 * to, and one that is no longer running is dropped rather than kept for an event nobody reads.
	 */
	function announce(board: any, thread: any, turn: any): void {
		const event = {
			type: "thread.settled",
			workspace: board.id,
			at: Date.now(),
			thread: {
				id: thread.id,
				title: thread.title,
				status: thread.status,
				answered: turn?.status === "answered",
				...(turn?.error ? { error: turn.error } : {}),
			},
		};
		for (const [plugin, types] of subscriptions) {
			if (!types.has("thread.settled")) continue;
			if (!notifyPlugin(plugin, "event", event)) subscriptions.delete(plugin);
		}
		if (subscriptions.size === 0) unwatchIfIdle();
	}

	/** The seam is held only while somebody wants an event, so a daemon with no plugin pays nothing. */
	function watch(): void {
		unwatch ??= onThreadSettled(announce);
	}

	function unwatchIfIdle(): void {
		if (!unwatch || subscriptions.size > 0) return;
		unwatch();
		unwatch = null;
	}

	/** Ask for one event type or a few. A plugin that sends no types is one that wants no events. */
	function subscribe(plugin: string, params: Record<string, unknown>): unknown {
		const wanted = params.types;
		if (!Array.isArray(wanted) || wanted.some((type) => typeof type !== "string")) {
			refuse(INVALID_PARAMS, `types must be a list of event types; this daemon sends ${PLUGIN_EVENTS.join(", ")}`);
		}
		const types = [...new Set(wanted as string[])];
		const unknown = types.filter((type) => !PLUGIN_EVENTS.includes(type));
		if (unknown.length) refuse(INVALID_PARAMS, `${unknown.join(", ")} is not an event this daemon sends; it sends ${PLUGIN_EVENTS.join(", ")}`);
		if (!types.length) {
			subscriptions.delete(plugin);
			unwatchIfIdle();
		} else {
			subscriptions.set(plugin, new Set(types));
			watch();
		}
		return { types };
	}

	return {
		handle: (call) => {
			if (!PLUGIN_METHODS.includes(call.method)) {
				refuse(METHOD_NOT_FOUND, `${call.method} is not a method this daemon answers; it answers ${PLUGIN_METHODS.join(", ")}`);
			}
			const params = paramsOf(call.params);
			if (call.method === "events.subscribe") return subscribe(call.plugin, params);
			if (call.method === "workspace.list") return { workspaces: workspaceList().map(describe) };
			if (call.method === "workspace.read") return read(workspaceOf(params));
			return note(workspaceOf(params), params);
		},
	};
}

// ---------- the methods that need no subscription ----------

/** One workspace as a plugin reads it: the id it names it by, and whether the folder is still there. */
function describe(workspace: any) {
	return {
		id: workspace.id,
		name: workspace.name,
		folder: workspace.folder,
		missing: folderFacts(workspace.folder).missing,
		scratch: isScratch(workspace.folder),
	};
}

/** The workspace a call names, resolved from the daemon's own list. A folder is never taken from a plugin. */
function workspaceOf(params: Record<string, unknown>): any {
	const id = params.workspace;
	if (typeof id !== "string" || id === "") refuse(INVALID_PARAMS, "workspace must be the id of a workspace this daemon knows; workspace.list names them");
	const workspace = workspaceById(id);
	if (!workspace) refuse(INVALID_PARAMS, `${id} is not a workspace this daemon knows; workspace.list names them`);
	return workspace;
}

/**
 * One workspace's cards, read without opening it. A board the daemon holds is answered from memory; one
 * it does not is read from what was written, so a read makes no folder and starts no process.
 */
function read(workspace: any): unknown {
	const live = boards.get(workspace.id);
	if (live) return { workspace: describe(workspace), open: true, cards: cardsFor(live) };
	return { workspace: describe(workspace), open: false, cards: cardsFor(savedView(workspace)) };
}

/**
 * A board-shaped object built from a saved file. It is the shape `cardsFor` reads — the threads, the
 * plain cards and nothing else — so a workspace the daemon has not opened answers in the same words as
 * one it has. The legacy global file is the one `savedBoardFor` reads, so a board from before the move
 * still answers.
 */
function savedView(workspace: any) {
	const saved = savedBoardFor(workspace) as any;
	const view = {
		id: workspace.id,
		folder: workspace.folder,
		name: workspace.name,
		threads: new Map<string, any>(),
		cards: new Map<string, any>(),
		clients: new Set<any>(),
		activity: [],
	};
	for (const raw of Array.isArray(saved?.threads) ? saved.threads : []) {
		const thread = restoredThread(raw, workspace.folder);
		if (thread) view.threads.set(thread.id, thread);
	}
	const plain = Array.isArray(saved?.cards) ? saved.cards : Array.isArray(saved?.notes) ? saved.notes : [];
	for (const raw of plain) {
		const card = restoredPlainCard(raw);
		if (card) view.cards.set(card.id, card);
	}
	return view;
}

/**
 * A note on a workspace's board, written the way the human's own note route writes one: a fresh card, or
 * a revision of the one its `key` names, so an agent stepping through a job revises one note instead of
 * stacking a copy of it. Unlike a read this opens the board for real, because a note is meant to last.
 */
function note(workspace: any, params: Record<string, unknown>): unknown {
	let board;
	try {
		board = boardFor(workspace);
	} catch (error) {
		refuse(INTERNAL_ERROR, `project state could not be opened: ${(error as Error).message}`);
	}
	try {
		return noteOnBoard(board, params);
	} catch (error) {
		const status = (error as { status?: unknown }).status;
		// A note the board will not draw is the plugin's params, not a failure of this daemon's.
		if (typeof status === "number" && status >= 400 && status < 500) refuse(INVALID_PARAMS, (error as Error).message);
		throw error;
	}
}

/** Params as one object. A method that takes nothing is sent no params, which reads as none. */
function paramsOf(params: unknown): Record<string, unknown> {
	if (params === undefined || params === null) return {};
	if (typeof params !== "object" || Array.isArray(params)) refuse(INVALID_PARAMS, "params must be one object");
	return params as Record<string, unknown>;
}
