/**
 * What a plugin may ask of this daemon: nine fixed methods, none of them a route, and no credential.
 *
 * A plugin runs beside the daemon as a trusted executable, so it is not handed the daemon's token, its
 * URL, or any other way in through the HTTP surface: the browser's token would let it act as the human,
 * and a route a plugin names would let it use whatever that route does. What it gets instead is this
 * adapter, called over the pipe it already has, and each method is a call into the daemon's own services
 * — the same board, the same card, the same thread and the same broadcast a tab's request reaches.
 *
 * The workspace is always one the daemon already knows, resolved from its own list by id, so a plugin
 * never names a folder and never receives one it asked for by path. A read never opens a workspace for
 * real: opening one makes a `.pi-studio` folder in somebody's project, and reading is not worth that.
 * `cards.note` and the three `threads.*` methods write, and each writes what the human's own route
 * writes.
 *
 * The methods, with their params and their answers:
 *
 *   workspace.list     {}                → { workspaces: [ { id, name, folder, missing, scratch } ] }
 *   workspace.read     { workspace }     → { workspace, open, cards: [ …the board as a tab draws it… ] }
 *   cards.note         { workspace, markdown, title?, key?, size?, after? }
 *                                        → { cardId, card, updated?, report? }
 *   cards.remove       { workspace, key } → { removed }
 *                                        The card its key names, taken off the board: the paired
 *                                        half of a stable key, so a plugin's one card can go when
 *                                        its work does.
 *   threads.list       { workspace }     → { workspace, threads: [ { id, title, status, hidden, mode,
 *                                            parentThread?, turns, at } ] }
 *   threads.create     { workspace, title?, mode?, provider?, model?, thinking?, type?, after? }
 *                                        → { workspace, threadId, thread }
 *   threads.prompt     { workspace, thread, text, mode? }
 *                                        → { workspace, thread, turn }
 *   threads.stop       { workspace, thread }
 *                                        → { workspace, stopped: [ …thread ids… ] }
 *   events.subscribe   { types: [ … ] }  → { types: [ … ] }
 *
 * `threads.create` makes the thread a human makes and is refused what a human is refused; like the
 * human's route it does not spawn, so a thread costs nothing until it is prompted. `threads.prompt`
 * writes one turn, or joins the run in flight: `mode: "queue"` (the default) puts the words behind
 * that run, `"steer"` keeps them on the turn it answers, ahead of its reply, and a thread not running
 * starts on the words at once. `threads.stop` asks one named run to
 * give up; it never stops the board's other runs, which is the human's own bottom bar.
 *
 * A refusal is a JSON-RPC error with a code a plugin can act on: `-32601` for a method this daemon does
 * not answer, `-32602` for params it cannot use, a workspace or thread it does not know, an event it
 * never sends, or a write one of the routes above refuses, and `-32603` for anything that went wrong
 * while answering.
 *
 * Events are the daemon's own notifications, sent only to the plugins that asked for that type:
 *
 *   event  { type: "thread.settled", workspace, at, thread: { id, title, status, answered, error? } }
 *   event  { type: "thread.stream", workspace, at, thread: { id, title }, turn, interim, reply }
 *
 * `thread.settled` is a run that has ended, however it ended; `answered` says whether the turn it ended
 * on was an answer rather than a stop or a failure, and `error` carries pi's reason when there was one.
 * `thread.stream` is a running answer as it is written, at the pace the browser's card is repainted:
 * `turn` is the index of the turn it is writing, `interim` is what the run said before it answered, and
 * `reply` is the answer so far. It is sent while a run is live and stops when the run settles, which is
 * why a plugin that follows one run subscribes to both types. `workspace` is the identifier the same
 * plugin uses in `workspace.read`, and `thread` is one `threads.list` names.
 */
