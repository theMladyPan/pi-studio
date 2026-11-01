// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * What a card is made of: a note, a source, an edited body, a rename, and the folder browser that
 * attaches paths to a message.
 */
import { auditMarkdown } from "../../chart-audit.ts";
import { answer, fail, readJson } from "../../http.ts";
import { BROWSE_LIMIT, CONTROL_CHARS, MAX_NOTE_CHARS, MAX_SOURCE_CHARS, MAX_TITLE_CHARS } from "../../limits.ts";
import { anchorOf, cardByKey, field, placedRect, rootOf } from "./thread.ts";
import { broadcast, card, update, updateCard } from "../../bus.ts";
import { cardFor, plainCardFor } from "../../cards.ts";
import { scheduleSave } from "../../store.ts";
import { makeRoom } from "./lifecycle.ts";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { workdirOf } from "../../worktrees/make.ts";
import { start } from "../../main.ts";
import { homedir } from "node:os";



/** The sizes a card may be drawn in. Anything else in a body is ignored, not refused. */
const CARD_SIZES = ["compact", "normal", "wide", "tall"];

/** How wide a `wide` card is drawn, which is what decides whether its labels are elided. */
const WIDE_CARD = 700;

/** How many cards one card may name as what it builds on: the board draws an arrow from each. */
const MAX_PREDECESSORS = 8;

/**
 * One entry of a card's `after`, as an id. A key resolves the way a `[[key]]` does — against a card's
 * key and against a thread's — so an agent can name `load-shape` instead of an id nobody showed it.
 */
export function predecessorId(board, name) {
	const wanted = typeof name === "string" ? name.trim() : "";
	if (!wanted) return "";
	const plain = board.cards.get(wanted) ?? [...board.cards.values()].find((held) => held.key === wanted);
	if (plain) return plain.id;
	const thread = board.threads.get(wanted) ?? [...board.threads.values()].find((held) => held.key === wanted);
	return thread?.id ?? "";
}

/**
 * What a new card builds on: the ids it named that this board knows, keys and ids both, at most eight.
 * An entry that names nothing is dropped rather than refused: the card is worth drawing even when the
 * arrow it asked for points at something a sweep has since taken away.
 */
export function predecessors(board, list) {
	const ids = [];
	for (const one of Array.isArray(list) ? list : []) {
		const id = predecessorId(board, one);
		if (!id || ids.includes(id)) continue;
		ids.push(id);
		if (ids.length >= MAX_PREDECESSORS) break;
	}
	return ids;
}



/**
 * How the card will read, in one line: the shape of each chart, then what to change about it. Empty
 * when the note holds no chart, so a note the board draws as written says nothing extra on the wire.
 */
function noteReport(markdown, width) {
	const { warnings, summary } = auditMarkdown(markdown, width);
	return [summary, ...warnings].filter(Boolean).join(" · ");
}



