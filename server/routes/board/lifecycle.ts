// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Opening and closing: the sweep that kills a child, the rows a closed thread leaves, and the reopen
 * that brings one back.
 */
import { liveTurn, stopStream } from "../../child/run.ts";
import { broadcast, card, closedCards, nudgeWelcome, resync, update, updateCard } from "../../bus.ts";
import { CHILD_CLOSE_DELAY_MS, MAX_PUT_AWAY_CHILDREN } from "../../limits.ts";
import { MAX_PLAIN_CARDS, putAwayByBoard, scheduleSave } from "../../store.ts";
import { ownedCards, refreshOwned } from "./message.ts";
import { answer, fail, readJson } from "../../http.ts";
import { field } from "./thread.ts";
import { randomUUID } from "node:crypto";
import { cleanBoard, clearBoard, plainCardFor, stopQueue, sweepTrees } from "../../cards.ts";
import { existsSync, unlinkSync } from "node:fs";
import { finished } from "../../waiters.ts";
import { liveThoughts, settleRows } from "../../thought.ts";
import { settleTreeBranch } from "../../worktrees/name.ts";
import { discardBranch, discardTree, retireWorktree, treeBranch, treeRepo } from "../../worktrees/retire.ts";
import { fragmentsOf, removeFragment, removePreview, stepsNote, treeOf } from "../../worktrees/fragments.ts";
import { sessionFile } from "../../session.ts";
import { repoOf } from "../../git/repo.ts";



/**
 * A card that leaves the board takes its child with it. Nothing can reach a thread the board cannot
 * draw, so keeping one alive would leave a session and a process behind every closed note; and a run
 * that was answering for the card must not write its reply onto some other card's turn.
 */
/** The child goes with its last card. Nothing can reach a thread the board cannot draw. */
export function closeThread(board, thread) {
	// A close of any kind disarms the put-away a finished answer queued. A card the human closes and then
	// brings back must not vanish when the first close's clock runs out. This covers the close that ends the
	// thread; `onKill` kills without closing and disarms in `killChild`; and the close that keeps its thread,
	// the one `onClose` takes for a child that owns cards, disarms in `hideClosedCard`.
	cancelAutoClose(thread);
	// The child is ended, not merely asked to leave: it is working in a tree, and a tree whose thread
	// is gone is what `clean` may sweep. A run still writing there would write into nothing.
	killChild(board, thread);
	try {
		board.children.get(thread.id)?.stdin?.end();
	} catch {
		// The child is already gone, which is what this wanted.
	}
	board.children.delete(thread.id);
	board.threads.delete(thread.id);
	// A thread that goes takes its place in the closed list with it.
	nudgeClosed(board);
	// The record is settled against the tree before anything is swept: a child that cut its own branch and
	// committed after `agent_settled` last ran is still recorded under the branch before that one — usually
	// one already merged — and a detached tree is recorded with no branch at all. Settling names the branch
	// the tree is actually on, or gives a detached tree's commits a name, which is what keeps a closed
	// thread's work visible to the proof the sweep runs.
	settleTreeBranch(board, thread);
	// With the child gone, the thread's tree may be retired — and only a tree whose work is provably
	// already in the branch goes, so a thread closed mid-work keeps its tree, and `ctrl+z` still brings
	// back a thread whose unfinished work was never touched.
	sweepTrees(board);
	scheduleSave(board);
}



/**
 * How many closed cards the board can still put back. A close is one keystroke away from the `q` that
 * reads like a scroll key, so undo has to reach the mistake; a board left open for a day does not need
 * every card it ever closed kept alive for it.
 */
const TRASH_KEPT = 20;

/**
 * Keep what a close took off the board, so `ctrl+z` can put it back. The entry holds the thing itself
 * rather than a copy: a hidden thread is still in the board's map, and a thread whose child was killed
 * kept its turns, its session id and its worktree, which is everything a card needs to be drawn again.
 */
function rememberClosed(board, entry) {
	if (!Array.isArray(board.trash)) board.trash = [];
	board.trash.push({ at: Date.now(), ...entry });
	if (board.trash.length > TRASH_KEPT) board.trash.splice(0, board.trash.length - TRASH_KEPT);
}



/**
 * End a child without ending its thread. The session file stays, so the next message starts a fresh
 * child with the conversation it had; only the process goes.
 */
