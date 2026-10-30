// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * A thread's own routes: making one, the card that carries it, and the geometry a card is placed with.
 */
import { answer, fail, readJson } from "../../http.ts";
import { randomUUID } from "node:crypto";
import { MAX_TITLE_CHARS, SPAWN_TIMEOUT_MS } from "../../limits.ts";
import { WORK_TYPES } from "../../worktrees/make.ts";
import { runtimeDefaults } from "../../workspaces.ts";
import { card, update } from "../../bus.ts";
import { cardFor } from "../../cards.ts";
import { cleanRect, MAX_THREADS } from "../../store.ts";
import { join } from "node:path";
import { homeCard } from "./message.ts";
import { ROLE_NAMES, ROLE_THINKING, roleSystemPrompt } from "../../child/roles.ts";
import { MODE_NAMES, PATH_NAMES, promptText } from "../../child/modes.ts";
import { runSpawn } from "../../child/spawn.ts";
import { killChild, threadForRuntime } from "./lifecycle.ts";
import { THINKING_LEVELS } from "../../models.ts";



// ---------- routes: the board ----------------------------------------------

/**
 * What a request asks for, checked once for both the plain and the spawning route: the two have to
 * refuse the same things for the same reasons. Answers the spec, or an `error` to send back.
 */
function threadSpec(board, body, caller) {
	// The parent is the caller when a child asks; only the human may name one, because a body is
	// whatever the caller wrote and the depth rule is worth nothing if the request decides it.
	const parentId = caller?.human === false ? caller.thread.id : field(body.parentThread, 100);
	const parent = parentId ? board.threads.get(parentId) : undefined;
	if (parentId && !parent) return { error: "no such parent thread" };
	// One level: the human's threads spawn children, and a child spawns nothing.
	const depth = parent ? (parent.depth ?? 0) + 1 : 0;
	if (depth > 1) return { error: "a thread spawned by an agent may not spawn another" };
	if (board.threads.size >= MAX_THREADS) return { error: `this board holds ${MAX_THREADS} threads` };
	// Predecessors are what the board draws arrows from, so a misspelled id is a mistake to report
	// rather than something to drop quietly.
	const wanted = [...new Set(Array.isArray(body.after) ? body.after.filter((id) => typeof id === "string" && id) : [])];
	const known = wanted.filter((id) => board.threads.has(id) || board.cards.has(id));
	if (known.length !== wanted.length) return { error: "no such predecessor" };
	if (known.length > 8) return { error: "too many predecessors" };
	// A hidden thread has no card of its own, so the arrow is drawn from the card it answers for.
	const after = known.map((id) => (board.threads.get(id)?.hidden ? anchorOf(board, id) : id));
	// A child hangs under the thread that spawned it, so the arrow is drawn even when the caller named
	// no predecessor. An explicit `after` still wins: a child may follow from earlier cards as well.
	const follow = after.length ? after : parent ? [parent.hidden ? anchorOf(board, parent.id) : parent.id] : [];
	const role = ROLE_NAMES.includes(body.role) ? body.role : "";
	if (typeof body.role === "string" && body.role && !role) return { error: `unknown role: ${body.role}` };
	// A role whose prompt file is missing is a child that does not know what it is for, so the spawn is
	// refused here rather than showing up later as a strange answer.
	if (role && !roleSystemPrompt(role)) return { error: `role prompt missing: prompts/roles/${role}.md` };
	// A mode belongs to a thread the human started, and only there: a spawned thread is given a role, and
	// a child that also carried a mode would be two instructions about what it is for.
	const mode = MODE_NAMES.includes(body.mode) ? body.mode : "";
	if (typeof body.mode === "string" && body.mode && !mode) return { error: `unknown mode: ${body.mode}` };
	if (mode && parent) return { error: "a spawned thread takes a role, not a mode" };
	if (mode && mode !== "agent" && !promptText("modes", mode)) return { error: `mode prompt missing: prompts/modes/${mode}.md` };
	// A path is the boss's: it says which flow that thread runs. An agent or a planner with a path would be
	// a flow nothing is following.
	const flow = PATH_NAMES.includes(body.path) ? body.path : "";
	if (typeof body.path === "string" && body.path && !flow) return { error: `unknown path: ${body.path}` };
	if (flow && mode !== "boss") return { error: "a path belongs to a boss thread" };
	if (flow && flow !== "auto" && !promptText("flows", flow)) {
		return { error: `flow prompt missing: prompts/flows/${flow}.md` };
	}
	return { parent, depth, after: follow, role, mode, path: mode === "boss" ? flow || "auto" : "" };
}



/** The thread row a checked spec describes, before anything is prompted. */
function newThread(board, body, spec) {
	const model = field(body.model, 100);
	const provider = field(body.provider, 60);
	return {
		id: randomUUID(),
		title: typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_CHARS) : "",
		// No name until the human types one or the first request supplies it: a card that invents its own
		// name is a card called `thread 3`, which says nothing and is wrong the moment the work starts.
		sessionId: null,
		status: "idle",
		...(WORK_TYPES.some(([type]) => type === body.type) ? { type: body.type } : {}),
		...runtimeDefaults(board),
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(THINKING_LEVELS.includes(body.thinking) ? { thinking: body.thinking } : {}),
		// A role brings its own thinking level; the board's default belongs to threads the human makes.
		...(spec.role && !THINKING_LEVELS.includes(body.thinking) ? { thinking: ROLE_THINKING[spec.role] } : {}),
		// Provenance, all of it decided here and none of it read back from a later request: which thread
		// spawned this one, how deep it sits, what it hangs under, and what it was asked to be.
		...(spec.parent ? { parentThread: spec.parent.id, depth: spec.depth } : {}),
		...(spec.parent ? { threadRoot: anchorOf(board, spec.parent.id) } : {}),
		...(spec.after.length ? { after: spec.after } : {}),
		...(spec.role ? { role: spec.role } : {}),
		...(spec.mode ? { mode: spec.mode } : {}),
		// A path the human pinned is theirs; `auto` means the boss decides and says which one it took.
		...(spec.path ? { path: spec.path, pathChosenBy: spec.path === "auto" ? "auto" : "human" } : {}),
		at: Date.now(),
		turns: [],
		queued: [],
		folder: board.folder,
	};
}

