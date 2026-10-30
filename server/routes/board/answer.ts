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
import { ASK_TIMEOUT_MS, MAX_ASK_QUESTIONS } from "../../limits.ts";



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



/** One question of an ask: what is asked, what may be clicked, and whether more than one may be. */
function askQuestion(raw) {
	return {
		question: field(raw?.question, 2000),
		options: (Array.isArray(raw?.options) ? raw.options : []).map((one) => field(one, 120)).filter(Boolean).slice(0, 4),
		// Off unless the caller asked: a question with one answer is answered by one click, and every
		// caller written before this flag existed asked one.
		...(raw?.multiple === true ? { multiple: true } : {}),
		allowFreeText: raw?.allowFreeText !== false,
	};
}



/**
 * The questions an ask carries: a list, or the one question a caller put beside the others.
 *
 * A card may ask five questions, each on its own tab, and a card that asks one is the card the board
 * always had. Both arrive here, because the client and the tool should not have to know which kind of
 * card they are looking at.
 */
function askQuestions(body) {
	const listed = Array.isArray(body.questions) ? body.questions : [body];
	return listed.map((one) => askQuestion(one));
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
	if (Array.isArray(body.questions) && body.questions.length > MAX_ASK_QUESTIONS)
		return void fail(res, 400, `a card asks up to ${MAX_ASK_QUESTIONS} questions`);
	const asked = askQuestions(body);
	// A tabbed card names the tab in its refusal, so the caller knows which question to fix.
	for (const [at, one] of asked.entries()) {
		const where = asked.length > 1 ? `question ${at + 1}: ` : "";
		if (!one.question) return void fail(res, 400, `${where}a question needs words`);
		if (one.options.length < 2) return void fail(res, 400, `${where}a question needs two to four options`);
	}
	makeRoom(board);
	// One question keeps the flat fields every reader of a question card already knows; several become
	// a list of tabs, and the card reads as one question with five parts.
	const alone = asked.length === 1 ? asked[0] : null;
	const card = {
		id: randomUUID(),
		type: "question",
		title: field(body.title) || (alone ? "question" : "questions"),
		...(alone
			? {
					question: alone.question,
					options: alone.options,
					allowFreeText: alone.allowFreeText,
					...(alone.multiple ? { multiple: true } : {}),
				}
			: { questions: asked }),
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



/**
 * The answers to a card that asks several questions, read in the order the tabs were drawn.
 *
 * Each tab sends its own answer: words for a question with one answer, a list for one that takes
 * several. A tab nobody answered refuses the whole send, because the card is one call and a child
 * woken with three of four answers has to ask again.
 */
function tabsOf(card, body) {
	const sent = Array.isArray(body.answers) ? body.answers : [];
	const asked = card.questions ?? [];
	if (sent.length !== asked.length)
		return { problem: `that card asks ${asked.length} questions, one answer each` };
	const lines = [];
	for (const [at, one] of asked.entries()) {
		const raw = sent[at];
		// A question that takes several answers arrives as a list, and one that takes a single answer
		// arrives as words: a typed answer is as good as a clicked option on either kind.
		const picks = Array.isArray(raw) ? [...new Set(raw.map((value) => field(value, 2000)).filter(Boolean))] : [];
		const reply = Array.isArray(raw) ? picks.join(", ") : field(raw, 2000);
		if (one.allowFreeText === false) {
			const offered = one.options ?? [];
			const off = (Array.isArray(raw) ? picks : reply ? [reply] : []).filter((value) => !offered.includes(value));
			if (off.length) return { problem: `question ${at + 1}: one of those is not an option` };
		}
		if (!reply) return { problem: `question ${at + 1}: empty answer` };
		lines.push(reply);
	}
	return { reply: lines.join("; "), picks: lines };
}



/** The human's click, arriving from whichever tab they were looking at. */
export async function onAnswer(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const card = board.cards.get(String(body.cardId ?? ""));
	if (!card || card.type !== "question") return void fail(res, 404, "no such question");
	if (card.status !== "open") return void fail(res, 409, "that question is already settled");
	// A card that asks several questions arrives as one answer per tab, and a card that asks one is
	// answered the way it always was.
	if (Array.isArray(card.questions) && card.questions.length) {
		const read = tabsOf(card, body);
		if (read.problem) return void fail(res, 400, read.problem);
		settleQuestion(board, card, "answered", read.reply, read.picks);
		return void answer(res, 200, { cardId: card.id });
	}
	const picks = card.multiple ? picksOf(body) : [];
	if (card.multiple && card.allowFreeText === false && picks.some((one) => !(card.options ?? []).includes(one)))
		return void fail(res, 400, "one of those is not an option");
	const reply = card.multiple ? picks.join(", ") : field(body.answer, 2000);
	if (!reply) return void fail(res, 400, "empty answer");
	settleQuestion(board, card, "answered", reply, picks);
	answer(res, 200, { cardId: card.id });
}
