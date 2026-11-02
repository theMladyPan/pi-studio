import assert from "node:assert/strict";
import { test } from "node:test";
import { closedCards } from "../server/bus.ts";
import { CHILD_CLOSE_DELAY_MS } from "../server/limits.ts";
import { autoCloseChild, autoCloseRefusal } from "../server/routes/board/lifecycle.ts";
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
