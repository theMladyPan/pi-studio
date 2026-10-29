// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The child itself: one `pi --mode rpc` per thread, the prompt that becomes a turn, and the stream a
 * turn answers with.
 */
import { childArgv, piCli } from "./argv.ts";
import { spawn } from "node:child_process";
import { ensureWorktree, shortId, workdirOf } from "../worktrees/make.ts";
import { handleChildLine, thinkingRuns } from "../thought.ts";
import { homeCard } from "../routes/board/message.ts";
import { port } from "../main.ts";
import { cardFor, plainCardFor, threadError } from "../cards.ts";
import { StringDecoder } from "node:string_decoder";
import { lastLine } from "./describe.ts";
import { NAME_MODEL, nameThread, titleFromRequest } from "../worktrees/name.ts";
import { broadcast, card, update, updateCard } from "../bus.ts";
import { randomUUID } from "node:crypto";
import { randomToken } from "../paths.ts";
import { join } from "node:path";



/** The thread's child, started on first use. One child per thread, reused until it exits. */
export function ensureChild(board, thread) {
	const existing = board.children.get(thread.id);
	if (existing && existing.exitCode === null && existing.stdin?.writable) return existing;
	const cli = piCli();
	const child = spawn(cli.command, [...cli.args, ...childArgv(board, thread)], {
		// A thread with a tree works in it: the child's whole notion of `here` is its own branch.
		cwd: workdirOf(board, thread),
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		// The bridge reads these: where the board is, what it may write to, and whose card it is.
		env: {
			...process.env,
			PI_STUDIO_URL: `http://127.0.0.1:${port}`,
			// Its own token, not the daemon's: the daemon then knows which thread is calling instead of
			// trusting a field the caller wrote, and a child reaches only the routes a child may use.
			PI_STUDIO_TOKEN: (thread.token ??= randomToken()),
			PI_STUDIO_WORKSPACE: board.id,
			PI_STUDIO_THREAD: thread.id,
		},
	});
	board.children.set(thread.id, child);
	// A child that died between two messages turns the next write into EPIPE. That is a card error,
	// not a daemon crash.
	child.stdin.on("error", (error) => threadError(board, thread, `child stdin failed: ${error.message}`));
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) handleChildLine(board, thread, line);
	});
	// Stdout is protocol only; diagnostics arrive here. The tail is kept as well as logged, because a
	// child that dies at startup can say why in one line and the card should repeat it.
	child.stderr.on("data", (chunk) => {
		const text = String(chunk);
		thread.stderrTail = `${thread.stderrTail ?? ""}${text}`.slice(-1000);
		process.stderr.write(`[${board.name}/${thread.title}] ${text}`);
	});
	// A child replaced by a fresh one is not this thread's voice any more: its exit is its own business.
	const mine = () => board.children.get(thread.id) === child;
	child.on("error", (error) => {
		if (!mine()) return;
		board.children.delete(thread.id);
		threadError(board, thread, `child failed to start: ${error.message}`);
	});
	child.on("close", (code, signal) => {
		if (!mine()) return;
		board.children.delete(thread.id);
		// An exit after `agent_settled` is the orderly shutdown this daemon asked for. An exit while a
		// run is live is the child dying mid-answer.
		if (thread.status !== "running") return;
		const reason = /no session found/i.test(thread.stderrTail ?? "")
			? "the pi session behind this thread is gone — start a new thread"
			: /fork this session into current directory/i.test(thread.stderrTail ?? "")
				? "this thread's session was recorded in another folder and could not be carried into its worktree"
				: `child exited (${signal ?? code}) before it settled`;
		// A child that dies at startup says why on stderr, and that line is the whole explanation.
		const said = lastLine(thread.stderrTail);
		threadError(board, thread, said ? `${reason}: ${said}` : reason);
	});
	// RPC mode emits no session header, so get_state is the only place a session id can come from.
	child.stdin.write(`${JSON.stringify({ id: "session", type: "get_state" })}\n`);
	return child;
}



