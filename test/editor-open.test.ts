import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The state folder is resolved once, when `server/paths.ts` is first imported, so this file sets it before
 * any board code is loaded and then loads that code dynamically: a test that wrote a board into the human's
 * own state folder would change their studio. It writes only into folders it made under `tmpdir()`.
 *
 * A card's file is opened here rather than through a daemon, because the defect is about which tree a path
 * is resolved against: two children in two trees, one board, and the editor set directly on the defaults.
 */
const state = mkdtempSync(join(tmpdir(), "pi-studio-editor-open-state-"));
process.env.PI_STUDIO_STATE = state;

const { onOpenCard, onSource } = await import("../server/routes/board/content.ts");
const { plainCardFor } = await import("../server/cards.ts");
const { boardFor, saveBoard } = await import("../server/store.ts");
const { setHomeDefaults } = await import("../server/workspaces.ts");
const { boardFile } = await import("../server/paths.ts");

after(() => rmSync(state, { recursive: true, force: true }));

/** A request and a response a handler writes to, with a promise for the one answer it gives. */
function wire(body: unknown) {
	const req = Readable.from([Buffer.from(JSON.stringify(body))]);
	let status = 0;
	let answers = 0;
	let said = "";
	let settle: () => void = () => {};
	const done = new Promise<void>((resolve) => (settle = resolve));
	const res = {
		writeHead(code: number) {
			status = code;
		},
		end(chunk?: unknown) {
			answers += 1;
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
		get answers() {
			return answers;
		},
	};
}

/** The answer a route gives, with a deadline so a route that never answers fails the test rather than hangs it. */
function answered(asked: ReturnType<typeof wire>) {
	const deadline = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("the route never answered")), 5_000).unref();
	});
	return Promise.race([asked.done, deadline]).then(() => asked);
}

/** A board folder and the two trees a flow of children works in, each with the same relative file. */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-editor-open-work-"));
	const folder = join(root, "board");
	const trees = { a: join(root, "tree-a"), b: join(root, "tree-b") };
	for (const [name, at] of [["board", folder], ["a", trees.a], ["b", trees.b]] as [string, string][]) {
		mkdirSync(join(at, "src"), { recursive: true });
		writeFileSync(join(at, "src/api.ts"), `export const api = "${name}";\n`);
	}
	const board: any = {
		id: "w-editor-open",
		name: "editor-open",
		folder,
		threads: new Map(),
		cards: new Map(),
		children: new Map(),
		clients: new Set(),
		trees: [],
		activity: [],
		trash: [],
		// A save is already queued, so nothing is written behind the test's back; `saveBoard` is called
		// where a test wants the file.
		saveTimer: { unref() {} },
	};
	for (const [id, path] of [["child-a", trees.a], ["child-b", trees.b]]) {
		board.threads.set(id, { id, title: id, status: "idle", turns: [], queued: [], at: Date.now(), worktree: { base: "dev", path } });
	}
	return { root, folder, trees, board };
}

