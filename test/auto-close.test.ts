import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { closedCards } from "../server/bus.ts";
import { CHILD_CLOSE_DELAY_MS, MAX_PUT_AWAY_CHILDREN } from "../server/limits.ts";
import { autoCloseChild, autoCloseRefusal, forgetCard, killChild, onClose, onReopen, onUndo } from "../server/routes/board/lifecycle.ts";
import { pruneHiddenThreads } from "../server/store.ts";
import { handleChildLine } from "../server/thought.ts";

/**
 * The smallest board the put-away touches. A child that has reported writes no cards of its own, so the
 * card map only holds whatever the test puts there, and there is no client to broadcast to.
 */
function fakeBoard(): any {
	return {
		id: "b1",
		name: "board",
		folder: "/tmp/board",
		threads: new Map(),
		cards: new Map(),
		children: new Map(),
		clients: new Set(),
		welcomeClients: new Set(),
		trees: [],
		activity: [],
		trash: [],
		// A save is already queued, so `scheduleSave` adds nothing: a test that ticked the clock would
		// otherwise write a board file into the human's state folder.
		saveTimer: { unref() {} },
	};
}

/** A parent thread the human started, and a child it spawned that has just answered. */
function family() {
	const board = fakeBoard();
	const parent: any = { id: "master-1", title: "master", status: "idle", turns: [], queued: [], at: Date.now() };
	const child: any = {
		id: "child-1",
		title: "a child",
		status: "idle",
		parentThread: "master-1",
		depth: 1,
		at: Date.now(),
		turns: [{ text: "look at it", status: "answered", reply: "it is fine", at: Date.now() }],
		queued: [],
		worktree: { base: "dev", path: "/tmp/board/.worktrees/child-1" },
	};
	board.threads.set(parent.id, parent);
	board.threads.set(child.id, child);
	return { board, parent, child };
}

test("a child that answered is hidden a moment later, and nothing of it is killed or swept", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	autoCloseChild(board, child);
	// Not at once: the caller may still be reading the answer, and a card that vanishes under a click is
	// a card the human thinks they lost.
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS - 1);
	assert.equal(child.hidden, undefined);
	t.mock.timers.tick(1);
	assert.equal(child.hidden, true);
	// Hidden, not closed: the thread, its turns, its session and its tree are all still there to assemble.
	assert.equal(board.threads.get(child.id), child);
	assert.equal(child.turns.length, 1);
	assert.deepEqual(child.worktree, { base: "dev", path: "/tmp/board/.worktrees/child-1" });
	assert.equal(board.children.size, 0, "no child was killed");
	assert.deepEqual(board.trash, [], "undo is not flooded with a close nobody asked for");
	// And it is in the rail's closed list, where a click draws it again.
	assert.deepEqual(
		closedCards(board).map((row) => row.id),
		[child.id],
	);
});

test("a message, a pin or a running child cancels the put-away", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const cases: [string, (thread: any) => void][] = [
		// The human wrote to the child again, which started a run.
		["running", (thread) => (thread.status = "running")],
		// A run is answering for a card this child owns.
		["answering", (thread) => (thread.answering = { cardId: "note-1", turn: 0 })],
		// A queued message is waiting for the child.
		["queued", (thread) => thread.queued.push({ text: "and one more thing" })],
		// The human kept the card in sight.
		["pinned", (thread) => (thread.pinned = true)],
		// The human closed it by hand.
		["hidden", (thread) => (thread.hidden = true)],
	];
	for (const [why, spoil] of cases) {
		const { board, child } = family();
		autoCloseChild(board, child);
		spoil(child);
		t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
		assert.deepEqual(child.hidden, why === "hidden" ? true : undefined, why);
		assert.equal(child.closedAt, undefined, why);
	}
});

test("a put-away queued twice hides the card once, at the last moment", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	autoCloseChild(board, child);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS - 5_000);
	// The child answered a second time before the first put-away fired: the clock starts again.
	autoCloseChild(board, child);
	t.mock.timers.tick(5_000);
	assert.equal(child.hidden, undefined);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(child.hidden, true);
	const closedAt = child.closedAt;
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS * 2);
	assert.equal(child.closedAt, closedAt, "a hidden card is not hidden a second time");
});

