import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { duplicateOnBoard, onDuplicate } from "../server/routes/board/lifecycle.ts";
import { sessionDir } from "../server/session.ts";

/**
 * Duplicating a card: a thread comes back as a new instance with a new id and a copied session, a
 * plain card as a clone under a new id, and cards the original owns stay bound to it.
 */
const folder = mkdtempSync(join(tmpdir(), "pi-studio-duplicate-"));
after(() => rmSync(folder, { recursive: true, force: true }));

function fakeBoard(): any {
	return {
		id: "b1",
		name: "board",
		folder,
		config: {},
		threads: new Map(),
		cards: new Map(),
		children: new Map(),
		clients: new Set(),
		welcomeClients: new Set(),
		trees: [],
		activity: [],
		trash: [],
		// A save is already queued, so `scheduleSave` adds nothing into the human's state folder.
		saveTimer: { unref() {} },
	};
}

function thread(board: any, extra: any = {}) {
	const held: any = {
		id: "thread-1",
		title: "fix the parser",
		sessionId: null,
		status: "idle",
		provider: "klotilda",
		model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
		thinking: "high",
		mode: "boss",
		path: "auto",
		pathChosenBy: "auto",
		at: 1_700_000_000_000,
		turns: [{ text: "fix it", status: "answered", reply: "done", at: 1_700_000_000_000 }],
		queued: [],
		folder,
		...extra,
	};
	board.threads.set(held.id, held);
	return held;
}

/** A session file as pi writes it: a header carrying the id, then the entries. */
function writeSession(board: any, sessionId: string) {
	const dir = sessionDir(board);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: folder }),
			JSON.stringify({ type: "message", id: "a1", parentId: null, message: { role: "user", content: [{ type: "text", text: "fix it" }] } }),
		].join("\n") + "\n",
	);
	return file;
}

function refusalOf(fn: () => unknown) {
	try {
		fn();
	} catch (error: any) {
		return error;
	}
	throw new Error("expected a refusal");
}

test("duplicating a thread forks it: new id, copied turns and session, cards left bound to the original", () => {
	const board = fakeBoard();
	const original = thread(board, { sessionId: "session-1", worktree: { base: "dev", path: "/tmp/tree-1" } });
	writeSession(board, "session-1");
	board.cards.set("note-1", {
		id: "note-1",
		type: "note",
		title: "a note",
		markdown: "the answer",
		ownerThread: "thread-1",
		at: 1_700_000_000_000,
	});

	const made: any = duplicateOnBoard(board, { cardId: "thread-1" });
	assert.notEqual(made.cardId, "thread-1", "the duplicate got its own thread id");
	const fork = board.threads.get(made.cardId);
	assert.ok(fork, "the duplicate is on the board");
	assert.equal(fork.title, "fix the parser");
	assert.deepEqual(fork.turns, original.turns, "the conversation came along");
	assert.notEqual(fork.turns, original.turns, "the turns are a copy, not the same list");
	assert.notEqual(fork.turns[0], original.turns[0], "a turn is a copy, not the same object");
	fork.turns[0].reply = "changed";
	assert.equal(original.turns[0].reply, "done", "editing the copy leaves the original alone");
	assert.equal(fork.status, "idle");
	assert.deepEqual(fork.queued, []);
	assert.equal(fork.worktree, undefined, "the copy cuts its own tree on its first message");
	assert.equal(fork.model, original.model, "the runtime came along");
	assert.equal(fork.thinking, "high");
	assert.equal(fork.mode, "boss");
	assert.equal(fork.path, "auto");
	// Children cards remain bound to the old thread.
	assert.equal(board.cards.get("note-1").ownerThread, "thread-1", "the original's card moved with the copy");
	assert.equal(board.cards.size, 1, "no card was added for the thread duplicate");
	// The session was copied under a fresh id, and the original file is untouched.
	assert.ok(fork.sessionId && fork.sessionId !== "session-1", "the copy resumed under its own session id");
	const copied = readFileSync(join(sessionDir(board), `2026-01-01T00-00-00-000Z_${fork.sessionId}.jsonl`), "utf8");
	assert.equal(JSON.parse(copied.split("\n")[0]).id, fork.sessionId, "the copied header names the new session");
	assert.match(copied, /fix it/, "the copied entries are the original's");
	const before = readFileSync(join(sessionDir(board), "2026-01-01T00-00-00-000Z_session-1.jsonl"), "utf8");
	assert.equal(JSON.parse(before.split("\n")[0]).id, "session-1", "the original session kept its id");
	assert.equal(board.threads.size, 2, "the original is still on the board");
});

