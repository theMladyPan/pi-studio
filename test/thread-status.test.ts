import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const state = mkdtempSync(join(tmpdir(), "pi-studio-status-state-"));
process.env.PI_STUDIO_STATE = state;

const { boardStatusBlock, boardStatuses } = await import("../server/routes/board/status.ts");
const { finished } = await import("../server/waiters.ts");

after(() => rmSync(state, { recursive: true, force: true }));

let at = 0;
const later = () => Date.now() - (at += 1000);

/** A thread row: running masters report, running children read by role, settled ones keep only a note. */
function thread(id: string, extra: Record<string, unknown> = {}) {
	return { id, title: `thread ${id}`, at: Date.now(), turns: [], ...extra };
}

function board() {
	return {
		threads: new Map([
			["master-red", thread("master-red", { status: "running", activity: { status: "reading", note: "scanning the router", at: later() } })],
			["master-blue", thread("master-blue", { status: "running", activity: { status: "merging", at: later() } })],
			["master-quiet", thread("master-quiet", { status: "idle" })],
			["master-broken", thread("master-broken", { status: "idle", activity: { status: "idle", note: "401: invalid api key", at: later() } })],
			["child-build", thread("child-build", { status: "running", parentThread: "master-red", role: "implement" })],
			["child-done", thread("child-done", { status: "idle", parentThread: "master-red", role: "scout" })],
		]),
	};
}

test("a running master that reported is listed with its note; a quiet one says nothing", () => {
	const listed = boardStatuses(board());
	const red = listed.find((one: any) => one.threadId === "master-red");
	assert.equal(red?.status, "reading");
	assert.equal(red?.note, "scanning the router");
	assert.equal(red?.reported, true);
	assert.equal(listed.find((one: any) => one.threadId === "master-quiet"), undefined, "an idle thread without a note was listed");
	assert.equal(listed.find((one: any) => one.threadId === "master-blue")?.status, "merging");
});

test("a running child reads by its role and is marked default; a settled one is not listed", () => {
	const listed = boardStatuses(board());
	const build = listed.find((one: any) => one.threadId === "child-build");
	assert.equal(build?.status, "writing");
	assert.equal(build?.reported, false);
	assert.equal(listed.find((one: any) => one.threadId === "child-done"), undefined, "a settled child was listed");
});

test("a settled thread appears only with the note that ended it", () => {
	const listed = boardStatuses(board());
	const broken = listed.find((one: any) => one.threadId === "master-broken");
	assert.equal(broken?.status, "idle");
	assert.equal(broken?.note, "401: invalid api key");
});

test("the injected block names the others and never the thread it opens for", () => {
	const text = boardStatusBlock(board(), "master-red");
	assert.ok(text.startsWith("[board threads]"));
	assert.ok(text.includes("master-blu"));
	assert.ok(text.includes("(merging)"));
	assert.ok(text.includes("401: invalid api key"));
	assert.doesNotMatch(text, /master-red/, "the opening thread was told its own phase");
	assert.equal(boardStatusBlock({ threads: new Map() }, "master-red"), "", "an empty board still says nothing");
});

test("a settled run clears silently, a cut leaves a stop note, and a failure leaves its reason", () => {
const reported = (turns: unknown[]) => ({ id: "t", turns, activity: { status: "writing", at: Date.now() } }) as any;
	const done = reported([{ status: "answered" }]);
	finished(done);
	assert.equal(done.activity, undefined, "an answer kept its phase");
	const cut = reported([{ status: "stopped" }]);
	finished(cut);
	assert.equal(cut.activity?.note, "stopped");
	const failed = reported([{ status: "stopped", error: "429\nRate limited" }]);
	finished(failed);
	assert.equal(failed.activity?.note, "429 Rate limited");
	const quiet = { id: "t", turns: [{ status: "stopped" }] } as any;
	finished(quiet);
	assert.equal(quiet.activity, undefined, "a stop without a report left a note");
});

test("the turn that ended the run decides even when the thread's own list disagrees", () => {
	// A hidden thread answers on its card, so its own turns can read answered while the card's turn was cut.
	const thread = { id: "t", turns: [{ status: "answered" }], activity: { status: "reading", at: Date.now() } } as any;
	finished(thread, { status: "stopped", error: "401: invalid api key" } as any);
	assert.equal(thread.activity?.status, "idle");
	assert.equal(thread.activity?.note, "401: invalid api key");
});