test("a card opens the file it was read from, whichever tree the key was written in last", async () => {
	const { root, trees, folder, board } = workspace();
	try {
		// `true` is a program that starts and opens nothing, so what is under test is the path, not the editor.
		setHomeDefaults({ editor: "true" });

		const read = wire({ path: "src/api.ts", threadRoot: "child-a", key: "api" });
		await onSource(read.req, read.res, board);
		assert.equal(read.status, 200, read.body);
		const cardId = JSON.parse(read.body).cardId;
		const card = board.cards.get(cardId);
		assert.equal(card.content, 'export const api = "a";\n', "the body is the child's file");
		assert.equal(card.file, resolve(trees.a, "src/api.ts"), "the card names the file its body came from");
		// The absolute path stays on the daemon's side of the wire: it is a whitelist that shapes a card.
		assert.equal(JSON.parse(read.body).card.file, undefined);
		assert.equal(plainCardFor(card, board).file, undefined);

		const opened = wire({ cardId });
		await onOpenCard(opened.req, opened.res, board);
		await answered(opened);
		assert.equal(opened.status, 200, opened.body);
		assert.deepEqual(JSON.parse(opened.body), { opened: true, file: resolve(trees.a, "src/api.ts") });

		// A second child in another tree writes the same key. Keys are the board's, so it revises the one
		// card — and the card follows the file its body was just read from.
		const again = wire({ path: "src/api.ts", threadRoot: "child-b", key: "api" });
		await onSource(again.req, again.res, board);
		const revised = JSON.parse(again.body);
		assert.equal(revised.cardId, cardId, "a key is the board's, so the same card is revised");
		assert.equal(revised.updated, true);
		assert.equal(board.cards.size, 1, "a second child stacked a second card");
		assert.equal(card.content, 'export const api = "b";\n', "the body is the second child's file");
		assert.equal(card.file, resolve(trees.b, "src/api.ts"), "the card points at the file it now shows");

		const openedB = wire({ cardId });
		await onOpenCard(openedB.req, openedB.res, board);
		await answered(openedB);
		assert.deepEqual(JSON.parse(openedB.body), { opened: true, file: resolve(trees.b, "src/api.ts") }, "the press opened another file than the card showed");

		// The recorded path survives the board file, and comes back with its content.
		saveBoard(board);
		const rows = JSON.parse(readFileSync(boardFile(board), "utf8")).cards;
		assert.equal(rows[0].file, resolve(trees.b, "src/api.ts"), "the file is not written with the board");
		const reloaded = boardFor({ id: board.id, folder, name: board.name });
		assert.equal(reloaded.cards.get(cardId)?.file, resolve(trees.b, "src/api.ts"), "the file did not come back with the board");

		// The tree is retired. A same-named file in the board folder is not the card's file, so the press is
		// refused rather than opening something the human never saw.
		rmSync(trees.b, { recursive: true, force: true });
		const retired = wire({ cardId });
		await onOpenCard(retired.req, retired.res, board);
		await answered(retired);
		assert.equal(retired.status, 409);
		assert.match(retired.body, /not a file on disk any more/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a card written before the file was recorded resolves against the tree of the thread that read it", async () => {
	const { root, trees, board } = workspace();
	try {
		setHomeDefaults({ editor: "true" });
		// A card from a board file that predates the field: the relative path, and the thread it was read by.
		const old = { id: "old", type: "source", title: "src/api.ts", path: "src/api.ts", content: "", at: Date.now(), ownerThread: "child-a" };
		board.cards.set(old.id, old);
		const opened = wire({ cardId: old.id });
		await onOpenCard(opened.req, opened.res, board);
		await answered(opened);
		assert.deepEqual(JSON.parse(opened.body), { opened: true, file: resolve(trees.a, "src/api.ts") });

		// A relative path that leaves the tree it is resolved against is refused, and names what it was given.
		const away = { id: "away", type: "source", title: "passwd", path: "../../etc/passwd", content: "", at: Date.now(), ownerThread: "child-a" };
		board.cards.set(away.id, away);
		const refused = wire({ cardId: away.id });
		await onOpenCard(refused.req, refused.res, board);
		await answered(refused);
		assert.equal(refused.status, 409);
		assert.equal(refused.body, "../../etc/passwd is outside the workspace");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an editor naming a binary nobody can run is refused before anything is started", async () => {
	const { root, trees, board } = workspace();
	try {
		const missing = resolve(trees.a, "no-such-editor");
		setHomeDefaults({ editor: missing });
		const card = { id: "api", type: "source", title: "src/api.ts", path: "src/api.ts", content: "", at: Date.now(), file: resolve(trees.a, "src/api.ts") };
		board.cards.set(card.id, card);
		const refused = wire({ cardId: card.id });
		await onOpenCard(refused.req, refused.res, board);
		await answered(refused);
		assert.equal(refused.status, 409);
		assert.equal(refused.body, `${missing} is not a program this machine can run`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
