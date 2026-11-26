import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The frame an HTML page is drawn in, exercised.
 *
 * The frame lives in the board's page, so there is no module to import. Instead the block from
 * `htmlFrame` to the code-view banner is read out of `public/client/board.js` and run here, with the
 * page's node maker stood in: what is checked is the real frame the card and the editor draw, not a
 * copy of it — its sandbox, its document and the cache a repaint reads back. The changed gate that
 * decides whether a card is repainted at all is read out the same way, so the words a file reopened
 * into its card carries are checked against the real gate too.
 *
 * What that leaves uncovered is the paint: the card's body taking the frame and the page's own
 * rendering inside it. Those are checked by eye, and this file says so rather than pretending otherwise.
 */

const BOARD = new URL("../public/client/board.js", import.meta.url);

/** One element as the frame builder reads it: a tag, a title, attributes and the document text. */
type Frame = {
	tag: string;
	title: string;
	attrs: Record<string, string>;
	srcdoc?: string;
	setAttribute(name: string, value: string): void;
};
type Entry = { htmlFrame?: Frame; htmlContent?: string };
type Data = { content: string; path?: string; title?: string };
type Card = Record<string, unknown>;

/** The frame block, as the page loads it, over a node maker that makes nothing. */
function load(): { htmlFrame: (content: string, title: string) => Frame; htmlBody: (data: Data, entry: Entry) => Frame } {
	const source = readFileSync(BOARD, "utf8");
	const start = source.indexOf("function htmlFrame(");
	const end = source.indexOf("/** Virtualized code view");
	assert.ok(start >= 0 && end > start, "the frame block is marked off in public/client/board.js");
	const el = (tag: string): Frame => ({
		tag,
		title: "",
		attrs: {},
		setAttribute(name, value) {
			this.attrs[name] = value;
		},
	});
	return new Function("el", `${source.slice(start, end)}\nreturn { htmlFrame, htmlBody };`)(el);
}

/** The gate a repaint passes through, as the page loads it: a card is repainted only when this says so. */
function loadGate(): { cardChanged: (before: Card, after: Card) => boolean } {
	const source = readFileSync(BOARD, "utf8");
	const start = source.indexOf("function cardChanged(");
	const end = source.indexOf("function markUpdated");
	assert.ok(start >= 0 && end > start, "the card-changed gate is marked off in public/client/board.js");
	return new Function(`${source.slice(start, end)}\nreturn { cardChanged };`)();
}

// ---------------------------------------------------------------- the frame

test("the frame is sandboxed with scripts alone, so the page has no origin of its own", () => {
	const { htmlFrame } = load();
	const frame = htmlFrame("<h1>hi</h1>", "page.html");
	assert.equal(frame.tag, "iframe");
	assert.equal(frame.attrs.sandbox, "allow-scripts");
	assert.equal(frame.srcdoc, "<h1>hi</h1>");
	assert.equal(frame.title, "page.html");
});

test("a card keeps one frame while its content stands, and draws anew when the file changes", () => {
	const { htmlBody } = load();
	const entry: Entry = {};
	const page = { content: "<p>first</p>", path: "page.html" };
	const again = { content: "<p>first</p>", title: "page.html" };
	const changed = { content: "<p>second</p>", path: "page.html" };

	const first = htmlBody(page, entry);
	assert.equal(htmlBody(again, entry), first, "a repaint reads the same frame back");
	assert.equal(htmlBody(page, entry), first);

	const second = htmlBody(changed, entry);
	assert.notEqual(second, first, "new words draw a new page");
	assert.equal(entry.htmlContent, "<p>second</p>");
	assert.equal(htmlBody(changed, entry), second);
});

test("a card with no path names the frame by its title, and the kind decides the body", () => {
	const { htmlBody } = load();
	const entry: Entry = {};
	const frame = htmlBody({ content: "<p>x</p>", title: "page" }, entry);
	assert.equal(frame.title, "page");
});

// ------------------------------------------------------- the changed gate

test("a file re-opened into its card is news when its words or its hit line moved", () => {
	const { cardChanged } = loadGate();
	// A file is opened again into the card it already holds with the same title and path, and only
	// its words or the line it lands on moved — the whole point of opening it again.
	const held: Card = { type: "source", title: "page.html", path: "page.html", content: "<p>first</p>", line: 5 };
	assert.equal(cardChanged(held, { ...held, content: "<p>second</p>" }), true, "new words are redrawn");
	assert.equal(cardChanged(held, { ...held, line: 9 }), true, "a new hit line is redrawn");
	// A broadcast that moved nothing on the card is still not news, and no repaint wipes a selection.
	assert.equal(cardChanged(held, { ...held, updatedAt: Date.now() }), false, "a stamp alone is not news");
});
