import assert from "node:assert/strict";
import { test } from "node:test";
import { handleChildLine } from "../server/thought.ts";

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
		trees: [],
		cards: [],
		config: { model: "m", provider: "p", thinking: "off" },
	};
}

function fakeThread(): Record<string, unknown> {
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
