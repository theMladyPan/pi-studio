/**
 * What a plugin may ask of the daemon, answered by the adapter rather than by a route.
 *
 * The state folder is a throwaway one, set before any daemon module is imported, so the workspaces here
 * are this test's own and the human's boards are never read or written. Nothing is spawned: a plugin's
 * process is the subject of `plugins-manager.test.ts`, and this file is the methods themselves.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { removeTree } from "../test-support/temp.ts";

const root = mkdtempSync(join(tmpdir(), "pi-studio-plugin-service-"));
process.env.PI_STUDIO_STATE = join(root, "state");

const { createPluginService, PLUGIN_EVENTS } = await import("../server/plugins/service.ts");
const { boardFor, boards, flushBoard } = await import("../server/store.ts");
const { boardFile, readJsonFile } = await import("../server/paths.ts");
const { ensureScratch, rememberWorkspace } = await import("../server/workspaces.ts");

after(async () => {
	await removeTree(root);
});

/** One call, as the host would hand it to the adapter. */
function call(service: { handle: (call: any) => unknown }, method: string, params?: unknown) {
	return service.handle({ plugin: "fixture", method, params }) as any;
}

/** The refusal a call earns, with the code a plugin acts on. */
async function refused(service: { handle: (call: any) => unknown }, method: string, params?: unknown) {
	try {
		await call(service, method, params);
	} catch (error) {
		return error as { code: number; message: string };
	}
	throw new assert.AssertionError({ message: `${method} was answered instead of refused` });
}

/** The scratch workspace: the one row every daemon has, in this test's own state folder. */
function scratch() {
	const found = ensureScratch();
	assert.ok(found, "the daemon has a scratch workspace");
	return found as { id: string; folder: string; name: string };
}

// ---------- what a plugin may read ----------

test("a plugin lists the workspaces the daemon knows, and never names a folder itself", async () => {
	const service = createPluginService();
	const listed = await call(service, "workspace.list");
	const one = listed.workspaces.find((workspace: any) => workspace.scratch);
	assert.deepEqual(Object.keys(one).sort(), ["folder", "id", "missing", "name", "scratch"]);
	assert.equal(one.id, scratch().id);
	// A folder is not a way to name a workspace: the daemon resolves its own list and nothing else.
	const byFolder = await refused(service, "workspace.read", { workspace: scratch().folder });
	assert.match(byFolder.message, /is not a workspace this daemon knows/);
});

test("a call naming a workspace the daemon does not know is refused", async () => {
	const service = createPluginService();
	const refusal = await refused(service, "workspace.read", { workspace: "not-a-workspace" });
	assert.equal(refusal.code, -32602);
	assert.match(refusal.message, /not a workspace this daemon knows/);
});

test("reading a workspace the daemon has not opened writes nothing into it", async () => {
	const service = createPluginService();
	const folder = join(root, "a-project");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "README.md"), "not a board\n");
	const workspace = rememberWorkspace(folder) as unknown as { id: string };
	const read = await call(service, "workspace.read", { workspace: workspace.id });
	assert.equal(read.open, false);
	assert.deepEqual(read.cards, []);
	// A list is a read too: it answers from what was written and opens nothing.
	assert.deepEqual((await call(service, "threads.list", { workspace: workspace.id })).threads, []);
	// Opening a board for real is what makes `.pi-studio` in somebody's project, and a read is not that.
	assert.equal(existsSync(join(folder, ".pi-studio")), false);
});

// ---------- a note written through the adapter ----------

test("a note lands on the scratch board, and the same key revises that one card", async () => {
	const service = createPluginService();
	const workspace = scratch();
	const first = await call(service, "cards.note", { workspace: workspace.id, markdown: "# first", title: "a note", key: "job-1" });
	assert.ok(first.cardId);
	assert.equal(first.updated, undefined);
	const second = await call(service, "cards.note", { workspace: workspace.id, markdown: "# second", key: "job-1" });
	assert.equal(second.cardId, first.cardId, "a key revises one card instead of stacking a second");
	assert.equal(second.updated, true);

	const read = await call(service, "workspace.read", { workspace: workspace.id });
	assert.equal(read.open, true);
	const notes = read.cards.filter((card: any) => card.type === "note");
	assert.equal(notes.length, 1);
	assert.equal(notes[0].markdown, "# second");

	// And the card survives the write: the board file on disk is what a restart reads.
	flushBoard(boards.get(workspace.id));
	const saved = readJsonFile(boardFile(workspace), null) as any;
	assert.deepEqual(
		saved.cards.filter((card: any) => card.type === "note").map((card: any) => [card.key, card.markdown]),
		[["job-1", "# second"]],
	);
});

test("a card the plugin noted is taken off by its key once the problem it carried is gone", async () => {
	const service = createPluginService();
	const workspace = scratch();
	await call(service, "cards.note", { workspace: workspace.id, markdown: "# failing", key: "job-1" });
	const removed = await call(service, "cards.remove", { workspace: workspace.id, key: "job-1" });
	assert.deepEqual(removed, { removed: true });
	const read = await call(service, "workspace.read", { workspace: workspace.id });
	assert.equal(read.cards.filter((card: any) => card.type === "note").length, 0, "the card is off the board");
	const again = await call(service, "cards.remove", { workspace: workspace.id, key: "job-1" });
	assert.deepEqual(again, { removed: false }, "removing a card that is not there is an answer, not a refusal");
	const refusal = await refused(service, "cards.remove", { workspace: workspace.id });
	assert.equal(refusal.code, -32602);
});

