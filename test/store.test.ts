import assert from "node:assert/strict";
import { test } from "node:test";
import { cardFor, plainCardFor } from "../server/cards.ts";
import { restoredPlainCard, restoredThread } from "../server/store.ts";

const now = 1_700_000_000_000;

test("a thread file from today reloads with its fields intact", () => {
	const saved = {
		id: "t1",
		title: "fix the parser",
		provider: "klotilda",
		model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
		thinking: "high",
		at: now,
		turns: [{ text: "hello", status: "answered" }],
		rect: { x: 10, y: 20, w: 300, h: 200 },
		worktree: { path: "/tmp/wt", base: "dev", repo: "/tmp/repo" },
	};
	const thread = restoredThread(saved, "/tmp/folder")!;
	assert.equal(thread.id, "t1");
	assert.equal(thread.title, "fix the parser");
	assert.equal(thread.sessionId, null);
	assert.equal(thread.status, "idle");
	assert.equal(thread.thinking, "high");
	// A restored turn keeps the words and is normalised into the shape the client draws.
	assert.equal(thread.turns.length, 1);
	assert.equal(thread.turns[0].text, "hello");
	assert.equal(thread.turns[0].status, "answered");
	assert.deepEqual(thread.worktree, saved.worktree);
	assert.equal(thread.folder, "/tmp/folder");
});

test("a boss comes back as a boss, with the flow it was running", () => {
	// The mode is what stops a boss doing the work itself, so a restart that dropped it would hand a
	// boss the write tool and a task it was told to delegate.
	const thread = restoredThread(
		{ id: "t2", title: "run the flow", mode: "boss", path: "advanced", pathChosenBy: "human", at: now, turns: [] },
		"/tmp/folder",
	)!;
	assert.equal(thread.mode, "boss");
	assert.equal(thread.path, "advanced");
	assert.equal(thread.pathChosenBy, "human");
});

test("and a mode that is not one of the three is dropped rather than trusted", () => {
	const thread = restoredThread({ id: "t3", title: "x", mode: "wizard", path: "quick", at: now, turns: [] }, "/tmp/folder")!;
	assert.equal(thread.mode, undefined);
	assert.equal(thread.path, undefined);
});

test("a board written before hidden was a flag still hides the card", () => {
	// `behind: <cardId>` is the old spelling. Read as anything else, those cards come back on top of a
	// board nobody put them on.
	const thread = restoredThread({ id: "t2", behind: "card-9", at: now }, "/tmp/folder")!;
	assert.equal(thread.hidden, true);
	// A hidden thread with no card behind it was put away by the human, so the rail can offer it back.
	assert.equal(thread.closedAt, now);
});

test("a thread with a card behind it is not treated as closed", () => {
	const thread = restoredThread({ id: "t3", behind: "card-9", threadRoot: "card-9", at: now }, "/tmp/folder")!;
	assert.equal(thread.hidden, true);
	assert.equal(thread.closedAt, undefined);
});

test("a plain card keeps its type, and one without a body is dropped", () => {
	// The store is still in its lifted form, so its return type is a union of shapes rather than one.
	const note = restoredPlainCard({ id: "c1", type: "note", markdown: "# hi", at: now }) as any;
	assert.deepEqual(note, { id: "c1", type: "note", title: "note", at: now, markdown: "# hi" });
	assert.equal(restoredPlainCard({ id: "c2", type: "note" }), null);
	assert.equal(restoredPlainCard({ id: "c3", type: "source", path: "a.ts" }), null);
	assert.equal(restoredPlainCard({ id: "c4" }), null);
});

test("a question card that asked several questions reloads with its tabs", () => {
	const card = restoredPlainCard({
		id: "c11",
		type: "question",
		title: "three things",
		at: now,
		status: "answered",
		answer: "a; x, y",
		answers: ["a", "x, y"],
		questions: [
			{ question: "one?", options: ["a", "b"] },
			{ question: "two?", options: ["x", "y"], multiple: true, allowFreeText: false },
		],
	}) as any;
	// A tabbed card carries no flat question, so the list is what keeps it a card at all.
	assert.equal(card.type, "question");
	assert.equal(card.questions.length, 2);
	assert.equal(card.questions[1].multiple, true);
	assert.equal(card.questions[1].allowFreeText, false);
	assert.deepEqual(card.answers, ["a", "x, y"]);
	// The agent that was waiting is gone after a restart, so the card is settled like every other one.
	assert.equal(card.status, "expired");
	assert.equal(restoredPlainCard({ id: "c12", type: "question", questions: [] }), null);
});

test("a file with no type is read as a note, which is what it was", () => {
	const card = restoredPlainCard({ id: "c5", markdown: "old shape", title: "kept" }) as any;
	assert.equal(card.type, "note");
	assert.equal(card.title, "kept");
});

test("a question card comes back with only its options", () => {
	const card = restoredPlainCard({ id: "c6", type: "question", question: "which?", options: ["a", 2, "b"] }) as any;
	assert.deepEqual(card.options, ["a", "b"]);
	// A question written before the boxes existed takes one answer, and says nothing about picks.
	assert.equal(card.multiple, undefined);
	assert.equal(card.answers, undefined);
});

test("a question card that took several answers keeps the picks", () => {
	const card = restoredPlainCard({
		id: "c8",
		type: "question",
		question: "which ones?",
		options: ["a", "b", "c"],
		multiple: true,
		answer: "a, c",
		answers: ["a", "c", 7],
		status: "answered",
	}) as any;
	assert.equal(card.multiple, true);
	assert.deepEqual(card.answers, ["a", "c"]);
	assert.equal(card.answer, "a, c");
	// The child that was waiting is gone, so the card is settled however the file read it.
	assert.equal(card.status, "expired");
});

test("a thread becomes a card the client can draw", () => {
	const thread = restoredThread({ id: "t9", title: "a title", at: now }, "/tmp/folder")!;
	const card = cardFor(thread, null);
	assert.equal(card.id, "t9");
	assert.equal(card.type, "sticky");
	assert.equal(card.title, "a title");
});

test("a plain card becomes a card of its own kind", () => {
	const card = plainCardFor({ id: "c7", type: "note", title: "n", at: now, markdown: "body" }, null) as any;
	assert.equal(card.id, "c7");
	assert.equal(card.type, "note");
	assert.equal(card.markdown, "body");
});

test("the browser is told when a question takes several answers", () => {
	const card = plainCardFor(
		{ id: "c9", type: "question", title: "q", at: now, question: "which?", options: ["a", "b"], multiple: true, status: "answered", answer: "a, b", answers: ["a", "b"] },
		null,
	) as any;
	assert.equal(card.multiple, true);
	assert.deepEqual(card.answers, ["a", "b"]);
	// One answer is still drawn from `answer`, so a card that never heard of the flag reads the same.
	const single = plainCardFor({ id: "c10", type: "question", title: "q", at: now, question: "which?", options: ["a", "b"], status: "answered", answer: "a" }, null) as any;
	assert.equal(single.multiple, false);
	assert.equal(single.answers, undefined);
});
