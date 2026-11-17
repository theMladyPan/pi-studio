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

// The shapes the explorer's block deals in, named here once. The page itself carries no types, so these
// interfaces are the seam between it and this file: every call below is checked against them.

/** One row of a folder, as `/files` names it. */
type ExEntry = { name: string; path: string; dir: boolean; size: number; mtime: number; link: boolean; git: string };

/** One folder's listing, as the drawer keeps it while the pages land. */
type ExListing = {
	seq: number;
	parent: string;
	entries: ExEntry[];
	seen: Set<string>;
	total: number;
	truncated: boolean;
	next: string | null;
	root: string;
	repo: boolean;
	dirty: string[];
	dirtyTruncated: boolean;
	state: string;
	trouble: string;
};

/** One page of a folder, in the shape `/files` answers with. */
type ExPage = {
	root?: string;
	path?: string;
	parent?: string | null;
	canonical?: string;
	entries?: ExEntry[];
	total?: number;
	next?: string | null;
	truncated?: boolean;
	repo?: boolean;
	dirty?: string[];
	dirtyTruncated?: boolean;
};

type ExSelection = { paths: Set<string>; anchor: string; lead: string };
type ExClip = { mode: string; paths: string[] };
type ExRef = { dir: boolean; missing: boolean };
type ExDraft = { dir: string; asDir: boolean; name?: string };
type ExPorts = { writeText?: (text: string) => unknown; selectCopy?: (text: string) => unknown };
type ExIcon = { glyph: string; color: string };
type ExSortable = { path: string; name: string; dir?: boolean };
type ExDeleteResult = {
	deleted: string[];
	trashed: boolean;
	needsPermanent: string[];
	failed: { path: string; error: string }[];
	partial: boolean;
};

/** Everything the block hands the page, and therefore everything this file may drive. */
type ExCore = {
	sortEntries(entries: ExSortable[]): ExSortable[];
	basename(path: string): string;
	listing(): ExListing;
	listingStart(listing: ExListing, parent?: string): number;
	listingPage(listing: ExListing, ticket: number, page: ExPage): boolean;
	selection(): ExSelection;
	select(sel: ExSelection, path: string): ExSelection;
	selectToggle(sel: ExSelection, path: string): ExSelection;
	selectRange(sel: ExSelection, order: string[], path: string): ExSelection;
	selectAll(sel: ExSelection, order: string[]): ExSelection;
	pressOpens(entry: { dir?: boolean } | null, event: { target?: { classList?: { contains(name: string): boolean } }; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } | null): boolean;
	editTarget(entry: { dir?: boolean; link?: boolean } | null | undefined): string;
	pressAgain(held: { path: string; at: number }, path: string, now: number): { repeated: boolean; next: { path: string; at: number } };
	selectKeep(sel: ExSelection, known: Set<string>): string[];
	rebasePath(path: string, from: string, to: string): string;
	rebaseListing(listing: ExListing, from: string, to: string): ExListing;
	rebaseHeld(
		held: { sel: ExSelection; clip: ExClip; renaming: string; draft: ExDraft | null },
		from: string,
		to: string,
	): unknown;
	rebaseTree(
		state: {
			folders: Map<string, ExListing>;
			expanded: Set<string>;
			sel: ExSelection;
			clip: ExClip;
			renaming: string;
			draft: ExDraft | null;
		},
		from: string,
		to: string,
	): unknown;
	clipboard(): ExClip;
	clipSet(clip: ExClip, mode: string, paths: string[]): ExClip;
	clipClear(clip: ExClip): ExClip;
	pasteTrouble(clip: ExClip, dest: string): string;
	cleanPath(value: unknown): string | null;
	under(path: string, dir: string): boolean;
	dragPayload(workspace: string, refs: { path: string; dir?: boolean }[]): string;
	readDrag(text: string, workspace: string): { ok: boolean; reason?: string; paths?: { path: string; dir: boolean }[] };
	dragKind(types: string[]): string;
	absolute(root: string, rel: string): string;
	relative(root: string, absolute: string): string | null;
	attachRefs(picked: Map<string, ExRef>, root: string, refs: { path: string; dir?: boolean }[]): { added: number; known: number };
	retargetRefs(picked: Map<string, ExRef>, root: string, from: string, to: string): [string, string][];
	markMissing(picked: Map<string, ExRef>, root: string, removed: string[]): number;
	deleteResult(status: number, body: unknown): ExDeleteResult;
	permanentPaths(result: ExDeleteResult): string[];
	failedLines(body: unknown): string[];
	nameTrouble(name: unknown): string;
	drawers(open?: string): { open: string };
	drawerOpen(state: { open: string }, name: string): { open: string };
	drawerClose(state: { open: string }): { open: string };
	drawerToggle(state: { open: string }, name: string): { open: string };
	escapeTarget(open: Record<string, boolean | undefined>): string;
	boardLetter(key: string, flags?: { shift?: boolean; typing?: boolean; panel?: boolean; surface?: boolean }): string;
	copyText(text: string, ports: ExPorts): Promise<unknown>;
	icon(theme: unknown, entry: { name: string; dir?: boolean }): ExIcon | null;
	gitKind(git: string): string;
	gitBadge(git: string): string;
	PATH_MIME: string;
};

