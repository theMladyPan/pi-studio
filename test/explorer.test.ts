import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The files explorer's decisions, exercised.
 *
 * The explorer lives in the board's page, so there is no module to import. Instead the block the client
 * marks as the explorer's own — from its opening banner to the one that closes it — is read out of
 * `public/client/board.js` and run here. It is written to call nothing of the board's while it is being
 * defined, so the functions the drawer runs are the ones under test rather than a copy of them.
 *
 * What that leaves uncovered is the paint: the rows, the menu's placement and the fonts. Those are
 * checked by eye, and this file says so rather than pretending otherwise.
 */

const BOARD = new URL("../public/client/board.js", import.meta.url);
const HTML = new URL("../public/index.html", import.meta.url);

/** The explorer's own block, as the page loads it. Its shape is the page's, which has no types. */
function loadCore(): any {
	const source = readFileSync(BOARD, "utf8");
	const start = source.indexOf("// ---------- explorer: the decisions ---");
	const end = source.indexOf("// ---------- explorer: the decisions end ---");
	assert.ok(start >= 0 && end > start, "the explorer core is marked off in public/client/board.js");
	const body = source.slice(start, end);
	// One function, so the block keeps its own consts and hands back exactly what the page uses.
	return new Function(`${body}\nreturn explorerCore;`)();
}

const core: any = loadCore();

/** The entry a listing holds for one name. */
const entry = (path: string, dir = false, git = "") => ({
	name: path.slice(path.lastIndexOf("/") + 1),
	path,
	dir,
	size: 0,
	mtime: 0,
	link: false,
	git,
});

/** One page of a folder, in the shape `/files` answers with. */
const page = (entries: ReturnType<typeof entry>[], extra: Record<string, unknown> = {}) => ({
	root: "/work/project",
	path: "",
	parent: null,
	canonical: "",
	entries,
	total: entries.length,
	...extra,
});

// ---------------------------------------------------------------- drawers

test("f, a and c each open their own drawer, and pressing one again rolls it up", () => {
	const drawers = core.drawers();
	assert.equal(drawers.open, "", "the column starts shut");
	core.drawerOpen(drawers, "files");
	assert.equal(drawers.open, "files");
	core.drawerToggle(drawers, "activity");
	assert.equal(drawers.open, "activity", "opening another rolls the first one up");
	core.drawerToggle(drawers, "activity");
	assert.equal(drawers.open, "", "the same key rolls it back up");
	core.drawerToggle(drawers, "cards");
	assert.equal(drawers.open, "cards");
	core.drawerClose(drawers);
	assert.equal(drawers.open, "");
});

test("a plain f is the files drawer, and shift+f is the fit it took from plain f", () => {
	assert.equal(core.boardLetter("f"), "files");
	assert.equal(core.boardLetter("f", { shift: true }), "fit");
	assert.equal(core.boardLetter("F", { shift: true }), "fit", "a shifted key arrives upper case");
	assert.equal(core.boardLetter("F"), "fit", "the capital is the shifted key, whatever the event says");
	assert.equal(core.boardLetter("a"), "activity");
	assert.equal(core.boardLetter("c"), "cards");
	// Nothing else is taken by this list, so the board's other letters reach their own handlers.
	for (const key of ["0", "m", "n", "o", "t", "g", "q", "p", "r"]) assert.equal(core.boardLetter(key), "", key);
});

test("a letter waits while a field is typed in, a panel is open or the drawer's own surface is up", () => {
	for (const lock of ["typing", "panel", "surface"]) {
		assert.equal(core.boardLetter("f", { [lock]: true }), "", `f waits for ${lock}`);
		assert.equal(core.boardLetter("f", { [lock]: true, shift: true }), "", `shift+f waits for ${lock}`);
		assert.equal(core.boardLetter("a", { [lock]: true }), "", `a waits for ${lock}`);
		assert.equal(core.boardLetter("c", { [lock]: true }), "", `c waits for ${lock}`);
	}
	// And a shifted letter the list does not own does nothing rather than falling through.
	assert.equal(core.boardLetter("m", { shift: true }), "");
});

