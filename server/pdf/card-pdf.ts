/**
 * A note as a page: the markdown a card holds, laid out on A4 with the fonts a reader already has.
 *
 * The reading order is the card's own, so the file says what the card says: headings, paragraphs, lists,
 * quotes, tables and code as they are written, and a note's footnotes numbered at the foot the way the
 * board numbers them. Two fences are read rather than drawn — a chart and a diagram are drawn by the
 * browser and have no place in a text file — so the page names what stood there, in the words the note
 * itself used to describe it.
 */
import { auditMarkdown } from "../chart-audit.ts";
import { PAGE_HEIGHT, PAGE_WIDTH, documentOf, measure, sheet } from "./write.ts";
import type { Face, Sheet } from "./write.ts";

/** What a note becomes: the card's own words, and enough about where they came from to find the card again. */
export type PdfNote = {
	title: string;
	markdown: string;
	/** The workspace the card sits on, named under the title. */
	board: string;
	/** When the card was written, as the board counts time. */
	at: number;
	/** The card's id, shortened under the title: how its owner says which card this is. */
	id?: string;
};

/** One stretch of words in one face. A line of the page is a row of these. */
type Piece = { text: string; face: Face; sup?: boolean };

/** A footnote number is drawn smaller and lifted, and measured the way it is drawn. */
const SUP = 0.72;
const SUP_RISE = 0.32;

const MARGIN = 48;
/** The width everything is laid out in: the page less a margin on each side. */
const WIDTH = PAGE_WIDTH - MARGIN * 2;
/** Where the text stops, leaves the footer its room. */
const FLOOR = 58;

const INK = 0.12;
const MUTED = 0.45;
const HAIRLINE = 0.78;
/** The paper a code block sits on, a shade off the page so the block reads as its own thing. */
const WASH = 0.945;

const PARAGRAPH = { size: 10.4, lead: 15.4, after: 6.5 };
const ITEM = { size: 10.4, lead: 14.8, after: 2.2, indent: 15 };
const QUOTE = { size: 10, lead: 14.8, after: 3 };
const CODE = { size: 8.5, lead: 11.2, pad: 8 };
const TABLE = { size: 9.2, lead: 12.4, padX: 5, padY: 4.2 };

/** How a heading is drawn, by the level the markdown gave it. Past h3 a card shows h3 too. */
const HEADING = [
	{ size: 16.5, lead: 21, before: 16, after: 5 },
	{ size: 13.4, lead: 18, before: 13, after: 4 },
	{ size: 11.6, lead: 16, before: 10, after: 3 },
];

type Align = "left" | "center" | "right";

type Block =
	| { kind: "para"; pieces: Piece[] }
	| { kind: "heading"; level: number; pieces: Piece[] }
	| { kind: "item"; marker: string; depth: number; pieces: Piece[] }
	| { kind: "quote"; paras: Piece[][] }
	| { kind: "rule" }
	| { kind: "code"; lines: string[] }
	| { kind: "figure"; label: string }
	| { kind: "table"; head: Piece[][]; rows: Piece[][][]; align: Align[] };

/** The footnotes of one body: what the labels say, and the order the reader meets them in. */
type Notes = { defs: Map<string, string>; order: string[] };

// ---------- inline ---------------------------------------------------------

const isWordChar = (char: string | undefined) => Boolean(char && /[\w]/.test(char));

/** A face with one more emphasis on it, so bold inside italic is still both. */
function stronger(base: Face, add: "bold" | "italic"): Face {
	const bold = base === "bold" || base === "boldItalic" || add === "bold";
	const italic = base === "italic" || base === "boldItalic" || add === "italic";
	return bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular";
}

/**
 * One line of markdown as the pieces a line of the page is made of. The markers are the card's own, so a
 * note that reads well on the board reads the same here: `**`, `*`, a code span, a `[[key]]`, a link, and
 * a footnote marker numbered by the order it is met. Anything unrecognised stays as it was typed.
 */
