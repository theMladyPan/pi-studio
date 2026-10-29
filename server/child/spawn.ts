// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * A spawned run: start a child thread on a task and wait for the answer.
 *
 * The master that spawned it reads the answer in its own context, so the run has a shape a delegated
 * run has: one task in, the last words out, what it cost, and which ceiling it crossed. The timeout is
 * the only thing that ends a child nobody is watching, and a child asked to stop still reports.
 */
import { randomUUID } from "node:crypto";
import { SPAWN_ABORT_GRACE_MS, SPAWN_REPLY_CHARS } from "../limits.ts";
import { prompt } from "./run.ts";
import { whenFinished, whenStats } from "../waiters.ts";



/**
 * Run one spawned thread to its end.
 *
 * `kill` is passed in rather than imported: killing a child belongs to the board's own routes, and this
 * module must not drag them in and back out again.
 */
export async function runSpawn(board, thread, task, limits, kill) {
	const costBefore = thread.stats?.cost ?? 0;
	// Assistant turns, which is what a turn ceiling means. The thread's own turns are messages, and a
	// run that calls six tools before it talks is still one turn of thinking.
	thread.runTurns = 0;
	const ended = whenFinished(thread);
	let killTimer;
	const timer = setTimeout(() => {
		limits.timedOut = true;
		// Abort first: a child that is only asked to stop still reports what it had.
		thread.abortWanted = true;
		try {
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`);
		} catch {
			// A child already gone has nothing to abort.
		}
		killTimer = setTimeout(() => {
			kill(board, thread);
		}, SPAWN_ABORT_GRACE_MS);
		killTimer.unref?.();
	}, limits.timeoutMs);
	timer.unref?.();
	// The turn is pushed before the prompt, the way a message from the composer is: a run writes into
	// the last turn, and the reply is read out of it when it settles.
	thread.turns.push({ text: task, status: "queued", mode: "queue", at: Date.now() });
	prompt(board, thread, task);
	await ended;
	clearTimeout(timer);
	// The abort did its job, so the kill that follows it has nothing left to do and must not fire into
	// whatever run the human starts next on this card.
	if (killTimer) clearTimeout(killTimer);
	const turn = thread.turns[thread.turns.length - 1];
	const turns = thread.runTurns ?? 0;
	// What the run spent is only known to the child, so it is asked, and the answer is waited for.
	const child = board.children.get(thread.id);
	if (child?.stdin?.writable) {
		try {
			child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "get_session_stats" })}\n`);
			await whenStats(thread);
		} catch {
			// A child already gone has nothing to report, and the ceiling reads zero.
		}
	}
	const spent = Math.max((thread.stats?.cost ?? 0) - costBefore, 0);
	const status = limits.timedOut
		? "timeout"
		: thread.status === "dead"
			? "failed"
			: turn?.status === "stopped"
				? "stopped"
				: "done";
	return {
		cardId: thread.id,
		title: thread.title,
		status,
		// The end of a run is the report: a cut keeps the last words rather than the first.
		output: String(turn?.reply ?? "").slice(-SPAWN_REPLY_CHARS),
		...(turn?.error ? { error: turn.error } : {}),
		usage: { cost: spent, turns, ...(thread.stats ? { total: thread.stats.total } : {}) },
		// Where the child worked, and why it may not have had a tree of its own.
		...(thread.worktree
			? { worktree: thread.worktree.skipped ? { skipped: thread.worktree.skipped } : { base: thread.worktree.base, path: thread.worktree.path } }
			: {}),
		breached: {
			timeout: Boolean(limits.timedOut),
			turns: Boolean(limits.maxTurns) && turns > limits.maxTurns,
			cost: Boolean(limits.maxCostUsd) && spent > limits.maxCostUsd,
		},
	};
}
