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
export function settleQuestion(board, card, status, answer) {
	card.status = status;
	card.updatedAt = Date.now();
	if (answer) card.answer = answer;
	broadcast(board, { type: "update", card: plainCardFor(card, board) });
	scheduleSave(board);
	const waiting = board.askers.get(card.id);
	board.askers.delete(card.id);
	if (waiting) waiting.resolve({ status, answer });
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
	if (settled.status === "answered") answer(res, 200, { cardId: card.id, answer: settled.answer ?? "" });
	else fail(res, 409, "nobody answered this question");
}



/** The human's click, arriving from whichever tab they were looking at. */
export async function onAnswer(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const card = board.cards.get(String(body.cardId ?? ""));
	if (!card || card.type !== "question") return void fail(res, 404, "no such question");
	if (card.status !== "open") return void fail(res, 409, "that question is already settled");
	const reply = field(body.answer, 2000);
	if (!reply) return void fail(res, 400, "empty answer");
	settleQuestion(board, card, "answered", reply);
	answer(res, 200, { cardId: card.id });
}
