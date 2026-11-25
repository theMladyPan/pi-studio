import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * A note's download press, exercised.
 *
 * The press lives in the board's page, so there is no module to import. Instead the block from
 * `downloadName` to the rename helper is read out of `public/client/board.js` and run here, with the
 * page's own globals (`fetch`, the object urls, the footnote and the link maker) stood in. What is
 * checked is the real functions the button calls, not a copy of them: both files are pressed, they share
 * one stem, and a pdf that fails leaves no lone markdown behind.
 *
 * What that leaves uncovered is the paint: the button itself and the browser's own download list. Those
 * are checked by eye.
 */

const BOARD = new URL("../public/client/board.js", import.meta.url);

type Saved = { download: string; type: string };
type Entry = { id: string; data: { markdown: string }; head: { querySelector(select: string): unknown } };

type Core = {
	download(entry: Entry): Promise<void>;
	saved: Saved[];
	notes: { text: string; error: boolean }[];
	button: { disabled: boolean; classList: { add(name: string): void; remove(name: string): void } };
};

/** The download block, as the page loads it. `ok` decides what the daemon answers on the pdf press. */
function load(ok: boolean): Core {
	const source = readFileSync(BOARD, "utf8");
	const start = source.indexOf("function downloadName(");
	const end = source.indexOf("/** Give a card the name");
	assert.ok(start >= 0 && end > start, "the download block is marked off in public/client/board.js");
	const saved: Saved[] = [];
	const notes: { text: string; error: boolean }[] = [];
	const button = { disabled: false, classList: { add: () => {}, remove: () => {} } };
	const el = () => ({
		href: "",
		download: "",
		click(this: { download: string; href: string }) {
			saved.push({ download: this.download, type: this.href });
		},
		remove() {},
	});
	const fetchFn = async () =>
		ok
			? {
					ok: true,
					headers: { get: () => 'attachment; filename="my-note-abc123.pdf"' },
					blob: async () => new Blob(["%PDF-fake"], { type: "application/pdf" }),
					text: async () => "",
				}
			: { ok: false, status: 409, text: async () => "no such card" };
	const footNote = (text: string, error = false) => notes.push({ text, error });
	const urls = { createObjectURL: (blob: Blob) => `blob:${blob.type}`, revokeObjectURL: () => {} };
	// One function, so the block keeps its own helpers and hands back the one the button calls. The
	// parameters are the seam: each is a global the page owns, stood in here.
	const download = new Function(
		"el",
		"document",
		"URL",
		"auth",
		"fetch",
		"footNote",
		"setTimeout",
		`${source.slice(start, end)}\nreturn downloadCard;`,
	)(
		el,
		{ body: { appendChild() {} } },
		urls,
		"t=x",
		fetchFn,
		footNote,
		() => 0,
	) as (entry: Entry) => Promise<void>;
	return { download, saved, notes, button };
}

/** A note card as the press reads it. */
const entry = (): Entry => ({
	id: "abc123",
	data: { markdown: "# Hello\n\nsource words\n" },
	head: { querySelector: () => null },
});

// ---------------------------------------------------------------- download

test("the button says what it saves: both files", () => {
	const source = readFileSync(BOARD, "utf8");
	assert.ok(source.includes('title="download this note as .md and .pdf"'), "the title names both files");
});

test("one press downloads the markdown and the pdf, under one stem", async () => {
	const core = load(true);
	await core.download(entry());
	assert.deepEqual(
		core.saved.map((one) => one.download),
		["my-note-abc123.md", "my-note-abc123.pdf"],
		"both files are pressed, the markdown first",
	);
	assert.ok(core.saved[0].type.startsWith("blob:text/markdown"), "the first is the markdown blob");
	assert.ok(core.saved[1].type.startsWith("blob:application/pdf"), "the second is the pdf blob");
	assert.ok(
		core.notes[0].text.includes("my-note-abc123.md") && core.notes[0].text.includes("my-note-abc123.pdf"),
		"the footnote names both files",
	);
});

test("a pdf that fails leaves no lone markdown behind", async () => {
	const core = load(false);
	await core.download(entry());
	assert.deepEqual(core.saved, [], "nothing is pressed when the daemon refuses");
	assert.equal(core.notes[0].error, true, "the refusal is said as an error");
});
