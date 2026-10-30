// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Opening and closing: the sweep that kills a child, the rows a closed thread leaves, and the reopen
 * that brings one back.
 */
import { liveTurn, stopStream } from "../../child/run.ts";
import { broadcast, card, closedCards, nudgeWelcome, resync, update, updateCard } from "../../bus.ts";
import { MAX_PLAIN_CARDS, scheduleSave } from "../../store.ts";
import { ownedCards, refreshOwned } from "./message.ts";
import { answer, fail, readJson } from "../../http.ts";
import { field } from "./thread.ts";
import { randomUUID } from "node:crypto";
import { cleanBoard, clearBoard, plainCardFor } from "../../cards.ts";
import { finished } from "../../waiters.ts";
import { settleRows } from "../../thought.ts";



/**
 * A card that leaves the board takes its child with it. Nothing can reach a thread the board cannot
 * draw, so keeping one alive would leave a session and a process behind every closed note; and a run
 * that was answering for the card must not write its reply onto some other card's turn.
 */
/** The child goes with its last card. Nothing can reach a thread the board cannot draw. */
export function closeThread(board, thread) {
	// The child is ended, not merely asked to leave: it is working in a tree, and a tree whose thread
	// is gone is what `clean` may sweep. A run still writing there would write into nothing.
	killChild(board, thread);
	try {
		board.children.get(thread.id)?.stdin?.end();
	} catch {
		// The child is already gone, which is what this wanted.
	}
	board.children.delete(thread.id);
	board.threads.delete(thread.id);
	// A thread that goes takes its place in the closed list with it.
	nudgeClosed(board);
}



/**
 * How many closed cards the board can still put back. A close is one keystroke away from the `q` that
 * reads like a scroll key, so undo has to reach the mistake; a board left open for a day does not need
 * every card it ever closed kept alive for it.
 */
const TRASH_KEPT = 20;

/**
 * Keep what a close took off the board, so `ctrl+z` can put it back. The entry holds the thing itself
 * rather than a copy: a hidden thread is still in the board's map, and a thread whose child was killed
 * kept its turns, its session id and its worktree, which is everything a card needs to be drawn again.
 */
function rememberClosed(board, entry) {
	if (!Array.isArray(board.trash)) board.trash = [];
	board.trash.push({ at: Date.now(), ...entry });
	if (board.trash.length > TRASH_KEPT) board.trash.splice(0, board.trash.length - TRASH_KEPT);
}



/**
 * End a child without ending its thread. The session file stays, so the next message starts a fresh
 * child with the conversation it had; only the process goes.
 */
export function killChild(board, thread) {
	const child = board.children.get(thread.id);
	if (!child) return false;
	// The child stops being this thread's voice before it is killed, so its death is not the run failing.
	board.children.delete(thread.id);
	const { turn, card: asked } = liveTurn(board, thread);
	if (turn) {
		turn.streaming = false;
		if (turn.status !== "answered") turn.status = "stopped";
	}
	stopStream(thread);
	// Nothing will arrive to drain the queue now, so what was waiting says stopped instead of waiting.
	for (const next of thread.queued) {
		// A queued message names the turn it was written to: a card's, or the thread's own.
		const held = typeof next === "string" || !next.target?.cardId ? undefined : board.cards.get(next.target.cardId);
		const parked = typeof next === "string" || !next.target ? undefined : (held ? held.turns?.[next.target.turn] : thread.turns[next.target.turn]);
		if (parked && parked.status === "queued") {
			parked.status = "stopped";
			if (held) updateCard(board, held);
		}
	}
	thread.queued = [];
	thread.answering = null;
	thread.abortWanted = false;
	thread.status = "idle";
	// A killed child never sends the end of the call it was in, and the rail would count that row as
	// running until the daemon restarts.
	settleRows(board, thread);
	try {
		// Stop asks the child to give up; kill is what happens when it does not.
		child.kill("SIGKILL");
	} catch {
		// Already gone, which is what this wanted.
	}
	// A note that was being answered has to be told, or its caret blinks for ever.
	if (asked) updateCard(board, asked);
	update(board, thread);
	scheduleSave(board);
	// A killed child is the end of its run, so whoever waits on it stops waiting.
	finished(thread);
	return true;
}



export function forgetCard(board, cardId) {
	for (const thread of [...board.threads.values()]) {
		if (thread.answering?.cardId === cardId) {
			const turn = board.cards.get(cardId)?.turns?.[thread.answering.turn];
			if (turn) {
				turn.streaming = false;
				if (turn.status !== "answered") turn.status = "stopped";
			}
			// Pinned to nowhere rather than forgotten: a run still going would otherwise fall back to
			// the thread's own last turn and overwrite an older answer with this card's.
			thread.answering = { cardId, turn: -1 };
		}
	}
	// A child lives while it has a card, so a hidden one that has just lost its last card goes with it.
	for (const thread of [...board.threads.values()]) {
		if (thread.hidden && !ownedCards(board, thread.id).length) closeThread(board, thread);
	}
}



/** Keep the board bounded: the oldest plain card goes when a new one arrives and there is no room. */
export function makeRoom(board) {
	while (board.cards.size >= MAX_PLAIN_CARDS) {
		const oldest = [...board.cards.values()].sort((a, b) => a.at - b.at)[0];
		if (!oldest) break;
		board.cards.delete(oldest.id);
		forgetCard(board, oldest.id);
		broadcast(board, { type: "remove", id: oldest.id });
	}
}



/** What the rail draws under "closed", told to every tab. */
export function nudgeClosed(board) {
	broadcast(board, { type: "closed", closed: closedCards(board) });
}



