// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * What the client draws: the wire shape of a card, the board's own meta, and the two sweeps that empty
 * it again.
 */
import { addRow, card, liveThreadIds, threadRef, update, updateCard } from "./bus.ts";
import { answer } from "./http.ts";
import { liveThoughts, settleThoughts } from "./thought.ts";
import { port } from "./main.ts";
import { retireWorktree } from "./worktrees/retire.ts";
import { stopStream } from "./child/run.ts";
import { INSTANCE } from "./paths.ts";
import { MODEL } from "./models.ts";
import { activeConfig } from "./workspaces.ts";
import { scheduleSave } from "./store.ts";
import { randomUUID } from "node:crypto";
import { finished } from "./waiters.ts";



// ---------- the board the client draws -------------------------------------

/** A thread as the card the browser draws: a title, and the conversation under it. */
export function cardFor(thread, board = null) {
	const answered = thread.turns.some((turn) => turn.status === "answered");
	const status =
		thread.status === "dead" ? "stopped" : thread.status === "running" ? "sent" : answered ? "answered" : "queued";
	const card = {
		id: thread.id,
		type: "sticky",
		title: thread.title,
		at: thread.at,
		// The conversation lives in the turns; the card's own `text` stays empty so no message is
		// invented for a thread nobody has typed into yet.
		text: "",
		status,
		mode: "queue",
		images: 0,
		turns: thread.turns.map((turn) => ({ ...turn })),
	};
	if (thread.rect) card.rect = thread.rect;
	if (thread.mini) card.mini = true;
	// The client cascades a card under the one its reply was asked on, and a note can be that one.
	if (thread.threadRoot) card.threadRoot = thread.threadRoot;
	// Where this card sits in the work: the threads and cards a spawning thread named as its
	// predecessors. The board draws one arrow per id, which is the visible reason it is here.
	if (thread.after?.length) card.after = thread.after;
	if (thread.parentThread) card.parentThread = thread.parentThread;
	if (thread.role) card.role = thread.role;
	// What this card answers with, so the composer can show the truth instead of the daemon's hope.
	card.provider = thread.provider;
	card.model = thread.model;
	if (thread.thinking) card.thinking = thread.thinking;
	if (thread.stats) card.stats = thread.stats;
	// Where the thread's work is, so the human can find the tree without reading its prompt.
	if (thread.worktree) card.worktree = thread.worktree;
	return card;
}



/** A plain card as the browser draws it: markdown under a title, or a file, with no run behind it. */
export function plainCardFor(card, board = null) {
	const shown = {
		id: card.id,
		type: card.type,
		title: card.title,
		at: card.at,
		text: "",
		status: "answered",
		mode: "queue",
		images: 0,
		...(card.turns?.length ? { turns: card.turns } : {}),
		...(card.type === "note"
			? { markdown: card.markdown }
			: card.type === "source"
				? { path: card.path, content: card.content, ...(Number.isFinite(card.line) ? { line: card.line } : {}) }
				: {
						question: card.question,
						options: card.options,
						allowFreeText: card.allowFreeText !== false,
						multiple: card.multiple === true,
						status: card.status ?? "expired",
						...(card.answer ? { answer: card.answer } : {}),
						...(card.answers?.length ? { answers: card.answers } : {}),
						...(Number.isFinite(card.expiresAt) ? { expiresAt: card.expiresAt } : {}),
					}),
	};
	if (card.updatedAt) shown.updatedAt = card.updatedAt;
	// The key is what a `[[key]]` in another card or in a reply points at, so the browser needs it to
	// make the cross-reference clickable. Without it the link falls back to a title that never matches.
	if (card.key) shown.key = card.key;
	if (card.rect) shown.rect = card.rect;
	if (card.mini) shown.mini = true;
	if (card.threadRoot) shown.threadRoot = card.threadRoot;
	if (card.ownerThread) shown.ownerThread = card.ownerThread;
	// The card carries the runtime of whoever answers it, so the composer's pickers can name and change
	// it without the thread that serves the card ever being drawn.
	// Boards written before ownership was its own field have only the thread that made the card, and a
	// thread that has ended answers nothing: the next child will, and that is what the pickers show.
	const ownerId = card.ownerThread ?? card.threadRoot;
	const owner = board && ownerId ? board.threads.get(ownerId) : undefined;
	if (owner && owner.status !== "dead") {
		shown.answersWith = {
			provider: owner.provider,
			model: owner.model,
			...(owner.thinking ? { thinking: owner.thinking } : {}),
			// Stop and kill are per thread, and a plain card is where its thread is read.
			running: owner.status === "running",
			thread: owner.id,
			...(owner.stats ? { stats: owner.stats } : {}),
		};
	}
	return shown;
}



/** Every card on a board: the threads, then the cards the human and the agents put there. */
export function cardsFor(board) {
	// A thread that answers for a card is not a card of its own: that card is the surface, and drawing
	// both would show one conversation on two cards.
	return [...board.threads.values()]
		.filter((thread) => !thread.hidden)
		.map((thread) => cardFor(thread, board))
		.concat([...board.cards.values()].map((card) => plainCardFor(card, board)));
}