test("Escape works down one order: a name or a menu, a sheet, the git graph, the drawer, then the card", () => {
	assert.equal(core.escapeTarget({}), "");
	assert.equal(core.escapeTarget({ card: true }), "card");
	assert.equal(core.escapeTarget({ drawer: true, card: true }), "drawer");
	assert.equal(core.escapeTarget({ git: true, drawer: true }), "git");
	assert.equal(core.escapeTarget({ sheet: true, git: true }), "sheet");
	assert.equal(core.escapeTarget({ rename: true, menu: true, sheet: true }), "menu");
	assert.equal(core.escapeTarget({ rename: true, card: true }), "rename");
});

// ---------------------------------------------------------------- the tree

test("a folder is sorted the way the explorer shows it: folders first, then names people can read", () => {
	const sorted = core
		.sortEntries([
			{ path: "b.txt", name: "b.txt", dir: false },
			{ path: "Folder10", name: "Folder10", dir: true },
			{ path: "Folder2", name: "Folder2", dir: true },
			{ path: "a.txt", name: "a.txt", dir: false },
			{ path: "file10.md", name: "file10.md", dir: false },
			{ path: "file2.md", name: "file2.md", dir: false },
		])
		.map((one) => one.path);
	assert.deepEqual(sorted, ["Folder2", "Folder10", "a.txt", "b.txt", "file2.md", "file10.md"]);
});

test(".git is never listed and a dot folder such as .agents is", () => {
	const listing = core.listing();
	core.listingStart(listing, "");
	core.listingPage(listing, listing.seq, page([entry(".git", true), entry(".agents", true), entry("src", true)]));
	assert.deepEqual(
		listing.entries.map((one) => one.path),
		[".agents", "src"],
	);
});

test("a folder of more than one page is read whole, once each, and in order", () => {
	const listing = core.listing();
	const ticket = core.listingStart(listing, "");
	// 250 names, 200 in the first page and 50 in the second.
	const all = Array.from({ length: 250 }, (_, at) => `f${String(at).padStart(3, "0")}.txt`);
	const accepted = core.listingPage(
		listing,
		ticket,
		page(all.slice(0, 200).map((one) => entry(one)), { total: 250, next: "f199.txt", truncated: true }),
	);
	assert.equal(accepted, true);
	assert.equal(listing.entries.length, 200);
	assert.equal(listing.next, "f199.txt");
	assert.equal(listing.truncated, true, "a truncated listing is known for what it is");
	core.listingPage(listing, ticket, page(all.slice(200).map((one) => entry(one)), { total: 250, next: null }));
	assert.equal(listing.entries.length, 250, "every page is consumed");
	assert.equal(listing.state, "ready");
	assert.equal(listing.next, null);
	assert.equal(listing.total, 250);
	// A name that arrived twice is one row, not two.
	core.listingPage(listing, ticket, page([entry("f001.txt")], { total: 250 }));
	assert.equal(listing.entries.length, 250);
	assert.deepEqual(
		listing.entries.slice(0, 3).map((one) => one.name),
		["f000.txt", "f001.txt", "f002.txt"],
	);
});

test("a page from a folder already left is dropped rather than merged", () => {
	const listing = core.listing();
	const stale = core.listingStart(listing, "src");
	// The human walked to another folder: the listing starts again, and the old ticket is history.
	const fresh = core.listingStart(listing, "docs");
	assert.equal(core.listingPage(listing, stale, page([entry("src/old.ts")])), false);
	assert.deepEqual(listing.entries, []);
	assert.equal(core.listingPage(listing, fresh, page([entry("docs/readme.md")])), true);
	assert.deepEqual(
		listing.entries.map((one) => one.path),
		["docs/readme.md"],
	);
});

test("a refresh keeps the selection that still exists and lets go of the rest", () => {
	const sel = core.selection();
	core.select(sel, "src/index.ts");
	sel.paths.add("src/gone.ts");
	sel.paths.add("src/lib/util.ts");
	sel.lead = "src/gone.ts";
	const gone = core.selectKeep(sel, new Set(["src/index.ts", "src/lib/util.ts"]));
	assert.deepEqual(gone, ["src/gone.ts"]);
	assert.deepEqual([...sel.paths].sort(), ["src/index.ts", "src/lib/util.ts"]);
	assert.equal(sel.lead, "", "a lead that vanished has no row to stand on");
});

