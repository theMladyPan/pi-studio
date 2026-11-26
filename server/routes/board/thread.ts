// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * A thread's own routes: making one, the card that carries it, and the geometry a card is placed with.
 */
import { answer, fail, readJson } from "../../http.ts";
import { randomUUID } from "node:crypto";
import { MAX_TITLE_CHARS, SPAWN_REPLY_CHARS, SPAWN_TIMEOUT_MS } from "../../limits.ts";
import { whenFinished } from "../../waiters.ts";
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
import { predecessorId } from "./content.ts";
import { THINKING_LEVELS, modelCatalog } from "../../models.ts";



// ---------- routes: the board ----------------------------------------------

/**
 * The flow this board works the same way with, or empty when it names none: a board that always works
 * one way says it once, and every boss that does not name a flow of its own starts there. A board that
 * says `auto` has named no flow, so a boss there still decides for itself.
 */
function boardFlow(board) {
	const chosen = board.config?.path;
	return PATH_NAMES.includes(chosen) && chosen !== "auto" ? chosen : "";
}

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
	// A child the board put away is still in `board.threads`, and one is left there for every answer read,
	// so only the threads that are drawn count against the ceiling. A board full of put-away children is a
	// board with room in it, and the cap on those children is `MAX_PUT_AWAY_CHILDREN`.
	const drawn = [...board.threads.values()].filter((thread) => !thread.hidden).length;
	if (drawn >= MAX_THREADS) return { error: `this board holds ${MAX_THREADS} threads` };
	// Predecessors are what the board draws arrows from, so a misspelled id is a mistake to report
	// rather than something to drop quietly. A key stands for a card the way a `[[key]]` does, so
	// `after: ["load-shape"]` is an arrow too.
	const wanted = [...new Set(Array.isArray(body.after) ? body.after.filter((id) => typeof id === "string" && id) : [])];
	if (wanted.length > 8) return { error: "too many predecessors" };
	const resolved = wanted.map((id) => predecessorId(board, id));
	if (resolved.some((id) => !id)) return { error: "no such predecessor" };
	const known = [...new Set(resolved)];
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
	// A role is what a spawn gives a child. A thread the human started is theirs to define with a mode, and
	// a root thread carrying a role would be a child's instructions on a conversation nobody spawned.
	if (role && !parent) return { error: "a role belongs to a spawned thread" };
	// A mode belongs to a thread the human started, and only there: a spawned thread is given a role, and
	// a child that also carried a mode would be two instructions about what it is for.
	const mode = MODE_NAMES.includes(body.mode) ? body.mode : "";
	if (typeof body.mode === "string" && body.mode && !mode) return { error: `unknown mode: ${body.mode}` };
	if (mode && parent) return { error: "a spawned thread takes a role, not a mode" };
	if (mode && mode !== "agent" && !promptText("modes", mode)) return { error: `mode prompt missing: prompts/modes/${mode}.md` };
	// A path is the boss's: it says what that thread is told to run. An agent or a planner with a path
	// would be a flow nothing is following.
	const named = PATH_NAMES.includes(body.path) ? body.path : "";
	if (typeof body.path === "string" && body.path && !named) return { error: `unknown path: ${body.path}` };
	if (named && mode !== "boss") return { error: "a path belongs to a boss thread" };
	// A boss starts on the board's own path unless this thread names one, so a board that always works
	// the same way says it once instead of on every thread. Where it came from decides who chose it: a
	// named one is the human's, the board's is neither theirs nor the boss's, and `auto` is the board's
	// way of saying the boss decides its own steps.
	const boardPath = boardFlow(board);
	const flow = mode === "boss" ? named || boardPath || "auto" : "";
	if (flow && flow !== "auto" && !promptText("flows", flow)) {
		return { error: `flow prompt missing: prompts/flows/${flow}.md` };
	}
	const flowBy = flow ? (named ? "human" : boardPath ? "board" : "auto") : "";
	return { parent, depth, after: follow, role, mode, path: flow, pathBy: flowBy };
}



/**
 * The model a request names, checked against what this machine has. A pair that is not in the catalogue
 * is the caller's mistake — a quote that rode along with a provider name, or a model this machine lost
 * since the thread was planned — and is refused here. Stored instead, it would reach pi as
 * `--provider` on the day the thread runs, and the card would die at startup with pi's own
 * `Unknown provider` and no answer at all. A catalogue with no models in it is a machine with no
 * credentials, and there is nothing to check against, so the pair is taken as given.
 */
async function chosenModel(body) {
	const provider = field(body.provider, 60);
	const model = field(body.model, 100);
	// No choice is the usual case: the board's own default decides, and nothing has to be read for it.
	if (!provider && !model) return {};
	if (!provider || !model) return { error: "provider and model belong together" };
	const { models } = await modelCatalog();
	if (models.length && !models.some((one) => one.provider === provider && one.model === model)) {
		return { error: `${provider}/${model} is not a model this machine has` };
	}
	return { provider, model };
}

