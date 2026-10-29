// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The question an agent asks and the answer that lets it carry on.
 */
import { broadcast, card } from "../../bus.ts";
import { answer, fail, readJson } from "../../http.ts";
import { plainCardFor } from "../../cards.ts";
import { scheduleSave } from "../../store.ts";
import { resolve } from "node:path";
import { anchorOf, field, rootOf } from "./thread.ts";
import { makeRoom } from "./lifecycle.ts";
import { randomUUID } from "node:crypto";
import { ASK_TIMEOUT_MS } from "../../limits.ts";



/** Settle a question, tell whoever was waiting, and keep the card honest about what happened. */
export function settleQuestion(board, card, status, answer, picks = []) {
	card.status = status;
	card.updatedAt = Date.now();
	if (answer) card.answer = answer;
	// A question that took several answers keeps them apart, so a settled card can still show which
	// boxes were ticked rather than one string the reader has to split again.
	if (picks.length) card.answers = picks;
	broadcast(board, { type: "update", card: plainCardFor(card, board) });
	scheduleSave(board);
	const waiting = board.askers.get(card.id);
	board.askers.delete(card.id);
	if (waiting) waiting.resolve({ status, answer, ...(picks.length ? { answers: picks } : {}) });
}



/**
 * Ask the human, and hold this request open until they answer.
 *
 * The response stays open for as long as the child's turn is waiting, because the answer travels
 * back in it: option clicked, words typed, or a failure the tool can read and act on.
 */
export async function onAsk(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const question = field(body.question, 2000);
	const options = (Array.isArray(body.options) ? body.options : []).map((one) => field(one, 120)).filter(Boolean);
	if (!question) return void fail(res, 400, "a question needs words");
	if (options.length < 2) return void fail(res, 400, "a question needs two to four options");
	makeRoom(board);
	const card = {
		id: randomUUID(),
		type: "question",
		title: field(body.title) || "question",
		question,
		options: options.slice(0, 4),
		allowFreeText: body.allowFreeText !== false,
		// Off unless the caller asked: a question with one answer is answered by one click, and every
		// caller written before this flag existed asked one.
		...(body.multiple === true ? { multiple: true } : {}),
		status: "open",
		at: Date.now(),
		expiresAt: Date.now() + ASK_TIMEOUT_MS,
		...(rootOf(board, body)
			? { threadRoot: anchorOf(board, rootOf(board, body)), ownerThread: rootOf(board, body) }
			: {}),
	};
	board.cards.set(card.id, card);
	broadcast(board, { type: "card", card: plainCardFor(card, board) });
	scheduleSave(board);

	const settled = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			settleQuestion(board, card, "expired");
		}, ASK_TIMEOUT_MS);
		board.askers.set(card.id, {
			resolve: (value) => {
				clearTimeout(timer);
				resolve(value);
			},
		});
		// A closed tab must not leave the child's turn waiting for a click nobody can make.
		res.on("close", () => {
			if (card.status !== "open") return;
			settleQuestion(board, card, "expired");
		});
	});
	if (settled.status === "answered")
		answer(res, 200, {
			cardId: card.id,
			answer: settled.answer ?? "",
			...(settled.answers ? { answers: settled.answers } : {}),
		});
	else fail(res, 409, "nobody answered this question");
}



/** What the human ticked on a question that takes several answers, in the order they were sent. */
function picksOf(body) {
	const sent = Array.isArray(body.answers) ? body.answers : [];
	return [...new Set(sent.map((one) => field(one, 2000)).filter(Boolean))];
}



/** The human's click, arriving from whichever tab they were looking at. */
export async function onAnswer(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const card = board.cards.get(String(body.cardId ?? ""));
	if (!card || card.type !== "question") return void fail(res, 404, "no such question");
	if (card.status !== "open") return void fail(res, 409, "that question is already settled");
	// A question that takes several answers arrives as a list, and one that takes a single answer
	// arrives as words: a typed answer is as good as a clicked option on either kind.
	const picks = card.multiple ? picksOf(body) : [];
	if (card.multiple && card.allowFreeText === false && picks.some((one) => !(card.options ?? []).includes(one)))
		return void fail(res, 400, "one of those is not an option");
	const reply = card.multiple ? picks.join(", ") : field(body.answer, 2000);
	if (!reply) return void fail(res, 400, "empty answer");
	settleQuestion(board, card, "answered", reply, picks);
	answer(res, 200, { cardId: card.id });
}