export async function onNote(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const markdown = typeof body.markdown === "string" ? body.markdown : "";
	if (!markdown.trim()) return void fail(res, 400, "empty note");
	if (markdown.length > MAX_NOTE_CHARS) return void fail(res, 413, `a note holds at most ${MAX_NOTE_CHARS} characters`);
	const title = field(body.title);
	const key = field(body.key);
	// The form the card is drawn in and what it builds on: a size nobody names is ignored, and an `after`
	// of ids and keys that name nothing on this board is no arrow at all.
	const size = CARD_SIZES.includes(body.size) ? body.size : "";
	const after = predecessors(board, body.after);
	const root = rootOf(board, body);
	// A wide card holds more labels than a narrow one, so the audit is told the width the card is drawn
	// at: telling a model to go wide when it already did is a warning it cannot act on.
	const report = noteReport(markdown, size === "wide" ? WIDE_CARD : undefined);
	// A key makes the card stable: saying the same thing twice revises one note instead of stacking
	// a second copy of it on the board, which is what a running agent stepping through a job does.
	const held = cardByKey(board, key, "note");
	if (held) {
		held.markdown = markdown;
		held.updatedAt = Date.now();
		if (title) held.title = title;
		// A revision that says nothing about the size or the lineage leaves what the card already carries.
		if (size) held.size = size;
		if (after.length) held.after = after;
		// Ownership moves only when a fork takes the card or a new thread starts answering it, so a
		// revision never changes who is responsible for the card it revises.
		if (root && !held.ownerThread) held.ownerThread = root;
		const rect = placedRect(body);
		if (rect) held.rect = rect;
		broadcast(board, { type: "update", card: plainCardFor(held, board) });
		scheduleSave(board);
		answer(res, 200, { cardId: held.id, card: plainCardFor(held, board), updated: true, ...(report ? { report } : {}) });
		return;
	}
	makeRoom(board);
	const note = {
		id: randomUUID(),
		type: "note",
		title: title || "note",
		markdown,
		at: Date.now(),
		...(key ? { key } : {}),
		...(after.length ? { after } : {}),
		...(size ? { size } : {}),
		...(root ? { threadRoot: anchorOf(board, root), ownerThread: root } : {}),
	};
	const rect = placedRect(body);
	if (rect) note.rect = rect;
	board.cards.set(note.id, note);
	broadcast(board, { type: "card", card: plainCardFor(note, board) });
	scheduleSave(board);
	answer(res, 200, { cardId: note.id, card: plainCardFor(note, board), ...(report ? { report } : {}) });
}



/** Read a file inside the workspace, refusing anything that leaves it. */
export function readInsideWorkspace(folder, wanted) {
	const target = resolve(folder, String(wanted ?? ""));
	const root = resolve(folder);
	if (target !== root && !target.startsWith(`${root}/`)) {
		throw new Error(`${wanted} is outside the workspace`);
	}
	const stat = statSync(target, { throwIfNoEntry: false });
	if (!stat) throw new Error(`${wanted} does not exist`);
	if (!stat.isFile()) throw new Error(`${wanted} is not a file`);
	if (stat.size > MAX_SOURCE_CHARS) throw new Error(`${wanted} is larger than ${MAX_SOURCE_CHARS} bytes`);
	const content = readFileSync(target, "utf8");
	// A binary file read as text is a card full of replacement characters, so say so instead.
	if (content.includes("\u0000")) throw new Error(`${wanted} is not a text file`);
	return content;
}



export async function onSource(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const wanted = field(body.path, 400);
	if (!wanted) return void fail(res, 400, "path is required");
	// A child works in its own tree, and what it asks to show is relative to where it stands. The card
	// is still the board's, so the path is resolved and named against that thread's folder.
	const owner = board.threads.get(field(body.threadRoot, 100));
	const folder = owner ? workdirOf(board, owner) : board.folder;
	let content;
	try {
		content = readInsideWorkspace(folder, wanted);
	} catch (error) {
		return void fail(res, 409, error.message);
	}
	const key = field(body.key, 400) || wanted;
	// The head says which file first, so a card is recognisable without opening it, then what the caller
	// called the place in it.
	const named = relative(folder, resolve(folder, wanted)) || basename(wanted) || wanted;
	const label = field(body.title, 200);
	const title = label ? `${named} - ${label}` : named;
	const line = Number.isFinite(body.line) && body.line > 0 ? Math.round(body.line) : undefined;
	const size = CARD_SIZES.includes(body.size) ? body.size : "";
	const after = predecessors(board, body.after);
	const root = rootOf(board, body);
	const held = cardByKey(board, key, "source");
	if (held) {
		// The file may have changed since the card was opened, which is the point of opening it again.
		held.path = wanted;
		held.content = content;
		held.title = title;
		held.updatedAt = Date.now();
		if (line) held.line = line;
		else delete held.line;
		// Absent from the request means "as it was": a refresh of the file says nothing about the shape.
		if (size) held.size = size;
		if (after.length) held.after = after;
		if (root && !held.ownerThread) held.ownerThread = root;
		broadcast(board, { type: "update", card: plainCardFor(held, board) });
		scheduleSave(board);
		const lines = content.split("\n").length;
		answer(res, 200, { cardId: held.id, card: { ...plainCardFor(held, board), lines }, updated: true });
		return;
	}
	makeRoom(board);
	const card = {
		id: randomUUID(),
		type: "source",
		title,
		path: wanted,
		content,
		key,
		at: Date.now(),
		...(line ? { line } : {}),
		...(after.length ? { after } : {}),
		...(size ? { size } : {}),
		...(root ? { threadRoot: anchorOf(board, root), ownerThread: root } : {}),
	};
	board.cards.set(card.id, card);
	broadcast(board, { type: "card", card: plainCardFor(card, board) });
	scheduleSave(board);
	answer(res, 200, { cardId: card.id, card: { ...plainCardFor(card, board), lines: content.split("\n").length } });
}



