import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

/**
 * The state folder is resolved once, when `server/paths.ts` is first imported, so this file sets it before
 * any board code is loaded and then loads that code dynamically. That is why it is a file of its own: a
 * static import beside it would be hoisted above the assignment and read the human's real folder. It writes
 * only into a folder it made under `tmpdir()`.
 */
const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-load-put-away-"));
process.env.PI_STUDIO_STATE = stateHome;

const paths = await import("../server/paths.ts");
const { boardFor } = await import("../server/store.ts");
const { MAX_PUT_AWAY_CHILDREN } = await import("../server/limits.ts");

test("a loaded board keeps the human's threads and the put-away children closed last", () => {
	try {
		assert.equal(paths.STATE_DIR, resolve(stateHome), "the board code did not take the temporary folder");
		const workspace = { id: "w-load", folder: join(stateHome, "work"), name: "load" };
		const live = [0, 1, 2].map((at) => ({ id: `live-${at}`, title: `live ${at}`, at: 1_000 + at, turns: [] }));
		// More put-away children than the cap allows, and the ones written to the file first were closed
		// last: the file's order and the close order disagree, which is what the cap has to sort by. Each is
		// a child the board filed, so each names the thread that spawned it.
		const away = Array.from({ length: MAX_PUT_AWAY_CHILDREN + 165 }, (_, at) => ({
			id: `away-${at}`,
			title: `away ${at}`,
			at: 1,
			parentThread: "live-0",
			hidden: true,
			closedAt: 1_000_000 - at,
			turns: [],
		}));
		paths.writeJsonFile(paths.boardFile(workspace), {
			version: paths.STATE_VERSION,
			workspace,
			threads: [...live, ...away],
			cards: [],
		});
		const board = boardFor(workspace);
		assert.equal(board.threads.size, live.length + MAX_PUT_AWAY_CHILDREN, "the human's threads all load");
		for (const thread of live) assert.equal(board.threads.get(thread.id)?.title, thread.title);
		// The newest by `closedAt` are kept, in the order they were closed rather than the order they were
		// written, so an early-spawned child put away last is not the first to go.
		for (let at = 0; at < MAX_PUT_AWAY_CHILDREN; at += 1) {
			assert.ok(board.threads.has(`away-${at}`), `away-${at} was closed late enough to keep`);
		}
		for (let at = MAX_PUT_AWAY_CHILDREN; at < away.length; at += 1) {
			assert.equal(board.threads.has(`away-${at}`), false, `away-${at} was closed too long ago to keep`);
		}
	} finally {
		rmSync(stateHome, { recursive: true, force: true });
	}
});

test("a thread the human closed by hand is neither counted against the cap nor dropped by the load", () => {
	try {
		const workspace = { id: "w-mine", folder: join(stateHome, "work"), name: "load" };
		// The human's own thread, closed by hand: it carries `hidden` and `closedAt` like a put-away child, and
		// its turns and session id live nowhere but here. It is the oldest row on the rail, so a cap that
		// counted it would drop it first.
		const mine = {
			id: "mine-1",
			title: "my own",
			at: 1,
			hidden: true,
			closedAt: 1,
			turns: [{ text: "what is here", status: "answered", reply: "this", at: 2 }],
		};
		// The rail holds as many children as the cap allows, every one of them filed after the human's thread.
		const away = Array.from({ length: MAX_PUT_AWAY_CHILDREN }, (_, at) => ({
			id: `filed-${at}`,
			title: `filed ${at}`,
			at: 1,
			parentThread: "mine-1",
			hidden: true,
			closedAt: 1_000 + at,
			turns: [],
		}));
		paths.writeJsonFile(paths.boardFile(workspace), {
			version: paths.STATE_VERSION,
			workspace,
			threads: [mine, ...away],
			cards: [],
		});
		const board = boardFor(workspace);
		assert.equal(board.threads.get(mine.id)?.title, mine.title, "a thread the human started is not one the board filed");
		assert.deepEqual(
			board.threads.get(mine.id)?.turns.map((turn: any) => turn.text),
			["what is here"],
			"and it comes back with the turns that live nowhere else",
		);
		assert.equal(board.threads.size, away.length + 1, "the cap keeps every filed child and the human's thread too");
	} finally {
		rmSync(stateHome, { recursive: true, force: true });
	}
});