/** The thread row a checked spec describes, before anything is prompted. */
function newThread(board, body, spec, choice = {}) {
	return {
		id: randomUUID(),
		title: typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_CHARS) : "",
		// No name until the human types one or the first request supplies it: a card that invents its own
		// name is a card called `thread 3`, which says nothing and is wrong the moment the work starts.
		sessionId: null,
		status: "idle",
		...(WORK_TYPES.some(([type]) => type === body.type) ? { type: body.type } : {}),
		...runtimeDefaults(board),
		...(choice.provider ? { provider: choice.provider } : {}),
		...(choice.model ? { model: choice.model } : {}),
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
		// A path the human pinned is theirs, one the board named is the board's, and `auto` means the boss
		// decides its own steps and reports them in its own words.
		...(spec.path ? { path: spec.path, pathChosenBy: spec.pathBy } : {}),
		at: Date.now(),
		turns: [],
		queued: [],
		folder: board.folder,
	};
}

export async function onThread(req, res, board, caller = { human: true }) {
	const body = await readJson(req, res);
	if (!body) return;
	let made;
	try {
		made = await threadOnBoard(board, body, caller);
	} catch (error) {
		return void fail(res, error.status ?? 500, error.message);
	}
	answer(res, 200, made);
}



/**
 * Create a thread on a board, checked and drawn, and answer what the route answers.
 *
 * It is the service behind `POST /thread` and behind the `threads.create` a plugin calls, so a plugin
 * makes the thread a human makes and is refused what a human is refused: the depth rule, a role or mode
 * whose prompt is missing, and a model this machine does not have. Creation does not spawn, and a
 * refusal throws with the status the route would have answered, so a caller with no response to write
 * still says what went wrong.
 */
export async function threadOnBoard(board, body, caller = { human: true }) {
	const spec = threadSpec(board, body, caller);
	if (spec.error) throw refusal(409, spec.error);
	const choice = await chosenModel(body);
	if (choice.error) throw refusal(409, choice.error);
	const thread = newThread(board, body, spec, choice);
	// Creation does not spawn: the child starts on the first message, so an empty board costs nothing.
	board.threads.set(thread.id, thread);
	card(board, thread);
	return { threadId: thread.id, card: cardFor(thread, board) };
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
	const choice = await chosenModel(body);
	if (choice.error) return void fail(res, 409, choice.error);
	const task = typeof body.task === "string" ? body.task.trim().slice(0, 20_000) : "";
	if (!task) return void fail(res, 409, "a spawned thread needs a task");
	const thread = newThread(board, body, spec, choice);
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


/**
 * The thread a wait names: the whole id, or a prefix that names one thread only.
 *
 * A wait names a thread the caller spawned or the human showed it, and a thread's own words carry the
 * first characters rather than forty. The full id wins over any prefix, so a prefix that happens to be
 * a whole id reads as that thread; the rest have to be unique, because two threads sharing eight
 * characters would wait on whichever was found first.
 */
export function waitTarget(board, raw) {
	const wanted = field(raw, 100);
	if (!wanted) return { error: "a thread to wait for is needed" };
	if (board.threads.has(wanted)) return { thread: board.threads.get(wanted) };
	const named = [...board.threads.values()].filter((one) => one.id.startsWith(wanted));
	if (named.length === 1) return { thread: named[0] };
	return { error: named.length ? "that prefix names more than one thread" : "no such thread" };
}


/**
 * What a wait answers with, once there is nothing left to wait for — or on a timeout, still is.
 *
 * Done is an answer, failed an error, stopped a cut: an error turn reads stopped with its reason on
 * it, so the words decide, and an idle thread that never answered is failed rather than done. The raw
 * thread and turn words ride along, so the caller never has to guess which case this was.
 */
function waitOutcome(thread, timedOut, waitedMs) {
	const turns = Array.isArray(thread.turns) ? thread.turns : [];
	const last = turns[turns.length - 1];
	let status;
	// A timeout is the caller's to interpret, so it keeps its own word rather than "failed".
	if (timedOut) status = "timeout";
	else if (thread.status === "dead" || (last?.status === "stopped" && last.error)) status = "failed";
	else if (last?.status === "answered") status = "done";
	else if (last?.status === "stopped") status = "stopped";
	else status = "failed";
	return {
		threadId: thread.id,
		title: thread.title ?? "",
		status,
		timedOut,
		waitedMs,
		// Reserved for when a thread reports its own goal: 0 would be achieved, anything else would not.
		exitCode: null,
		threadStatus: thread.status,
		turnStatus: last?.status ?? "",
		...(last?.reply ? { output: String(last.reply).slice(-SPAWN_REPLY_CHARS) } : {}),
		...(last?.error ? { error: String(last.error).slice(0, 500) } : {}),
	};
}


/**
 * Wait for another thread to finish, so a caller can chain on it: "merge to dev after 1a2b3c is done".
 *
 * The answer is held until the thread settles or the timeout lapses. A timeout is a normal answer with
 * `timedOut`, never an error: the caller waits again, alerts the human, or takes the safe route, and the
 * thread itself is left running. A thread with no run in flight is already at its answer.
 */
export async function onThreadWait(req, res, board, caller = { human: true }) {
	const body = await readJson(req, res);
	if (!body) return;
	const found = waitTarget(board, body.threadId);
	if (found.error) return void fail(res, 409, found.error);
	const thread = found.thread;
	if (caller.thread?.id === thread.id) return void fail(res, 409, "a thread cannot wait for itself");
	const seconds = Number(body.timeoutSeconds);
	const timeoutMs = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) * 1000 : SPAWN_TIMEOUT_MS;
	const started = Date.now();
	if (thread.status !== "running") return void answer(res, 200, waitOutcome(thread, false, 0));
	// Held open like a spawn: headers at once, then a space every half minute, because a client gives
	// up on silent headers and on a body that goes quiet after five minutes.
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
		// The waiter left: the thread it waited on keeps running, and nobody is left to tell.
	});
	// The waiter registers before the first await, so a settle sailing past between the status check
	// and the wait cannot be missed: between the two no other code runs.
	const ended = whenFinished(thread);
	let timer;
	const lapsed = new Promise((resolve) => {
		timer = setTimeout(() => resolve(true), timeoutMs);
		timer.unref?.();
	});
	const timedOut = await Promise.race([ended.then(() => false), lapsed]);
	clearTimeout(timer);
	clearInterval(keep);
	if (gone || res.writableEnded || res.destroyed) return;
	res.end(JSON.stringify(waitOutcome(thread, timedOut, Date.now() - started)));
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