export function killChild(board, thread) {
	// A child that died is not one whose answer is being read, and a kill leaves the thread idle: the
	// put-away a finished answer queued must not fire on it. A close disarms it in `closeThread`; this is
	// the kill that leaves the thread in place, which is what `onKill` asks for. It is disarmed before the
	// lookup, because a run that has already exited is the ordinary shape a second after the answer and a
	// kill on it still has to take the queued put-away with it.
	cancelAutoClose(thread);
	const child = board.children.get(thread.id);
	if (!child) return false;
	// The child stops being this thread's voice before it is killed, so its death is not the run failing.
	board.children.delete(thread.id);
	const { turn, card: asked } = liveTurn(board, thread);
	if (turn) {
		turn.streaming = false;
		if (turn.status !== "answered") turn.status = "stopped";
	}
	stopStream(thread);
	// Nothing will arrive to drain the queue now, so what was waiting says stopped instead of waiting.
	stopQueue(board, thread);
	thread.answering = null;
	thread.abortWanted = false;
	thread.status = "idle";
	// A killed child never sends the end of the call it was in, and the rail would count that row as
	// running until the daemon restarts.
	settleRows(board, thread);
	try {
		// Stop asks the child to give up; kill is what happens when it does not.
		child.kill("SIGKILL");
	} catch {
		// Already gone, which is what this wanted.
	}
	// A note that was being answered has to be told, or its caret blinks for ever.
	if (asked) updateCard(board, asked);
	update(board, thread);
	scheduleSave(board);
	// A killed child is the end of its run, so whoever waits on it stops waiting.
	finished(thread);
	return true;
}



export function forgetCard(board, cardId) {
	for (const thread of [...board.threads.values()]) {
		if (thread.answering?.cardId === cardId) {
			const turn = board.cards.get(cardId)?.turns?.[thread.answering.turn];
			if (turn) {
				turn.streaming = false;
				if (turn.status !== "answered") turn.status = "stopped";
			}
			// Pinned to nowhere rather than forgotten: a run still going would otherwise fall back to
			// the thread's own last turn and overwrite an older answer with this card's.
			thread.answering = { cardId, turn: -1 };
		}
	}
	// A child lives while it has a card, so a hidden one that has just lost its last card goes with it —
	// unless the board put it away on its own. That one carries `closedAt`, is in the rail's closed list
	// and owns no cards by design, which is the same rule `pruneHiddenThreads` applies to a saved board.
	for (const thread of [...board.threads.values()]) {
		if (thread.hidden && !thread.closedAt && !ownedCards(board, thread.id).length) closeThread(board, thread);
	}
}



/** Keep the board bounded: the oldest plain card goes when a new one arrives and there is no room. */
export function makeRoom(board) {
	while (board.cards.size >= MAX_PLAIN_CARDS) {
		const oldest = [...board.cards.values()].sort((a, b) => a.at - b.at);
		// A pinned card is one the human keeps in sight, so the oldest unpinned card goes first. A board of
		// nothing but pinned cards still gives one up: the new card has to land, and this loop has to end.
		const gone = oldest.find((held) => !held.pinned) ?? oldest[0];
		if (!gone) break;
		board.cards.delete(gone.id);
		forgetCard(board, gone.id);
		broadcast(board, { type: "remove", id: gone.id });
	}
}



/** What the rail draws under "closed", told to every tab. */
export function nudgeClosed(board) {
	broadcast(board, { type: "closed", closed: closedCards(board) });
}



/**
 * Take a thread's card off the board and keep the thread: its session, its turns and its worktree stay
 * where they are, and `closedAt` puts it in the rail's closed list where a click draws it again. Nothing
 * is killed and nothing is swept, so the work of a thread that goes this way is still there to assemble.
 */
function hideClosedCard(board, thread) {
	// The put-away a finished answer queued belongs to a moment that has passed, and the close this card is
	// going through may be undone from the rail: a card the human brings back must not vanish when the first
	// clock runs out. It is a no-op when the timer itself is the caller.
	cancelAutoClose(thread);
	thread.hidden = true;
	thread.closedAt = Date.now();
	broadcast(board, { type: "remove", id: thread.id });
	refreshOwned(board, thread);
	trimPutAway(board);
	nudgeClosed(board);
	scheduleSave(board);
	nudgeWelcome();
}



