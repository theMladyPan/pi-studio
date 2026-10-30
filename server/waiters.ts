// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Whoever is waiting on a run that someone started and means to read the answer of.
 *
 * A spawning route holds its HTTP answer until the child settles, so "the run is over" has to reach the
 * request that started it. This module is only the bookkeeping: the callers that end a run wake it, and
 * the spawner waits. It imports nothing, so cards, the child runner and the routes can all wake it
 * without one of them dragging the others in.
 */


/** Threads whose run is finished, and the resolvers waiting to hear it. */
const settleWaiters = new Map();

/** Whoever waits for the child's own accounting, which arrives after the run settles. */
const statsWaiters = new Map();

/** Whoever waits for a compaction to come back: the button that asked for it reads it. */
const compactWaiters = new Map();



/** Wake whoever waits on this thread. Called where a run ends, never where one starts. */
export function finished(thread) {
	const waiting = settleWaiters.get(thread.id);
	if (!waiting) return;
	settleWaiters.delete(thread.id);
	for (const wake of waiting) wake();
}



export function whenFinished(thread) {
	return new Promise((resolve) => {
		const waiting = settleWaiters.get(thread.id) ?? new Set();
		waiting.add(resolve);
		settleWaiters.set(thread.id, waiting);
	});
}



/** The numbers a spawn asked the child for have arrived. */
export function statsArrived(thread) {
	const waiting = statsWaiters.get(thread.id);
	if (!waiting) return;
	statsWaiters.delete(thread.id);
	for (const wake of waiting) wake();
}



/** Wait for a stats answer, but never longer than the number is worth. */
export function whenStats(thread, ms = 2_000) {
	return new Promise((resolve) => {
		const waiting = statsWaiters.get(thread.id) ?? new Set();
		waiting.add(resolve);
		statsWaiters.set(thread.id, waiting);
		const give = setTimeout(() => statsArrived(thread), ms);
		give.unref?.();
	});
}


/** The child's answer about the compaction, or that it said nothing in time. */
export function compacted(thread, result) {
	const entry = compactWaiters.get(thread.id);
	if (!entry) return;
	compactWaiters.delete(thread.id);
	// The ceiling outlives the answer it was set for, so it is cleared here: a timer left running would
	// end a later compaction of the same thread the moment it started.
	clearTimeout(entry.timer);
	for (const wake of entry.waiting) wake(result);
}


export function whenCompacted(thread, ms = 0) {
	return new Promise((resolve) => {
		const entry = compactWaiters.get(thread.id) ?? { waiting: new Set(), timer: null };
		entry.waiting.add(resolve);
		compactWaiters.set(thread.id, entry);
		if (ms <= 0 || entry.timer) return;
		entry.timer = setTimeout(() => compacted(thread, { timedOut: true }), ms);
		entry.timer.unref?.();
	});
}