test("a closed parent leaves no put-away behind, and a thread the human started is never touched", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, parent, child } = family();
	autoCloseChild(board, child);
	// The parent closes while the child waits: its children's cards are no longer the board's business.
	parent.hidden = true;
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(child.hidden, undefined);

	const other = family();
	const mine = other.parent;
	autoCloseChild(other.board, mine);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(mine.hidden, undefined);
	// Refused when it is asked, and for the reason the board would give a human reading it.
	assert.match(autoCloseRefusal(other.board, mine), /human started/);
});

/**
 * A request as the close and undo routes read one, and a response that keeps nothing: the route is what
 * is under test here, not the wire it answers on.
 */
function wire(body: any) {
	const req: any = Readable.from([Buffer.from(JSON.stringify(body))]);
	const res: any = { writeHead() {}, end() {} };
	return { req, res };
}

/** The line a child sends when its run is over, which is where the put-away is now queued. */
const SETTLED = JSON.stringify({ type: "agent_settled" });

test("an answer that arrives without a spawn is put away all the same", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	handleChildLine(board, child, SETTLED);
	// The run resolved, so the report is in the parent's hands and the clock has started.
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS - 1);
	assert.equal(child.hidden, undefined);
	t.mock.timers.tick(1);
	assert.equal(child.hidden, true);
	// Hidden, not closed: the thread and its turns are still there to assemble.
	assert.equal(board.threads.get(child.id), child);
});

test("a run that was stopped or failed is never put away, however much it said", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	// The turn as a timeout, an abort or an error leaves it: an answer was written, and it is not one.
	const stopped = family();
	stopped.child.turns[0].status = "stopped";
	handleChildLine(stopped.board, stopped.child, SETTLED);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS * 2);
	assert.equal(stopped.child.hidden, undefined, "a stopped run");
	assert.equal(stopped.child.closedAt, undefined, "a stopped run");
	// A run that said nothing at all leaves its turn `sent`, and settling that reads as stopped.
	const { board, child } = family();
	child.turns[0].status = "sent";
	handleChildLine(board, child, SETTLED);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS * 2);
	assert.equal(child.hidden, undefined, "a turn that never answered");
});

test("closing an ordinary note leaves the put-away child where the rail can reach it", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	autoCloseChild(board, child);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(child.hidden, true);
	// A spawned child owns no cards, which is exactly the shape a hidden thread takes when its last card
	// went with it — so the close of an unrelated note must not read it as one to throw away.
	const note = { id: "note-1", title: "a note", type: "note", at: Date.now() };
	board.cards.set(note.id, note);
	const closed = wire({ cardId: note.id });
	await onClose(closed.req, closed.res, board, { human: true });
	assert.equal(board.cards.get(note.id), undefined, "the note the human closed is gone");
	assert.equal(board.threads.get(child.id), child, "the child is still there to bring back");
	assert.deepEqual(
		closedCards(board).map((row) => row.id),
		[child.id],
		"and still listed by the closed rail",
	);
	assert.deepEqual(
		board.trash.map((entry: any) => entry.kind),
		["card"],
		"undo holds the note, and nothing was put away on the human's behalf",
	);
});

test("a child closed by hand and brought back inside the window keeps its card", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	autoCloseChild(board, child);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS - 15_000);
	// The human closes the child before the put-away fires, then presses ctrl+z to have it back.
	const closed = wire({ cardId: child.id });
	await onClose(closed.req, closed.res, board, { human: true });
	const undone = wire({});
	await onUndo(undone.req, undone.res, board);
	assert.equal(board.threads.get(child.id), child, "ctrl+z put the card back");
	assert.equal(child.hidden, undefined);
	// The deadline of the put-away the child's answer queued has come and gone.
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(child.hidden, undefined, "the card the human brought back stays on the board");
	assert.equal(child.closedAt, undefined);
});

test("a child that owns a note keeps its card when a close and a reopen land inside the window", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	// A child that wrote a note of its own keeps its thread through a close, so `onClose` takes the branch
	// that hides the card rather than the one that ends the thread — which is exactly the branch the queued
	// put-away used to survive.
	board.cards.set("note-1", {
		id: "note-1",
		type: "note",
		title: "a note",
		markdown: "the answer",
		ownerThread: child.id,
		at: Date.now(),
	});
	autoCloseChild(board, child);
	t.mock.timers.tick(5_000);
	const closed = wire({ cardId: child.id });
	await onClose(closed.req, closed.res, board, { human: true });
	assert.equal(child.hidden, true, "the close took the card off the board");
	t.mock.timers.tick(5_000);
	// The human has it back from the rail, a quarter of the way into the window the answer started.
	const reopened = wire({ cardId: child.id });
	await onReopen(reopened.req, reopened.res, board);
	assert.equal(child.hidden, false, "the human brought the card back");
	// The deadline of the put-away the child's answer queued has come and gone.
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(child.hidden, false, "the card the human brought back stays on the board");
	assert.equal(child.closedAt, undefined);
});

