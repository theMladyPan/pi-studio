import assert from "node:assert/strict";
import { test } from "node:test";
import { handleChildLine, settleRows } from "../server/thought.ts";

/**
 * One activity row as the tests hand it to the reader and read back: the fields the rail, the store and a
 * settle touch. Narrow on purpose, so a row missing its tool or holding a stringly duration fails to check.
 */
type ActivityRow = {
	id: string;
	kind: string;
	tool: string;
	status: string;
	startedAt: number;
	durationMs?: number;
	thread: { id: string; title: string };
};

/**
 * The smallest board the line reader will accept. It is a plain object on purpose: the reader is a
 * state machine over the child's JSON, and everything it touches is passed in.
 */
function fakeBoard() {
	return {
		id: "b1",
		name: "board",
		folder: "/tmp/board",
		children: new Map(),
		// Nothing to broadcast to, but the reader still walks the set.
		clients: new Set(),
		trees: [],
		cards: [],
		// The rows the reader settles, pushed onto by the tests that give it calls to settle.
		activity: [] as ActivityRow[],
		config: { model: "m", provider: "p", thinking: "off" },
	};
}

// A fake the tests poke at freely: they set fields on it and read back what the child's lines did, so
// its shape is whatever that particular test needs rather than one the reader has to keep in step.
function fakeThread(): any {
	return { id: "abcdef123456", title: "a thread", status: "running", turns: [], queued: [], folder: "/tmp/board" };
}

/**
 * Only the guard is tested here. Everything past it lands in `update`, `scheduleSave` and
 * `settleThoughts`, which reach the whole board; a fake for that would be testing the fake. Reaching
 * the rest means one board object built by the routes rather than by hand, which is the next step.
 */
test("a line that is not JSON is reported and dropped", () => {
	const board = fakeBoard();
	const thread = fakeThread();
	// A child that writes half a line must not take the daemon down with it.
	assert.doesNotThrow(() => handleChildLine(board, thread, "this is not json"));
	assert.equal(thread.sessionId, undefined);
});

/** A child as the compaction branch touches it: a writable stdin and a record of what it was sent. */
function fakeChild(sent: any[]) {
	return {
		stdin: {
			writable: true,
			write: (frame: string) => sent.push(JSON.parse(frame)),
			end: () => sent.push({ type: "end" }),
		},
	};
}

const COMPACTED = JSON.stringify({ type: "response", command: "compact", success: true, data: { tokensBefore: 150000, estimatedTokensAfter: 32000 } });

test("a compaction on an idle thread reads the figures before the child goes", () => {
	const board = fakeBoard();
	const thread = fakeThread();
	thread.status = "idle";
	const sent: any[] = [];
	board.children.set(thread.id, fakeChild(sent));
	handleChildLine(board, thread, COMPACTED);
	// The numbers the button shows are asked for again, and the child is closed once they arrive.
	assert.equal(thread.pendingClose, true);
	assert.equal(sent[0]?.type, "get_session_stats");
});

test("a compaction that lands during a run leaves that run's child alone", () => {
	const board = fakeBoard();
	const thread = fakeThread();
	// A message typed while the summary was being written: the turn owns the child now.
	const sent: any[] = [];
	board.children.set(thread.id, fakeChild(sent));
	handleChildLine(board, thread, COMPACTED);
	assert.deepEqual(sent, [], "a live run's child was written to or closed by the compaction");
	assert.equal(thread.pendingClose, undefined);
});

/** The stats answer as pi really writes it, which is the shape the meter divides by. */
const STATS = (usage: unknown) =>
	JSON.stringify({ type: "response", command: "get_session_stats", success: true, data: { tokens: { input: 1, output: 1, total: 2 }, contextUsage: usage } });

test("the window pi reports is kept as the denominator of the meter", () => {
	const board = fakeBoard();
	const thread = fakeThread();
	thread.status = "idle";
	board.children.set(thread.id, fakeChild([]));
	handleChildLine(board, thread, STATS({ tokens: 60000, contextWindow: 200000, percent: 30 }));
	assert.equal(thread.stats.context, 60000);
	assert.equal(thread.stats.contextMax, 200000);
	assert.equal(thread.stats.contextPercent, 30);
});

test("a context pi cannot measure yet keeps the estimate the compaction gave", () => {
	const board = fakeBoard();
	const thread = fakeThread();
	thread.status = "idle";
	board.children.set(thread.id, fakeChild([]));
	// After a compaction pi reports null until an answer is measured, and the button that was just
	// pressed would otherwise go blank.
	handleChildLine(board, thread, COMPACTED.replace("32000", "32000"));
	handleChildLine(board, thread, STATS({ tokens: null, contextWindow: 200000, percent: null }));
	assert.equal(thread.stats.context, 32000);
	assert.equal(thread.stats.contextPercent, 16);
});

/**
 * The bug this covers: the rail said `activity 1` over a board where nothing was running, because a
 * call whose child was killed never sent its end line and its row kept a clock for ever.
 */
test("a thread that stops closes the calls it was in, and nobody else's", () => {
	const board = fakeBoard();
	const thread = fakeThread();
	const before = Date.now() - 5000;
	board.activity.push(
		{ id: "call-in-flight", kind: "tool", tool: "bash", status: "running", startedAt: before, thread: { id: thread.id, title: thread.title } },
		{ id: "call-done", kind: "tool", tool: "read", status: "ok", startedAt: before, durationMs: 12, thread: { id: thread.id, title: thread.title } },
		{ id: "other-thread-call", kind: "tool", tool: "bash", status: "running", startedAt: before, thread: { id: "another", title: "a busy neighbour" } },
	);
	settleRows(board, thread);
	const rows = new Map(board.activity.map((row) => [row.id, row] as const));
	const inFlight = rows.get("call-in-flight");
	assert.ok(inFlight, "the call that was running was dropped from the board");
	assert.equal(inFlight.status, "stopped");
	assert.ok(typeof inFlight.durationMs === "number" && inFlight.durationMs >= 4000);
	// A row that has already reported its own end is not touched, and neither is another thread's work.
	assert.equal(rows.get("call-done")?.status, "ok");
	assert.equal(rows.get("call-done")?.durationMs, 12);
	assert.equal(rows.get("other-thread-call")?.status, "running");
});
