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
const { boards, flushBoard } = await import("../server/store.ts");
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

test("a note the board will not draw is refused with the reason, not with a daemon failure", async () => {
	const service = createPluginService();
	const refusal = await refused(service, "cards.note", { workspace: scratch().id, markdown: "   " });
	assert.equal(refusal.code, -32602);
	assert.equal(refusal.message, "empty note");
});

// ---------- what the adapter will not answer ----------

test("a method this daemon does not answer is refused as one", async () => {
	const service = createPluginService();
	const refusal = await refused(service, "thread.spawn", { workspace: scratch().id, text: "do the thing" });
	assert.equal(refusal.code, -32601);
	assert.match(refusal.message, /it answers workspace\.list, workspace\.read, cards\.note, events\.subscribe/);
});

test("params that are not one object are refused", async () => {
	const service = createPluginService();
	const refusal = await refused(service, "workspace.read", [scratch().id]);
	assert.equal(refusal.code, -32602);
	assert.match(refusal.message, /params must be one object/);
});

test("a subscription names the events this daemon sends, and nothing else", async () => {
	const service = createPluginService();
	assert.deepEqual(PLUGIN_EVENTS, ["thread.settled"]);
	assert.deepEqual(await call(service, "events.subscribe", { types: ["thread.settled"] }), { types: ["thread.settled"] });
	const refusal = await refused(service, "events.subscribe", { types: ["card.made"] });
	assert.equal(refusal.code, -32602);
	assert.match(refusal.message, /card\.made is not an event this daemon sends/);
});