test("selecting is one row, ctrl adds a row, shift takes the range, and ctrl+a the lot", () => {
	const order = ["a.ts", "b.ts", "c.ts", "d.ts"];
	const sel = core.selection();
	core.select(sel, "b.ts");
	assert.deepEqual([...sel.paths], ["b.ts"]);
	core.selectToggle(sel, "d.ts");
	assert.deepEqual([...sel.paths].sort(), ["b.ts", "d.ts"]);
	core.select(sel, "b.ts");
	core.selectRange(sel, order, "d.ts");
	assert.deepEqual([...sel.paths], ["b.ts", "c.ts", "d.ts"]);
	core.selectAll(sel, order);
	assert.deepEqual([...sel.paths], order);
	assert.equal(sel.lead, "d.ts");
});

// ---------------------------------------------------------------- paths and drags

test("a path from a page or a payload is cleaned, and one that walks out of the workspace is refused", () => {
	assert.equal(core.cleanPath("src/lib/util.ts"), "src/lib/util.ts");
	assert.equal(core.cleanPath("./src//lib/"), "src/lib");
	assert.equal(core.cleanPath("src/lib/../main.ts"), "src/main.ts");
	assert.equal(core.cleanPath(""), "");
	assert.equal(core.cleanPath("../../etc/passwd"), null);
	assert.equal(core.cleanPath("a/../../b"), null);
	assert.equal(core.cleanPath("a\u0000b"), null);
	assert.equal(core.cleanPath(42), null);
});

test("a drag from this tree reads as paths, and one from another workspace or outside it is refused", () => {
	const payload = core.dragPayload("b08b6688", [
		{ path: "src/index.ts", dir: false },
		{ path: "src/lib", dir: true },
	]);
	const read = core.readDrag(payload, "b08b6688");
	assert.equal(read.ok, true);
	assert.deepEqual(read.paths, [
		{ path: "src/index.ts", dir: false },
		{ path: "src/lib", dir: true },
	]);

	const elsewhere = core.readDrag(payload, "00000000");
	assert.equal(elsewhere.ok, false);
	assert.match(elsewhere.reason, /another workspace/);

	const outside = core.readDrag(JSON.stringify({ workspace: "b08b6688", paths: [{ path: "../secrets" }] }), "b08b6688");
	assert.equal(outside.ok, false);
	assert.match(outside.reason, /outside the workspace/);

	const absolute = core.readDrag(JSON.stringify({ workspace: "b08b6688", paths: [{ path: "/etc/shadow" }] }), "b08b6688");
	assert.equal(absolute.ok, false, "an absolute payload path never leaves as one");

	assert.equal(core.readDrag("", "b08b6688").ok, false);
	assert.equal(core.readDrag(JSON.stringify({ workspace: "b08b6688", paths: [] }), "b08b6688").ok, false);

	// A drag of bytes from the desktop is the composer's own upload, never a reference.
	assert.equal(core.dragKind(["Files"]), "os");
	assert.equal(core.dragKind([core.PATH_MIME, "Files"]), "path", "the tree's own drag wins");
	assert.equal(core.dragKind(["text/plain"]), "");
});

// ------------------------------------------------- a message's references

test("a path dragged onto a thread joins that message once, and nothing is sent", () => {
	const picked = new Map();
	const root = "/work/project";
	const first = core.attachRefs(picked, root, [{ path: "src/index.ts", dir: false }]);
	assert.deepEqual(first, { added: 1, known: 0 });
	assert.equal(picked.get("/work/project/src/index.ts").dir, false);
	// The same file again is a reference already there, not a second chip.
	const again = core.attachRefs(picked, root, [
		{ path: "src/index.ts", dir: false },
		{ path: "src/lib", dir: true },
	]);
	assert.deepEqual(again, { added: 1, known: 1 });
	assert.equal(picked.size, 2);
	assert.equal(picked.get("/work/project/src/lib").dir, true);
	// A reference is an entry in this map and nothing else: the core holds no sender, so attaching
	// cannot have sent, uploaded or moved anything.
	assert.deepEqual([...picked.keys()].sort(), ["/work/project/src/index.ts", "/work/project/src/lib"]);
});

test("a rename or a move rewrites the references that named the old path, and a delete flags them", () => {
	const picked = new Map([["/work/project/old/a.ts", { dir: false, missing: false }]]);
	core.attachRefs(picked, "/work/project", [{ path: "other/b.ts", dir: false }]);
	const moved = core.retargetRefs(picked, "/work/project", "old", "new/nested");
	assert.equal(moved.length, 1);
	assert.ok(picked.has("/work/project/new/nested/a.ts"));
	assert.ok(!picked.has("/work/project/old/a.ts"));
	assert.ok(picked.has("/work/project/other/b.ts"), "the reference that was not renamed stays");
	const marked = core.markMissing(picked, "/work/project", ["other"]);
	assert.equal(marked, 1);
	assert.equal(picked.get("/work/project/other/b.ts").missing, true);
	assert.equal(picked.get("/work/project/new/nested/a.ts").missing, false);
});