/** One prompt, either a new question or what was waiting behind the run in flight. */
export function prompt(board, thread, text, target = null) {
	// The tree is made here, before anything is spawned: this is the first moment the thread is going
	// to do something, and the child's working folder is decided by it.
	ensureWorktree(board, thread);
	// A thread with no name takes one from its first request: the request's own words at once, and a
	// better name from a fast model afterwards if it offers one.
	if (!thread.title) {
		thread.title = titleFromRequest(text) || shortId(thread);
		thread.namedBy = "request";
		update(board, thread);
		if (NAME_MODEL) void nameThread(board, thread, text);
	}
	// A question written on a card is answered on that card, and the run in flight remembers which
	// one, so the reply lands where the human typed rather than on the thread's own card.
	thread.answering = target;
	if (target) {
		const held = board.cards.get(target.cardId);
		const turn = held?.turns?.[target.turn];
		if (held && turn) {
			turn.status = "sent";
			// The caret says a run is writing this turn, from the moment it is asked: the first word
			// can take seconds, and a card that looks idle until then is a card that looks stuck.
			turn.streaming = true;
			updateCard(board, held);
		}
	} else {
		const turn = thread.turns[thread.turns.length - 1];
		if (turn) {
			turn.status = "sent";
			turn.streaming = true;
		}
	}
	thread.status = "running";
	thread.runStartedAt = Date.now();
	// A stop pressed before the child got going has nothing to abort yet; `onStop` remembers it and the
	// first event of the run repeats it.
	thread.abortWanted = false;
	// A new run starts with nothing said yet, whatever the last one left behind.
	thread.streamDone = "";
	thread.streamParts = new Map();
	thinkingRuns.delete(thread);
	update(board, thread);
	try {
		const child = ensureChild(board, thread);
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "prompt", message: text })}\n`);
	} catch (error) {
		threadError(board, thread, `could not send to the child: ${error.message}`);
	}
}



/**
 * How often a running answer reaches the browser. Deltas arrive far faster than anyone can read, and
 * every tick costs a whole card.
 */
export const STREAM_MS = 100;



/** The turn a running answer is written into, and the card that holds it when there is one. */
export function liveTurn(board, thread) {
	const asked = thread.answering ? board.cards.get(thread.answering.cardId) : undefined;
	const turn = thread.answering ? asked?.turns?.[thread.answering.turn] : thread.turns[thread.turns.length - 1];
	return { turn, card: asked };
}



/** The answer as it reads this instant: the messages that finished, then the one still arriving. */
export function runText(thread) {
	const arriving = [...(thread.streamParts?.values() ?? [])].join("");
	return [thread.streamDone ?? "", arriving].filter((part) => part).join("\n\n");
}



/**
 * The flush a thread has pending, kept off the thread itself: `/state` serialises whole threads, and a
 * Node timer is a circular object that would make that request throw.
 */
export const streamTimers = new WeakMap();



/** A flush still pending belongs to a run that is over, and is worth nothing. */
export function stopStream(thread) {
	const pending = streamTimers.get(thread);
	if (pending) clearTimeout(pending);
	streamTimers.delete(thread);
}



/**
 * Put what the child has said so far on the turn and tell the browsers. The board file is not
 * written: half a sentence is not a thing to reopen tomorrow.
 */
export function streamTick(board, thread) {
	streamTimers.delete(thread);
	// A child that has been written off is not producing an answer any more, whatever it still sends.
	if (thread.status !== "running") return;
	const { turn, card: held } = liveTurn(board, thread);
	if (!turn) return;
	turn.reply = runText(thread);
	turn.streaming = true;
	// The card that holds the turn is the one to repaint: a run answering a note writes the note's
	// turn, and a run answering its own card writes the card. Falling back to `homeCard` while the
	// thread is drawn would repaint an unrelated note the thread once wrote.
	if (held) broadcast(board, { type: "update", card: plainCardFor(held, board), quiet: true });
	else if (!thread.hidden) broadcast(board, { type: "update", card: cardFor(thread, board), quiet: true });
	else {
		const shown = homeCard(board, thread);
		if (shown) broadcast(board, { type: "update", card: plainCardFor(shown, board), quiet: true });
	}
}
