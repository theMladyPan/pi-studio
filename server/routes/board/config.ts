// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Settings for a card or for the whole board: the model, the thinking level, the tools, and where the
 * cards sit.
 */
import { answer, fail, readJson } from "../../http.ts";
import { field } from "./thread.ts";
import { BUILTIN_TOOLS, CHILD_EXTENSIONS, THINKING_LEVELS, modelCatalog } from "../../models.ts";
import { threadForRuntime } from "./lifecycle.ts";
import { scheduleSave } from "../../store.ts";
import { broadcast, card, update } from "../../bus.ts";
import { activeConfig } from "../../workspaces.ts";
import { randomUUID } from "node:crypto";
import { COMPACT_TIMEOUT_MS } from "../../limits.ts";
import { ensureChild } from "../../child/run.ts";
import { whenCompacted } from "../../waiters.ts";
import { homeCard, refreshOwned } from "./message.ts";
import { cardFor, plainCardFor } from "../../cards.ts";
import { join } from "node:path";



/**
 * Choosing the model a thread answers with. Without a `cardId` the choice belongs to the board
 * instead, which is what the next thread starts with; with one it is written on the thread and sent
 * to a live child, which uses it for its next request.
 */
export async function onModel(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const provider = field(body.provider, 80);
	const model = field(body.model, 120);
	if (!provider || !model) return void fail(res, 400, "provider and model are required");
	const { models } = await modelCatalog();
	if (models.length && !models.some((one) => one.provider === provider && one.model === model)) {
		return void fail(res, 409, `${provider}/${model} is not a model this machine has`);
	}
	const thread = threadForRuntime(board, body.cardId);
	if (!thread || thread.status === "dead") {
		// Nothing answers this card any more, so the choice belongs where the next child comes from.
		board.config = { ...(board.config ?? {}), provider, model };
		scheduleSave(board);
		broadcast(board, { type: "config", config: activeConfig(board) });
		return void answer(res, 200, { config: activeConfig(board) });
	}
	thread.provider = provider;
	thread.model = model;
	// A child whose stdin is closing is not this thread's voice any more; the next one starts with the
	// choice. Writing to it would end the thread with "write after end".
	const child = board.children.get(thread.id);
	if (child?.stdin?.writable) {
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "set_model", provider, modelId: model })}\n`);
	}
	update(board, thread);
	refreshOwned(board, thread);
	const home = thread.hidden ? homeCard(board, thread) : undefined;
	answer(res, 200, { card: home ? plainCardFor(home, board) : cardFor(thread, board) });
}



/** The thinking level, with the same shape: a thread's own, or the board's default for new ones. */
export async function onThinking(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const level = field(body.level, 20);
	if (!THINKING_LEVELS.includes(level)) return void fail(res, 400, `a level is one of ${THINKING_LEVELS.join(", ")}`);
	const thread = threadForRuntime(board, body.cardId);
	if (!thread || thread.status === "dead") {
		board.config = { ...(board.config ?? {}), thinking: level };
		scheduleSave(board);
		broadcast(board, { type: "config", config: activeConfig(board) });
		return void answer(res, 200, { config: activeConfig(board) });
	}
	thread.thinking = level;
	const child = board.children.get(thread.id);
	if (child?.stdin?.writable) {
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "set_thinking_level", level })}\n`);
	}
	update(board, thread);
	refreshOwned(board, thread);
	const home = thread.hidden ? homeCard(board, thread) : undefined;
	answer(res, 200, { card: home ? plainCardFor(home, board) : cardFor(thread, board) });
}



/** Threads with a summarising call in flight, so two tabs cannot pay for the same summary twice. */
const compacting = new Set();



/**
 * The one piece of housekeeping a human presses: squeeze the thread's context before it fills the
 * window. pi owns compaction, so the board asks the child and reads the answer back; the figures the
 * button is about come from the stats read that follows, which is the same path a settled run uses.
 */