test("a run the board timed out is never put away, even when its turn reads answered", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	// The timeout landed after the last `turn_end`, so the turn is `answered` and the flag the spawn set is
	// the only record left that this run was cut rather than finished.
	child.timedOut = true;
	handleChildLine(board, child, SETTLED);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS * 2);
	assert.equal(child.hidden, undefined, "a timed-out run");
	assert.equal(child.closedAt, undefined, "a timed-out run");
	assert.match(autoCloseRefusal(board, child), /timed out/);
});

test("a session keeps no more put-away children than a restart would", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	// The board yesterday left one more put-away child than the cap allows, oldest first. Nothing trims them
	// while the daemon runs, so a session that spawns all day files them for ever.
	for (let at = 0; at < MAX_PUT_AWAY_CHILDREN; at += 1) {
		const old = {
			id: `old-${at}`,
			title: "a child from yesterday",
			status: "idle",
			parentThread: "master-1",
			hidden: true,
			closedAt: 1_000 + at,
			turns: [],
		};
		board.threads.set(old.id, old);
	}
	autoCloseChild(board, child);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(child.hidden, true);
	const away = [...board.threads.values()].filter((thread: any) => thread.hidden && thread.closedAt);
	assert.equal(away.length, MAX_PUT_AWAY_CHILDREN, "the cap holds while the daemon runs");
	assert.equal(board.threads.get("old-0"), undefined, "the child put away first is the one the rail loses");
	assert.ok(board.threads.has(`old-${MAX_PUT_AWAY_CHILDREN - 1}`), "the ones the human saw last stay");
	assert.ok(board.threads.has(child.id), "and the one just put away is on the rail");
	assert.deepEqual(board.trash, [], "trimming is not a close the human can undo");
});

/** A child the board put away on an earlier day: hidden, closed, and owning nothing. */
function filed(id: string, closedAt: number) {
	return { id, title: "a child from yesterday", status: "idle", parentThread: "master-1", hidden: true, closedAt, turns: [] };
}

/** The rail filled to the cap with children put away before this session started. */
function fullRail(board: any) {
	for (let at = 0; at < MAX_PUT_AWAY_CHILDREN; at += 1) board.threads.set(`old-${at}`, filed(`old-${at}`, 1_000 + at));
}

test("the trim never reaches a child that is hidden, closed and still working", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	// The human closes the card of a child that owns a note while that child is working: `onClose` has no
	// status guard, so the thread takes `hidden` and `closedAt` and keeps its note.
	const busy: any = { ...filed("busy-1", 1), status: "running" };
	board.threads.set(busy.id, busy);
	board.cards.set("note-1", { id: "note-1", type: "note", title: "a note", ownerThread: busy.id, at: Date.now() });
	// The note then goes — the board's plain-card ceiling evicts it — and `forgetCard` spares the thread because
	// it carries `closedAt`. What the trim now sees is a child that is cardless, hidden, closed and working.
	board.cards.delete("note-1");
	forgetCard(board, "note-1");
	let ended = 0;
	board.children.set(busy.id, {
		stdin: { end: () => (ended += 1) },
		kill: () => assert.fail("a child that is still working is not killed by a trim"),
	});
	fullRail(board);
	// The next put-away arrives, which is what asks the board to trim the rail.
	autoCloseChild(board, child);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(board.threads.get(busy.id), busy, "a child still working stays where the rail can reach it");
	assert.equal(ended, 0, "and its stdin is not closed under it");
	assert.ok(board.children.has(busy.id), "and its process is still the board's");
	assert.equal(board.threads.get("old-0"), undefined, "the trim did run");
});