/** The explorer's own block, as the page loads it. Its shape is the page's, which it has no types for. */
function loadCore(): ExCore {
	const source = readFileSync(BOARD, "utf8");
	const start = source.indexOf("// ---------- explorer: the decisions ---");
	const end = source.indexOf("// ---------- explorer: the decisions end ---");
	assert.ok(start >= 0 && end > start, "the explorer core is marked off in public/client/board.js");
	const body = source.slice(start, end);
	// One function, so the block keeps its own consts and hands back exactly what the page uses. The
	// interfaces above are the promise it keeps; nothing below them is unchecked.
	return new Function(`${body}\nreturn explorerCore;`)() as ExCore;
}

const core: ExCore = loadCore();

/** The entry a listing holds for one name. */
const entry = (path: string, dir = false, git = ""): ExEntry => ({
	name: path.slice(path.lastIndexOf("/") + 1),
	path,
	dir,
	size: 0,
	mtime: 0,
	link: false,
	git,
});

/** One page of a folder, in the shape `/files` answers with. */
const page = (entries: ExEntry[], extra: Partial<ExPage> = {}): ExPage => ({
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
	// The question about a permanent delete is the last word on a destructive press, so it goes first.
	assert.equal(core.escapeTarget({ confirm: true, menu: true, rename: true, drawer: true }), "confirm");
	assert.equal(core.escapeTarget({ confirm: false, drawer: true }), "drawer", "a hidden question holds nothing");
	// The editor a file opened in stands over all of it, because the text in it is the human's.
	assert.equal(core.escapeTarget({ editor: true, confirm: true, drawer: true }), "editor");
	assert.equal(core.escapeTarget({ editor: false, drawer: true }), "drawer", "a closed editor holds nothing");
});

// ---------------------------------------------------------------- the tree

test("a folder is sorted the way the explorer shows it: folders first, then names people can read", () => {
	const sorted: string[] = core
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
	assert.deepEqual(listing.entries, [] as ExEntry[]);
	assert.equal(core.listingPage(listing, fresh, page([entry("docs/readme.md")])), true);
	assert.deepEqual(
		listing.entries.map((one) => one.path),
		["docs/readme.md"],
	);
});