test("a path is named relative to the board's root, and one outside it stays absolute", () => {
	assert.equal(core.absolute("/work/project", "src/index.ts"), "/work/project/src/index.ts");
	assert.equal(core.relative("/work/project", "/work/project/src/index.ts"), "src/index.ts");
	assert.equal(core.relative("/work/project/", "/work/project/src/index.ts"), "src/index.ts");
	assert.equal(core.relative("/work/project", "/somewhere/else/x.ts"), null);
});

// ---------------------------------------------------------------- clipboard

test("cut and copy are in-app state, and a folder never lands inside itself", () => {
	const clip = core.clipboard();
	assert.equal(core.pasteTrouble(clip, ""), "nothing is on the file clipboard");
	core.clipSet(clip, "cut", ["src"]);
	assert.equal(clip.mode, "cut");
	assert.equal(clip.paths.length, 1);
	assert.equal(core.pasteTrouble(clip, "src/lib"), "a folder cannot go inside itself");
	assert.equal(core.pasteTrouble(clip, "src"), "a folder cannot go inside itself");
	assert.equal(core.pasteTrouble(clip, ""), "that is where it already is", "a cut into its own folder is a no-op");
	core.clipSet(clip, "copy", ["src"]);
	assert.equal(core.pasteTrouble(clip, "docs"), "", "a copy elsewhere can land");
	assert.equal(core.pasteTrouble(clip, "src/inner"), "a folder cannot go inside itself");
});

test("Copy Path uses the browser clipboard, and the selection trick when the page has none", async () => {
	const written = [];
	await core.copyText("/work/project/a.ts", { writeText: (text) => written.push(text) });
	assert.deepEqual(written, ["/work/project/a.ts"]);

	// A board reached over plain http is not a secure context: `navigator.clipboard` is absent, so the
	// text is selected and the browser is asked to copy that selection.
	const selected = [];
	await core.copyText("src/a.ts", { selectCopy: (text) => selected.push(text) });
	assert.deepEqual(selected, ["src/a.ts"]);

	await assert.rejects(() => core.copyText("src/a.ts", {}), /no clipboard/);
});

// ---------------------------------------------------------------- deletion

test("a partial delete is read for what happened, and only the trash's refusals are asked about again", () => {
	const result = core.deleteResult(207, {
		deleted: ["src/a.ts"],
		trashed: true,
		needsPermanent: ["vendor/big.bin"],
		failed: [{ path: "build/locked", error: "permission denied" }],
	});
	assert.equal(result.partial, true);
	assert.deepEqual(result.deleted, ["src/a.ts"]);
	assert.deepEqual(result.needsPermanent, ["vendor/big.bin"]);
	assert.deepEqual(result.failed, [{ path: "build/locked", error: "permission denied" }]);
	// The permanent pass takes the refusals, and never a name that already went or already failed.
	assert.deepEqual(core.permanentPaths(result), ["vendor/big.bin"]);
});

test("a name reported as both gone and refused is not asked for twice", () => {
	const result = core.deleteResult(207, { deleted: ["a"], needsPermanent: ["a", "b"], failed: [{ path: "b", error: "no" }] });
	assert.deepEqual(core.permanentPaths(result), [], "a deleted name is not resent, and a failed one gave its reason");
});

test("a 200 delete with nothing refused asks for nothing permanent", () => {
	const result = core.deleteResult(200, { deleted: ["src/a.ts", "src/b.ts"], trashed: true, needsPermanent: [] });
	assert.equal(result.partial, false);
	assert.equal(result.deleted.length, 2);
	assert.deepEqual(core.permanentPaths(result), []);
});

// ---------------------------------------------------------------- names

test("a name is checked before anything is made with it", () => {
	assert.equal(core.nameTrouble("notes.md"), "");
	assert.equal(core.nameTrouble("notes.md".toUpperCase()), "");
	assert.match(core.nameTrouble(""), /name is needed/);
	assert.match(core.nameTrouble("   "), /name is needed/);
	assert.match(core.nameTrouble("."), /not a name/);
	assert.match(core.nameTrouble(".."), /not a name/);
	assert.match(core.nameTrouble("a/b"), /no slash/);
	assert.match(core.nameTrouble(".git"), /repository/);
	assert.match(core.nameTrouble("x".repeat(256)), /too long/);
});