/**
 * Hold the rail's put-away children to the same ceiling a restart applies. The cap on put-away children is
 * enforced at load, and a daemon that ran all day would file them without one until the next start — at
 * which point the rows the human saw last were the ones that went. So the oldest goes here, when the
 * newest arrives, and a session and a restart agree on what is still offerable.
 *
 * Both places count the one shape `putAwayByBoard` describes — a child the board put away — so a thread the
 * human started or closed by hand is never read as room, however many rows the rail draws with it. Only a
 * child the board put away is retired: a thread that still owns a card is drawn through it, and one that is
 * not idle is still working, so each of those is passed over rather than read as room.
 */
function trimPutAway(board) {
	const away = [...board.threads.values()].filter(putAwayByBoard);
	if (away.length <= MAX_PUT_AWAY_CHILDREN) return;
	away.sort((a, b) => a.closedAt - b.closedAt);
	for (const old of away.slice(0, away.length - MAX_PUT_AWAY_CHILDREN)) {
		if (!old.parentThread || old.status !== "idle" || ownedCards(board, old.id).length) continue;
		// The record goes and nothing is killed: a child that had finished exits when its stdin closes, which is
		// the end a restart gives it by not finding it at all.
		try {
			board.children.get(old.id)?.stdin?.end();
		} catch {
			// Already gone, which is what this wanted.
		}
		board.children.delete(old.id);
		board.threads.delete(old.id);
	}
}



/**
 * The put-away a child is waiting for, kept off the thread itself: `/state` serialises whole threads, and
 * a Node timer is a circular object that would make that request throw.
 */
const closeTimers = new WeakMap();



/**
 * Why this child's card may not be put away on its own, or "" when it may.
 *
 * The rule is "the answer arrived and nobody is using it". A thread the human started is theirs to keep;
 * a pinned card is one they keep in sight; a child that is not idle is being spoken to or working again;
 * a run the board cut short is not an answer; and one whose card is already gone, or whose parent has
 * closed, has nothing left to tidy. It is asked twice — when the close is queued and again when the timer
 * fires — so a message, a stop, a kill or a close in between needs no bookkeeping of its own.
 */
export function autoCloseRefusal(board, thread) {
	if (!thread) return "no such thread";
	if (!thread.parentThread) return "a thread the human started is not put away on its own";
	if (board.threads.get(thread.id) !== thread) return "this card is already closed";
	if (thread.hidden) return "this card is already closed";
	if (thread.pinned === true) return "that card is pinned";
	if (thread.status !== "idle") return "the child is not finished";
	if (thread.answering) return "the child is answering";
	if (thread.queued?.length) return "the child has work waiting";
	// A run the board timed out is not an answer, however much of the last turn arrived before the abort: a
	// timeout that lands after the last `turn_end` leaves it reading `answered`, and the parent is told the
	// run timed out, so the card has to stay where that is read.
	if (thread.timedOut) return "that run timed out";
	const parent = board.threads.get(thread.parentThread);
	if (!parent || parent.hidden) return "the thread that spawned it is closed";
	return "";
}



/** A queued put-away belongs to a moment that has passed, and is worth nothing. */
export function cancelAutoClose(thread) {
	const pending = closeTimers.get(thread);
	if (pending) clearTimeout(pending);
	closeTimers.delete(thread);
}



/**
 * Queue the put-away of a child whose answer has been read: hidden a short moment later, never deleted.
 *
 * A parent that spawns six children was left with six spent cards, and the prompt that asked it to close
 * them was advice rather than a rule. The board does it here, and only the card goes: `closeThread` would
 * kill the child and `sweepTrees` could retire its worktree, and both are wrong for a child the human has
 * not assembled yet. A spawned child writes no cards of its own, so hiding is all a close can be here.
 */
export function autoCloseChild(board, thread) {
	if (autoCloseRefusal(board, thread)) return;
	cancelAutoClose(thread);
	const pending = setTimeout(() => {
		closeTimers.delete(thread);
		if (autoCloseRefusal(board, thread)) return;
		hideClosedCard(board, thread);
	}, CHILD_CLOSE_DELAY_MS);
	pending.unref?.();
	closeTimers.set(thread, pending);
}



/**
 * The thread a runtime choice applies to. A card id names the thread that answers for the card, so the
 * composer can set the model of a card whose child is not drawn anywhere.
 */
