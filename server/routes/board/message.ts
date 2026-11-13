// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * A message into a thread, and the bookkeeping that decides which cards a turn owns.
 */
import { answer, fail, readJson } from "../../http.ts";
import { cardIndex } from "./index.ts";
import { cardPreamble, field } from "./thread.ts";
import { randomUUID } from "node:crypto";
import { runtimeDefaults } from "../../workspaces.ts";
import { card, update, updateCard } from "../../bus.ts";
import { acceptedImages, promptImages, thumbImages, threadError } from "../../cards.ts";
import { prompt } from "../../child/run.ts";
import { chipSections, MAX_CHIPS } from "./chips.ts";



/**
 * One turn as the child reads it: what the board has to say, the commands the human picked, then a named
 * line where the human's words begin. Each section is bracketed by whoever made it and the sections are
 * divided by `---`, so a model never reads the human's request as one more thing the board said, a quoted
 * card as an order, or a skill as something the human wrote.
 *
 * The human's section is always named, even when nothing precedes it: the same shape on every turn is
 * what makes the name mean something, and a turn that changed shape would be the one read as an order.
 */
function boardSections(board, preamble, naming, text, commands = "") {
	const sections = [cardIndex(board), preamble, naming]
		.map((one) => String(one ?? "").replace(/\s+$/, ""))
		.filter(Boolean);
	// The chips sit closest above the words: the message is the pair, and a skill's instructions were written
	// to be read against what the human then asked for.
	return [...sections, commands, `[user message]\n${text}`].filter(Boolean).join("\n---\n");
}



/**
 * The chip names a message carries, in the order the human arranged them, or the sentence it is refused
 * with. A list longer than the composer draws was built by something other than the composer, and trimming
 * it would run commands the human never saw. A leading slash goes as `/command` drops it, so a chip and a
 * typed name are read the same way.
 */
function pickedNames(held) {
	if (held === undefined || held === null) return [];
	if (!Array.isArray(held)) return "commands must be a list of command names";
	if (held.length > MAX_CHIPS) return `a message carries at most ${MAX_CHIPS} commands`;
	const names = [];
	for (const one of held) {
		const name = typeof one === "string" ? one.trim().replace(/^\//, "") : "";
		if (!name) return "a chip with no command name";
		names.push(name);
	}
	return names;
}



export async function onMessage(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const text = typeof body.text === "string" ? body.text.trim() : "";
	// A message may be pictures alone: the words are what a turn says, and a screenshot says something.
	const images = acceptedImages(body.images);
	// The commands the human arranged as chips beside the words, in their order: names the menu offered, and
	// the whole list rides this one message.
	const picked = pickedNames(body.commands);
	if (typeof picked === "string") return void fail(res, 400, picked);
	// Chips alone are still something to say: a skill's text is the request.
	if (!text && !images.length && !picked.length) return void fail(res, 400, "empty message");
	// What the turn remembers of them, which is the thumbnail and not the bytes.
	const thumbs = thumbImages(images);
	const mode = body.mode === "steer" ? "steer" : "queue";
	const asked = typeof body.cardId === "string" ? body.cardId : "";
	const fork = body.fork === true;
	// The cards a message names beside the one it answers. Each is quoted into the prompt below, so one
	// message can put several artifacts in front of the agent at once: a note it wrote, a source it read,
	// and the question it is answering. A thread card is not a card of this map — it is the thread that
	// reads the message — so naming one simply adds nothing.
	const named = [
		...(new Set(Array.isArray(body.refs) ? body.refs.filter((id) => typeof id === "string" && id) : [])),
	]
		.filter((id) => id !== asked)
		.slice(0, 8);
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
	// What the message names, in the order the human named it: the agent reads the same words the board
	// shows, and the card it is asked about comes first.
	const naming = named
		.map((id) => board.cards.get(id))
		.filter(Boolean)
		.map((held) => cardPreamble(held, false))
		.join("");
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
	// What the chips bring to the turn: a skill's text read, an extension command run, both before the
	// message goes out — one turn and one answer is what the human asked the chips to be.
	const chipped = picked.length ? await chipSections(board, thread, picked) : { sections: "" };
	if ("error" in chipped) return void fail(res, chipped.status, chipped.error);

	// The card shows what the human typed; the child is told what card it is about. The answer is kept
	// where it will be read: a thread that is drawn has a card of its own, the field is docked in that
	// card, and the answer belongs under the words that asked for it. So a note, source or question is
	// only quoted, never written on — the entry stays the artifact the child made, and the question and
	// the answer are read on the card of the thread that answered. A fork is such a thread now. Only a
	// child a card nobody answers for got has no card of its own, so the card is the only place its turn
	// can be read, and it keeps the turn there.
	// A message may be chips alone. The card shows what the human picked, and the agent is told in words,
	// because a human section holding a bare `/name` reads as a command to run a second time.
	const words = text || "(the human sent no words; the commands above are the request)";
	const said = text || picked.map((one) => `/${one}`).join(" ");
	const message = boardSections(board, preamble, naming, words, chipped.sections);
	const holding = askedCard && thread.hidden ? askedCard : null;
	let target = null;
	let index;
	if (holding) {
		holding.turns = holding.turns ?? [];
		// A steer joins the run in flight, so the turn is already being acted on.
		holding.turns.push({
			text: said.slice(0, 4000),
			status: mode === "steer" ? "sent" : "queued",
			mode,
			at: Date.now(),
			...(thumbs.length ? { images: thumbs } : {}),
		});
		index = holding.turns.length - 1;
		target = { cardId: holding.id, turn: index };
		updateCard(board, holding);
	} else {
		thread.turns.push({
			text: said.slice(0, 4000),
			status: mode === "steer" ? "sent" : "queued",
			mode,
			at: Date.now(),
			...(thumbs.length ? { images: thumbs } : {}),
		});
		index = thread.turns.length - 1;
		// The thread's own turn is named by its index alone: there is no card holding it.
		target = { turn: index };
		update(board, thread);
	}
	const running = thread.status === "running";
	if (running && mode === "steer") {
		// A steer joins the run in flight instead of waiting behind it.
		try {
			const pictures = promptImages(images);
			board.children
				.get(thread.id)
				?.stdin?.write(
					`${JSON.stringify({ id: randomUUID(), type: "steer", message, ...(pictures.length ? { images: pictures } : {}) })}\n`,
				);
		} catch (error) {
			threadError(board, thread, `could not steer the child: ${error.message}`);
		}
	} else if (running) {
		// The card quote is kept beside the words the human typed, so a message still waiting can be
		// rewritten without losing what the child needs to know about the card it is about.
		// The pictures wait with the words: a run that has not read them yet is not told about them twice.
		thread.queued.push({ message, text: said, preamble, skills: chipped.sections, target, ...(images.length ? { images } : {}) });
	} else {
		prompt(board, thread, message, target, images);
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
	// Only the human's own words change: the card quote the message was queued with stays as it was. The
	// board section is built again, so a message rewritten after a card was added still names that card.
	entry.message = boardSections(board, entry.preamble ?? "", "", entry.text, entry.skills ?? "");
	const turn = queuedTurn(board, thread, target);
	if (turn) turn.text = entry.text;
	showQueue(board, thread, target);
	answer(res, 200, { text: entry.text });
}



/**
 * Taking a message back before the child is told it. The turn is not drawn: the client skips it, because
 * the human who took the message back asked for it to go. It stays on the daemon's side, marked `stopped`
 * with `error: "withdrawn"`, because that mark is what the client reads to skip it, and because every
 * other row is still addressed by the index it was given.
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
