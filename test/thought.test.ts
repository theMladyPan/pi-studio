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