export function threadForRuntime(board, cardId) {
	const id = String(cardId ?? "");
	const thread = board.threads.get(id);
	if (thread) return thread;
	const card = board.cards.get(id);
	const ownerId = card ? (card.ownerThread ?? card.threadRoot) : "";
	return ownerId ? board.threads.get(ownerId) : undefined;
}



/**
 * The card a key names, as seen by the thread asking. Two threads may both hold a card keyed `plan`, so
 * the caller's own card is looked for first: a thread reading a key off its board line means its own.
 */
function cardByKey(board, key, own) {
	const held = [...board.cards.values()];
	if (own) {
		const mine = held.find((card) => card.key === key && (card.ownerThread === own || card.threadRoot === own));
		if (mine) return mine;
	}
	return held.find((card) => card.key === key);
}



/**
 * Why a thread may not close this card, or "" when it may. A thread tidies what it wrote and retires the
 * children it spawned, and nothing else: another thread's cards are that thread's, the human's own card
 * is the human's, and its own card is the one close that would kill the process asking.
 */
function closeRefusal(plain, thread, own) {
	if (thread) {
		// A card the board already put away is in the rail's closed list, and closing it again would take that
		// entry with it: `closeThread` deletes the thread, so the one place the human can bring it back from
		// would be gone. There is nothing left to close.
		if (thread.hidden) return "this card is already closed";
		if (thread.id === own) return "a thread cannot close its own card";
		return thread.parentThread === own ? "" : "a thread closes only a thread it spawned";
	}
	if (!plain) return "";
	return plain.ownerThread === own || plain.threadRoot === own ? "" : "a thread closes only the cards it wrote";
}



export async function onClose(req, res, board, caller = { human: false }) {
	const body = await readJson(req, res);
	if (!body) return;
	const asked = String(body.cardId ?? "");
	const own = caller.human ? "" : String(caller.thread?.id ?? "");
	// A card is named by its id or by the key a [[key]] already resolves to: a thread reads the key off the
	// board line it was given, and should not have to hold the id as well.
	const plain = board.cards.get(asked) ?? cardByKey(board, asked, own);
	const thread = plain ? undefined : board.threads.get(asked);
	// A pin is the human's: a thread closes a card that is spent and leaves the one they keep in sight.
	// The refusal is the route's rather than the tool's, so a pinned card is protected over the wire too.
	if ((plain ?? thread)?.pinned === true && !caller.human) return void fail(res, 409, "that card is pinned");
	// A close is scoped to the caller: a thread that could close anything could close the card it answers
	// on, and `closeThread` would SIGKILL the process making the request before it got its answer.
	if (!caller.human) {
		const refused = closeRefusal(plain, thread, own);
		if (refused) return void fail(res, 409, refused);
	}
	const id = plain ? plain.id : asked;
	if (plain) {
		board.cards.delete(id);
		forgetCard(board, id);
		rememberClosed(board, { kind: "card", card: plain });
		broadcast(board, { type: "remove", id });
		scheduleSave(board);
		answer(res, 200, { closed: id });
		return;
	}
	if (!thread) return void fail(res, 404, "no such card");
	// Closing this card closes the thread card, not the child's life: a child lives while it has a card,
	// so one that still answers notes keeps running where those notes are read. The last card ends it.
	const kept = ownedCards(board, thread.id);
	if (kept.length) {
		hideClosedCard(board, thread);
	} else {
		closeThread(board, thread);
		broadcast(board, { type: "remove", id });
	}
	// Either way the card is off the board and the human may want it back, so both shapes are kept.
	rememberClosed(board, { kind: "thread", thread });
	scheduleSave(board);
	nudgeWelcome();
	answer(res, 200, { closed: id, kept: kept.length });
}



/**
 * Put a closed card back. The thread kept its session, its turns and its worktree while it was hidden,
 * so this draws the same card again rather than starting anything: the conversation resumes where it
 * was left, and the cards it owns stay where they are.
 */
export async function onReopen(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = String(body.cardId ?? "");
	const thread = board.threads.get(id);
	if (!thread) return void fail(res, 404, "no such card");
	if (!thread.hidden) return void fail(res, 409, "this card is already on the board");
	thread.hidden = false;
	delete thread.closedAt;
	// The card comes back where it was, with the turns it had, and every tab hears the new list.
	card(board, thread);
	nudgeClosed(board);
	answer(res, 200, { reopened: id });
}



