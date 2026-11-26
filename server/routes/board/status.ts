// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The work phase a thread reports, and the board status that lets threads cooperate.
 *
 * A fuzzy semaphore, not a lock: a thread says reading, writing, merging or system, and anyone starting a
 * merge, a rebase or another operation that touches every worktree pulls the board's status first. It is
 * advisory — nothing blocks on it — so it only works when reports are timely and pullers check before the
 * irreversible act. Children have no board tools by design, so a running child reads by its role.
 */
import { answer, fail, readJson } from "../../http.ts";
import { STATUS_NOTE_CHARS } from "../../limits.ts";



/** The phases a thread may report. `idle` is the clearing one: anything else names work in flight. */
export const STATUS_NAMES = ["reading", "writing", "merging", "system", "idle"];


/** How many entries the injected block names at most. Newest claims first, like the card index beside it. */
const MAX_ENTRIES = 20;


/** The longest the injected block may be. It rides one message, so it keeps the card index's economy. */
const MAX_CHARS = 1000;


/** A title runs long enough to recognise the thread, short enough to keep the line moving. */
const TITLE_CHARS = 50;


/**
 * What a child is taken to be doing while it runs, by its role: it has no tools to say so. Most spawns
 * read or write in their own worktree, so the defaults only matter if one of them starts global work.
 */
const DEFAULT_STATUS = { scout: "reading", review: "reading", architect: "reading", implement: "writing", chore: "writing" };


/** A string field from a request body, trimmed and cut short. */
function field(value, limit = 80) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : "";
}


/** One thread on the board as the status pull sees it, or null when it says nothing. */
function entryOf(thread) {
	const said = thread.activity;
	if (thread.status === "running" && said && said.status !== "idle") {
		return {
			threadId: thread.id,
			title: thread.title ?? "",
			status: said.status,
			...(said.note ? { note: said.note } : {}),
			reported: true,
			at: said.at,
		};
	}
	if (thread.status === "running" && thread.parentThread) {
		const status = DEFAULT_STATUS[thread.role];
		if (status) return { threadId: thread.id, title: thread.title ?? "", status, reported: false, at: thread.at ?? Date.now() };
	}
	// A settled thread whose note names what ended it: the failure a teammate needs to see.
	if (thread.status !== "running" && said?.note) {
		return {
			threadId: thread.id,
			title: thread.title ?? "",
			status: said.status ?? "idle",
			note: said.note,
			reported: true,
			at: said.at,
		};
	}
	return null;
}


/** The board's phases, newest claim first. A running thread that reported nothing says nothing. */
export function boardStatuses(board) {
	const entries = [...board.threads.values()].map(entryOf).filter(Boolean);
	entries.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));
	return entries;
}


/** A number of milliseconds as the reader walks it: seconds under a minute, then minutes. */
function ageOf(at) {
	const seconds = Math.max(0, Math.round((Date.now() - Number(at ?? Date.now())) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}


/** One entry as the injected block reads it. */
function lineOf(entry) {
	const title = String(entry.title ?? "").replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS) || "this thread";
	const note = entry.note ? ` — “${String(entry.note).replace(/\s+/g, " ").slice(0, STATUS_NOTE_CHARS)}”` : "";
	const age = entry.reported ? ` · ${ageOf(entry.at)}` : " (default)";
	return `- ${String(entry.threadId).slice(0, 8)} — ${title} (${entry.status})${age}${note}`;
}


/**
 * The block a thread's first message carries about the others, or "" when nobody is mid-phase.
 *
 * A thread's own row is out: it knows what it is about to do. The block is orientation, not a check —
 * it is stale the moment the thread starts — so the freshness has to come from `get_board_status`.
 */
export function boardStatusBlock(board, exceptId = "") {
	const entries = boardStatuses(board).filter((one) => one.threadId !== exceptId).slice(0, MAX_ENTRIES);
	if (!entries.length) return "";
	const block = (list) => `[board threads]\n${list.map(lineOf).join("\n")}`;
	let out = block(entries);
	while (entries.length > 1 && out.length > MAX_CHARS) {
		entries.pop();
		out = block(entries);
	}
	return out.length > MAX_CHARS ? out.slice(0, MAX_CHARS) : out;
}


/**
 * A thread reports the phase of the work in front of it.
 *
 * The status is ephemeral: it lives on the thread object, is cleared when the run settles (see
 * `finished`), and is never saved — a daemon restart leaves every thread idle, so a saved phase would
 * be a lie by the time it was read back.
 */
export async function onStatus(req, res, board, caller = { human: true }) {
	const body = await readJson(req, res);
	if (!body) return;
	if (!caller.thread) return void fail(res, 409, "a thread reports its own status");
	const status = field(body.status, 20);
	if (!STATUS_NAMES.includes(status)) return void fail(res, 409, `unknown status: ${status}`);
	const note = field(body.note, STATUS_NOTE_CHARS);
	const at = Date.now();
	caller.thread.activity = { status, ...(note ? { note } : {}), at };
	answer(res, 200, { threadId: caller.thread.id, status, ...(note ? { note } : {}), at });
}


/** The board's phases as they stand right now: the fresh read, pulled before a cooperative act. */
export async function onBoardStatus(req, res, board) {
	await readJson(req, res);
	answer(res, 200, { threads: boardStatuses(board) });
}
