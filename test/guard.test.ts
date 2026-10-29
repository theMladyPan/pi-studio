import assert from "node:assert/strict";
import { test } from "node:test";
import { THREAD_ROUTES, threadRefusal } from "../server/main.ts";

// A child token is minted inside the spawn, so no HTTP client can forge one. The decision it answers to
// is a plain function, and that is what these tests call.
const child = { human: false, board: { id: "board-a" }, thread: {} };
const human = { human: true };

test("a child may write on its own board, and may ask the human a question there", () => {
	const allowed = ["/card/note", "/card/source", "/thread/spawn", "/card/ask"];
	for (const path of allowed) assert.equal(threadRefusal(child, "POST", path, "board-a"), null, path);
	// The list is compared whole, because a route added to it and not to this test would widen what a
	// child may reach without a single case going red.
	assert.deepEqual([...THREAD_ROUTES].sort(), [...allowed].sort());
});

test("a child may not reach the routes that belong to the human", () => {
	// board_ask was refused here for the same reason /layout is, which is what made it dead for every thread.
	const refused = ["/layout", "/close", "/kill", "/config", "/answer", "/message"];
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