/**
 * Put back the last card the human closed. This undoes a close and nothing else: the board's other
 * changes are not a history, and a key that sometimes moved a card and sometimes reopened one would be
 * a key nobody could predict.
 */
export async function onUndo(req, res, board) {
	req.resume();
	// An entry that is already back belongs to a second tab that got there first, so it is passed over
	// rather than reported as the undo.
	while (Array.isArray(board.trash) && board.trash.length) {
		const entry = board.trash.pop();
		if (entry.kind === "card") {
			if (board.cards.has(entry.card.id)) continue;
			// The card keeps its id, its key and its rect, so whatever pointed at it and wherever it sat
			// are both still true. `restored` says it is not an arrival: the tab draws it without the
			// new-card badge and pill, because the human is looking at a card they already had.
			board.cards.set(entry.card.id, entry.card);
			broadcast(board, { type: "card", card: plainCardFor(entry.card, board), restored: true });
			scheduleSave(board);
			return void answer(res, 200, { restored: entry.card.id });
		}
		const thread = entry.thread;
		// The sweep that ran on close may have retired this thread's tree, so the record it kept points at a
		// folder that is gone. The restored thread carries that record no longer, so its next run cuts a
		// fresh tree rather than falling back to the board's folder, which is the human's own checkout.
		if (thread.worktree?.path && !existsSync(thread.worktree.path)) delete thread.worktree;
		// A hidden thread was never off the board, so it comes back where it was; one whose child was
		// killed was deleted, and the session file it kept means the next message resumes the work.
		if (thread.hidden) {
			thread.hidden = false;
			delete thread.closedAt;
		}
		if (!board.threads.has(thread.id)) board.threads.set(thread.id, thread);
		card(board, thread, { restored: true });
		nudgeClosed(board);
		return void answer(res, 200, { restored: thread.id });
	}
	fail(res, 409, "nothing to undo");
}