export async function onCompact(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = threadForRuntime(board, body.cardId);
	if (!thread) return void fail(res, 409, "no thread answers this card");
	if (thread.status === "dead") return void fail(res, 409, "this thread has ended");
	// Compaction while the agent is writing would cut the answer in half, so the button waits for idle.
	if (thread.status === "running") return void fail(res, 409, "this thread is answering: compact when it is idle");
	// A thread nobody has asked anything has no session, and therefore no context to squeeze.
	if (!thread.sessionId) return void fail(res, 409, "this thread has not run yet, so there is nothing to compact");
	// The run that just ended is still reading its last stats, and its close is already on the way: a
	// frame written now would be dropped by the child as it goes.
	if (thread.pendingClose) return void fail(res, 409, "this thread is finishing its run: try again in a moment");
	// Two tabs are one human, and a summarising call twice over is money for the same summary.
	if (compacting.has(thread.id)) return void fail(res, 409, "a compaction is already running for this thread");
	compacting.add(thread.id);
	try {
		// The child between two runs is gone, so a compaction starts one for the same session: nothing is
		// asked of a model but the summary itself.
		const ask = () => {
			const child = ensureChild(board, thread);
			child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "compact" })}\n`);
		};
		const heard = whenCompacted(thread, COMPACT_TIMEOUT_MS);
		try {
			ask();
		} catch {
			// A child whose pipe has broken is not this thread's voice any more; a fresh one resumes the
			// same session, and that is the one the compaction belongs to.
			board.children.delete(thread.id);
			try {
				ask();
			} catch (error) {
				return void fail(res, 409, `could not send the compaction: ${error.message}`);
			}
		}
		const result = await heard;
		if (result?.timedOut) {
			// A child that was started only to compact and never answered is not kept: the next prompt would
			// write into a wedged process. A run of its own keeps it.
			const held = board.children.get(thread.id);
			if (thread.status !== "running" && held?.stdin?.writable) held.stdin.end();
			return void fail(res, 504, "the child has not answered the compaction yet");
		}
		if (result?.error) return void fail(res, 409, result.error);
		// The figure the button reads next comes over the board's own stream, from the stats the child's
		// answer asks for, so this route has nothing left to wait on.
		answer(res, 200, { threadId: thread.id, ...result });
	} finally {
		compacting.delete(thread.id);
	}
}



export async function onLayout(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = String(body.cardId ?? "");
	// A plain card is dragged and resized like a thread, and its place is kept the same way.
	const held = board.threads.get(id) ?? board.cards.get(id);
	const rect = body.rect;
	if (!held || !rect) return void fail(res, 409, "no such card");
	const clamp = (value) => Math.max(0, Math.min(40000, Math.round(Number.isFinite(Number(value)) ? Number(value) : 0)));
	held.rect = { x: clamp(rect.x), y: clamp(rect.y), w: clamp(rect.w), h: clamp(rect.h) };
	if (typeof body.mini === "boolean") held.mini = body.mini;
	broadcast(board, { type: "move", id: held.id, rect: held.rect, mini: held.mini === true });
	scheduleSave(board);
	answer(res, 200, { placed: held.id });
}



/**
 * Change what the board is configured with. Only the switches live here: the model and the thinking
 * level keep their own routes, which already know how to validate against the catalog and how to tell
 * a running child.
 *
 * A body may carry any of the three, so one checkbox is one request and never has to repeat the rest.
 */
export async function onConfig(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const next = { ...(board.config ?? {}) };
	let changed = false;
	if (typeof body.dimOthers === "boolean") {
		next.dimOthers = body.dimOthers;
		changed = true;
	}
	// The built-in tools a new thread is not given, by the names pi itself uses. A name this pi does
	// not have is dropped rather than refused: the panel cannot offer one, and an old board file may
	// hold a tool a later pi stopped shipping.
	if (body.toolsOff !== undefined) {
		if (!Array.isArray(body.toolsOff)) return void fail(res, 400, "toolsOff must be a list of tool names");
		next.toolsOff = body.toolsOff.filter((name) => BUILTIN_TOOLS.includes(name));
		changed = true;
	}
	// The extensions a new thread does not load, by folder name. An unknown name is a mistake in the
	// request, so it is refused instead of quietly accepted as a no-op.
	if (body.extensionsOff !== undefined) {
		if (!Array.isArray(body.extensionsOff)) return void fail(res, 400, "extensionsOff must be a list of extension names");
		const known = new Set(CHILD_EXTENSIONS.map((one) => one.name));
		const unknown = body.extensionsOff.filter((name) => !known.has(name));
		if (unknown.length) return void fail(res, 400, `no such extension: ${unknown.join(", ")}`);
		next.extensionsOff = body.extensionsOff;
		changed = true;
	}
	if (!changed) return void fail(res, 400, "nothing to change: dimOthers, toolsOff or extensionsOff");
	board.config = next;
	scheduleSave(board);
	broadcast(board, { type: "config", config: activeConfig(board) });
	answer(res, 200, { config: activeConfig(board) });
}