import { onThreadSettled, onThreadStream } from "../bus.ts";
import { cardsFor } from "../cards.ts";
import { notifyPlugin } from "./manager.ts";
import { INVALID_PARAMS, INTERNAL_ERROR, METHOD_NOT_FOUND } from "./protocol.ts";
import { noteOnBoard } from "../routes/board/content.ts";
import { stopOnBoard } from "../routes/board/lifecycle.ts";
import { messageOnBoard } from "../routes/board/message.ts";
import { cardByKey, threadOnBoard } from "../routes/board/thread.ts";
import { boardFor, boards, restoredPlainCard, restoredThread, scheduleSave } from "../store.ts";
import { broadcast } from "../bus.ts";
import { folderFacts, isScratch, savedBoardFor, workspaceById, workspaceList } from "../workspaces.ts";
import type { PluginCall } from "./host.ts";

/** The methods this daemon answers a plugin with, and the events it will send one. */
export const PLUGIN_METHODS = [
	"workspace.list",
	"workspace.read",
	"cards.note",
	"cards.remove",
	"events.subscribe",
	"threads.list",
	"threads.create",
	"threads.prompt",
	"threads.stop",
];
export const PLUGIN_EVENTS = ["thread.settled", "thread.stream"];

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
	/** The listeners this adapter holds on the board's seams, while anybody is subscribed. */
	let unwatch: Array<() => void> = [];

	/**
	 * A run has ended. Every plugin that asked for `thread.settled` is told, with the workspace it belongs
	 * to, and one that is no longer running is dropped rather than kept for an event nobody reads.
	 */
	function announce(board: any, thread: any, turn: any): void {
		send({
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
		});
	}

	/**
	 * A running answer was flushed. Every plugin that asked for `thread.stream` is told what the card was
	 * just repainted with, so a subscriber watching a run reads the words as they arrive.
	 */
	function announceStream(board: any, thread: any, said: any): void {
		send({
			type: "thread.stream",
			workspace: board.id,
			at: Date.now(),
			thread: { id: thread.id, title: thread.title },
			// The turn the run is writing, in the list the surface it answers on draws. A run that has just
			// begun names it already; nothing names one before that.
			turn: thread.answering?.turn ?? null,
			interim: said?.interim ?? [],
			reply: said?.reply ?? "",
		});
	}

	/** One event to every plugin that asked for its type. A plugin that is gone is dropped, not kept. */
	function send(event: { type: string; [field: string]: unknown }): void {
		for (const [plugin, types] of subscriptions) {
			if (!types.has(event.type)) continue;
			if (!notifyPlugin(plugin, "event", event)) subscriptions.delete(plugin);
		}
		if (subscriptions.size === 0) unwatchIfIdle();
	}

	/** The seams are held only while somebody wants an event, so a daemon with no plugin pays nothing. */
	function watch(): void {
		if (unwatch.length) return;
		unwatch = [onThreadSettled(announce), onThreadStream(announceStream)];
	}

	function unwatchIfIdle(): void {
		if (!unwatch.length || subscriptions.size > 0) return;
		for (const stop of unwatch) stop();
		unwatch = [];
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
			if (call.method === "cards.note") return note(workspaceOf(params), params);
			if (call.method === "cards.remove") return removeCard(workspaceOf(params), params);
			if (call.method === "threads.list") return listThreads(workspaceOf(params));
			if (call.method === "threads.create") return createThread(workspaceOf(params), params);
			if (call.method === "threads.prompt") return promptThread(workspaceOf(params), params);
			return stopThread(workspaceOf(params), params);
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
	return through(() => noteOnBoard(openBoard(workspace), params));
}

/**
 * The card a stable key names, off the board: the same close a human's close route performs, minus
 * the human's bookkeeping (a plugin removing what it notes is not undoable), so a card whose problem
 * is gone leaves with the problem. No card of that key answers `{ removed: false }`.
 */
function removeCard(workspace: any, params: Record<string, unknown>): unknown {
	const key = params.key;
	if (typeof key !== "string" || key.trim() === "") refuse(INVALID_PARAMS, "key must name the card to remove");
	return through(() => {
		const board = openBoard(workspace);
		const held = cardByKey(board, key.trim(), "note");
		if (!held) return { removed: false };
		board.cards.delete(held.id);
		broadcast(board, { type: "remove", id: held.id });
		scheduleSave(board);
		return { removed: true };
	});
}

// ---------- the threads of a board ----------