/**
 * A refusal the route would have answered with, thrown instead. The status rides on the error, so a
 * caller with no response to write — the plugin service behind these routes — still says what went
 * wrong and how a tab would have read it.
 */
export function refusal(status, message) {
	const refused = new Error(message);
	refused.status = status;
	return refused;
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
	if (card.type === "html") {
		about = `The card renders this page:\n${String(card.html ?? "").trim().slice(0, 1500) || "(empty)"}`;
	} else {
		// A note is quoted as the human wrote it: flattening a table or a tree into one line is what
		// makes the reply about "the card says" and not about the thing on it. A question is two strings.
		const body = String(
			card.type === "question" ? [card.question, card.answer ?? ""].join("\n").replace(/\s+/g, " ") : (card.markdown ?? ""),
		)
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
	return `[board reply · card ${card.id}${card.key ? ` · key ${card.key}` : ""} · "${title}"]\n${about}\n${chain ? `Earlier about this card:\n${chain}\n` : ""}\n`;
}



/**
 * A thread quoted for an agent that is not it. Bounded like a card quote: the last few turns, trimmed,
 * so a message can name a thread without carrying its whole conversation.
 */
export function threadPreamble(thread) {
	const title = String(thread.title ?? "this thread").replace(/\s+/g, " ").trim().slice(0, 60) || "this thread";
	const facts = [
		thread.status ? `status ${thread.status}` : "",
		thread.role ? `role ${thread.role}` : "",
		thread.mode ? `mode ${thread.mode}` : "",
		thread.provider && thread.model ? `model ${thread.model}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	const turns = Array.isArray(thread.turns) ? thread.turns : [];
	const chain = turns
		.slice(-3)
		.map((turn) => {
			const asked = String(turn.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
			const said = String(turn.reply ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
			return `- asked: ${asked}${said ? `\n  answered: ${said}` : ""}`;
		})
		.join("\n")
		.slice(-700);
	return `[board reply · thread ${thread.id} · "${title}"]\nThe thread is ${facts || "idle"}; ${turns.length} turn${turns.length === 1 ? "" : "s"}.\n${chain ? `Latest turns:\n${chain}\n` : ""}\n`;
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
		// A thread made as an agent had no flow to keep, so becoming a boss starts it where a boss made
		// now would start: on the board's flow when the board names one, and on `auto` otherwise.
		const boardPath = boardFlow(board);
		thread.path = boardPath || "auto";
		thread.pathChosenBy = boardPath ? "board" : "auto";
	}
	update(board, thread);
	answer(res, 200, { card: cardFor(thread, board) });
}



/**
 * What a boss is told to run. The human picks it and keeps it: a boss on `auto` decides its own steps, so
 * nothing a thread sends can pin a flow or report one. A named path brings its prompt file with it.
 */
export async function onPath(req, res, board, caller = { human: true }) {
	const body = await readJson(req, res);
	if (!body) return;
	if (!caller.human) return void fail(res, 403, "a flow is the human's to choose");
	const path = field(body.path, 20);
	if (!PATH_NAMES.includes(path)) return void fail(res, 400, `a path is one of ${PATH_NAMES.join(", ")}`);
	if (path !== "auto" && !promptText("flows", path)) return void fail(res, 409, `flow prompt missing: prompts/flows/${path}.md`);
	const thread = threadForRuntime(board, body.cardId);
	if (!thread) return void fail(res, 409, "no such thread");
	if (thread.mode !== "boss") return void fail(res, 409, "a path belongs to a boss thread");
	thread.path = path;
	thread.pathChosenBy = "human";
	update(board, thread);
	answer(res, 200, { card: cardFor(thread, board) });
}
