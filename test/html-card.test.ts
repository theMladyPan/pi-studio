import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The frame an HTML page is drawn in, exercised.
 *
 * The frame lives in the board's page, so there is no module to import. Instead the block from
 * `htmlFrame` to the questions body is read out of `public/client/board.js` and run here, with the
 * page's node maker stood in: what is checked is the real frame the card and the editor draw, not a
 * copy of it — its sandbox, its document, the cache a repaint reads back, and the secret a card's
 * frame load makes for its bridge. The changed gate that decides whether a card is repainted at all
 * is read out the same way, so a page revised into its card is checked against the real gate too.
 * So is the choice of body, so an html card is drawn as a page and a note as a note in the same run.
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
	listeners: Record<string, () => void>;
	contentWindow: { posted: unknown[]; postMessage(message: unknown, origin: string): void } | null;
	setAttribute(name: string, value: string): void;
	addEventListener(name: string, handler: () => void): void;
};
type Entry = { htmlFrame?: Frame; htmlContent?: string; htmlNonce?: string };
type Data = { html: string; title?: string; id?: string };
type Card = Record<string, unknown>;

/** The frame block, as the page loads it, over a node maker that makes nothing. */
function load(): { htmlFrame: (content: string, title: string) => Frame; htmlBody: (data: Data, entry: Entry) => Frame; bridges: Map<string, unknown> } {
	const source = readFileSync(BOARD, "utf8");
	const start = source.indexOf("function htmlFrame(");
	const end = source.indexOf("/**\n * The questions a card asks");
	assert.ok(start >= 0 && end > start, "the frame block is marked off in public/client/board.js");
	const el = (tag: string): Frame => ({
		tag,
		title: "",
		attrs: {},
		listeners: {},
		contentWindow: null,
		setAttribute(name, value) {
			this.attrs[name] = value;
		},
		addEventListener(name, handler) {
			this.listeners[name] = handler;
		},
	});
	const win = { addEventListener() {} };
	const loaded = new Function("el", "window", "auth", `${source.slice(start, end)}\nreturn { htmlFrame, htmlBody, bridges: htmlBridges };`)(el, win, "");
	return { htmlFrame: loaded.htmlFrame, htmlBody: loaded.htmlBody, bridges: loaded.bridges };
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
	const frame = htmlFrame("<h1>hi</h1>", "page");
	assert.equal(frame.tag, "iframe");
	assert.equal(frame.attrs.sandbox, "allow-scripts");
	assert.equal(frame.srcdoc, "<h1>hi</h1>");
	assert.equal(frame.title, "page");
});

test("an html card keeps one frame while its page stands, and draws anew when the page changes", () => {
	const { htmlBody, bridges } = load();
	const entry: Entry = {};
	const page = { html: "<p>first</p>", title: "page", id: "c1" };
	const again = { html: "<p>first</p>", title: "page", id: "c1" };
	const changed = { html: "<p>second</p>", title: "page", id: "c1" };

	const first = htmlBody(page, entry);
	assert.equal(htmlBody(again, entry), first, "a repaint reads the same frame back");
	assert.equal(htmlBody(page, entry), first);
	assert.ok(entry.htmlNonce, "a load made its bridge secret");
	assert.ok(bridges.has(entry.htmlNonce as string), "the secret is registered for that load");

	const second = htmlBody(changed, entry);
	assert.notEqual(second, first, "new words draw a new page");
	assert.equal(entry.htmlContent, "<p>second</p>");
	assert.equal(htmlBody(changed, entry), second);
});

test("a new page load makes a new bridge secret, and the old one stops being believed", () => {
	const { htmlBody, bridges } = load();
	const entry: Entry = {};
	htmlBody({ html: "<p>first</p>", id: "c1" }, entry);
	const oldNonce = entry.htmlNonce as string;
	htmlBody({ html: "<p>second</p>", id: "c1" }, entry);
	assert.notEqual(entry.htmlNonce, oldNonce);
	assert.equal(bridges.has(oldNonce), false);
	assert.ok(bridges.has(entry.htmlNonce as string));
});

// ----------------------------------------------------------- the body choice

/** What a body looks like to the choice: a body is a node with the class the card wears. */
type Body = { node: unknown; cls: string };

/** The body choice, as the page loads it, over the real frame builder and stub bodies. */
function loadBodyFor(): (data: Record<string, unknown>, entry: Entry) => Body {
	const source = readFileSync(BOARD, "utf8");
	const bodyStart = source.indexOf("function bodyFor(");
	const bodyEnd = source.indexOf("// ---------- cards ---");
	assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, "the choice block is marked off in public/client/board.js");
	const { htmlBody } = load();
	const stickyBody = () => "sticky";
	const questionBody = () => "question";
	const renderMarkdown = () => "note";
	const detailsBlock = () => "details";
	return new Function(
		"stickyBody",
		"questionBody",
		"renderMarkdown",
		"detailsBlock",
		"htmlBody",
		`${source.slice(bodyStart, bodyEnd)}\nreturn bodyFor;`,
	)(stickyBody, questionBody, renderMarkdown, detailsBlock, htmlBody);
}

test("an html card draws the frame, and a note never draws one", () => {
	const bodyFor = loadBodyFor();
	const page = bodyFor({ type: "html", html: "<h1>x</h1>", title: "page" }, {});
	assert.equal(page.cls, "html-body");
	assert.equal((page.node as Frame).attrs.sandbox, "allow-scripts");
	assert.equal((page.node as Frame).srcdoc, "<h1>x</h1>");
	const note = bodyFor({ type: "note", markdown: "hi" }, {});
	assert.equal(note.cls, "note-body");
	assert.equal(note.node, "note");
});

// ------------------------------------------------------- the changed gate

test("a page revised into its card is news when its words moved", () => {
	const { cardChanged } = loadGate();
	const held: Card = { type: "html", title: "page", html: "<p>first</p>" };
	assert.equal(cardChanged(held, { ...held, html: "<p>second</p>" }), true, "new words are redrawn");
	// A broadcast that moved nothing on the card is still not news, and no repaint wipes a selection.
	assert.equal(cardChanged(held, { ...held, updatedAt: Date.now() }), false, "a stamp alone is not news");
});
