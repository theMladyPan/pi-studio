import assert from "node:assert/strict";
import { test } from "node:test";
import { THREAD_ROUTES, threadRefusal } from "../server/main.ts";

// A child token is minted inside the spawn, so no HTTP client can forge one. The decision it answers to
// is a plain function, and that is what these tests call.
const child = { human: false, board: { id: "board-a" }, thread: {} };
/** A thread a spawn started: the one thing that draws nothing and asks nothing. */
const spawned = { human: false, board: { id: "board-a" }, thread: { id: "child-1", parentThread: "master-1" } };
const human = { human: true };

test("a thread that answers for a card may write on its own board, and may ask the human a question there", () => {
	// `/thread/path` is here because a boss reports the flow it chose on its own row. A hidden thread that
	// answers a note the human started is not a spawned child, and it keeps every one of these.
	const allowed = ["/card/note", "/card/source", "/thread/spawn", "/card/ask", "/thread/path", "/skill", "/close"];
	for (const path of allowed) assert.equal(threadRefusal(child, "POST", path, "board-a"), null, path);
	// The list is compared whole, because a route added to it and not to this test would widen what a
	// child may reach without a single case going red.
	assert.deepEqual([...THREAD_ROUTES].sort(), [...allowed].sort());
});

test("a spawned child draws nothing: every card route is refused, on its own board included", () => {
	// One card per child is what turned a six-step flow into eighteen cards beside the winner. The refusal
	// is here rather than in a prompt because a prompt is advice and this is the wall behind it.
	for (const path of THREAD_ROUTES) assert.equal(threadRefusal(spawned, "POST", path, "board-a"), "a spawned child has no board tools", path);
});

test("a child may not reach the routes that belong to the human", () => {
	// board_ask was refused here for the same reason /layout is, which is what made it dead for every thread.
	// /close is not here: a thread tidies the cards it spent, and the handler refuses it the pinned ones.
	const refused = ["/layout", "/undo", "/kill", "/config", "/answer", "/message", "/mode"];
	for (const path of refused) {
		assert.equal(threadRefusal(child, "POST", path, "board-a"), "a thread may not use that", path);
	}
});

test("a child may read nothing, the board state included", () => {
	assert.equal(threadRefusal(child, "GET", "/state", "board-a"), "a thread may not use that");
	assert.equal(threadRefusal(child, "GET", "/card/ask", "board-a"), "a thread may not use that");
});

test("a child may not post to another board", () => {
	assert.equal(threadRefusal(child, "POST", "/card/ask", "board-b"), "a thread may not use another board");
	assert.equal(threadRefusal(child, "POST", "/card/note", ""), "a thread may not use another board");
});

test("the human at the keyboard is never refused", () => {
	for (const method of ["GET", "POST"]) {
		assert.equal(threadRefusal(human, method, "/layout", "board-b"), null);
		assert.equal(threadRefusal(human, method, "/state", ""), null);
	}
});