test("a folder that moved takes its open descendants, their rows and the held paths with it", () => {
	// The root, the folder being moved, and one folder under it that is also open.
	const root = core.listing();
	core.listingStart(root, "");
	core.listingPage(root, root.seq, page([entry("old", true)]));
	const child = core.listing();
	core.listingStart(child, "old");
	core.listingPage(child, child.seq, page([entry("old/a.ts"), entry("old/nested", true)], { total: 2 }));
	const nested = core.listing();
	core.listingStart(nested, "old/nested");
	core.listingPage(nested, nested.seq, page([entry("old/nested/deep.ts")]));

	const state = {
		folders: new Map([
			["", root],
			["old", child],
			["old/nested", nested],
		]),
		expanded: new Set(["", "old", "old/nested"]),
		sel: core.selection(),
		clip: core.clipboard(),
		renaming: "old/a.ts",
		draft: { dir: "old/nested", asDir: false } as ExDraft | null,
	};
	core.select(state.sel, "old/a.ts");
	state.sel.paths.add("old/nested/deep.ts");
	core.clipSet(state.clip, "cut", ["old/nested"]);

	core.rebaseTree(state, "old", "renamed");

	// The listing that stood under the folder is keyed by its new name, and every row inside it too.
	assert.deepEqual([...state.folders.keys()].sort(), ["", "renamed", "renamed/nested"]);
	assert.equal(state.folders.get("renamed")?.parent, "renamed");
	assert.deepEqual(
		state.folders.get("renamed")?.entries.map((one) => one.path),
		["renamed/nested", "renamed/a.ts"],
		"folders first, as the listing is drawn",
	);
	// The names a listing has taken follow as well, so the next page cannot add the old spelling beside.
	assert.deepEqual([...state.folders.get("renamed")?.seen ?? []].sort(), ["renamed/a.ts", "renamed/nested"]);
	assert.deepEqual(state.folders.get("renamed/nested")?.entries.map((one) => one.path), ["renamed/nested/deep.ts"]);
	// The folders that were open are still open, on the rows they were opened on.
	assert.deepEqual([...state.expanded].sort(), ["", "renamed", "renamed/nested"]);
	// The selection, its lead row, the clipboard and the two inline names follow their own paths.
	assert.deepEqual([...state.sel.paths].sort(), ["renamed/a.ts", "renamed/nested/deep.ts"]);
	assert.equal(state.sel.lead, "renamed/a.ts");
	assert.deepEqual(state.clip.paths, ["renamed/nested"]);
	assert.equal(state.clip.mode, "cut");
	assert.equal(state.renaming, "renamed/a.ts");
	assert.equal(state.draft?.dir, "renamed/nested");
	// A move uses the same walk, and a name that only starts with the same letters is never dragged along.
	assert.equal(core.rebasePath("old", "old", "vendor/old"), "vendor/old");
	assert.equal(core.rebasePath("older/a.ts", "old", "vendor/old"), "older/a.ts");
});

