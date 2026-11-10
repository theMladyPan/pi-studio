import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { notePdf } from "../server/pdf/card-pdf.ts";
import { cardPdf, pdfName, revealFile } from "../server/routes/board/pdf.ts";

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
	let said = "";
	let settle: () => void = () => {};
	const done = new Promise<void>((resolve) => (settle = resolve));
	const res = {
		writeHead(code: number) {
			status = code;
		},
		end(chunk?: unknown) {
			said = String(chunk ?? "");
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
	assert.equal(pdfName("  !!!  ", "abcdef012345"), "note-abcdef.pdf");
});

test("the press writes the page into the temp folder and says who opened it", async () => {
	const held = {
		id: "abcdef012345",
		type: "note",
		title: "a note on disk",
		markdown: "The sweep names the leftovers.",
		at: Date.UTC(2025, 2, 14),
	};
	const answer = wire({ cardId: held.id });
	await cardPdf(answer.req, answer.res, board([held]), async (file: string) => {
		assert.ok(existsSync(file), "the file is written before the browser is asked to show it");
		assert.ok(statSync(file).size > 800, "and it holds a page");
		return { program: "test-browser", selected: true };
	});
	await answer.done;
	assert.equal(answer.status, 200);
	const said = JSON.parse(answer.body);
	assert.equal(said.opener, "test-browser");
	assert.equal(said.selected, true);
	assert.match(said.file, /pi-studio[/\\]a-note-on-disk-abcdef\.pdf$/);
	assert.ok(readFileSync(said.file).toString("latin1").startsWith("%PDF-1.4"), "what landed is a pdf");
	// The file is the one this test asked for, and nothing else in the folder is touched.
	rmSync(said.file, { force: true });
});

test("a browser that takes a file is handed the file, and one that cannot opens the folder", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-reveal-"));
	// Two stand-ins for a file browser: one says it offers `--select`, the other says nothing at all.
	const picky = join(folder, "picky");
	writeFileSync(picky, "#!/bin/sh\necho '  -s, --select  Select specified URI in parent folder.'\n", { mode: 0o755 });
	const plain = join(folder, "plain");
	writeFileSync(plain, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

	const choosing = await revealFile("/tmp/pi-studio/a-note.pdf", (name) => (name === "nautilus" ? picky : ""));
	assert.deepEqual(choosing, { program: "nautilus", selected: true }, "the browser that offers the flag gets the file");

	const opening = await revealFile("/tmp/pi-studio/a-note.pdf", (name) =>
		name === "nautilus" ? plain : name === "xdg-open" ? plain : "",
	);
	assert.equal(opening.selected, false, "a browser without the flag is given the folder");
	assert.ok(opening.program, "and the answer still names what opened");

	const asked: string[] = [];
	const nothing = await revealFile("/tmp/pi-studio/a-note.pdf", (name) => {
		asked.push(name);
		return "";
	});
	assert.deepEqual(nothing, { program: "", selected: false }, "a machine with no browser opens nothing");
	assert.ok(asked.includes("xdg-open"), "and the last thing it asks for is the folder itself");
	rmSync(folder, { recursive: true, force: true });
});

test("a card that is not a note is refused, and so is an id nobody holds", async () => {
	const source = { id: "aaaaaa111111", type: "source", title: "a file", path: "src/a.ts" };
	const wrong = wire({ cardId: source.id });
	await cardPdf(wrong.req, wrong.res, board([source]), async () => ({ program: "", selected: false }));
	await wrong.done;
	assert.equal(wrong.status, 409);

	const missing = wire({ cardId: "nobody" });
	await cardPdf(missing.req, missing.res, board([]), async () => ({ program: "", selected: false }));
	await missing.done;
	assert.equal(missing.status, 409);
});
