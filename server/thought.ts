// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The streaming thought: the text a turn is thinking with, folded into rows a rail can tick, and the
 * one line reader that turns a child's JSON into those rows.
 */
import { refreshOwned } from "./routes/board/message.ts";
import { start } from "./main.ts";
import { addRow, card, patchRow, threadRef, update, updateCard } from "./bus.ts";
import { randomUUID } from "node:crypto";
import { MAX_ROW_CHARS } from "./limits.ts";
import { scheduleSave } from "./store.ts";
import { threadError } from "./cards.ts";
import { STREAM_MS, liveTurn, prompt, stopStream, streamTick, streamTimers } from "./child/run.ts";
import { keptArgs } from "./child/argv.ts";
import { describeTool, firstLine, headline, rowResult } from "./child/describe.ts";
import { join } from "node:path";
import { settleTreeBranch } from "./worktrees/name.ts";
import { noteGit } from "./git/graph.ts";
import { finished, compacted, statsArrived } from "./waiters.ts";



// ---------- the thought ----------------------------------------------------

/**
 * A thought is not the answer and does not belong on the card, but it is the only thing a run says
 * while it is looking something up. So each thinking block gets a row of its own: four tails a second
 * while it streams, the whole block kept for the panel where it is actually read.
 */
export const THOUGHT_PUSH_MS = 250;


/** A few lines is all the rail can show, so the row carries the tail and no more. */
export const THOUGHT_TAIL = 400;


/** A few seconds of samples read as a rate, and cost nothing to keep. */
export const THOUGHT_WINDOW_MS = 5000;


/** Providers count thinking their own way; four characters each is the usual estimate. */
export const CHARS_PER_TOKEN = 4;



/**
 * The thinking blocks of the run in progress, off the thread itself: `/state` serialises whole threads,
 * and a Map is not part of a thread's shape.
 */
export const thinkingRuns = new WeakMap();


/**
 * The text of every block still streaming, by row id. A row carries only its tail while it runs, so
 * the panel reads the whole thought from here through `GET /activity/<id>`.
 */
export const liveThoughts = new Map();



/** The newest characters, without splitting a surrogate pair, so no emoji turns into a box. */
export function tailOf(text, keep) {
	const start = Math.max(0, text.length - keep);
	return /[\uDC00-\uDFFF]/.test(text[start] ?? "") ? text.slice(start + 1) : text.slice(start);
}



/** Tokens a second over the newest samples, which the rail labels as the estimate it is. */
export function thoughtRate(block) {
	const first = block.samples[0];
	const last = block.samples[block.samples.length - 1];
	const seconds = first && last ? (last.at - first.at) / 1000 : 0;
	return seconds > 0 ? Math.round((last.chars - first.chars) / seconds / CHARS_PER_TOKEN) : 0;
}



/** What a row carries while its block streams: the tail, the estimate, and the rate. */
export function pushThought(board, block) {
	patchRow(board, block.id, {
		status: "running",
		text: `${block.cut ? "…" : ""}${block.tail}`,
		rate: thoughtRate(block),
		tokens: Math.round(block.chars / CHARS_PER_TOKEN),
		tokensEstimated: true,
	});
}



export function thoughtState(thread) {
	let state = thinkingRuns.get(thread);
	if (!state) {
		state = { message: 0, blocks: new Map() };
		thinkingRuns.set(thread, state);
	}
	return state;
}



