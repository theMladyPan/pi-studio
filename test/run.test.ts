import assert from "node:assert/strict";
import { test } from "node:test";
import { afterMessage, runText } from "../server/child/run.ts";

/** A thread as the streaming reader leaves it: no narration, no answer, nothing half arrived. */
function freshRun(): any {
	return { streamInterim: [], streamLast: "", streamParts: new Map() };
}

test("a run that narrates and then answers keeps the two apart", () => {
	const thread = freshRun();
	afterMessage(thread, "I'll look at the fork logic first.", true);
	afterMessage(thread, "The field follows the card the message was written on.", false);
	const { interim, reply } = runText(thread);
	assert.deepEqual(interim, ["I'll look at the fork logic first."]);
	// The answer is the last message and nothing else: no narration in front of it.
	assert.equal(reply, "The field follows the card the message was written on.");
});

test("a message that asks for a tool without a word adds no narration", () => {
	const thread = freshRun();
	afterMessage(thread, "", true);
	assert.deepEqual(runText(thread).interim, []);
	assert.equal(runText(thread).reply, "");
});

test("the block still arriving is joined to the answer, never to the narration", () => {
	const thread = freshRun();
	afterMessage(thread, "narration", true);
	thread.streamParts = new Map([[0, "half an ans"]]);
	const { interim, reply } = runText(thread);
	assert.deepEqual(interim, ["narration"]);
	assert.equal(reply, "half an ans");
});

test("a failed message is shown as what arrived and not kept for the retry", () => {
	const thread = freshRun();
	afterMessage(thread, "a broken half sentence", false, true);
	// Nothing is carried into the retry, so the retry's text cannot read twice.
	assert.equal(runText(thread).reply, "");
	assert.deepEqual(runText(thread).interim, []);
});

test("narration that failed is not kept as narration either", () => {
	const thread = freshRun();
	afterMessage(thread, "about to look", true, true);
	assert.deepEqual(runText(thread).interim, []);
	assert.equal(runText(thread).reply, "");
});

test("a run with no tool call at all has no narration to draw", () => {
	const thread = freshRun();
	afterMessage(thread, "One message, one answer.", false);
	assert.deepEqual(runText(thread).interim, []);
	assert.equal(runText(thread).reply, "One message, one answer.");
});