function inline(text: string, notes: Notes, base: Face = "regular"): Piece[] {
	const pieces: Piece[] = [];
	let plain = "";
	const flush = () => {
		if (!plain) return;
		pieces.push({ text: plain, face: base });
		plain = "";
	};
	const keep = (inner: string, face: Face) => {
		flush();
		pieces.push(...inline(inner, notes, face));
	};

	let index = 0;
	while (index < text.length) {
		const char = text[index];
		const rest = text.slice(index);

		// A backslash escapes the character after it, which is how a card writes a literal star.
		if (char === "\\" && index + 1 < text.length && /[\\`*_[\]()#|~-]/.test(text[index + 1])) {
			plain += text[index + 1];
			index += 2;
			continue;
		}
		if (char === "`") {
			const end = text.indexOf("`", index + 1);
			if (end > index + 1) {
				keep(text.slice(index + 1, end), "mono");
				index = end + 1;
				continue;
			}
		}
		if (rest.startsWith("**")) {
			const end = text.indexOf("**", index + 2);
			if (end > index + 2) {
				keep(text.slice(index + 2, end), stronger(base, "bold"));
				index = end + 2;
				continue;
			}
		}
		// A star inside a word is multiplication, not emphasis, which is the rule the board draws by.
		if (char === "*" && !isWordChar(text[index - 1])) {
			const end = text.indexOf("*", index + 1);
			if (end > index + 1 && !isWordChar(text[end + 1])) {
				keep(text.slice(index + 1, end), stronger(base, "italic"));
				index = end + 1;
				continue;
			}
		}
		if (rest.startsWith("[[") && rest.includes("]]")) {
			const end = text.indexOf("]]", index + 2);
			const whole = text.slice(index + 2, end);
			const bar = whole.indexOf("|");
			keep(bar > 0 ? whole.slice(bar + 1).trim() : whole.trim(), base);
			index = end + 2;
			continue;
		}
		if (rest.startsWith("[^")) {
			const match = /^\[\^([^\]\s]+)\]/.exec(rest);
			if (match && notes.defs.has(match[1])) {
				let number = notes.order.indexOf(match[1]);
				if (number < 0) number = notes.order.push(match[1]) - 1;
				flush();
				pieces.push({ text: String(number + 1), face: base, sup: true });
				index += match[0].length;
				continue;
			}
		}
		if (char === "[") {
			const match = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
			if (match) {
				flush();
				pieces.push(...inline(match[1], notes, base));
				pieces.push({ text: ` (${match[2]})`, face: base });
				index += match[0].length;
				continue;
			}
		}
		plain += char;
		index += 1;
	}
	flush();
	return pieces;
}

// ---------- blocks ---------------------------------------------------------

/** A line of a table split into its cells, outer pipes dropped. */
function cellsOf(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((cell) => cell.trim());
}