/** A block's own row, from its first delta to the end that carries the whole of it. */
export function thoughtEvent(board, thread, update, at) {
	const state = thoughtState(thread);
	const key = `${state.message}:${at}`;
	const now = Date.now();
	if (update.type === "thinking_start") {
		// The id is random rather than counted: a board keeps its rows, and the second run of a thread
		// must not take the id of the first run's block.
		const block = { id: `think-${randomUUID()}`, startedAt: now, chars: 0, tail: "", cut: false, samples: [], pushedAt: now, text: "" };
		state.blocks.set(key, block);
		liveThoughts.set(block.id, "");
		addRow(board, {
			id: block.id,
			kind: "thinking",
			label: "thinking",
			status: "running",
			startedAt: now,
			text: "",
			tokens: 0,
			tokensEstimated: true,
			thread: threadRef(thread),
		});
		return;
	}
	const block = state.blocks.get(key);
	if (!block) return;
	if (update.type === "thinking_delta") {
		const delta = String(update.delta ?? "");
		block.chars += delta.length;
		block.text += delta;
		block.tail += delta;
		if (block.tail.length > THOUGHT_TAIL) {
			block.tail = tailOf(block.tail, THOUGHT_TAIL);
			block.cut = true;
		}
		// The row keeps a tail, the panel the whole thought, and only that is worth a ceiling: a
		// thought this long is served on request rather than pushed with every tail.
		liveThoughts.set(block.id, block.text.slice(0, MAX_ROW_CHARS));
		// One sample per delta would cost more than the rate is worth, so a sample lands with each push.
		const last = block.samples[block.samples.length - 1];
		if (!last || now - last.at >= THOUGHT_PUSH_MS) {
			block.samples.push({ at: now, chars: block.chars });
			while (block.samples.length > 2 && block.samples[0].at < now - THOUGHT_WINDOW_MS) block.samples.shift();
		}
		// A fast provider would flood the stream, so a delta reaches the board four times a second.
		if (now - block.pushedAt >= THOUGHT_PUSH_MS) {
			block.pushedAt = now;
			pushThought(board, block);
		}
		return;
	}

	// The end carries the authoritative text, so the row follows it and stops with its total.
	const content = typeof update.content === "string" && update.content ? update.content : block.text;
	const over = content.length > THOUGHT_TAIL;
	patchRow(board, block.id, {
		status: "ok",
		durationMs: now - block.startedAt,
		text: `${over ? "…" : ""}${over ? tailOf(content, THOUGHT_TAIL) : content}`,
		thinking: content.slice(0, MAX_ROW_CHARS),
		...(content.length > MAX_ROW_CHARS ? { cut: ["thinking"] } : {}),
		rate: undefined,
		tokens: Math.round(Math.max(block.chars, content.length) / CHARS_PER_TOKEN),
		tokensEstimated: true,
	});
	liveThoughts.delete(block.id);
	state.blocks.delete(key);
}



/** A block that never got its end — an abort, a failure — stops where it stands and keeps what it said. */
export function settleThoughts(board, thread) {
	const state = thinkingRuns.get(thread);
	if (!state) return;
	for (const block of state.blocks.values()) {
		patchRow(board, block.id, {
			status: "stopped",
			durationMs: Date.now() - block.startedAt,
			...(block.text ? { thinking: block.text.slice(0, MAX_ROW_CHARS) } : {}),
			rate: undefined,
			tokens: Math.round(block.chars / CHARS_PER_TOKEN),
			tokensEstimated: true,
		});
		liveThoughts.delete(block.id);
	}
	state.blocks.clear();
	thinkingRuns.delete(thread);
}



/** A row as the panel reads it: the whole thought while it streams, the row's own text once it ends. */
export function rowWithThought(row) {
	const live = liveThoughts.get(row.id);
	return row.kind === "thinking" && typeof live === "string" ? { ...row, thinking: live } : row;
}