export function boardMeta(board) {
	const working = [...board.threads.values()].filter((thread) => thread.status === "running");
	return {
		folder: board.name,
		cwd: board.folder,
		port,
		// Empty for the one daemon most machines run; the name of its state folder for a second one,
		// which the tab title carries so two boards are told apart at a glance.
		instance: INSTANCE,
		model: MODEL,
		// The board's configuration: what the next thread starts with, and which features are on.
		config: activeConfig(board),
		// The board's own totals, summed from every thread: what this workspace has spent, which is the
		// number the header shows while a section shows one thread's share.
		...(() => {
			let input = 0;
			let output = 0;
			let cost = 0;
			for (const thread of board.threads.values()) {
				if (!thread.stats) continue;
				input += thread.stats.input ?? 0;
				output += thread.stats.output ?? 0;
				cost += thread.stats.cost ?? 0;
			}
			return { tokensIn: input, tokensOut: output, cost };
		})(),
		// The client draws a board of threads: no bottom composer, a + that starts one, and the field
		// inside the card being answered.
		mode: "threads",
		workspace: { id: board.id, folder: board.folder, name: board.name },
		contextPercent: null,
		running: working.length > 0,
		runStartedAt: working.length ? Math.min(...working.map((thread) => thread.runStartedAt ?? thread.at)) : null,
	};
}



/**
 * Clean: forget what belongs to threads that are gone or dead. A dead thread's card goes too — it
 * cannot answer again, and its logs are the part of the rail nobody reads twice. What such a thread
 * owned stays on the board, owned by nobody, so its next comment starts a fresh child.
 */
export function cleanBoard(board) {
	const alive = liveThreadIds(board);
	const removed = [];
	const trees = [];
	for (const thread of [...board.threads.values()]) {
		if (thread.status !== "dead") continue;
		removed.push(thread.id);
		board.threads.delete(thread.id);
		board.children.get(thread.id)?.kill("SIGKILL");
		board.children.delete(thread.id);
	}
	// A tree whose thread is gone is retired only when it holds nothing unmerged; the rest is reported.
	// The record is the board's, not the thread's, so a closed or cleared thread is swept too.
	for (const tree of [...board.trees]) {
		if (tree.thread && board.threads.has(tree.thread)) continue;
		const retired = retireWorktree(board, tree);
		if (retired) trees.push(retired);
	}
	for (const card of board.cards.values()) {
		if (card.ownerThread && !alive.has(card.ownerThread)) delete card.ownerThread;
	}
	const before = board.activity.length;
	const dropped = [];
	board.activity = board.activity.filter((row) => {
		const id = row.thread?.id;
		if (id && alive.has(id)) return true;
		dropped.push(row.id);
		return false;
	});
	// A thought still streaming belongs to a row that is still here; one whose row is gone is worth nothing.
	for (const id of dropped) liveThoughts.delete(id);
	scheduleSave(board);
	return { removed, rows: before - board.activity.length, trees };
}



/** New: the same workspace and the same settings, with nothing on the board. */
export function clearBoard(board) {
	for (const thread of [...board.threads.values()]) {
		board.children.get(thread.id)?.kill("SIGKILL");
		board.children.delete(thread.id);
		board.threads.delete(thread.id);
	}
	board.cards.clear();
	for (const row of board.activity) liveThoughts.delete(row.id);
	board.activity = [];
	board.askers.clear();
	scheduleSave(board);
}



/** Something the daemon cannot paper over: the card shows it as stopped and the console says why. */
export function threadError(board, thread, message) {
	console.error(`pi-studio: ${board.name}/${thread.title}: ${message}`);
	thread.status = "dead";
	stopStream(thread);
	settleThoughts(board, thread);
	const last = thread.turns[thread.turns.length - 1];
	if (last) {
		// What was being written stays as the child left it, but nothing is writing it now.
		last.streaming = false;
		if (last.status !== "answered") {
			last.status = "stopped";
			// A turn that reads only "stopped" hides the one line the child managed to say.
			last.error = message;
		}
	}
	// A question that was written on a card is stuck in the same way the thread's own turn is.
	const asked = thread.answering ? board.cards.get(thread.answering.cardId) : undefined;
	const cardTurn = asked?.turns?.[thread.answering.turn];
	if (cardTurn) {
		cardTurn.streaming = false;
		if (cardTurn.status !== "answered") {
			cardTurn.status = "stopped";
			cardTurn.error = message;
		}
		// Unconditional: a caret cleared on the daemon and not on the browser blinks for ever.
		updateCard(board, asked);
	}
	thread.answering = null;
	addRow(board, {
		id: randomUUID(),
		kind: "reply",
		status: "error",
		startedAt: Date.now(),
		text: message,
		thread: threadRef(thread),
	});
	update(board, thread);
	board.children.get(thread.id)?.stdin?.end();
	// A dead thread is an ended run too: the caller waiting on it must not wait for a settle that will
	// never come.
	finished(thread);
}
