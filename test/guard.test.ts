import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * The daemon's state folder is resolved once, when `server/paths.ts` is first imported, so this file moves
 * it to a folder it made before any of the daemon's code is loaded and then loads that code dynamically.
 * Importing the daemon reads the session store, and a store that pruned while it loaded wrote into whatever
 * folder was named — the human's own when nothing named one. It writes only into folders it made under
 * `tmpdir()`, and binds no socket.
 */
const state = mkdtempSync(join(tmpdir(), "pi-studio-guard-state-"));
process.env.PI_STUDIO_STATE = state;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** A token, and a session that ran out long ago, seeded before the store reads them: reading is the defect. */
const savedToken = "a".repeat(32);
const spent = "b".repeat(32);
const sessionsFile = join(state, "sessions.json");
const seeded = `${JSON.stringify({ owner: sha(savedToken).slice(0, 16), sessions: { [sha(spent)]: Date.now() - 1000 } }, null, 2)}\n`;
writeFileSync(join(state, "daemon.json"), JSON.stringify({ token: savedToken }));
writeFileSync(sessionsFile, seeded);

const { boards } = await import("../server/store.ts");
const { hasSession } = await import("../server/login.ts");
const { THREAD_ROUTES, callerFor, threadRefusal } = await import("../server/main.ts");

after(() => rmSync(state, { recursive: true, force: true }));

// A child token is minted inside the spawn, so no HTTP client can forge one. The decision it answers to
// is a plain function, and that is what these tests call.
const child = { human: false, board: { id: "board-a" }, thread: {} };
/** A thread a spawn started: the one thing that draws nothing and asks nothing. */
const spawned = { human: false, board: { id: "board-a" }, thread: { id: "child-1", parentThread: "master-1" } };
const human = { human: true };

test("a thread that answers for a card may write on its own board, and may ask the human a question there", () => {
	// `/thread/path` is not here: a flow is the human's to pin, and a boss on `auto` decides its own steps. A
	// hidden thread that answers a note the human started is not a spawned child, and it keeps every one of
	// these.
	const allowed = ["/card/note", "/card/source", "/thread/spawn", "/card/ask", "/thread/collect", "/skill", "/close"];
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
	// Opening a card's file in the human's editor starts a program on their desktop, so it is here too.
	// `/scratch/empty` deletes a whole folder and every card on a board, which is the human's press alone.
	const refused = ["/layout", "/undo", "/kill", "/config", "/answer", "/message", "/mode", "/shell", "/card/open", "/scratch/empty"];
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

test("loading the session store prunes in memory and leaves the state folder alone", () => {
	// The spent session is gone from what the daemon will answer with…
	assert.equal(hasSession(`pi-studio-${sha(savedToken).slice(0, 8)}=${spent}`), false);
	// …and the file it was read from is exactly as it was: a load is not a create and not a logout, so it
	// writes nothing. A test that only imports the daemon must not touch the folder it did not make.
	assert.equal(readFileSync(sessionsFile, "utf8"), seeded, "loading the sessions wrote to the state folder");
});

test("a thread's token is its own in a query and nothing at all in a cookie", () => {
	const board = { id: "board-cookie", threads: new Map([["t1", { id: "t1", token: "thread-secret-token" }]]) };
	boards.set(board.id, board as any);
	try {
		assert.equal(callerFor("thread-secret-token", undefined)?.human, false);
		for (const header of ["thread-secret-token", `pi-studio-00000000=thread-secret-token; a=b`]) {
			assert.equal(callerFor("", header), null, header);
			assert.equal(callerFor(null, header), null, header);
		}
	} finally {
		boards.delete(board.id);
	}
});