export function handleChildLine(board, thread, line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		process.stderr.write(`[${board.name}/${thread.title}] unparsed child line: ${line.slice(0, 200)}\n`);
		return;
	}
	if (event.type === "response") {
		if (event.command === "get_session_stats" && event.data?.tokens) {
			const data = event.data;
			// Context is what the last request carried, so it is the number a compaction turns on; the
			// totals are what this thread has spent since it started.
			thread.stats = {
				input: data.tokens.input ?? 0,
				output: data.tokens.output ?? 0,
				cacheRead: data.tokens.cacheRead ?? 0,
				total: data.tokens.total ?? 0,
				cost: typeof data.cost === "number" ? data.cost : 0,
				messages: data.totalMessages ?? 0,
				tools: data.toolCalls ?? 0,
				...(data.contextUsage ? { context: data.contextUsage.tokens ?? data.contextUsage.used } : {}),
				...(data.contextUsage?.maxTokens ? { contextMax: data.contextUsage.maxTokens } : {}),
			};
			if (thread.pendingClose) {
				thread.pendingClose = false;
				board.children.get(thread.id)?.stdin?.end();
			}
			update(board, thread);
			scheduleSave(board);
			// The numbers a spawn is waiting for have arrived.
			statsArrived(thread);
		} else if (event.command === "compact") {
			// The one command the human presses that this child answers on its own account. The context the
			// next request carries is smaller now, so the numbers are read again before it goes, and the
			// route that asked for the compaction hears what came back.
			const child = board.children.get(thread.id);
			if (event.success === false) {
				// A child started only to compact has nothing else to do, so it goes the way a settled run's does.
				if (child?.stdin?.writable) child.stdin.end();
				compacted(thread, { error: String(event.error ?? "the child refused the compaction") });
			} else {
				const data = event.data ?? {};
				const before = Number(data.tokensBefore);
				const after = Number(data.estimatedTokensAfter);
				compacted(thread, {
					...(Number.isFinite(before) ? { tokensBefore: before } : {}),
					...(Number.isFinite(after) ? { estimatedTokensAfter: after } : {}),
				});
				if (child?.stdin?.writable) {
					thread.pendingClose = true;
					try {
						child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "get_session_stats" })}\n`);
					} catch {
						thread.pendingClose = false;
						child.stdin.end();
					}
				}
			}
		} else if (event.command === "get_state" && typeof event.data?.sessionId === "string") {
			thread.sessionId = event.data.sessionId;
			update(board, thread);
		} else if (event.command === "prompt" && event.success === false) {
			// A rejected prompt starts no run, so no agent_settled would ever arrive.
			threadError(board, thread, `prompt rejected: ${event.error ?? "unknown reason"}`);
		} else if (event.command === "prompt" && event.data?.disposition === "handled") {
			threadError(board, thread, "the message was handled as a command, so no run started");
		} else if ((event.command === "set_model" || event.command === "set_thinking_level") && event.success === false) {
			// The chip already shows the choice, so a refusal has to be said out loud.
			addRow(board, {
				id: randomUUID(),
				kind: "reply",
				status: "error",
				startedAt: Date.now(),
				text: `${event.command} refused: ${event.error ?? "unknown reason"}`,
				thread: threadRef(thread),
			});
		}
		return;
	}
	if (thread.abortWanted && (event.type === "turn_start" || event.type === "message_start")) {
		thread.abortWanted = false;
		try {
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`);
		} catch {
			// The child is gone; its exit says so.
		}
	}
	if (event.type === "message_start" && event.message?.role === "assistant") {
		// `contentIndex` counts from zero in every message, so a message is what keeps two blocks apart.
		thoughtState(thread).message += 1;
		return;
	}
	if (event.type === "message_update") {
		const next = event.assistantMessageEvent;
		const at = Number.isInteger(next?.contentIndex) ? next.contentIndex : 0;
		// A thought is what the run is doing while it says nothing, so it gets a row of its own.
		if (next?.type === "thinking_start" || next?.type === "thinking_delta" || next?.type === "thinking_end") {
			thoughtEvent(board, thread, next, at);
			return;
		}
		// A finished block is authoritative, so a delta dropped on the way cannot leave a hole. Tool
		// arguments ride the same stream and stay off the card.
		if (next?.type === "text_delta" || next?.type === "text_end") {
			thread.streamParts ??= new Map();
			const said = next.type === "text_end" ? String(next.content ?? "") : `${thread.streamParts.get(at) ?? ""}${String(next.delta ?? "")}`;
			thread.streamParts.set(at, said);
		} else {
			return;
		}
		if (!streamTimers.has(thread)) {
			const pending = setTimeout(() => streamTick(board, thread), STREAM_MS);
			pending.unref?.();
			streamTimers.set(thread, pending);
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		const cut = new Set();
		const args = keptArgs(event.args, cut);
		addRow(board, {
			id: String(event.toolCallId),
			kind: "tool",
			tool: String(event.toolName ?? "tool"),
			label: describeTool(event.toolName, args ?? {}),
			status: "running",
			startedAt: Date.now(),
			thread: threadRef(thread),
			args,
			...(cut.size ? { cut: [...cut] } : {}),
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		patchRow(board, String(event.toolCallId), {
			status: event.isError ? "error" : "ok",
			durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
			summary: firstLine(event.result),
			...rowResult(event.result),
		});
		return;
	}
	if (event.type === "turn_end" && event.message?.role === "assistant") {
		// One assistant turn, which is what a spawn's turn ceiling counts.
		thread.runTurns = (thread.runTurns ?? 0) + 1;
		// A thought whose message ended without its end event stops where it stands.
		settleThoughts(board, thread);
		const message = event.message;
		const text = (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block?.type === "text")
			.map((block) => String(block.text ?? ""))
			.join("")
			.trim();
		const thinking = (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block?.type === "thinking")
			.map((block) => String(block.thinking ?? ""))
			.join("")
			.trim();
		// When the run was answering for a card, only that card may receive the reply. Falling back to
		// the thread's own turn would overwrite an older answer with a card's answer.
		const { turn, card: asked } = liveTurn(board, thread);
		// The answer is what the whole run said. A run that talks, calls a tool and talks again would
		// otherwise drop its first half the moment its second arrived.
		const said = [thread.streamDone ?? "", text].filter(Boolean).join("\n\n");
		const aborted = message.stopReason === "aborted";
		const failed = message.stopReason === "error";
		// Why a run stopped belongs on the turn. A card that reads only "stopped" sends the human looking
		// through session files for the reason, and a connection error is the common case.
		const reason = failed ? headline(message.errorMessage) : undefined;
		// A message pi is about to retry is not half an answer: keeping it would make the retry's full
		// text read twice.
		thread.streamDone = failed ? "" : said;
		thread.streamParts = new Map();
		stopStream(thread);
		if (!text) {
			// A message of nothing but tool calls settles nothing: the turn keeps what has arrived and
			// the caret stays until a message has words in it. A failed one has no words coming, so it
			// ends here, carrying the reason.
			if (turn) {
				turn.error = reason;
				if (reason) turn.status = "stopped";
				if (turn.streaming) turn.reply = said;
				if (reason || turn.streaming) {
					if (asked) updateCard(board, asked);
					else update(board, thread);
				}
			}
			return;
		}
		if (turn) {
			turn.reply = said;
			// An aborted or failed message is not an answer, however much of it arrived before it was
			// cut. Saying `answered` over half a sentence would be a card that lies.
			turn.status = aborted || failed ? "stopped" : "answered";
			turn.error = reason;
		}
		addRow(board, {
			id: randomUUID(),
			kind: "reply",
			status: "ok",
			startedAt: Date.now(),
			text: text.slice(0, 4000),
			...(thinking ? { thinking: thinking.slice(0, 4000) } : {}),
			thread: threadRef(thread),
		});
		if (turn && asked) updateCard(board, asked);
		else if (!thread.answering) update(board, thread);
		return;
	}
	if (event.type === "agent_settled") {
		thread.status = "idle";
		thread.abortWanted = false;
		stopStream(thread);
		settleThoughts(board, thread);
		// A run that edited has either cut its own branch or committed on the detached base, and this is
		// the moment the board learns which and puts a name on the work.
		settleTreeBranch(board, thread);
		// The turn has just finished, and whatever it did to the disk is what the strip must show.
		noteGit(board);
		// A turn whose answer was redirected by a steer, or whose run was stopped, never gets a reply
		// of its own. It reads as stopped rather than as a message still being worked on, and the
		// caret goes because nothing is being written any more.
		for (const turn of thread.turns) {
			turn.streaming = false;
			if (turn.status === "sent") turn.status = "stopped";
		}
		const parked = thread.answering ? board.cards.get(thread.answering.cardId) : undefined;
		if (parked) {
			for (const turn of parked.turns ?? []) {
				turn.streaming = false;
				if (turn.status === "sent") turn.status = "stopped";
			}
			updateCard(board, parked);
		}
		thread.answering = null;
		update(board, thread);
		// The cards this thread answers through carried `answersWith.running` while it ran, and a card
		// still offering a stop for a run that has finished is a button that cannot work.
		refreshOwned(board, thread);
		const next = thread.queued.shift();
		if (next) {
			// An older board file queued plain strings; a card quote travels with the message now.
			const text = typeof next === "string" ? next : next.text;
			const target = typeof next === "string" ? null : (next.target ?? null);
			if (target) {
				const held = board.cards.get(target.cardId);
				if (held?.turns?.[target.turn]) {
					held.turns[target.turn].status = "queued";
					updateCard(board, held);
				}
			} else {
				thread.turns.push({ text, status: "queued", mode: "queue", at: Date.now() });
				update(board, thread);
			}
			prompt(board, thread, typeof next === "string" ? next : next.message, target);
			return;
		}
		// Nothing else is queued, so the run is over for anyone waiting on it.
		finished(thread);
		// What the run spent is only known to the child, so it is asked before stdin closes. The close
		// waits for the answer.
		const child = board.children.get(thread.id);
		if (child?.stdin?.writable) {
			thread.pendingClose = true;
			try {
				child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "get_session_stats" })}\n`);
			} catch {
				thread.pendingClose = false;
				child.stdin.end();
			}
		}
	}
}