// ---------------------------------------------------------------- the icon

test("a file wears the Seti theme's own glyph, and a folder wears the codicon VS Code draws", () => {
	const theme = {
		file: "_default",
		fileNames: { "readme.md": "_info", "tsconfig.json": "_tsconfig" },
		fileExtensions: { ts: "_typescript", md: "_markdown", "spec.ts": "_typescript_test" },
		iconDefinitions: {
			_default: { fontCharacter: "\\E023", fontColor: "#d4d7d6" },
			_info: { fontCharacter: "\\E012", fontColor: "#519aba" },
			_tsconfig: { fontCharacter: "\\E015" },
			_typescript: { fontCharacter: "\\E020", fontColor: "#519aba" },
			_typescript_test: { fontCharacter: "\\E021", fontColor: "#519aba" },
			_markdown: { fontCharacter: "\\E031" },
		},
	};
	assert.deepEqual(core.icon(theme, { name: "readme.md", dir: false }), { glyph: "\uE012", color: "#519aba" });
	assert.equal(core.icon(theme, { name: "a.spec.ts", dir: false }).glyph, "\uE021", "the longest extension wins");
	assert.equal(core.icon(theme, { name: "main.ts", dir: false }).glyph, "\uE020");
	assert.equal(core.icon(theme, { name: "notes", dir: false }).glyph, "\uE023", "an unknown name takes the default");
	assert.equal(core.icon(theme, { name: "src", dir: true }), null, "a folder is not the theme's to draw");
	assert.equal(core.icon(null, { name: "a.ts", dir: false }), null, "no theme read yet is no icon");
});

// ---------------------------------------------------------------- git

test("Git's two letters become the one colour and the one badge a row shows", () => {
	assert.equal(core.gitKind(" M"), "modified");
	assert.equal(core.gitKind("??"), "untracked");
	assert.equal(core.gitKind("A "), "untracked");
	assert.equal(core.gitKind(" D"), "deleted");
	assert.equal(core.gitKind("UU"), "conflicting");
	assert.equal(core.gitKind("!!"), "ignored");
	assert.equal(core.gitKind(""), "");
	assert.equal(core.gitBadge(" M"), "M");
	assert.equal(core.gitBadge("??"), "?");
	assert.equal(core.gitBadge(""), "");
});

// ---------------------------------------------------------------- the page

test("the three drawers and the tree exist in the page, and the old picker is gone", () => {
	const html = readFileSync(HTML, "utf8");
	for (const id of ["drawerFiles", "drawerActivity", "drawerCards", "exTree", "exFilter", "exMenu", "exConfirm", "pickCount"]) {
		assert.ok(html.includes(`id="${id}"`), `#${id} is in the page`);
	}
	for (const gone of ['id="picker"', 'id="pickList"', 'id="pickFilter"', 'id="pickHidden"', 'id="railOpen"']) {
		assert.ok(!html.includes(gone), `${gone} is gone with the picker`);
	}
	const board = readFileSync(BOARD, "utf8");
	for (const dangling of ["picker.hidden", "closePicker", "drawList(", "getElementById(\"picker\")", "railShown(", "railOpenCount"]) {
		assert.ok(!board.includes(dangling), `no dangling picker or rail guard: ${dangling}`);
	}
});

test("the keys panel says what the keys do, including f as the drawer and shift+f as the fit", () => {
	const board = readFileSync(BOARD, "utf8");
	assert.ok(board.includes('{ keys: "f", does: "open the files drawer, and press it again to roll it up" }'));
	assert.ok(board.includes('{ keys: "a", does: "open the activity drawer, and press it again to roll it up" }'));
	assert.ok(board.includes('{ keys: "c", does: "open the cards drawer, and press it again to roll it up" }'));
	assert.ok(board.includes('{ keys: "shift+f", does: "fit every card on the screen" }'));
	assert.ok(!board.includes('{ keys: "f", does: "fit every card on the screen" }'), "f no longer claims the fit");
	// The map button still names its own key, which the project's own rule asks for.
	const html = readFileSync(HTML, "utf8");
	assert.ok(html.includes('id="mapBtn" aria-pressed="true" title="hide the board overview (m)"'));
});