test("the trim leaves the human's own closed thread alone", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	// A thread the human started, closed by hand after its cards went: it carries `closedAt` like a put-away
	// child, and it is the oldest row on the rail, so the trim reaches it first.
	const mine: any = { id: "mine-1", title: "my own", status: "idle", hidden: true, closedAt: 1, turns: [] };
	board.threads.set(mine.id, mine);
	fullRail(board);
	autoCloseChild(board, child);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(board.threads.get(mine.id), mine, "a thread the human started is theirs to keep");
	assert.equal(board.threads.get("old-0"), undefined, "and the trim still ran");
});

test("the closed rail never lists more put-away children than the cap after a trim", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	const now = Date.now();
	// A closed child that still owns a card, and one the human started: both are rows on the rail, and neither
	// is one the trim may retire. They sit newer than the ones it retires, so its room comes from those.
	const keeper: any = filed("keeper-1", now - 100);
	board.threads.set(keeper.id, keeper);
	board.cards.set("note-9", { id: "note-9", type: "note", title: "a note", ownerThread: keeper.id, at: now });
	const mine: any = { id: "mine-1", title: "my own", status: "idle", hidden: true, closedAt: now - 50, turns: [] };
	board.threads.set(mine.id, mine);
	fullRail(board);
	autoCloseChild(board, child);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	// The cap counts the rows the board filed and no others: the human's own closed thread is a row the rail
	// draws without being room the cap may spend, so it is left out of the count.
	const filedRows = closedCards(board).filter((row) => board.threads.get(row.id)?.parentThread);
	assert.ok(
		filedRows.length <= MAX_PUT_AWAY_CHILDREN,
		`the rail lists ${filedRows.length} put-away children for a cap of ${MAX_PUT_AWAY_CHILDREN}`,
	);
	assert.equal(board.threads.get(keeper.id), keeper, "the row that owns a card is still drawn through it");
	assert.equal(board.threads.get(mine.id), mine, "and the human's own thread is still there");
});

test("a kill on a child that has already exited still disarms the put-away", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, child } = family();
	autoCloseChild(board, child);
	// The run is over and its process has exited, which is the ordinary shape a second after the answer. There
	// is nothing to kill, and the kill must still take the queued put-away with it.
	assert.equal(killChild(board, child), false, "there was no process left to kill");
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(child.hidden, undefined, "the card stays where the human is reading it");
});

test("an agent cannot close a card the board has already put away", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { board, parent, child } = family();
	autoCloseChild(board, child);
	t.mock.timers.tick(CHILD_CLOSE_DELAY_MS);
	assert.equal(child.hidden, true);
	// The parent tidies up after its child, and there is nothing left to close: the card is in the rail's
	// closed list, and `closeThread` would take the thread with it and lose the one way back.
	const res: any = { writeHead(status: number) { this.status = status; }, end(body: string) { this.body = body; } };
	const req: any = Readable.from([Buffer.from(JSON.stringify({ cardId: child.id }))]);
	await onClose(req, res, board, { human: false, thread: parent } as any);
	assert.equal(res.status, 409);
	assert.equal(res.body, "this card is already closed");
	assert.equal(board.threads.get(child.id), child, "the rail still offers it back");
	assert.equal(board.children.size, 0, "and nothing was killed");
});

test("a hidden child the rail still lists survives a restart, and one it does not is dropped", () => {
	// The auto-closed child owns no cards, and its `closedAt` is what puts it in the rail's closed list.
	const board = fakeBoard();
	const put = { id: "child-1", title: "a child", hidden: true, closedAt: 1_700_000_000_000, turns: [] };
	// A child that answers for a card, hidden because the card is where it is read, and now cardless.
	const orphan = { id: "child-2", title: "an answerer", hidden: true, threadRoot: "note-9", turns: [] };
	const answerer = { id: "child-3", title: "an answerer", hidden: true, threadRoot: "note-8", turns: [] };
	const note = { id: "note-8", title: "note", type: "note", threadRoot: "child-3", ownerThread: "child-3", at: 1 };
	for (const thread of [put, orphan, answerer]) board.threads.set(thread.id, thread);
	board.cards.set(note.id, note);
	pruneHiddenThreads(board);
	assert.equal(board.threads.get(put.id), put, "a put-away child is still there to bring back");
	assert.equal(board.threads.get(orphan.id), undefined, "a hidden thread nothing draws is dropped");
	assert.equal(board.threads.get(answerer.id), answerer, "a hidden thread that still owns a card stays");
});
