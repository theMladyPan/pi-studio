// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The boards themselves: one per workspace, held in memory, written down on a debounce, and read back
 * across three generations of on-disk shape that must keep loading.
 */
import { join } from "node:path";
import { STATE_VERSION, boardFile, readJsonFile, writeJsonFile } from "./paths.ts";
import { card, diskRow } from "./bus.ts";
import { ownedCards } from "./routes/board/message.ts";
import { activeConfig, homeDefaults, workspaceById } from "./workspaces.ts";
import { answer, fail } from "./http.ts";
import { MODEL, PROVIDER, THINKING_LEVELS } from "./models.ts";
import { ROLE_NAMES } from "./child/roles.ts";



/** @type {Map<string, Board>} boards that this daemon has loaded, one per workspace. */
export const boards = new Map();




/** Everything a `Turn` needs and nothing that dies with the process. */
export function savedTurn(turn) {
	return {
		text: turn.text,
		// A turn in flight when the daemon stopped is nobody's work now.
		status: turn.status === "answered" ? "answered" : "stopped",
		mode: turn.mode,
		at: turn.at,
		...(turn.reply ? { reply: turn.reply } : {}),
		// What the run said on the way is kept with the answer: a card that reopens without it reads as
		// a run that answered out of nowhere.
		...(turn.interim?.length ? { interim: turn.interim } : {}),
		...(turn.error ? { error: turn.error } : {}),
	};
}