/** The row under a header that turns it into a table: dashes, colons, and nothing else. */
function isTableRule(line: string | undefined): boolean {
	if (!line || !line.includes("-")) return false;
	const cells = cellsOf(line);
	return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function alignOf(rule: string): Align {
	const cell = rule.trim();
	if (cell.startsWith(":") && cell.endsWith(":")) return "center";
	if (cell.endsWith(":")) return "right";
	return "left";
}

/**
 * The markdown of a card as the blocks it is read in. The order of the passes is the card's own: fences
 * are lifted out first so that a footnote inside a code block stays code, then footnote definitions are
 * lifted out so that the body carries only the markers, and only then are the lines walked.
 */
function blocksOf(markdown: string, notes: Notes): Block[] {
	const fences: { lang: string; body: string }[] = [];
	const stripped = markdown.replace(/(`{3,})([a-zA-Z0-9_-]*)\n([\s\S]*?)\1/g, (_whole, _ticks, lang: string, body: string) => {
		const index = fences.push({ lang: lang.toLowerCase(), body }) - 1;
		return `\u0000FENCE${index}\u0000`;
	});

	const body: string[] = [];
	let openNote: string | null = null;
	for (const line of stripped.replace(/(\u0000FENCE\d+\u0000)/g, "\n\n$1\n\n").split("\n")) {
		const definition = line.match(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/);
		if (definition) {
			openNote = definition[1];
			notes.defs.set(definition[1], definition[2]);
			continue;
		}
		// The lines indented under a definition belong to it, which is how a long note is written.
		if (openNote && /^(?: {2,}|\t)\S/.test(line)) {
			notes.defs.set(openNote, `${notes.defs.get(openNote)} ${line.trim()}`);
			continue;
		}
		openNote = null;
		body.push(line);
	}

	const blocks: Block[] = [];
	for (const chunk of body.join("\n").split(/\n{2,}/)) {
		const fence = chunk.match(/^\u0000FENCE(\d+)\u0000$/);
		const held = fence ? fences[Number(fence[1])] : undefined;
		if (held) {
			if (held.lang === "chart") {
				// The card draws the chart from the config; a page can only say what shape it was, and the
				// audit is what already knows how to say it.
				const { summary } = auditMarkdown(["```chart", held.body, "```"].join("\n"));
				blocks.push({ kind: "figure", label: summary || "chart: drawn on the board, not in this file" });
			} else if (held.lang === "mermaid") {
				blocks.push({ kind: "figure", label: `diagram — ${held.body.trim().split("\n").length} lines, drawn on the board` });
			} else if (held.lang === "svg") {
				blocks.push({ kind: "figure", label: "drawing — drawn on the board, not in this file" });
			} else {
				blocks.push({ kind: "code", lines: held.body.replace(/\n$/, "").split("\n") });
			}
			continue;
		}
		const lines = chunk.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			const tableHead = cellsOf(line);
			if (line.includes("|") && isTableRule(lines[index + 1]) && cellsOf(lines[index + 1] ?? "").length === tableHead.length) {
				const rule = cellsOf(lines[index + 1]);
				const rows: string[][] = [];
				let cursor = index + 2;
				while (cursor < lines.length && lines[cursor].includes("|")) rows.push(cellsOf(lines[cursor++]));
				blocks.push({
					kind: "table",
					head: tableHead.map((cell) => inline(cell, notes)),
					rows: rows.map((row) => row.map((cell) => inline(cell, notes))),
					align: rule.map(alignOf),
				});
				index = cursor - 1;
				continue;
			}
			const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
			const numbered = bullet ? null : line.match(/^(\s*)(\d{1,3})[.)]\s+(.*)$/);
			if (bullet || numbered) {
				const depth = Math.min(3, Math.floor((bullet ? bullet[1] : numbered?.[1] ?? "").length / 2));
				// A ticked box travels as a box and a mark, because the page's font has no ballot glyph.
				const box = bullet ? bullet[2].match(/^\[([ xX]?)\]\s*(.*)$/) : null;
				blocks.push({
					kind: "item",
					marker: bullet ? (box ? (box[1].trim() ? "[x]" : "[ ]") : "•") : `${numbered?.[2]}.`,
					depth,
					pieces: inline(box ? box[2] : bullet ? bullet[2] : numbered?.[3] ?? "", notes),
				});
				continue;
			}
			if (!line.trim()) continue;
			const heading = line.match(/^(#{1,6})\s+(.*)$/);
			if (heading) {
				blocks.push({ kind: "heading", level: Math.min(3, heading[1].length), pieces: inline(heading[2], notes) });
				continue;
			}
			if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
				blocks.push({ kind: "rule" });
				continue;
			}
			const quoted = line.match(/^\s*>\s?(.*)$/);
			if (quoted) {
				// One quote holds its lines together, and a bare `>` starts a new paragraph inside it.
				const inner: Piece[] = [];
				const paragraphs: Piece[][] = [];
				let cursor = index;
				while (cursor < lines.length) {
					const next = lines[cursor].match(/^\s*>\s?(.*)$/);
					if (!next) break;
					if (!next[1].trim()) {
						if (inner.length) paragraphs.push(inner.splice(0));
					} else {
						// The lines of one quote are one sentence: a space between them is the markdown's own rule.
						if (inner.length) inner.push({ text: " ", face: "italic" });
						inner.push(...inline(next[1].trim(), notes, "italic"));
					}
					cursor += 1;
				}
				if (inner.length) paragraphs.push(inner);
				blocks.push({ kind: "quote", paras: paragraphs });
				index = cursor - 1;
				continue;
			}
			blocks.push({ kind: "para", pieces: inline(line, notes) });
		}
	}
	return blocks;
}

// ---------- the page -------------------------------------------------------

/** Where the next line goes: the paper, and how far down it the drawing has come. */
type Page = { sheets: Sheet[]; sheet: Sheet; y: number };

function newPage(page: Page) {
	page.sheet = sheet();
	page.sheets.push(page.sheet);
	page.y = PAGE_HEIGHT - MARGIN;
}

/** Make sure a block as tall as this still fits, and turn the page when it does not. */
function room(page: Page, height: number) {
	if (page.y - height >= FLOOR) return;
	newPage(page);
}

function pieceWidth(piece: Piece, size: number): number {
	return measure(piece.face, piece.sup ? size * SUP : size, piece.text);
}

/** How wide a run of pieces reaches, which is what a line is measured by. */
function piecesWidth(pieces: Piece[], size: number): number {
	return pieces.reduce((total, piece) => total + pieceWidth(piece, size), 0);
}

/** A word too long for the line is cut where it stops fitting, so nothing runs into the margin. */
function cut(word: string, face: Face, size: number, width: number): string[] {
	const parts: string[] = [];
	let held = "";
	for (const char of word) {
		if (measure(face, size, held + char) > width && held) {
			parts.push(held);
			held = char;
			continue;
		}
		held += char;
	}
	if (held) parts.push(held);
	return parts;
}

/**
 * The pieces of a paragraph broken into the lines the page has room for. Words are kept whole; a word
 * wider than the line, which a path or a URL can be, is cut rather than left to run into the margin.
 */
function wrap(pieces: Piece[], size: number, width: number): Piece[][] {
	const lines: Piece[][] = [];
	let line: Piece[] = [];
	let used = 0;
	const breakLine = () => {
		while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
		lines.push(line);
		line = [];
		used = 0;
	};
	for (const piece of pieces) {
		for (const word of piece.text.split(/(\s+)/)) {
			if (!word) continue;
			const wide = pieceWidth({ ...piece, text: word }, size);
			if (used + wide <= width) {
				line.push({ ...piece, text: word });
				used += wide;
				continue;
			}
			if (/^\s+$/.test(word)) {
				breakLine();
				continue;
			}
			if (line.length) breakLine();
			if (wide <= width) {
				line.push({ ...piece, text: word });
				used = wide;
				continue;
			}
			for (const [position, part] of cut(word, piece.face, piece.sup ? size * SUP : size, width).entries()) {
				if (position > 0) breakLine();
				line.push({ ...piece, text: part });
				used = pieceWidth({ ...piece, text: part }, size);
			}
		}
	}
	if (line.length) breakLine();
	return lines;
}

function drawPieces(page: Page, pieces: Piece[], size: number, x: number, y: number) {
	let at = x;
	for (const piece of pieces) {
		const drawn = piece.sup ? size * SUP : size;
		page.sheet.text(piece.face, drawn, at, piece.sup ? y + size * SUP_RISE : y, piece.text);
		at += measure(piece.face, drawn, piece.text);
	}
}

function drawParagraph(page: Page, pieces: Piece[], size: number, lead: number, x: number, width: number): number {
	const lines = wrap(pieces, size, width);
	for (const line of lines) {
		room(page, lead);
		page.y -= lead;
		drawPieces(page, line, size, x, page.y + lead * 0.28);
	}
	return lines.length;
}

function drawHeading(page: Page, level: number, pieces: Piece[]) {
	const style = HEADING[Math.max(0, Math.min(HEADING.length - 1, level - 1))];
	const lines = wrap(pieces, style.size, WIDTH);
	// A heading belongs with what it names, so it moves to the next page rather than standing alone.
	room(page, style.before + lines.length * style.lead + style.after + style.lead);
	page.y -= style.before;
	page.sheet.paint(INK);
	for (const line of lines) {
		page.y -= style.lead;
		drawPieces(page, line, style.size, MARGIN, page.y + style.lead * 0.28);
	}
	page.y -= style.after;
}

function drawItem(page: Page, block: { marker: string; depth: number; pieces: Piece[] }) {
	const x = MARGIN + block.depth * ITEM.indent + 2;
	const markerWidth = Math.max(measure("regular", ITEM.size, block.marker) + 6, 10);
	const lines = wrap(block.pieces, ITEM.size, WIDTH - (x - MARGIN) - markerWidth);
	for (const [index, line] of lines.entries()) {
		room(page, ITEM.lead);
		page.y -= ITEM.lead;
		page.sheet.paint(INK);
		if (index === 0) page.sheet.text("regular", ITEM.size, x, page.y + ITEM.lead * 0.28, block.marker);
		drawPieces(page, line, ITEM.size, x + markerWidth, page.y + ITEM.lead * 0.28);
	}
	page.y -= ITEM.after;
}

function drawQuote(page: Page, paras: Piece[][]) {
	const x = MARGIN + 12;
	const width = WIDTH - 24;
	const box = { size: QUOTE.size, lead: QUOTE.lead, after: QUOTE.after };
	const height = paras.reduce((total, one) => total + wrap(one, QUOTE.size, width).length * QUOTE.lead + 4, 0);
	room(page, height + 4);
	const top = page.y;
	for (const one of paras) {
		drawParagraph(page, one, box.size, box.lead, x, width);
		page.y -= 4;
	}
	// The bar is drawn last, when both ends of the quote are known.
	page.sheet.paint(0.72);
	page.sheet.box(MARGIN + 2, page.y + 2, 1.6, top - page.y - 2);
	page.y -= QUOTE.after;
}

function drawRule(page: Page) {
	room(page, 20);
	page.y -= 10;
	page.sheet.paint(HAIRLINE);
	page.sheet.line(MARGIN, page.y, PAGE_WIDTH - MARGIN, page.y, 0.6);
	page.y -= 10;
}

function drawCode(page: Page, lines: string[]) {
	// Long lines wrap here rather than scroll: a page has no scrollbar, and a cut line loses words.
	const wrapped = lines.flatMap((line) => (line ? wrap([{ text: line, face: "mono" }], CODE.size, WIDTH - CODE.pad * 2) : [[]]));
	// The block fills the page it is on and carries on at the top of the next one, so a long listing does
	// not leave half a page blank waiting for a box that would fit whole.
	for (let start = 0; start < wrapped.length; ) {
		let fits = Math.floor((page.y - FLOOR - CODE.pad * 2) / CODE.lead);
		if (fits < 1) {
			newPage(page);
			fits = Math.floor((PAGE_HEIGHT - MARGIN * 2 - CODE.pad * 2) / CODE.lead);
		}
		const slice = wrapped.slice(start, start + fits);
		const height = slice.length * CODE.lead + CODE.pad * 2;
		const top = page.y;
		page.sheet.paint(WASH);
		page.sheet.box(MARGIN, top - height, WIDTH, height);
		page.sheet.paint(INK);
		for (const line of slice) {
			page.y -= CODE.lead;
			drawPieces(page, line, CODE.size, MARGIN + CODE.pad, page.y + CODE.lead * 0.26);
		}
		page.y -= CODE.pad;
		start += slice.length;
		if (start < wrapped.length) newPage(page);
	}
	page.y -= PARAGRAPH.after;
}

/**
 * A picture the page cannot draw, said in one line: what it was, and that the card holds the drawing. It is
 * marked with a bar rather than a panel, so it reads as a note about the card instead of as content of it.
 */
function drawFigure(page: Page, label: string) {
	const lines = wrap([{ text: label, face: "italic" }], 9.4, WIDTH - 18);
	room(page, 6 + lines.length * 13 + PARAGRAPH.after);
	const top = page.y - 3;
	page.y -= 3;
	page.sheet.paint(MUTED);
	for (const line of lines) {
		page.y -= 13;
		drawPieces(page, line, 9.4, MARGIN + 12, page.y + 13 * 0.3);
	}
	const bottom = page.y - 4;
	page.sheet.paint(0.62);
	page.sheet.box(MARGIN + 2, bottom, 1.6, top - bottom);
	page.y = bottom - PARAGRAPH.after;
}

/** The columns a table is drawn in: what each one needs, shared out so the table fills the page's width. */
function columnWidths(head: Piece[][], rows: Piece[][][]): number[] {
	const count = head.length;
	const natural = new Array<number>(count).fill(28);
	for (const row of [head, ...rows]) {
		for (const [index, cell] of row.entries()) {
			if (index >= count) break;
			natural[index] = Math.max(natural[index], Math.min(piecesWidth(cell, TABLE.size), 240));
		}
	}
	const total = natural.reduce((sum, one) => sum + one, 0);
	const widths = natural.map((one) => Math.max(34, (one / total) * WIDTH));
	const over = widths.reduce((sum, one) => sum + one, 0) - WIDTH;
	if (over <= 0) return widths;
	// Whatever the floor pushed past the page is taken back from the columns that have room to spare.
	const spare = widths.reduce((sum, one) => sum + Math.max(0, one - 34), 0);
	return widths.map((one) => one - (Math.max(0, one - 34) / spare) * over);
}

function drawTable(page: Page, head: Piece[][], rows: Piece[][][], align: Align[]) {
	const widths = columnWidths(head, rows);
	const heightOf = (row: Piece[][]) =>
		Math.max(...row.map((cell, index) => wrap(cell, TABLE.size, (widths[index] ?? 34) - TABLE.padX * 2).length)) * TABLE.lead +
		TABLE.padY * 2;
	const drawRow = (row: Piece[][], top: number, bold: boolean) => {
		const height = heightOf(row);
		let x = MARGIN;
		for (const [index, cell] of row.entries()) {
			const width = widths[index] ?? 34;
			const lines = wrap(cell, TABLE.size, width - TABLE.padX * 2);
			let y = top - TABLE.padY;
			for (const line of lines) {
				y -= TABLE.lead;
				const drawn = bold ? line.map((piece) => ({ ...piece, face: stronger(piece.face, "bold") })) : line;
				const reach = piecesWidth(drawn, TABLE.size);
				const where = align[index] === "center" ? x + (width - reach) / 2 : align[index] === "right" ? x + width - TABLE.padX - reach : x + TABLE.padX;
				drawPieces(page, drawn, TABLE.size, where, y + TABLE.lead * 0.28);
			}
			x += width;
		}
		return height;
	};

	let top = page.y;
	page.sheet.paint(INK);
	page.y -= drawRow(head, top, true);
	page.sheet.paint(0.55);
	page.sheet.line(MARGIN, page.y, PAGE_WIDTH - MARGIN, page.y, 0.7);
	for (const [index, row] of rows.entries()) {
		const height = heightOf(row);
		if (page.y - height < FLOOR) {
			// A table too long for one page carries its header over, so the rest still says what it is.
			newPage(page);
			top = page.y;
			page.sheet.paint(INK);
			page.y -= drawRow(head, top, true);
			page.sheet.paint(0.55);
			page.sheet.line(MARGIN, page.y, PAGE_WIDTH - MARGIN, page.y, 0.7);
		}
		page.sheet.paint(INK);
		page.y -= drawRow(row, page.y, false);
		if (index < rows.length - 1) {
			page.sheet.paint(0.87);
			page.sheet.line(MARGIN, page.y, PAGE_WIDTH - MARGIN, page.y, 0.4);
		}
	}
	page.y -= PARAGRAPH.after + 2;
}

/** The date on the title line, in the order a page reads it: 2025-03-14. */
function dayOf(at: number): string {
	const when = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/**
 * The note as a PDF: a title line that says which card this is, the body in the card's own order, the
 * footnotes numbered where the body pointed at them, and a footer on every page so a printed stack can
 * be put back together.
 */
export function notePdf(note: PdfNote): Buffer {
	const page: Page = { sheets: [], sheet: sheet(), y: PAGE_HEIGHT - MARGIN };
	page.sheets.push(page.sheet);
	const title = String(note.title ?? "").trim() || "note";
	const notes: Notes = { defs: new Map(), order: [] };
	const blocks = blocksOf(String(note.markdown ?? ""), notes);

	page.sheet.paint(INK);
	for (const line of wrap([{ text: title, face: "bold" }], HEADING[0].size, WIDTH)) {
		page.y -= HEADING[0].lead;
		drawPieces(page, line, HEADING[0].size, MARGIN, page.y + HEADING[0].lead * 0.3);
	}

	// Where this came from: the workspace, the day, and the card's own short name.
	const short = String(note.id ?? "").slice(0, 8);
	const about = [note.board, dayOf(note.at), short ? `card ${short}` : ""].filter(Boolean).join(" · ");
	page.y -= 12;
	page.sheet.paint(MUTED);
	page.sheet.text("regular", 8.6, MARGIN, page.y, about);
	page.y -= 7;
	page.sheet.paint(0.8);
	page.sheet.line(MARGIN, page.y, PAGE_WIDTH - MARGIN, page.y, 0.7);
	page.y -= 6;
	page.sheet.paint(INK);

	for (const block of blocks) {
		switch (block.kind) {
			case "heading":
				drawHeading(page, block.level, block.pieces);
				break;
			case "para":
				drawParagraph(page, block.pieces, PARAGRAPH.size, PARAGRAPH.lead, MARGIN, WIDTH);
				page.y -= PARAGRAPH.after;
				break;
			case "item":
				drawItem(page, block);
				break;
			case "quote":
				drawQuote(page, block.paras);
				break;
			case "rule":
				drawRule(page);
				break;
			case "code":
				drawCode(page, block.lines);
				break;
			case "figure":
				drawFigure(page, block.label);
				break;
			case "table":
				drawTable(page, block.head, block.rows, block.align);
				break;
		}
	}

	if (notes.order.length) {
		page.y -= 4;
		room(page, 34);
		page.sheet.paint(HAIRLINE);
		page.sheet.line(MARGIN + 14, page.y, PAGE_WIDTH - MARGIN, page.y, 0.5);
		page.y -= 12;
		// The order is read once: a footnote that points at another one must not grow the list it is drawn from.
		for (const [index, label] of [...notes.order].entries()) {
			const defs = notes.defs;
			const pieces: Piece[] = [{ text: `${index + 1}`, face: "regular", sup: true }, { text: " ", face: "regular" }, ...inline(defs.get(label) ?? "", { defs, order: [] })];
			page.sheet.paint(MUTED);
			const lines = wrap(pieces, 8.8, WIDTH - 14);
			for (const [position, line] of lines.entries()) {
				room(page, 12.4);
				page.y -= 12.4;
				drawPieces(page, line, 8.8, MARGIN + (position === 0 ? 0 : 14), page.y + 12.4 * 0.28);
			}
		}
	}

	// The footer is written after the body, because the count of pages is only known once it is done.
	const total = page.sheets.length;
	for (const [index, one] of page.sheets.entries()) {
		one.paint(MUTED);
		one.text("regular", 7.6, MARGIN, 26, title);
		const count = `page ${index + 1} / ${total}`;
		one.text("regular", 7.6, PAGE_WIDTH - MARGIN - measure("regular", 7.6, count), 26, count);
	}
	return documentOf(page.sheets);
}