export async function onThread(req, res, board, caller = { human: true }) {
	const body = await readJson(req, res);
	if (!body) return;
	const spec = threadSpec(board, body, caller);
	if (spec.error) return void fail(res, 409, spec.error);
	const thread = newThread(board, body, spec);
	// Creation does not spawn: the child starts on the first message, so an empty board costs nothing.
	board.threads.set(thread.id, thread);
	card(board, thread);
	answer(res, 200, { threadId: thread.id, card: cardFor(thread, board) });
}



/**
 * Create a thread and run it to the end in the same request. This is what the `board_thread` tool
 * calls: a child that only judged something answers here, and its answer is the tool's result.
 */
export async function onThreadSpawn(req, res, board, caller = { human: true }) {
	const body = await readJson(req, res);
	if (!body) return;
	const spec = threadSpec(board, body, caller);
	if (spec.error) return void fail(res, 409, spec.error);
	const task = typeof body.task === "string" ? body.task.trim().slice(0, 20_000) : "";
	if (!task) return void fail(res, 409, "a spawned thread needs a task");
	const thread = newThread(board, body, spec);
	board.threads.set(thread.id, thread);
	card(board, thread);
	const seconds = Number(body.timeoutSeconds);
	// A run can take minutes, and a client that sees no headers for long enough gives up on the request
	// while the child keeps spending. So the answer is opened at once and kept alive with a space now
	// and then: leading whitespace is still valid JSON for the reader at the other end.
	res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	const keep = setInterval(() => {
		try {
			res.write(" ");
		} catch {
			// A closed socket is noticed by the close handler below.
		}
	}, 30_000);
	keep.unref?.();
	let gone = false;
	res.on("close", () => {
		if (res.writableFinished) return;
		gone = true;
		// The master stopped waiting — a stop button, a killed parent — so the child it started has no
		// reader left. It is ended here rather than left to spend its timeout.
		killChild(board, thread);
	});
	const result = await runSpawn(
		board,
		thread,
		task,
		{
			timeoutMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : SPAWN_TIMEOUT_MS,
			maxTurns: Number(body.maxTurns) > 0 ? Number(body.maxTurns) : 0,
			maxCostUsd: Number(body.maxCostUsd) > 0 ? Number(body.maxCostUsd) : 0,
		},
		killChild,
	);
	clearInterval(keep);
	if (gone || res.writableEnded) return;
	res.end(JSON.stringify(result));
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

/**
 * What a thread is for. A mode is chosen by the human and only on a thread they started: a spawned
 * thread's role is what it is for, and two answers to that question is one too many.
 */
export async function onMode(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const mode = field(body.mode, 20);
	if (!MODE_NAMES.includes(mode)) return void fail(res, 400, `a mode is one of ${MODE_NAMES.join(", ")}`);
	if (mode !== "agent" && !promptText("modes", mode)) return void fail(res, 409, `mode prompt missing: prompts/modes/${mode}.md`);
	const thread = threadForRuntime(board, body.cardId);
	if (!thread) return void fail(res, 409, "no such thread");
	if (thread.parentThread) return void fail(res, 409, "a spawned thread takes a role, not a mode");
	thread.mode = mode;
	// A path belongs to a boss: leaving one behind on an agent would be a flow nothing is following.
	if (mode !== "boss") {
		delete thread.path;
		delete thread.pathChosenBy;
	} else if (!thread.path) {
		thread.path = "auto";
		thread.pathChosenBy = "auto";
	}
	update(board, thread);
	answer(res, 200, { card: cardFor(thread, board) });
}



/**
 * Which flow a boss runs. The boss itself reports the one it chose when the thread is on `auto`, and
 * the human may pin one; a thread may only ever write this on its own row.
 */
export async function onPath(req, res, board, caller = { human: true }) {
	const body = await readJson(req, res);
	if (!body) return;
	const path = field(body.path, 20);
	if (!PATH_NAMES.includes(path)) return void fail(res, 400, `a path is one of ${PATH_NAMES.join(", ")}`);
	if (path !== "auto" && !promptText("flows", path)) return void fail(res, 409, `flow prompt missing: prompts/flows/${path}.md`);
	const thread = caller.human ? threadForRuntime(board, body.cardId) : caller.thread;
	if (!thread) return void fail(res, 409, "no such thread");
	if (thread.mode !== "boss") return void fail(res, 409, "a path belongs to a boss thread");
	if (!caller.human && path === "auto") return void fail(res, 409, "a boss reports the path it chose, not auto");
	thread.path = path;
	thread.pathChosenBy = caller.human ? "human" : "auto";
	update(board, thread);
	answer(res, 200, { card: cardFor(thread, board) });
}