/** A saved card position, or undefined when the file holds something that is not one. */
export function cleanRect(rect) {
	return rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.w > 0 && rect.h > 0
		? { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
		: undefined;
}



/** Write one board: its threads, their turns, their layout and their session ids, and its notes. */
export function saveBoard(board) {
	const payload = {
		version: STATE_VERSION,
		workspace: { id: board.id, folder: board.folder, name: board.name },
		savedAt: Date.now(),
		activity: board.activity.slice(-MAX_ACTIVITY).map(diskRow),
		config: activeConfig(board),
		trees: board.trees,
		threads: [...board.threads.values()].map((thread) => ({
			id: thread.id,
			title: thread.title,
			sessionId: thread.sessionId,
			provider: thread.provider,
			model: thread.model,
			...(thread.thinking ? { thinking: thread.thinking } : {}),
			...(thread.stats ? { stats: thread.stats } : {}),
			at: thread.at,
			turns: thread.turns.map(savedTurn),
			...(thread.rect ? { rect: thread.rect } : {}),
			...(thread.namedBy ? { namedBy: thread.namedBy } : {}),
			...(thread.mini ? { mini: true } : {}),
			...(thread.threadRoot ? { threadRoot: thread.threadRoot } : {}),
			...(thread.parentThread ? { parentThread: thread.parentThread } : {}),
			...(Number.isFinite(thread.depth) ? { depth: thread.depth } : {}),
			...(thread.after?.length ? { after: thread.after } : {}),
			...(thread.role ? { role: thread.role } : {}),
			...(thread.hidden ? { hidden: true } : {}),
			...(thread.closedAt ? { closedAt: thread.closedAt } : {}),
			...(thread.type ? { type: thread.type } : {}),
			...(thread.worktree ? { worktree: thread.worktree } : {}),
		})),
		cards: [...board.cards.values()].map((card) => ({
			id: card.id,
			type: card.type,
			title: card.title,
			at: card.at,
			...(typeof card.markdown === "string" ? { markdown: card.markdown } : {}),
			...(typeof card.path === "string" ? { path: card.path } : {}),
			...(typeof card.content === "string" ? { content: card.content } : {}),
			...(Number.isFinite(card.line) ? { line: card.line } : {}),
			...(typeof card.question === "string" ? { question: card.question } : {}),
			...(Array.isArray(card.options) ? { options: card.options } : {}),
			...(card.type === "question" ? { allowFreeText: card.allowFreeText !== false } : {}),
			...(typeof card.status === "string" ? { status: card.status } : {}),
			...(typeof card.answer === "string" ? { answer: card.answer } : {}),
			...(Number.isFinite(card.expiresAt) ? { expiresAt: card.expiresAt } : {}),
			...(card.updatedAt ? { updatedAt: card.updatedAt } : {}),
			...(card.key ? { key: card.key } : {}),
			...(card.threadRoot ? { threadRoot: card.threadRoot } : {}),
			...(card.ownerThread ? { ownerThread: card.ownerThread } : {}),
			...(card.turns?.length ? { turns: card.turns.map(savedTurn) } : {}),
			...(card.rect ? { rect: card.rect } : {}),
			...(card.mini ? { mini: true } : {}),
		})),
	};
	writeJsonFile(boardFile(board), payload);
}



/** A burst of turns and moves costs one write per board. */
export function scheduleSave(board) {
	if (board.saveTimer) return;
	board.saveTimer = setTimeout(() => {
		board.saveTimer = null;
		saveBoard(board);
	}, 500);
	board.saveTimer.unref();
}



export function flushBoard(board) {
	if (board.saveTimer) clearTimeout(board.saveTimer);
	board.saveTimer = null;
	saveBoard(board);
}



/** Rebuild a thread from its file, never as something that is still running. */
export function restoredTurns(raw) {
	return (Array.isArray(raw) ? raw : [])
		.filter((turn) => turn && typeof turn.text === "string")
		.map((turn) => ({
			text: String(turn.text),
			status: turn.status === "answered" ? "answered" : "stopped",
			mode: turn.mode === "steer" ? "steer" : "queue",
			at: Number.isFinite(turn.at) ? turn.at : Date.now(),
			...(typeof turn.reply === "string" ? { reply: turn.reply } : {}),
			...(Array.isArray(turn.interim) && turn.interim.length ? { interim: turn.interim.map(String) } : {}),
			...(typeof turn.error === "string" && turn.error ? { error: turn.error } : {}),
		}));
}



export function restoredThread(raw, folder) {
	if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
	const turns = restoredTurns(raw.turns);
	const rect = cleanRect(raw.rect);
	/** The thread as its file describes it, before the one repair a legacy file needs. */
	const thread = {
		id: raw.id,
		title: typeof raw.title === "string" && raw.title ? raw.title : "thread",
		sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
		status: "idle",
		provider: typeof raw.provider === "string" ? raw.provider : PROVIDER,
		model: typeof raw.model === "string" ? raw.model : MODEL,
		...(THINKING_LEVELS.includes(raw.thinking) ? { thinking: raw.thinking } : {}),
		...(raw.stats && typeof raw.stats === "object" ? { stats: raw.stats } : {}),
		at: Number.isFinite(raw.at) ? raw.at : Date.now(),
		turns,
		queued: [],
		...(rect ? { rect } : {}),
		...(typeof raw.namedBy === "string" && raw.namedBy ? { namedBy: raw.namedBy } : {}),
		...(raw.mini ? { mini: true } : {}),
		...(typeof raw.threadRoot === "string" && raw.threadRoot ? { threadRoot: raw.threadRoot } : {}),
		...(typeof raw.parentThread === "string" && raw.parentThread ? { parentThread: raw.parentThread } : {}),
		...(Number.isFinite(raw.depth) ? { depth: raw.depth } : {}),
		...(Array.isArray(raw.after) ? { after: raw.after.filter((id) => typeof id === "string") } : {}),
		...(ROLE_NAMES.includes(raw.role) ? { role: raw.role } : {}),
		...(typeof raw.type === "string" && raw.type ? { type: raw.type } : {}),
		// The tree is not made again after a restart: it is on disk, and its branch is where the work is.
		...(raw.worktree && typeof raw.worktree === "object" && typeof raw.worktree.path === "string"
			? { worktree: raw.worktree }
			: {}),
		// Boards saved before this was a plain flag said `behind: <cardId>`; the id is not needed now that
		// ownership decides which cards a thread answers for.
		...(raw.hidden === true || (typeof raw.behind === "string" && raw.behind) ? { hidden: true } : {}),
		// When the human put its card away, so the rail can offer it back. A thread that is only hidden
		// because a card is where it is read was never closed by anyone.
		...(Number.isFinite(raw.closedAt) ? { closedAt: raw.closedAt } : {}),
		folder,
	};
	// A board written before a closed card carried a mark said only `hidden`, which a child that answers
	// for a card also says. A hidden thread with no card behind it was put away by the human, so it is
	// offered back like one rather than staying lost in a file nobody can reach.
	if (thread.hidden && !thread.threadRoot && !thread.closedAt) thread.closedAt = thread.at;
	return thread;
}



/** Rebuild a plain card from its file. One without the body its type needs is nothing, so it goes. */
export function restoredPlainCard(raw) {
	if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
	// Files written before source cards existed carried notes under their own key and no type.
	const type = raw.type === "source" || raw.type === "question" ? raw.type : "note";
	if (type === "note" && typeof raw.markdown !== "string") return null;
	if (type === "source" && (typeof raw.path !== "string" || typeof raw.content !== "string")) return null;
	if (type === "question" && typeof raw.question !== "string") return null;
	const rect = cleanRect(raw.rect);
	const card = {
		id: raw.id,
		type,
		title: typeof raw.title === "string" && raw.title ? raw.title : type,
		at: Number.isFinite(raw.at) ? raw.at : Date.now(),
		...(type === "note"
			? { markdown: raw.markdown }
			: type === "source"
				? { path: raw.path, content: raw.content }
				: { question: raw.question, options: Array.isArray(raw.options) ? raw.options.filter((one) => typeof one === "string") : [] }),
		// A question is answered by an agent that was waiting for it, and that agent is gone: whatever
		// the file says, a restored question is settled.
		...(type === "question"
			? {
					status: "expired",
					allowFreeText: raw.allowFreeText !== false,
					...(raw.multiple === true ? { multiple: true } : {}),
					...(Array.isArray(raw.answers) ? { answers: raw.answers.filter((one) => typeof one === "string") } : {}),
				}
			: {}),
		...(typeof raw.answer === "string" ? { answer: raw.answer } : {}),
		...(Number.isFinite(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
		...(Number.isFinite(raw.line) ? { line: raw.line } : {}),
		...(typeof raw.key === "string" && raw.key ? { key: raw.key } : {}),
		...(typeof raw.threadRoot === "string" && raw.threadRoot ? { threadRoot: raw.threadRoot } : {}),
		...(typeof raw.ownerThread === "string" && raw.ownerThread ? { ownerThread: raw.ownerThread } : {}),
		...(() => {
			const turns = restoredTurns(raw.turns);
			return turns.length ? { turns } : {};
		})(),
		...(rect ? { rect } : {}),
		...(raw.mini ? { mini: true } : {}),
	};
	return card;
}



/** Load a workspace's board into memory, or hand back the one already there. */
export function boardFor(workspace) {
	const existing = boards.get(workspace.id);
	if (existing) {
		// A workspace that has simply been opened again keeps its place in the recent list.
		existing.folder = workspace.folder;
		existing.name = workspace.name;
		return existing;
	}
	/** @type {Board} */
	const board = {
		id: workspace.id,
		folder: workspace.folder,
		name: workspace.name,
		threads: new Map(),
		cards: new Map(),
		askers: new Map(),
		activity: [],
		children: new Map(),
		clients: new Set(),
		trees: [],
		// What `ctrl+z` puts back: the last cards a close took off the board. It lives while the daemon
		// does, because a card restored after a restart would come back to a board that never missed it.
		trash: [],
		saveTimer: null,
	};
	const saved = readJsonFile(boardFile(workspace), null);
	// A board is born with the crossroads' defaults; its own file takes over from there. Boards saved
	// before this was called `config` kept the same three fields under `defaults`.
	const born = saved?.config && typeof saved.config === "object" ? saved.config : saved?.defaults;
	board.config = { ...homeDefaults, ...(born && typeof born === "object" ? born : {}) };
	if (Array.isArray(saved?.trees)) {
		board.trees = saved.trees.filter(
			(tree) =>
				tree &&
				typeof tree.path === "string" &&
				// A tree still on its detached base was never given a branch, and is a tree all the same.
				(tree.branch === undefined || typeof tree.branch === "string") &&
				typeof tree.base === "string" &&
				tree.base.length > 0,
		);
	}
	if (saved && saved.version === STATE_VERSION && Array.isArray(saved.threads)) {
		for (const raw of saved.threads.slice(-MAX_THREADS)) {
			const thread = restoredThread(raw, workspace.folder);
			if (thread && !board.threads.has(thread.id)) board.threads.set(thread.id, thread);
		}
		// A board written before source cards existed kept its notes under `notes`.
		const plain = Array.isArray(saved.cards) ? saved.cards : Array.isArray(saved.notes) ? saved.notes : [];
		for (const raw of plain.slice(-MAX_PLAIN_CARDS)) {
			const card = restoredPlainCard(raw);
			if (card && !board.cards.has(card.id)) board.cards.set(card.id, card);
		}
		for (const row of (Array.isArray(saved.activity) ? saved.activity : []).slice(-MAX_ACTIVITY)) {
			if (row && typeof row.id === "string" && row.status !== "running") board.activity.push(row);
		}
		// A card and the child that answers for it belong together, and pruning can part them. Repair it
		// here rather than let a card quietly re-fork because a thread id in it means nothing.
		for (const thread of [...board.threads.values()]) {
			if (thread.hidden && !ownedCards(board, thread.id).length) board.threads.delete(thread.id);
		}
		// The tree is the board's record, so a thread points at that object rather than a copy of it.
		for (const thread of board.threads.values()) {
			const held = thread.worktree?.path ? board.trees.find((tree) => tree.path === thread.worktree.path) : null;
			if (held) thread.worktree = held;
		}
		for (const card of board.cards.values()) {
			if (card.ownerThread && !board.threads.has(card.ownerThread)) delete card.ownerThread;
		}
	}
	boards.set(board.id, board);
	return board;
}



/** The board a request is about, from `?workspace=`; answers 409 itself when there is none. */
export function boardFrom(url, res) {
	const id = url.searchParams.get("workspace") ?? "";
	const workspace = workspaceById(id);
	if (!workspace) {
		fail(res, 409, "no such workspace");
		return null;
	}
	return boardFor(workspace);
}


export const MAX_ACTIVITY = 300;


export const MAX_THREADS = 200;


export const MAX_PLAIN_CARDS = 200;
