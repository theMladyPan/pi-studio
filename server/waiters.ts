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

/**
 * Threads with a compaction in flight, and whether one is already running for a thread. The compaction
 * route marks a thread here for the whole summary, and the message route reads it: a child asked to
 * compact cannot take a prompt until the summary is done, so a message that arrives in that window
 * waits in the thread's queue instead of reaching a child that would refuse it. Kept here, beside the
 * compaction waiters, so the two routes share one record without importing each other.
 */
const compactingThreads = new Set();

/** Mark a thread as compacting. False means a compaction is already running for it. */
export function beginCompact(thread) {
	if (compactingThreads.has(thread.id)) return false;
	compactingThreads.add(thread.id);
	return true;
}

/** The compaction in flight is over, one way or another, and the thread takes messages again. */
export function endCompact(thread) {
	compactingThreads.delete(thread.id);
}

/** Whether a compaction is in flight for this thread. */
export function isCompacting(thread) {
	return compactingThreads.has(thread.id);
}



/** A settled note is a glance like a reported one, so it keeps the same ceiling; kept here to keep this module import-free. */
const NOTE_CHARS = 140;


/**
 * A report that outlives its run is a lie, so a settled thread keeps no phase: done clears it, and an end
 * that was not an answer leaves the reason as its note, so a failed thread still says why (a 429, a cut)
 * where the board status can be read. A stopped thread needs a report to leave one: a kill on a thread
 * that never claimed anything would otherwise fill the board with stops. What ended the run is the turn
 * passed in — a hidden thread's own turn list sits empty while its card carries the turns — so the
 * newest turn is only a fallback. Kept here, beside finished, so every settle — end of run, kill,
 * error — clears through one place.
 */
function settleActivity(thread, ended = null) {
	const said = thread.activity;
	const turns = Array.isArray(thread.turns) ? thread.turns : [];
	const last = ended ?? turns[turns.length - 1];
	const failed = thread.status === "dead" || (last?.status === "stopped" && last.error);
	if (thread.status === "dead" || failed) {
		const reason = last?.error ? String(last.error).replace(/\s+/g, " ").trim().slice(0, NOTE_CHARS) : "";
		thread.activity = { status: "idle", at: Date.now(), ...(reason ? { note: reason } : {}) };
	} else if (last?.status === "stopped" && said) {
		thread.activity = { status: "idle", note: "stopped", at: Date.now() };
	} else {
		delete thread.activity;
	}
}


/** Wake whoever waits on this thread. Called where a run ends, never where one starts. */
export function finished(thread, ended = null) {
	settleActivity(thread, ended);
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
