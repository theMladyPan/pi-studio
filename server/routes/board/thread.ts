// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * A thread's own routes: making one, the card that carries it, and the geometry a card is placed with.
 */
import { answer, readJson } from "../../http.ts";
import { randomUUID } from "node:crypto";
import { MAX_TITLE_CHARS } from "../../limits.ts";
import { WORK_TYPES } from "../../worktrees/make.ts";
import { runtimeDefaults } from "../../workspaces.ts";
import { card } from "../../bus.ts";
import { cardFor } from "../../cards.ts";
import { cleanRect } from "../../store.ts";
import { join } from "node:path";
import { homeCard } from "./message.ts";



// ---------- routes: the board ----------------------------------------------

export async function onThread(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = {
		id: randomUUID(),
		title: typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_CHARS) : "",
		// No name until the human types one or the first request supplies it: a card that invents its own
		// name is a card called `thread 3`, which says nothing and is wrong the moment the work starts.
		sessionId: null,
		status: "idle",
		...(WORK_TYPES.some(([type]) => type === body.type) ? { type: body.type } : {}),
		...runtimeDefaults(board),
		...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
		at: Date.now(),
		turns: [],
		queued: [],
		folder: board.folder,
	};
	// Creation does not spawn: the child starts on the first message, so an empty board costs nothing.
	board.threads.set(thread.id, thread);
	card(board, thread);
	answer(res, 200, { threadId: thread.id, card: cardFor(thread, board) });
}



/** The card a key already addresses, so a caller that repeats itself revises instead of stacking. */
export function cardByKey(board, key, type) {
	if (!key) return undefined;
	return [...board.cards.values()].find((card) => card.key === key && card.type === type);
}



/** A string field from a request body, trimmed and cut short. */
export function field(value, limit = 80) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : "";
}



/** Where a card goes when the caller gave it a place, rounded to whole pixels. */
export function placedRect(body) {
	const rect = cleanRect(body.rect);
	return rect
		? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
		: undefined;
}



/**
 * What a card carries, quoted for the agent that is asked about it. A card without a child has no
 * conversation of its own, so the quote is how the agent that is asked learns what it is being asked
 * about. It is capped: the card is on the board, and the rest of a long note is not worth paying for
 * twice.
 */
export function cardPreamble(card, whole = false) {
	const title = String(card.title ?? card.path ?? card.type).replace(/\s+/g, " ").trim().slice(0, 60);
	let about;
	if (card.type === "source") {
		const lines = String(card.content ?? "").split("\n");
		const focus = Math.max(1, Math.min(card.line ?? 1, lines.length));
		const from = Math.max(1, focus - 8);
		const to = Math.min(lines.length, focus + 12);
		const numbered = lines
			.slice(from - 1, to)
			.map((line, index) => `${from + index}| ${line}`)
			.join("\n")
			.slice(0, 1500);
		about = `The card shows ${card.path}, lines ${from}-${to}:\n${numbered || "(empty)"}`;
	} else {
		const body = String(card.type === "question" ? [card.question, card.answer ?? ""].join("\n") : (card.markdown ?? ""))
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 1500);
		about = `The card says: ${body || "(empty)"}`;
	}
	// A chain of comments is the card's own history. A thread that already answered on this card holds
	// it in its own session, so it only needs a reminder. A fork, or a thread that has to be restarted,
	// starts clean and gets the whole chain — it owns this card and nothing else, so what happened on
	// other cards is none of its business.
	const turns = card.turns ?? [];
	const chain = (whole ? turns : turns.slice(-3))
		.map((turn) => {
			const room = whole ? 400 : 200;
			const asked = String(turn.text ?? "").replace(/\s+/g, " ").trim().slice(0, room);
			const said = String(turn.reply ?? "").replace(/\s+/g, " ").trim().slice(0, room);
			return `- asked: ${asked}${said ? `\n  answered: ${said}` : ""}`;
		})
		.join("\n")
		// The newest turns matter most, so cutting from the front keeps the end intact.
		.slice(-(whole ? 4000 : 900));
	return `[board reply · card ${card.id} · "${title}"]\n${about}\n${chain ? `Earlier about this card:\n${chain}\n` : ""}\n`;
}



/** The thread a card should cascade under, when the caller named one that exists. */
export function rootOf(board, body) {
	const root = field(body.threadRoot, 100);
	return root && board.threads.has(root) ? root : undefined;
}



/**
 * Where a card a thread writes should cascade. Usually the thread's own card, but a child that answers
 * for a card has no card of its own, so its notes land under the card it serves.
 */
export function anchorOf(board, threadId) {
	const thread = threadId ? board.threads.get(threadId) : undefined;
	if (!thread?.hidden) return threadId;
	return homeCard(board, thread)?.id ?? threadId;
}