export async function onStop(req, res, board) {
	// A card stops its own thread; no card stops everything, which is what the header button means.
	const body = (await readJson(req, res)) ?? {};
	const asked = body?.cardId ? threadForRuntime(board, field(body.cardId, 100)) : undefined;
	const running = asked
		? asked.status === "running"
			? [asked]
			: []
		: [...board.threads.values()].filter((thread) => thread.status === "running");
	if (!running.length) return void fail(res, 409, asked ? "this thread has no run in progress" : "no run in progress");
	for (const thread of running) {
		// A child still starting has no run to abort, so the request is kept for its first turn.
		thread.abortWanted = true;
		try {
			// Abort lets the child settle and report; the kill is only for a child that will not.
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`);
		} catch {
			// A child already gone has nothing to abort.
		}
	}
	answer(res, 200, { stopped: running.map((thread) => thread.id) });
}



/** Kill one thread's child. The thread stays, so its cards stay answerable. */
export async function onKill(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = threadForRuntime(board, field(body.cardId, 100));
	if (!thread) return void fail(res, 404, "no thread answers this card");
	if (!killChild(board, thread)) return void fail(res, 409, "this thread has no child running");
	answer(res, 200, { killed: thread.id });
}



/**
 * The thread a trash action is about. A card id and a thread id are the same thing to the board — the card
 * a thread draws carries its id — so both are taken, and both refusals say which one failed to answer.
 */
function trashTarget(board, asked) {
	const thread = asked ? threadForRuntime(board, asked) : undefined;
	if (thread) return { thread };
	return { refusal: asked && (board.cards.has(asked) || board.threads.has(asked)) ? "no thread answers this card" : "no such card" };
}



/** What removing this card's thread would take: the branch, the folder and the work still in it. */
export async function onRemovePreview(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const { thread, refusal } = trashTarget(board, field(body.card, 100));
	if (refusal) return void fail(res, 404, refusal);
	answer(res, 200, removePreview(board, thread));
}



/**
 * Take a thread away whole. `force` is what `/remove` asks for: the child, the card and its thread, the
 * transcript, the folder and the branch, in that order. Nothing is kept and nothing is put where `ctrl+z`
 * looks, which is why the client shows the diff of `/remove/preview` before it asks for that. A step that
 * fails is reported and the next one still runs, so one locked file does not leave the other four behind;
 * the branch goes only once its folder is gone, because a branch deleted under a folder that would not go
 * takes the name of the work with it.
 *
 * `retire` is the mode the Closed panel's clean and the collect a thread asks for use: `retireWorktree` is
 * asked about the tree before anything is killed or dropped, and an answer of `kept` leaves the thread, its
 * cards, its trash entries and its transcript exactly as they were. Only a tree whose work is provably
 * somewhere else goes, and once it has, nothing here touches git again.
 */
export function removeThreadWhole(board, thread, mode = "force", options = {}) {
	// The branch and the folder are read before anything is killed or deleted: the folder is where both are.
	const tree = treeOf(board, thread);
	const repo = tree ? treeRepo(board, tree) : repoOf(board.folder);
	const branch = (tree ? treeBranch(repo, tree) : "") || tree?.branch || "";
	const path = tree?.path ?? "";
	const retired = mode === "retire" ? retireWorktree(board, tree, options) : null;
	if (retired?.kept) return { kept: retired.kept, path, branch: retired.branch || branch };
	const steps = [];
	cancelAutoClose(thread);
	const stopped = killChild(board, thread);
	try {
		board.children.get(thread.id)?.stdin?.end();
	} catch {
		// The child is already gone, which is what this wanted.
	}
	board.children.delete(thread.id);
	steps.push({ what: "child", ok: true, note: stopped ? "the child was stopped" : "no child was running" });
	// The cards it answered for go with it, and the rail's rows too: a row left behind reads as a thread the
	// human can open, and there is nothing there to open.
	const owned = ownedCards(board, thread.id);
	for (const gone of owned) {
		board.cards.delete(gone.id);
		forgetCard(board, gone.id);
	}
	board.threads.delete(thread.id);
	// An entry the trash already holds would put the thread back on `ctrl+z`, and this removal is final.
	board.trash = (Array.isArray(board.trash) ? board.trash : []).filter(
		(entry) => entry.thread?.id !== thread.id && entry.card?.ownerThread !== thread.id,
	);
	const dropped = board.activity.filter((row) => row.thread?.id !== thread.id);
	for (const row of board.activity) if (row.thread?.id === thread.id) liveThoughts.delete(row.id);
	board.activity = dropped;
	steps.push({ what: "card", ok: true, note: owned.length ? `the thread was dropped with ${owned.length} card(s)` : "the thread was dropped" });
	const file = thread.sessionId ? sessionFile({ id: board.id }, thread.sessionId) : "";
	steps.push(file ? unlinkStep(file) : { what: "session", ok: true, note: thread.sessionId ? "the transcript was already gone" : "this thread never had a transcript" });
	let retiredNote = null;
	if (mode === "retire") {
		// The proof above took the folder and the branch, so the only thing left here is to report them.
		retiredNote = retired ? (retired.note ?? retired.proof ?? "the folder was retired") : "there was no folder to retire";
		steps.push({ what: "tree", ok: true, note: retiredNote });
		if (retired?.branchKept) steps.push({ what: "branch", ok: false, note: retired.branchKept });
	} else {
		const folder = discardTree(board, tree);
		steps.push({ what: "tree", ...folder });
		// The branch goes only once the folder is really gone: deleted under a folder git would not remove, its
		// name is the one thing that still points at the work.
		if (folder.ok) steps.push({ what: "branch", ...discardBranch(repo, branch) });
	}
	// The strip draws the trees, so a removal is a redraw rather than one card leaving: `resync` reads git again.
	resync(board);
	nudgeWelcome();
	scheduleSave(board);
	return { thread: { id: thread.id, title: thread.title }, branch: branch || null, path: path || null, steps, note: stepsNote(steps) ?? retiredNote };
}



/**
 * `/remove`, which is the human's: a thread that answers a card is not asked to take a folder with it.
 */
export async function onRemove(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const { thread, refusal } = trashTarget(board, field(body.card, 100));
	if (refusal) return void fail(res, 404, refusal);
	answer(res, 200, removeThreadWhole(board, thread, "force"));
}



/** The closed threads this board lists, newest first, as `closedCards` orders them. */
function closedThreads(board) {
	const listed = new Set(closedCards(board).map((card) => card.id));
	return [...board.threads.values()].filter((thread) => listed.has(thread.id));
}



/**
 * Retire the closed threads `pick` names, one at a time, and report what went and what stayed. A thread whose
 * child still holds it is kept: the tree is where that child is writing, and a sweep never runs beside one.
 */
function retireClosed(board, pick, options) {
	const removed = [];
	const kept = [];
	for (const thread of closedThreads(board)) {
		if (!pick(thread)) continue;
		const tree = treeOf(board, thread);
		const repo = tree ? treeRepo(board, tree) : repoOf(board.folder);
		const branch = (tree ? treeBranch(repo, tree) : "") || tree?.branch || "";
		const path = tree?.path ?? "";
		if (board.children.has(thread.id)) {
			kept.push({ id: thread.id, title: thread.title, path, branch, reason: "its child is still running" });
			continue;
		}
		const gone = removeThreadWhole(board, thread, "retire", options);
		if (gone.kept) kept.push({ id: thread.id, title: thread.title, path: gone.path, branch: gone.branch, reason: gone.kept });
		// A thread with no tree record has nothing to prove, so it is simply dropped.
		else removed.push({ id: thread.id, title: thread.title, path: gone.path, branch: gone.branch, note: gone.note });
	}
	return { removed, kept };
}



/**
 * Clean the Closed panel: every card the human put away goes, worktree and branch with it, and only a tree
 * whose work is provably somewhere else is retired. It is the same guarantee `/clean` gives without asking
 * about one list; a tree that is kept keeps its thread on the board, because the work in it is the thing the
 * human would reopen to read. The human's own, so it is not in `THREAD_ROUTES`.
 */
export async function onCleanClosed(req, res, board) {
	req.resume();
	const result = retireClosed(board, () => true, {});
	// The panel and the rail both draw from the snapshot, so the redraw is the answer to a clean, not a patch.
	resync(board);
	scheduleSave(board);
	answer(res, 200, result);
}



/**
 * The agent side of the same action: a thread retires the closed children it spawned, with the proof
 * `retireWorktree` asks for, and reads back what went and what stayed. The caller's own branch is offered as
 * a second place its children's work may have landed, which is what lets a parent that cherry-picked a
 * child's commit into its own branch retire that child instead of reading it as unmerged for ever.
 */
export async function onThreadCollect(req, res, board, caller = { human: false }) {
	req.resume();
	const own = caller.human ? "" : String(caller.thread?.id ?? "");
	const mine = caller.thread ?? null;
	// A collect is scoped to the caller the way a close is: a thread retires the children it spawned and
	// nothing else, and its own card is not one of them. A thread whose own card is in the closed list is
	// refused outright, because the thread that would come back is the one making the request.
	if (!caller.human && own && closedThreads(board).some((thread) => thread.id === own)) {
		return void fail(res, 409, "a thread cannot clean its own card");
	}
	const tree = mine ? treeOf(board, mine) : undefined;
	const branch = tree ? treeBranch(treeRepo(board, tree), tree) || tree.branch || "" : "";
	const result = retireClosed(board, (thread) => thread.parentThread === own && thread.id !== own, { alsoUp: branch ? [branch] : [] });
	resync(board);
	scheduleSave(board);
	answer(res, 200, result);
}



/** The transcript gone, or the reason it is still there. */
function unlinkStep(file) {
	try {
		unlinkSync(file);
		return { what: "session", ok: true, note: "the transcript was deleted" };
	} catch (error) {
		return { what: "session", ok: false, note: `the transcript could not be deleted: ${error.message}` };
	}
}



/** What earlier trash actions left behind: worktrees, folders and branches no thread answers for. */
export async function onFragments(req, res, board) {
	req.resume();
	answer(res, 200, { items: fragmentsOf(board) });
}



/** Clear one of those leftovers, and report the steps the same way a thread removal does. */
export async function onFragmentRemove(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const asked = { kind: String(body.kind ?? ""), path: body.path ? String(body.path) : "", branch: body.branch ? String(body.branch) : "" };
	const result = removeFragment(board, asked);
	if (!result) return void fail(res, 404, "no such fragment");
	// The record of a tree that just went has to leave the board's file with it.
	scheduleSave(board);
	resync(board);
	nudgeWelcome();
	answer(res, 200, result);
}



/** Forget dead threads and their logs. Safe: nothing that can answer is touched. */
export async function onClean(req, res, board) {
	req.resume();
	const result = cleanBoard(board);
	resync(board);
	nudgeWelcome();
	answer(res, 200, result);
}



/** Start over in this workspace, keeping the board's settings. */
export async function onNew(req, res, board) {
	req.resume();
	clearBoard(board);
	resync(board);
	nudgeWelcome();
	answer(res, 200, { cleared: true });
}
