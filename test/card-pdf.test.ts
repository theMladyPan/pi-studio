import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { notePdf } from "../server/pdf/card-pdf.ts";
import { onCardPdf, pdfName } from "../server/routes/board/pdf.ts";

/**
 * A card's page is written by the daemon itself, so what is checked here is the page: the objects a reader
 * asks for, the words the card carried, and the way the markers became what a page can show. The streams are
 * written uncompressed, which is what lets a test read the text without a renderer.
 */

const card = (markdown: string, title = "a note") => notePdf({ title, markdown, board: "pi-studio", at: Date.UTC(2025, 2, 14), id: "abcdef012345" });

/** The whole file as text: every stream in it is plain, so the drawn words are searchable as they stand. */
const textOf = (bytes: Buffer) => bytes.toString("latin1");

/** A request and a response a handler writes to, with a promise for the one answer it gives. */
function wire(body: unknown) {
	const req = Readable.from([Buffer.from(JSON.stringify(body))]);
	let status = 0;
	let headers: Record<string, string> = {};
	let said: Buffer = Buffer.alloc(0);
	let settle: () => void = () => {};
	const done = new Promise<void>((resolve) => (settle = resolve));
	const res = {
		writeHead(code: number, given?: Record<string, string>) {
			status = code;
			headers = given ?? {};
		},
		end(chunk?: unknown) {
			said = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
			settle();
		},
	};
	return {
		req,
		res,
		done,
		get status() {
			return status;
		},
		get headers() {
			return headers;
		},
		get body() {
			return said;
		},
	};
}

/** The shape a card route reads off a board: the cards it holds by id, and the name a page carries. */
type Held = { id: string; type: string; title?: string; markdown?: string; at?: number };

function board(cards: (Held & Record<string, unknown>)[]) {
	return { name: "pi-studio", cards: new Map(cards.map((one): [string, Held] => [one.id, one])) };
}

test("the file is a pdf a reader can open, with one page per sheet and a footer on each", () => {
	const bytes = card("# Title\n\nA short note.");
	const text = textOf(bytes);
	assert.ok(text.startsWith("%PDF-1.4\n"), "a pdf starts with its version");
	assert.ok(text.trimEnd().endsWith("%%EOF"), "and ends with the end marker");
	assert.equal((text.match(/\/Count (\d+)/) ?? [])[1], "1");
	// Every object the page tree names is written with its number, which is what the cross-reference counts.
	assert.ok(text.includes("1 0 obj"), "the catalog is an object");
	assert.ok(text.includes("/MediaBox [0 0 595.28 841.89]"), "the page is A4");
	assert.ok(text.includes("(page 1 / 1) Tj"), "the footer counts the pages");
});

test("the card's words are the page's words: title, headings, prose and list items", () => {
	const text = textOf(card("## What the scan found\n\nThe sweep names the leftovers.\n\n- a card nobody read"));
	assert.ok(text.includes("(a note) Tj"), "the title is drawn");
	assert.ok(text.includes("(pi-studio \\(2025-03-14\\)") || text.includes("pi-studio"), "the line under the title says where the card came from");
	assert.ok(text.includes("(scan) Tj") && text.includes("(found) Tj"), "a heading keeps its words");
	assert.ok(text.includes("(sweep) Tj") && text.includes("(leftovers.) Tj"), "prose keeps its words");
	assert.ok(text.includes("(nobody) Tj") && text.includes("(read) Tj"), "a list item keeps its words");
});

test("emphasis is drawn in the face it asked for, and inline code in the monospaced one", () => {
	const text = textOf(card("a **bold** word and a `fixed` one"));
	assert.match(text, /\/F2 [\d.]+ Tf\n1 0 0 1 [\d.]+ [\d.]+ Tm\n\(bold\) Tj/, "bold is the bold face");
	assert.match(text, /\/F5 [\d.]+ Tf\n1 0 0 1 [\d.]+ [\d.]+ Tm\n\(fixed\) Tj/, "code is the monospaced face");
});

test("a table keeps its header and every cell, and its rules line up", () => {
	const markdown = ["| leftover | what happens |", "|---|---:|", "| a merged branch | freed |", "| a session file | kept |"].join("\n");
	const text = textOf(card(markdown));
	for (const word of ["leftover", "happens", "merged", "branch", "freed", "session", "kept"]) {
		assert.ok(text.includes(`(${word}) Tj`), `${word} is drawn`);
	}
	assert.match(text, /[\d.]+ w\n[\d.]+ [\d.]+ m [\d.]+ [\d.]+ l S/, "the rules that mark the rows are drawn");
});

test("a chart block is described rather than printed, and its config is not in the file", () => {
	const body = JSON.stringify({ type: "bar", data: { labels: ["a", "b"], datasets: [{ label: "errors", data: [1, 2] }] } });
	const text = textOf(card(["```chart", body, "```"].join("\n")));
	assert.ok(text.includes("(chart:) Tj") && text.includes("(labels,) Tj") && text.includes("(dataset) Tj"), "the page names the shape the note described");
	assert.ok(!text.includes("{\"type\""), "the config itself is not text on the page");
});

test("a diagram and a drawing are named as what the card holds, not as their own source", () => {
	const mermaid = textOf(card(["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n")));
	assert.ok(mermaid.includes("diagram"), "a diagram says what it was");
	assert.ok(!mermaid.includes("flowchart TD"), "and its source is not printed as prose");
	const svg = textOf(card(['```svg', '<svg viewBox="0 0 4 4"></svg>', "```"].join("\n")));
	assert.ok(svg.includes("drawing"), "a drawing says what it was");
});

