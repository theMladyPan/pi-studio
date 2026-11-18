/**
 * The shapes that cross a boundary as plain JSON: what the daemon writes to disk and what it puts on
 * the wire. They are the contract the client and the on-disk format both depend on, so they live here
 * rather than beside whichever module happens to build them first.
 */

/** `daemon.json`: what the last run left behind, read back so a restarted daemon keeps its token. */
export type DaemonRecord = {
	token: string;
	port: number;
	at: string;
};

/**
 * A thread as the browser draws it. A thread's card is built from what the thread has, so most fields are
 * there only when the thread carries one: a card that says `modeAtRun` is a card whose run in flight follows
 * a mode other than the one chosen on it, which is how the head says a choice is waiting.
 */
export type ThreadCard = {
	id: string;
	type: string;
	title: string;
	at: number;
	/** Empty on purpose: a thread's words live in its turns, so the card invents no message. */
	text: string;
	status: string;
	mode: string;
	/** The mode the run in flight follows, set only when it differs from the mode the card shows. */
	modeAtRun?: string;
	turns: unknown[];
	rect?: { x: number; y: number; w: number; h: number };
	mini?: boolean;
	threadRoot?: string;
	after?: string[];
	parentThread?: string;
	parentTitle?: string;
	role?: string;
	path?: string;
	pathChosenBy?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	stats?: Record<string, unknown>;
	worktree?: { base?: string; path: string; repo?: string };
};

/** What the Git Graph page is handed before it draws anything, beside the settings it draws itself from. */
export type { GitGraphInitPayload } from "./git/gitgraph/libre.ts";