test("the drawer's header names the folder the human opened, and a repository stays a flag", () => {
	assert.equal(core.basename("/work/project"), "project");
	assert.equal(core.basename("/work/project/"), "project");
	assert.equal(core.basename("C:\\work\\project"), "project", "a Windows root is read the same way");
	assert.equal(core.basename(""), "", "there is no name to print before the daemon has answered");
	const listing = core.listing();
	assert.equal(listing.repo, false, "a fresh listing is not a repository");
	const ticket = core.listingStart(listing, "");
	core.listingPage(listing, ticket, page([entry("a.ts")], { repo: true }));
	assert.equal(listing.repo, true);
	assert.equal(typeof listing.repo, "boolean", "`repo` is a flag, never the string the header prints");
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

test("a press on a folder opens it, and a press that picks several rows only picks", () => {
	assert.equal(core.pressOpens({ dir: true }, {}), true);
	assert.equal(core.pressOpens({ dir: false }, {}), false);
	assert.equal(core.pressOpens(null, {}), false);
	// Building a selection is not opening: shift and the two multi-pick keys only pick.
	assert.equal(core.pressOpens({ dir: true }, { shiftKey: true }), false);
	assert.equal(core.pressOpens({ dir: true }, { ctrlKey: true }), false);
	assert.equal(core.pressOpens({ dir: true }, { metaKey: true }), false);
	// The arrow is the switch on its own, whatever is held for the selection.
	const twist = { classList: { contains: (name: string) => name === "ex-twist" }, ctrlKey: true };
	assert.equal(core.pressOpens({ dir: true }, { target: twist, ctrlKey: true }), true);
	assert.equal(core.pressOpens({ dir: false }, { target: twist }), false);
});

test("a second press on the same row inside a moment is the same intent, not another one", () => {
	const first = core.pressAgain({ path: "", at: 0 }, "src", 1_000);
	assert.deepEqual([first.repeated, first.next], [false, { path: "src", at: 1_000 }]);
	// A real double press: the second click lands inside the window and opens nothing again.
	const second = core.pressAgain(first.next, "src", 1_180);
	assert.deepEqual([second.repeated, second.next], [true, { path: "", at: 0 }]);
	// Long after, or on another row, the press is its own intent again.
	assert.equal(core.pressAgain({ path: "src", at: 1_000 }, "src", 2_000).repeated, false);
	assert.equal(core.pressAgain({ path: "src", at: 1_000 }, "docs", 1_100).repeated, false);
	assert.equal(core.pressAgain({ path: "", at: 0 }, "", 1_000).repeated, false);
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
	assert.match(elsewhere.reason ?? "", /another workspace/);

	const outside = core.readDrag(JSON.stringify({ workspace: "b08b6688", paths: [{ path: "../secrets" }] }), "b08b6688");
	assert.equal(outside.ok, false);
	assert.match(outside.reason ?? "", /outside the workspace/);

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
	// `?.` is the guard: a reference that fell out of the map is `undefined`, which is not `true` either.
	assert.equal(picked.get("/work/project/other/b.ts")?.missing, true);
	assert.equal(picked.get("/work/project/new/nested/a.ts")?.missing, false);
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
	const written: string[] = [];
	await core.copyText("/work/project/a.ts", { writeText: (text: string) => written.push(text) });
	assert.deepEqual(written, ["/work/project/a.ts"]);

	// A board reached over plain http is not a secure context: `navigator.clipboard` is absent, so the
	// text is selected and the browser is asked to copy that selection.
	const selected: string[] = [];
	await core.copyText("src/a.ts", { selectCopy: (text: string) => selected.push(text) });
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

test("a refused batch is read for the daemon's own reasons, whatever status carried them", () => {
	// 207 and 409 both answer with a row per name; the reason is the daemon's, not one guessed here.
	assert.deepEqual(
		core.failedLines({
			failed: [
				{ path: "vendor/big.bin", error: "permission denied" },
				{ path: "build/locked", error: "no such file" },
			],
		}),
		["vendor/big.bin: permission denied", "build/locked: no such file"],
	);
	assert.deepEqual(core.failedLines({ failed: [{ path: "a.bin" }] }), ["a.bin: refused"], "a reasonless refusal still names the file");
	assert.deepEqual(core.failedLines({ failed: [] }), []);
	assert.deepEqual(core.failedLines({ error: "already there" }), [], "a single-body answer adds no row of its own");
	assert.deepEqual(core.failedLines(null), []);
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
	assert.equal(core.icon(theme, { name: "a.spec.ts", dir: false })?.glyph, "\uE021", "the longest extension wins");
	assert.equal(core.icon(theme, { name: "main.ts", dir: false })?.glyph, "\uE020");
	assert.equal(core.icon(theme, { name: "notes", dir: false })?.glyph, "\uE023", "an unknown name takes the default");
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
	assert.equal(core.gitBadge("??"), "U", "a name Git has never tracked wears VS Code's own letter");
	assert.equal(core.gitBadge(""), "");
});

// ---------------------------------------------------------------- the editor gate

test("a second press on a row asks for an edit, a read, or nothing", () => {
	assert.equal(core.editTarget(entry("a.py")), "edit");
	assert.equal(core.editTarget(entry("src/main.ts")), "edit");
	// A folder has nothing to open this way: a press already opens it.
	assert.equal(core.editTarget(entry("src", true)), "");
	// A link is read, because the daemon will not promise to write through one.
	assert.equal(core.editTarget({ ...entry("link.py"), link: true }), "read");
	assert.equal(core.editTarget(null), "");
	assert.equal(core.editTarget(undefined), "");
});

// ---------------------------------------------------------------- the page

test("the three drawers and the tree exist in the page, and the old picker is gone", () => {
	const html = readFileSync(HTML, "utf8");
	for (const id of ["drawerFiles", "drawerActivity", "drawerCards", "exTree", "exFilter", "exMenu", "exConfirm", "pickCount"]) {
		assert.ok(html.includes(`id="${id}"`), `#${id} is in the page`);
	}
	// The editor a file opens in: its frame, the path it names, the surface it draws into, its status
	// line and the two buttons that are its whole keyboard-free interface.
	assert.ok(html.includes('id="exEditor" hidden role="dialog" aria-modal="true"'), "#exEditor is a modal dialog");
	for (const id of ["exEditorTitle", "exEditorBody", "exEditorStatus", "exEditorSave", "exEditorClose"]) {
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
