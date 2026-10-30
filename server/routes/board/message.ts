// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * A message into a thread, and the bookkeeping that decides which cards a turn owns.
 */
import { answer, fail, readJson } from "../../http.ts";
import { cardPreamble, field } from "./thread.ts";
import { randomUUID } from "node:crypto";
import { runtimeDefaults } from "../../workspaces.ts";
import { card, update, updateCard } from "../../bus.ts";
import { threadError } from "../../cards.ts";
import { prompt } from "../../child/run.ts";



export async function onMessage(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return void fail(res, 400, "empty message");
	const mode = body.mode === "steer" ? "steer" : "queue";
	const asked = typeof body.cardId === "string" ? body.cardId : "";
	const fork = body.fork === true;
	// A thread answers about itself. A card without a child — a note, a source, a question — is asked
	// of the thread that made it, quoted, so the agent that wrote it is the one that answers. A fork,
	// or a thread that has since ended, starts a thread of its own under the card instead.
	const askedCard = asked ? board.cards.get(asked) : undefined;
	let thread = asked && !askedCard ? board.threads.get(asked) : undefined;
	if (asked && !askedCard && !thread) return void fail(res, 409, "no such card");
	// Only the thread that already answers for a card keeps the question on that card. A fork, or a card
	// nobody answers for, gets a thread of its own, and a thread card is where its turns belong.
	let answeredByOwner = false;
	if (askedCard && !fork) {
		// Boards written before ownership was its own field have only the thread that made the card.
		const ownerId = askedCard.ownerThread ?? askedCard.threadRoot;
		const owner = ownerId ? board.threads.get(ownerId) : undefined;
		if (owner && owner.status !== "dead") {
			thread = owner;
			answeredByOwner = true;
		}
	}
	const preamble = askedCard ? cardPreamble(askedCard, !answeredByOwner) : "";
	if (!thread) {
		// Two shapes, and only one of them is drawn. A card nobody answers for gets a hidden child: the
		// child answers for the card and is not drawn, because the card already is the surface this
		// conversation is read on. A fork asks for the opposite — a new thread beside that card — so it
		// is drawn as a card of its own, cascades under the card it was asked about, and leaves that card
		// to its owner.
		const title = askedCard?.title ?? text;
		thread = {
			id: randomUUID(),
			title: title.slice(0, 60),
			sessionId: null,
			status: "idle",
			...runtimeDefaults(board),
			at: Date.now(),
			turns: [],
			queued: [],
			...(askedCard ? { threadRoot: askedCard.id } : {}),
			...(askedCard && !fork ? { hidden: true } : {}),
			folder: board.folder,
		};
		board.threads.set(thread.id, thread);
		if (thread.hidden) {
			// The thread that answers for a card owns it, so every later comment on the card is answered
			// by this child, which is what makes it the card's thread.
			askedCard.ownerThread = thread.id;
			updateCard(board, askedCard);
		} else {
			// A thread with a card of its own is drawn; a child behind a card is announced through it.
			card(board, thread);
		}
	}
	if (thread.status === "dead") return void fail(res, 409, "thread ended");

	// The card shows what the human typed; the child is told what card it is about. The answer is kept
	// where it will be read: a thread that is drawn has a card of its own, the field is docked in that
	// card, and the answer belongs under the words that asked for it. So a note, source or question is
	// only quoted, never written on — the entry stays the artifact the child made, and the question and
	// the answer are read on the card of the thread that answered. A fork is such a thread now. Only a
	// child a card nobody answers for got has no card of its own, so the card is the only place its turn
	// can be read, and it keeps the turn there.
	const message = `${preamble}${text}`;
	const holding = askedCard && thread.hidden ? askedCard : null;
	let target = null;
	let index;
	if (holding) {
		holding.turns = holding.turns ?? [];
		// A steer joins the run in flight, so the turn is already being acted on.
		holding.turns.push({ text: text.slice(0, 4000), status: mode === "steer" ? "sent" : "queued", mode, at: Date.now() });
		index = holding.turns.length - 1;
		target = { cardId: holding.id, turn: index };
		updateCard(board, holding);
	} else {
		thread.turns.push({ text: text.slice(0, 4000), status: mode === "steer" ? "sent" : "queued", mode, at: Date.now() });
		index = thread.turns.length - 1;
		// The thread's own turn is named by its index alone: there is no card holding it.
		target = { turn: index };
		update(board, thread);
	}
	const running = thread.status === "running";
	if (running && mode === "steer") {
		// A steer joins the run in flight instead of waiting behind it.
		try {
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "steer", message })}\n`);
		} catch (error) {
			threadError(board, thread, `could not steer the child: ${error.message}`);
		}
	} else if (running) {
		// The card quote is kept beside the words the human typed, so a message still waiting can be
		// rewritten without losing what the child needs to know about the card it is about.
		thread.queued.push({ message, text, preamble, target });
	} else {
		prompt(board, thread, message, target);
	}
	answer(res, 200, { id: thread.id, turn: index });
}



/**
 * A message that is still waiting behind a run, named the way the browser has it: the card the turn is
 * drawn on, and its place in that card's conversation. A thread's own card names the thread, a card a
 * hidden child answers for names the card; the two differ only in which turn list holds the turn.
 */
function waitingMessage(board, body) {
	const cardId = field(body.cardId, 100);
	const at = Number(body.turn);
	if (!cardId || !Number.isInteger(at) || at < 0) return {};
	// Not `threadForRuntime`: it lives in lifecycle.ts, which imports this file, and a cycle is a poor
	// trade for four lines of lookup.
	const held = board.cards.get(cardId);
	const owner = held ? (held.ownerThread ?? held.threadRoot) : cardId;
	const thread = owner ? board.threads.get(owner) : undefined;
	if (!thread) return {};
	const target = held ? { cardId, turn: at } : { turn: at };
	const entry = (thread.queued ?? []).find(
		(next) => typeof next !== "string" && next.target?.turn === at && (next.target.cardId ?? "") === (target.cardId ?? ""),
	);
	return { thread, target, entry };
}



/** The turn a queued message is drawn in, wherever it is held. */
function queuedTurn(board, thread, target) {
	if (!target.cardId) return thread.turns[target.turn];
	return board.cards.get(target.cardId)?.turns?.[target.turn];
}



/** The surface the queue changed on: the card that holds the turn, or the thread's own card. */
function showQueue(board, thread, target) {
	const held = target.cardId ? board.cards.get(target.cardId) : undefined;
	if (held) updateCard(board, held);
	else update(board, thread);
}



/**
 * Rewriting a message the child has not been told yet. The words go into the queue and into the turn the
 * card draws, so the two never disagree about what is about to be sent.
 */
export async function onMessageEdit(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return void fail(res, 400, "empty message");
	const { thread, target, entry } = waitingMessage(board, body);
	if (!thread) return void fail(res, 409, "no such thread");
	if (!entry) return void fail(res, 409, "that message is not waiting: the child has it");
	entry.text = text.slice(0, 4000);
	// Only the human's own words change: the card quote the message was queued with stays as it was.
	entry.message = `${entry.preamble ?? ""}${entry.text}`;
	const turn = queuedTurn(board, thread, target);
	if (turn) turn.text = entry.text;
	showQueue(board, thread, target);
	answer(res, 200, { text: entry.text });
}



/**
 * Taking a message back before the child is told it. The turn stays, wearing the words that were
 * withdrawn: a card that silently lost a message reads as one that was never typed.
 */
export async function onMessageDrop(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const { thread, target, entry } = waitingMessage(board, body);
	if (!thread) return void fail(res, 409, "no such thread");
	if (!entry) return void fail(res, 409, "that message is not waiting: the child has it");
	thread.queued.splice(thread.queued.indexOf(entry), 1);
	const turn = queuedTurn(board, thread, target);
	if (turn) {
		turn.status = "stopped";
		turn.error = "withdrawn";
	}
	showQueue(board, thread, target);
	answer(res, 200, { withdrawn: target.turn });
}



/**
 * Every card this thread answers for carries its runtime, so a model or level change has to reach those
 * cards as well as the thread's own card. A card that is not told keeps showing the old model.
 */
/** The cards a thread answers for. In creation order, so the newest is last. */
export function ownedCards(board, threadId) {
	return [...board.cards.values()].filter((card) => card.ownerThread === threadId);
}



/** The card a hidden thread is read through: the newest one it answers for. */
export function homeCard(board, thread) {
	const owned = ownedCards(board, thread.id);
	return owned[owned.length - 1];
}



export function refreshOwned(board, thread) {
	for (const held of board.cards.values()) {
		if (held.ownerThread === thread.id) updateCard(board, held);
	}
}
