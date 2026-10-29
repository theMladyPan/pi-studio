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
