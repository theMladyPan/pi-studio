/**
 * What a thread knows about the board before it reads the message it was sent: the cards already there,
 * one bullet each.
 *
 * A thread that cannot see the board writes a card that duplicates one already on it, or opens a second
 * card where the first one wanted a revision. The block is short and always prepended, so the board is a
 * fact the thread starts with rather than a lookup it may forget to make.
 */

/** The types a thread may read: the plain cards. A thread card is a thread, not an artifact of one. */
const PLAIN = new Set(["note", "source"]);

/** Newest first, and this many at most. A long board is named by its tail, which is what a thread builds on. */
const MAX_ENTRIES = 40;

/**
 * The longest the block may be. It rides on every message, so a board nobody tidied is paid for once per
 * turn; past this the oldest entries are dropped, which keeps the newest cards named rather than the
 * first forty ever made.
 */
const MAX_CHARS = 1200;

/** The longest a title may run: enough to recognise the card, short enough to keep the line moving. */
const TITLE_CHARS = 60;

/** A card as the line reads it. A board file holds more, and none of it is needed to name the card. */
type IndexCard = { id?: string; type?: string; key?: string; title?: string; at?: number };

/** One entry: the key a `[[key]]` resolves by, or the id, then the title and the kind of card. */
function entryOf(card: IndexCard): string {
	const title = String(card.title ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, TITLE_CHARS);
	// A card with no title has nothing to name it by, and an entry reading `id — ()` is worse than none.
	if (!title) return "";
	const name = String(card.key ?? "").trim() || String(card.id ?? "");
	if (!name) return "";
	return `${name} — ${title} (${card.type})`;
}

/**
 * The whole block, bracketed and one bullet to a card, so a model reads a list rather than a sentence it
 * may take for an instruction. The label is the board's own, the same way `[user message]` is the human's.
 */
function block(entries: string[]): string {
	return `[board state]\n${entries.map((one) => `- ${one}`).join("\n")}`;
}

/**
 * The block a thread's message is prefixed with, or "" when the board holds no plain card: a board with
 * nothing on it says nothing, rather than saying it has nothing.
 */
export function cardIndex(board: { cards?: Map<string, IndexCard> } | null | undefined): string {
	const cards = board?.cards;
	if (!cards) return "";
	const entries = [...cards.values()]
		.filter((card) => PLAIN.has(String(card?.type ?? "")))
		.sort((a, b) => Number(b?.at ?? 0) - Number(a?.at ?? 0))
		.map(entryOf)
		.filter(Boolean)
		.slice(0, MAX_ENTRIES);
	while (entries.length && block(entries).length > MAX_CHARS) entries.pop();
	return entries.length ? `${block(entries)}\n` : "";
}