/**
 * The thread a runtime choice applies to. A card id names the thread that answers for the card, so the
 * composer can set the model of a card whose child is not drawn anywhere.
 */
export function threadForRuntime(board, cardId) {
	const id = String(cardId ?? "");
	const thread = board.threads.get(id);
	if (thread) return thread;
	const card = board.cards.get(id);
	const ownerId = card ? (card.ownerThread ?? card.threadRoot) : "";
	return ownerId ? board.threads.get(ownerId) : undefined;
}



export async function onClose(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = String(body.cardId ?? "");
	const plain = board.cards.get(id);
	if (plain) {
		board.cards.delete(id);
		forgetCard(board, id);
		rememberClosed(board, { kind: "card", card: plain });
		broadcast(board, { type: "remove", id });
		scheduleSave(board);
		answer(res, 200, { closed: id });
		return;
	}
	const thread = board.threads.get(id);
	if (!thread) return void fail(res, 404, "no such card");
	// Closing this card closes the thread card, not the child's life: a child lives while it has a card,
	// so one that still answers notes keeps running where those notes are read. The last card ends it.
	const kept = ownedCards(board, thread.id);
	if (kept.length) {
		thread.hidden = true;
		thread.closedAt = Date.now();
		broadcast(board, { type: "remove", id });
		refreshOwned(board, thread);
		nudgeClosed(board);
	} else {
		closeThread(board, thread);
		broadcast(board, { type: "remove", id });
	}
	// Either way the card is off the board and the human may want it back, so both shapes are kept.
	rememberClosed(board, { kind: "thread", thread });
	scheduleSave(board);
	nudgeWelcome();
	answer(res, 200, { closed: id, kept: kept.length });
}



/**
 * Put a closed card back. The thread kept its session, its turns and its worktree while it was hidden,
 * so this draws the same card again rather than starting anything: the conversation resumes where it
 * was left, and the cards it owns stay where they are.
 */
export async function onReopen(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = String(body.cardId ?? "");
	const thread = board.threads.get(id);
	if (!thread) return void fail(res, 404, "no such card");
	if (!thread.hidden) return void fail(res, 409, "this card is already on the board");
	thread.hidden = false;
	delete thread.closedAt;
	// The card comes back where it was, with the turns it had, and every tab hears the new list.
	card(board, thread);
	nudgeClosed(board);
	answer(res, 200, { reopened: id });
}



/**
 * Put back the last card the human closed. This undoes a close and nothing else: the board's other
 * changes are not a history, and a key that sometimes moved a card and sometimes reopened one would be
 * a key nobody could predict.
 */
export async function onUndo(req, res, board) {
	req.resume();
	// An entry that is already back belongs to a second tab that got there first, so it is passed over
	// rather than reported as the undo.
	while (Array.isArray(board.trash) && board.trash.length) {
		const entry = board.trash.pop();
		if (entry.kind === "card") {
			if (board.cards.has(entry.card.id)) continue;
			// The card keeps its id, its key and its rect, so whatever pointed at it and wherever it sat
			// are both still true. `restored` says it is not an arrival: the tab draws it without the
			// new-card badge and pill, because the human is looking at a card they already had.
			board.cards.set(entry.card.id, entry.card);
			broadcast(board, { type: "card", card: plainCardFor(entry.card, board), restored: true });
			scheduleSave(board);
			return void answer(res, 200, { restored: entry.card.id });
		}
		const thread = entry.thread;
		// A hidden thread was never off the board, so it comes back where it was; one whose child was
		// killed was deleted, and the session file it kept means the next message resumes the work.
		if (thread.hidden) {
			thread.hidden = false;
			delete thread.closedAt;
		}
		if (!board.threads.has(thread.id)) board.threads.set(thread.id, thread);
		card(board, thread, { restored: true });
		nudgeClosed(board);
		return void answer(res, 200, { restored: thread.id });
	}
	fail(res, 409, "nothing to undo");
}



export async function onStop(req, res, board) {
	// A card stops its own thread; no card stops everything, which is what the header button means.
	const body = (await readJson(req, res)) ?? {};
	const asked = body?.cardId ? threadForRuntime(board, field(body.cardId, 100)) : undefined;
	const running = asked
		? asked.status === "running"
			? [asked]
			: []
		: [...board.threads.values()].filter((thread) => thread.status === "running");
	if (!running.length) return void fail(res, 409, asked ? "this thread has no run in progress" : "no run in progress");
	for (const thread of running) {
		// A child still starting has no run to abort, so the request is kept for its first turn.
		thread.abortWanted = true;
		try {
			// Abort lets the child settle and report; the kill is only for a child that will not.
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`);
		} catch {
			// A child already gone has nothing to abort.
		}
	}
	answer(res, 200, { stopped: running.map((thread) => thread.id) });
}



/** Kill one thread's child. The thread stays, so its cards stay answerable. */
export async function onKill(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = threadForRuntime(board, field(body.cardId, 100));
	if (!thread) return void fail(res, 404, "no thread answers this card");
	if (!killChild(board, thread)) return void fail(res, 409, "this thread has no child running");
	answer(res, 200, { killed: thread.id });
}



/** Forget dead threads and their logs. Safe: nothing that can answer is touched. */
export async function onClean(req, res, board) {
	req.resume();
	const result = cleanBoard(board);
	resync(board);
	nudgeWelcome();
	answer(res, 200, result);
}



/** Start over in this workspace, keeping the board's settings. */
export async function onNew(req, res, board) {
	req.resume();
	clearBoard(board);
	resync(board);
	nudgeWelcome();
	answer(res, 200, { cleared: true });
}