/** The note the human edited: the text is theirs, so it is stored as written. */
export async function onEdit(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const held = board.cards.get(String(body.cardId ?? ""));
	const note = held && held.type === "note" ? held : undefined;
	if (!note) return void fail(res, 409, "not an editable note");
	if (typeof body.markdown !== "string") return void fail(res, 400, "markdown is required");
	if (body.markdown.length > MAX_NOTE_CHARS) return void fail(res, 413, `a note holds at most ${MAX_NOTE_CHARS} characters`);
	note.markdown = body.markdown;
	note.updatedAt = Date.now();
	broadcast(board, { type: "update", card: plainCardFor(note, board) });
	scheduleSave(board);
	answer(res, 200, { card: plainCardFor(note, board) });
}



/**
 * The human names a card. A thread is drawn as a card of its own, so its name lives on the thread;
 * every other card carries its own title. A name the human typed is theirs, kept as written.
 */
export async function onRename(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const title = field(body.title, MAX_TITLE_CHARS);
	if (!title) return void fail(res, 400, "title is required");
	const id = String(body.cardId ?? "");
	const card = board.cards.get(id);
	if (card) {
		card.title = title;
		card.updatedAt = Date.now();
		updateCard(board, card);
		answer(res, 200, { cardId: card.id, card: plainCardFor(card, board) });
		return;
	}
	const thread = board.threads.get(id);
	if (!thread) return void fail(res, 409, "no such card");
	thread.title = title;
	update(board, thread);
	answer(res, 200, { cardId: thread.id, card: cardFor(thread, board) });
}



/** The composer's file picker walks folders and answers with paths, never with file contents. */
export function onBrowse(url, res) {
	const start = process.cwd();
	const asked = url.searchParams.get("path") ?? "";
	let dir = start;
	let named = "";
	if (asked) {
		const expanded = asked === "~" ? homedir() : asked.startsWith("~/") ? join(homedir(), asked.slice(2)) : resolve(start, asked);
		try {
			dir = realpathSync(expanded);
			if (!statSync(dir).isDirectory()) {
				named = basename(dir);
				dir = dirname(dir);
			}
		} catch {
			return void fail(res, 404, `no such folder: ${asked}`);
		}
	}
	const query = (url.searchParams.get("q") ?? named).trim().toLowerCase();
	const entries = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			if (CONTROL_CHARS.test(entry.name)) continue;
			if (query && !entry.name.toLowerCase().includes(query)) continue;
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = statSync(join(dir, entry.name)).isDirectory();
				} catch {
					continue; // a link to nothing would only fail after it was picked
				}
			}
			entries.push({ name: entry.name, path: join(dir, entry.name), dir: isDir });
		}
	} catch {
		return void fail(res, 403, `cannot list ${dir}`);
	}
	entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
	answer(res, 200, {
		path: dir,
		parent: dirname(dir),
		home: homedir(),
		cwd: start,
		entries: entries.slice(0, BROWSE_LIMIT),
		total: entries.length,
		truncated: entries.length > BROWSE_LIMIT,
	});
}