/**
 * The threads a workspace holds, read the way `workspace.read` reads its cards: from the board the daemon
 * holds when it is open, and from what was written when it is not, so a list makes no folder and starts
 * no process.
 */
function listThreads(workspace: any): unknown {
	const view = boards.get(workspace.id) ?? savedView(workspace);
	return { workspace: describe(workspace), threads: [...view.threads.values()].map(threadRow) };
}

/**
 * One thread as a plugin reads it: the id it prompts and stops, and what that thread is doing. `status`
 * is `idle` when no run is going, `running` while one is, and `dead` once the board has written it off.
 */
function threadRow(thread: any) {
	return {
		id: thread.id,
		title: thread.title,
		status: thread.status,
		hidden: thread.hidden === true,
		mode: thread.mode ?? "agent",
		...(thread.parentThread ? { parentThread: thread.parentThread } : {}),
		turns: Array.isArray(thread.turns) ? thread.turns.length : 0,
		at: thread.at,
	};
}

/**
 * The thread a call names, resolved from the board its workspace holds. A thread is named by id and by
 * nothing else — not a card the thread answers for — so a plugin prompts the thread it listed.
 */
function threadOf(board: any, params: Record<string, unknown>): any {
	const id = params.thread;
	if (typeof id !== "string" || id === "") refuse(INVALID_PARAMS, "thread must be the id of a thread in this workspace; threads.list names them");
	const thread = board.threads.get(id);
	if (!thread) refuse(INVALID_PARAMS, `${id} is not a thread in this workspace; threads.list names them`);
	return thread;
}

/**
 * A thread made on a board, by the route that makes one for the human: the same checks of the mode, the
 * role and the model, and the same card drawn for it. Creation does not spawn, so a thread made here
 * costs nothing until it is prompted.
 */
async function createThread(workspace: any, params: Record<string, unknown>): Promise<unknown> {
	const board = openBoard(workspace);
	const made = await through(() => threadOnBoard(board, params, { human: true }));
	return { workspace: describe(workspace), threadId: made.threadId, thread: threadRow(board.threads.get(made.threadId)) };
}

/**
 * One turn into a thread, composed and sent the way the human's own message is: the board's sections
 * above the human's line, the turn drawn where that thread is read, and the words queued behind a run in
 * flight unless `steer` joins it.
 */
async function promptThread(workspace: any, params: Record<string, unknown>): Promise<unknown> {
	const board = openBoard(workspace);
	const thread = threadOf(board, params);
	const text = typeof params.text === "string" ? params.text.trim() : "";
	if (!text) refuse(INVALID_PARAMS, "text must be the words to send to the thread");
	// Only the words and the way they join the run are taken from the plugin: the rest of a message — the
	// pictures, the cards it quotes and the commands it carries — belongs to a surface that composed it.
	const sent = await through(() => messageOnBoard(board, { cardId: thread.id, text, ...(params.mode === "steer" ? { mode: "steer" } : {}) }));
	return { workspace: describe(workspace), thread: threadRow(board.threads.get(thread.id)), turn: sent.turn };
}

/**
 * A named thread's run asked to give up. The board's other runs are the human's to stop, so a call that
 * names no thread is refused here rather than taken as the board's own bottom bar.
 */
async function stopThread(workspace: any, params: Record<string, unknown>): Promise<unknown> {
	const board = openBoard(workspace);
	const thread = threadOf(board, params);
	const stopped = await through(() => stopOnBoard(board, { cardId: thread.id }));
	return { workspace: describe(workspace), stopped: stopped.stopped };
}

// ---------- what every method that writes shares ----------

/** The board a method that changes something works on. Opening one is what makes a `.pi-studio` folder. */
function openBoard(workspace: any): any {
	try {
		return boardFor(workspace);
	} catch (error) {
		refuse(INTERNAL_ERROR, `project state could not be opened: ${(error as Error).message}`);
	}
}

/**
 * What one of the routes refused, as the params it could not use. A note, a thread or a turn the board
 * will not draw is the plugin's params, not a failure of this daemon's: the route answered a 4xx, so the
 * plugin is told the same thing with the code it can act on.
 */
async function through<T>(work: () => T | Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		const status = (error as { status?: unknown }).status;
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