test("a note the board will not draw is refused with the reason, not with a daemon failure", async () => {
	const service = createPluginService();
	const refusal = await refused(service, "cards.note", { workspace: scratch().id, markdown: "   " });
	assert.equal(refusal.code, -32602);
	assert.equal(refusal.message, "empty note");
});

// ---------- a thread followed through the adapter ----------

test("a plugin makes a thread, prompts it while it runs, and stops that one run", async () => {
	const service = createPluginService();
	const workspace = scratch();
	const made = await call(service, "threads.create", { workspace: workspace.id, title: "a job" });
	assert.ok(made.threadId);
	assert.deepEqual(Object.keys(made.thread).sort(), ["at", "hidden", "id", "mode", "status", "title", "turns"]);
	assert.equal(made.thread.status, "idle");

	const listed = await call(service, "threads.list", { workspace: workspace.id });
	assert.ok(listed.threads.some((thread: any) => thread.id === made.threadId));

	// A thread with a run in flight takes the words behind it instead of starting a second run, so this
	// drives the write path without a child to talk to.
	const board = boardFor(workspace);
	const thread = board.threads.get(made.threadId);
	thread.status = "running";
	const prompted = await call(service, "threads.prompt", { workspace: workspace.id, thread: made.threadId, text: "do the thing" });
	assert.equal(prompted.turn, 0);
	assert.equal(prompted.thread.turns, 1);
	assert.equal(prompted.thread.status, "running");
	assert.equal(thread.queued.length, 1);
	assert.match(thread.queued[0].message, /\[user message\]\ndo the thing/);

	// A stop names the thread it is asked of, and never the board's other runs.
	const stopped = await call(service, "threads.stop", { workspace: workspace.id, thread: made.threadId });
	assert.deepEqual(stopped.stopped, [made.threadId]);
	assert.equal(stopped.workspace.id, workspace.id);
	assert.equal(thread.abortWanted, true);
});

test("a thread this workspace does not hold is refused, and an unnamed stop never reaches the board", async () => {
	const service = createPluginService();
	const workspace = scratch();
	const unknown = await refused(service, "threads.prompt", { workspace: workspace.id, thread: "not-a-thread", text: "go" });
	assert.equal(unknown.code, -32602);
	assert.match(unknown.message, /not-a-thread is not a thread in this workspace/);
	// The human's own bottom bar stops every run on the board; a plugin asks for one thread or for nothing.
	const unnamed = await refused(service, "threads.stop", { workspace: workspace.id });
	assert.equal(unnamed.code, -32602);
	assert.match(unnamed.message, /thread must be the id of a thread in this workspace/);
});

test("a thread with no run in progress has nothing to stop", async () => {
	const service = createPluginService();
	const workspace = scratch();
	const made = await call(service, "threads.create", { workspace: workspace.id, title: "quiet job" });
	const refusal = await refused(service, "threads.stop", { workspace: workspace.id, thread: made.threadId });
	assert.equal(refusal.code, -32602);
	assert.equal(refusal.message, "this thread has no run in progress");
});

test("a thread the board will not make is refused with the reason the route gives", async () => {
	const service = createPluginService();
	const refusal = await refused(service, "threads.create", { workspace: scratch().id, mode: "not-a-mode" });
	assert.equal(refusal.code, -32602);
	assert.equal(refusal.message, "unknown mode: not-a-mode");
});

test("an ended thread takes no new words", async () => {
	const service = createPluginService();
	const workspace = scratch();
	const made = await call(service, "threads.create", { workspace: workspace.id, title: "spent job" });
	boardFor(workspace).threads.get(made.threadId).status = "dead";
	const refusal = await refused(service, "threads.prompt", { workspace: workspace.id, thread: made.threadId, text: "one more" });
	assert.equal(refusal.code, -32602);
	assert.equal(refusal.message, "thread ended");
});

// ---------- what the adapter will not answer ----------

test("a method this daemon does not answer is refused as one", async () => {
	const service = createPluginService();
	const refusal = await refused(service, "thread.spawn", { workspace: scratch().id, text: "do the thing" });
	assert.equal(refusal.code, -32601);
	assert.match(refusal.message, /it answers workspace\.list, workspace\.read, cards\.note, cards\.html, cards\.remove, events\.subscribe/);
});

test("params that are not one object are refused", async () => {
	const service = createPluginService();
	const refusal = await refused(service, "workspace.read", [scratch().id]);
	assert.equal(refusal.code, -32602);
	assert.match(refusal.message, /params must be one object/);
});

test("a subscription names the events this daemon sends, and nothing else", async () => {
	const service = createPluginService();
	assert.deepEqual(PLUGIN_EVENTS, ["thread.settled", "thread.stream"]);
	assert.deepEqual(await call(service, "events.subscribe", { types: ["thread.settled", "thread.stream"] }), {
		types: ["thread.settled", "thread.stream"],
	});
	const refusal = await refused(service, "events.subscribe", { types: ["card.made"] });
	assert.equal(refusal.code, -32602);
	assert.match(refusal.message, /card\.made is not an event this daemon sends/);
});