test("a footnote is numbered where it is pointed at and printed at the foot", () => {
	const text = textOf(card("The rule is in the sweeper.[^rule]\n\n[^rule]: It is made there, not in the panel."));
	assert.ok(text.includes("(1) Tj"), "the marker is drawn as a number");
	assert.ok(text.includes("(sweeper.) Tj"), "the sentence keeps its words");
	assert.ok(text.includes("(panel.) Tj"), "the note is printed at the foot");
});

test("a marker with no definition stays as it was typed rather than becoming a number", () => {
	const text = textOf(card("a typo[^nowhere] reads better than a lost marker"));
	assert.ok(text.includes("[^nowhere]") || text.includes("(a typo) Tj"), "the line is drawn");
	assert.ok(!text.includes("(1) Tj"), "and nothing is numbered");
});

test("a letter the standard font has no byte for is folded to the letter it is built on", () => {
	// The words a page in Polish or Czech is made of. Dropping the diacritic instead of folding it would turn
	// `Przegląd` into `Przegld`, which reads as a typo rather than as the word.
	const text = textOf(card("Przegląd čísel a řádků, Łódź"));
	assert.ok(text.includes("(Przeglad) Tj"), "a letter with a tail is folded to the letter it is built on");
	assert.ok(text.includes("(císel) Tj"), "and the word around it is whole");
	assert.ok(text.includes("(rádku,) Tj") && text.includes("(Lódz) Tj"), "a stroked letter becomes the letter it is");
	// A letter the Latin set already holds keeps its own byte, so the word is drawn with its accent whole.
	assert.ok(text.includes("císel"), "a letter the font does hold is kept as it is");
});

test("characters the standard font has no glyph for are said in characters it does", () => {
	const text = textOf(card("an arrow → and a dash — and a quote “like this” ✓"));
	assert.ok(text.includes("(arrow) Tj"), "the words around them survive");
	assert.ok(text.includes("(->) Tj"), "an arrow is written as the arrow a page can hold");
	assert.ok(text.includes("\u0097"), "an em dash is the Latin set's own byte");
	assert.ok(text.includes("\u0093like") && text.includes("this\u0094"), "curly quotes are the Latin set's own bytes");
	assert.ok(text.includes("([x]) Tj"), "a tick is said as a ticked box");
});

test("text past the page breaks onto a second one, and both carry the count", () => {
	const many = Array.from({ length: 90 }, (_, index) => `Paragraph ${index + 1}: a line about the sweep and what it can prove.`).join("\n\n");
	const text = textOf(card(many));
	const pages = Number((text.match(/\/Count (\d+)/) ?? [])[1]);
	assert.ok(pages >= 2, `a note this long spills onto more than one page, and this one took ${pages}`);
	assert.ok(text.includes(`(page 1 / ${pages}) Tj`), "the first page counts");
	assert.ok(text.includes(`(page ${pages} / ${pages}) Tj`), "and so does the last");
});

test("a note with nothing in it is still one page, named after the fallback title", () => {
	const text = textOf(notePdf({ title: "", markdown: "", board: "", at: Date.UTC(2025, 2, 14) }));
	assert.equal((text.match(/\/Count (\d+)/) ?? [])[1], "1");
	assert.ok(text.includes("(note) Tj"), "an untitled note is called a note");
});

test("a file is named after the card, in the shape a file system takes", () => {
	assert.equal(pdfName("Where the leftovers went, and why", "abcdef012345"), "where-the-leftovers-went-and-why-abcdef.pdf");
});

test("the press answers with the page itself, named after the card and marked a download", async () => {
	const held = { id: "abcdef012345", type: "note", title: "a note on disk", markdown: "The sweep names the leftovers.", at: Date.UTC(2025, 2, 14) };
	const answer = wire({ cardId: held.id });
	await onCardPdf(answer.req, answer.res, board([held]));
	await answer.done;
	assert.equal(answer.status, 200);
	assert.equal(answer.headers["Content-Type"], "application/pdf");
	assert.equal(answer.headers["Content-Disposition"], 'attachment; filename="a-note-on-disk-abcdef.pdf"');
	assert.equal(Number(answer.headers["Content-Length"]), answer.body.length, "the length is the file's own");
	assert.ok(answer.body.toString("latin1").startsWith("%PDF-1.4"), "and the body is the pdf");
});

test("a note with a title outside ascii is saved under a name a header can carry", () => {
	assert.equal(pdfName("Przegląd — karta", "abcdef012345"), "przeglad-karta-abcdef.pdf", "an accent is folded to its letter");
	assert.equal(pdfName("日本語のタイトル", "abcdef012345"), "note-abcdef.pdf", "a title with no ascii in it keeps the fallback name");
	assert.equal(pdfName("  !!!  ", "abcdef012345"), "note-abcdef.pdf");
});

test("a card that is not a note is refused, and so is an id nobody holds", async () => {
	const source = { id: "aaaaaa111111", type: "source", title: "a file", path: "src/a.ts" };
	const wrong = wire({ cardId: source.id });
	await onCardPdf(wrong.req, wrong.res, board([source]));
	await wrong.done;
	assert.equal(wrong.status, 409);

	const missing = wire({ cardId: "nobody" });
	await onCardPdf(missing.req, missing.res, board([]));
	await missing.done;
	assert.equal(missing.status, 409);
});