test("a thread with no session yet forks without one", () => {
	const board = fakeBoard();
	thread(board);
	const made: any = duplicateOnBoard(board, { cardId: "thread-1" });
	assert.equal(board.threads.get(made.cardId).sessionId, null);
});

test("a running or ended thread, and a missing session file, are refused rather than forked", () => {
	const running = fakeBoard();
	thread(running, { status: "running" });
	assert.equal(refusalOf(() => duplicateOnBoard(running, { cardId: "thread-1" })).status, 409);
	assert.equal(running.threads.size, 1, "nothing was made behind a run in progress");

	const dead = fakeBoard();
	thread(dead, { status: "dead" });
	assert.equal(refusalOf(() => duplicateOnBoard(dead, { cardId: "thread-1" })).status, 409);

	const gone = fakeBoard();
	thread(gone, { sessionId: "session-gone" });
	assert.equal(refusalOf(() => duplicateOnBoard(gone, { cardId: "thread-1" })).status, 409, "a session that is not on disk cannot be copied");
	assert.equal(gone.threads.size, 1, "no half-made thread was left behind");

	assert.equal(refusalOf(() => duplicateOnBoard(fakeBoard(), { cardId: "nope" })).status, 404);
});

test("duplicating a note clones it under a new id, with no key and no rect, and the same owner", () => {
	const board = fakeBoard();
	thread(board);
	board.cards.set("note-1", {
		id: "note-1",
		type: "note",
		title: "a note",
		markdown: "# hello",
		key: "plan",
		ownerThread: "thread-1",
		rect: { x: 10, y: 20, w: 300, h: 200 },
		pinned: true,
		turns: [{ text: "and?", status: "answered", reply: "yes", at: 1_700_000_000_000 }],
		at: 1_700_000_000_000,
	});

	const made: any = duplicateOnBoard(board, { cardId: "note-1" });
	assert.notEqual(made.cardId, "note-1");
	const copy = board.cards.get(made.cardId);
	assert.equal(copy.markdown, "# hello");
	assert.equal(copy.key, undefined, "a key on two cards would make every revision a coin toss");
	assert.equal(copy.rect, undefined, "the board places the copy, as it places a new card");
	assert.equal(copy.pinned, undefined, "the copy is not kept in sight by the original's pin");
	assert.equal(copy.ownerThread, "thread-1", "the copy is answered by the thread that answered the original");
	assert.deepEqual(copy.turns, board.cards.get("note-1").turns);
	assert.notEqual(copy.turns[0], board.cards.get("note-1").turns[0]);
	assert.equal(board.cards.get("note-1").key, "plan", "the original kept its key");
	assert.equal(board.cards.size, 2);
});

test("duplicating an html card keeps its page, and a settled question keeps its answer", () => {
	const board = fakeBoard();
	board.cards.set("html-1", {
		id: "html-1",
		type: "html",
		title: "page",
		html: "<p>hi</p>",
		at: 1_700_000_000_000,
	});
	const html: any = duplicateOnBoard(board, { cardId: "html-1" });
	assert.equal(board.cards.get(html.cardId).html, "<p>hi</p>");

	board.cards.set("question-1", {
		id: "question-1",
		type: "question",
		title: "question",
		question: "which one?",
		options: ["a", "b"],
		status: "answered",
		answer: "a",
		at: 1_700_000_000_000,
	});
	const question: any = duplicateOnBoard(board, { cardId: "question-1" });
	assert.equal(board.cards.get(question.cardId).status, "answered");
	assert.equal(board.cards.get(question.cardId).answer, "a");
});

test("an open question is refused: the child waiting on it waits on the original id", () => {
	const board = fakeBoard();
	board.cards.set("question-1", {
		id: "question-1",
		type: "question",
		title: "question",
		question: "which one?",
		options: ["a", "b"],
		status: "open",
		expiresAt: Date.now() + 60_000,
		at: 1_700_000_000_000,
	});
	assert.equal(refusalOf(() => duplicateOnBoard(board, { cardId: "question-1" })).status, 409);
	assert.equal(board.cards.size, 1, "no orphaned question was left behind");
});

test("the route answers the copy, as the head press expects", async () => {
	const board = fakeBoard();
	thread(board);
	const req: any = Readable.from([Buffer.from(JSON.stringify({ cardId: "thread-1" }))]);
	const res: any = {
		status: 0,
		body: "",
		writeHead(status: number) {
			this.status = status;
		},
		end(body: string) {
			this.body = body;
		},
	};
	await onDuplicate(req, res, board);
	assert.equal(res.status, 200);
	const made = JSON.parse(res.body);
	assert.ok(made.cardId && made.cardId !== "thread-1", "the answer names the copy");
	assert.equal(made.card.title, "fix the parser");
});
