/**
 * What an extension asks the human through `ctx.ui`, answered on the board.
 *
 * In RPC mode pi turns a dialog into an `extension_ui_request` and blocks the child until an
 * `extension_ui_response` comes back on its stdin. The daemon ignored those frames, so a command that
 * asks anything — `/dump_codebase` asks which files to dump before it reads a single one — did nothing
 * at all. There is no second dialog to build here: a question card with options is the board's own way
 * of asking, `onAnswer` already settles it and wakes whoever waited on it, so a dialog becomes one of
 * those and the answer travels back to pi in the shape it expects.
 *
 * `notify` expects no answer and becomes a reply row. A dialog the board cannot draw — `editor` takes
 * many lines and a question card takes one — is cancelled, so the extension gets its `undefined` and
 * says so itself instead of the child waiting for ever.
 */
import { broadcast, addRow, threadRef } from "../bus.ts";
import { plainCardFor } from "../cards.ts";
import { scheduleSave } from "../store.ts";
import { settleQuestion } from "../routes/board/answer.ts";
import { anchorOf } from "../routes/board/thread.ts";
import { MAX_TITLE_CHARS } from "../limits.ts";
import { randomUUID } from "node:crypto";

/** The dialogs a question card draws: a list to pick from, a yes or no, and a line of words. */
const DRAWN = new Set(["select", "confirm", "input"]);

/** The options a `confirm` is asked about, so the answer can be read back as a yes or a no. */
const CONFIRM_OPTIONS = ["Yes", "No"];

/**
 * The questions on the board that pi is waiting on, by card id. A child that exits with one open would
 * otherwise leave a question nobody can answer and an asker nobody will wake.
 */
const asked = new Map<string, { board: any; thread: any; id: string; method: string }>();

/** One frame from a child that wants the human, in the shape `ctx.ui` asked for it. */
export function onExtensionUi(board: any, thread: any, event: any): void {
	const id = String(event.id ?? "");
	if (!id) return;
	if (event.method === "notify") {
		addRow(board, {
			id: randomUUID(),
			kind: "reply",
			status: event.notifyType === "error" ? "error" : "ok",
			startedAt: Date.now(),
			text: String(event.message ?? "").slice(0, 4000),
			thread: threadRef(thread),
		});
		return;
	}
	if (!DRAWN.has(event.method)) return void cancelDialog(board, thread, id, `pi asked for a ${event.method} dialog, which this board cannot draw`);
	void askHuman(board, thread, id, event);
}



/** A dialog, put to the human as a question card and answered into the child's stdin. */
async function askHuman(board: any, thread: any, id: string, event: any): Promise<void> {
	const options = event.method === "select" && Array.isArray(event.options) ? event.options.map((one: unknown) => String(one)).filter(Boolean) : [];
	const card = {
		id: randomUUID(),
		type: "question",
		title: String(event.title || event.method).slice(0, MAX_TITLE_CHARS),
		// A `confirm` is one question with two answers; an `input` asks for words and offers none.
		question: String(event.method === "confirm" ? event.message || event.title || "yes or no?" : event.title || event.message || "pi asks"),
		options: event.method === "confirm" ? CONFIRM_OPTIONS : options,
		allowFreeText: event.method === "input",
		status: "open",
		at: Date.now(),
		// No clock: the child is blocked on this answer, so the human gets it whenever they get to it,
		// which is what a question card does once a human has touched it.
		paused: true,
		threadRoot: anchorOf(board, thread.id),
	};
	board.cards.set(card.id, card);
	broadcast(board, { type: "card", card: plainCardFor(card, board) });
	scheduleSave(board);
	asked.set(card.id, { board, thread, id, method: event.method });
	const settled = await new Promise<{ status: string; answer?: string }>((resolve) => {
		board.askers.set(card.id, { resolve });
	});
	asked.delete(card.id);
	// The child may have exited, or the question been used for something else, between the answer and
	// this line: a write to a child that is gone is not worth a crash.
	respond(board, thread, id, answerFor(event.method, settled));
}



/** What pi expects to read for each dialog it can send. */
function answerFor(method: string, settled: { status: string; answer?: string }): Record<string, unknown> {
	// A question nobody answered, one that ran out of time and one settled any other way all mean the
	// same thing to a waiting extension: it was dismissed, and it gets the `undefined` that says so.
	if (settled.status !== "answered" || !settled.answer) return { cancelled: true };
	if (method === "confirm") return { confirmed: settled.answer === CONFIRM_OPTIONS[0] };
	return { value: settled.answer };
}



/** The answer, back on the stdin of the child that asked. */
function respond(board: any, thread: any, id: string, payload: Record<string, unknown>): void {
	const child = board.children.get(thread.id);
	if (!child?.stdin?.writable) return;
	try {
		child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...payload })}\n`);
	} catch {
		// The exit the answer was too late for is reported by the child's own close handler.
	}
}



/** Dismiss a dialog without the human: the extension is told, and the board keeps a line saying why. */
function cancelDialog(board: any, thread: any, id: string, reason: string): void {
	respond(board, thread, id, { cancelled: true });
	addRow(board, {
		id: randomUUID(),
		kind: "reply",
		status: "error",
		startedAt: Date.now(),
		text: reason,
		thread: threadRef(thread),
	});
}



/**
 * The questions this thread asked that its child will never hear the answers to: they are settled where
 * they stand, so the board does not keep offering an answer that goes nowhere.
 */
export function cancelDialogs(thread: any): void {
	for (const [cardId, held] of asked) {
		if (held.thread !== thread) continue;
		asked.delete(cardId);
		const card = held.board.cards.get(cardId);
		if (card && card.status === "open") settleQuestion(held.board, card, "expired", "");
	}
}
