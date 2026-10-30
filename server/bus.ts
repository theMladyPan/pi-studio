// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Everything the board pushes at its tabs: the one broadcast, the resync a new tab asks for, and the
 * row helpers every route writes through.
 */
import { send } from "./http.ts";
import { boardMeta, cardFor, cardsFor, plainCardFor } from "./cards.ts";
import { homeCard } from "./routes/board/message.ts";
import { refreshGit } from "./git/graph.ts";
import { describeWorkspace, welcomeClients, workspaces } from "./workspaces.ts";
import { MAX_ACTIVITY, scheduleSave } from "./store.ts";



export function broadcast(board, payload) {
	send(board.clients, payload);
}



/** Rebuild every open tab from the board as it stands, after something large changed at once. */
export function resync(board) {
	// A snapshot is everything a tab draws, and the strip is part of that: a sweep retires worktrees, so
	// the graph is read again here rather than left as the last tick found it. Without it the strip
	// vanished on `clean` and `new`, because a snapshot without `git` reads as "no repository".
	// The closed cards go in for the other half of the reason: a link to a card this pass closed is
	// stale, and a tab that hears no `closed` would offer to jump to a card that is gone.
	broadcast(board, {
		type: "snapshot",
		cards: cardsFor(board),
		closed: closedCards(board),
		activity: board.activity,
		meta: boardMeta(board),
		git: refreshGit(board, true),
	});
}



/** The activity rows of a thread that is still here and still alive. */
export function liveThreadIds(board) {
	const ids = new Set();
	for (const thread of board.threads.values()) if (thread.status !== "dead") ids.add(thread.id);
	return ids;
}



/** The crossroads shows counts, so it hears about every change that alters one. */
export function nudgeWelcome() {
	if (!welcomeClients.size) return;
	send(welcomeClients, { type: "workspaces", workspaces: workspaces.map(describeWorkspace) });
}



export const card = (board, thread, extra = {}) => {
	broadcast(board, { type: "card", card: cardFor(thread, board), ...extra });
	scheduleSave(board);
	nudgeWelcome();
};


export const update = (board, thread) => {
	// A thread that answers for a card is not drawn: what changes is that card, and broadcasting the
	// thread would put a second card on the board for the same conversation.
	if (!thread.hidden) {
		broadcast(board, { type: "update", card: cardFor(thread, board) });
		return;
	}
	// A hidden thread is read through a card it answers for, so that card carries its state instead.
	const shown = homeCard(board, thread);
	if (shown) broadcast(board, { type: "update", card: plainCardFor(shown, board) });
	scheduleSave(board);
	nudgeWelcome();
};


/** A card without a child changes the same way, and is broadcast in its own shape. */
export const updateCard = (board, held) => {
	broadcast(board, { type: "update", card: plainCardFor(held, board) });
	scheduleSave(board);
	nudgeWelcome();
};



/** A row says which thread wrote it, so the rail can group a thread's work into one section. */
export const threadRef = (thread) => ({ id: thread.id, title: thread.title });



export function addRow(board, row) {
	board.activity.push(row);
	if (board.activity.length > MAX_ACTIVITY) board.activity.splice(0, board.activity.length - MAX_ACTIVITY);
	broadcast(board, { type: "activity", row });
}



export function patchRow(board, id, patch) {
	const row = board.activity.find((candidate) => candidate.id === id);
	if (!row) return;
	// A row learns what was cut in two steps, so a later patch adds to that list rather than replacing it.
	if (Array.isArray(patch.cut)) patch.cut = [...new Set([...(row.cut || []), ...patch.cut])];
	Object.assign(row, patch);
	broadcast(board, { type: "activity", row });
}



/**
 * A row as the board file keeps it. A picture a screenshot returned is worth the memory it takes while
 * the daemon runs, and not worth writing a megabyte of base64 into the state file every time, so the
 * file remembers only that there was one.
 */
export function diskRow(row) {
	if (!Array.isArray(row.images) || !row.images.length) return row;
	return { ...row, images: row.images.map(({ mime }) => ({ mime, dropped: true })) };
}



/**
 * The cards the human closed while they still held a conversation. They are not drawn, but the board
 * keeps them, so the rail can offer them back: a click that closed the wrong card costs one more click
 * rather than a session. A thread that is hidden because a card is where it is read was never closed
 * by anyone, so it is not here.
 */
export function closedCards(board) {
	return [...board.threads.values()]
		.filter((thread) => thread.hidden && thread.closedAt)
		.sort((a, b) => b.closedAt - a.closedAt)
		.map((thread) => ({
			id: thread.id,
			title: thread.title,
			closedAt: thread.closedAt,
			turns: thread.turns.length,
		}));
}
