import assert from "node:assert/strict";
import { test } from "node:test";
import { cardFor, plainCardFor } from "../server/cards.ts";
import { restoredPlainCard, restoredThread, savedTurn } from "../server/store.ts";

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

test("a steer the run read survives a save and a load, and a turn still in flight does not", () => {
	// A steer that joined a live run is answered inside the run's own turn, so its words were spent and the
	// file has to say so: saved as stopped, a restart brought the false label back. A turn the run is still
	// writing, and one waiting behind it, are nobody's work once the daemon is gone.
	const spent = savedTurn({ text: "and this instead", status: "sent", mode: "steer", at: now });
	assert.equal(spent.status, "sent");
	const writing = savedTurn({ text: "the first words", status: "sent", mode: "queue", streaming: true, at: now });
	assert.equal(writing.status, "stopped");
	const waiting = savedTurn({ text: "behind the run", status: "queued", mode: "queue", at: now });
	assert.equal(waiting.status, "stopped");

	const thread = restoredThread({ id: "t10", title: "x", at: now, turns: [spent, writing, waiting] }, "/tmp/folder")!;
	assert.deepEqual(
		thread.turns.map((turn) => turn.status),
		["sent", "stopped", "stopped"],
	);
	assert.equal(thread.turns[0].mode, "steer");
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

test("and a flow the board named comes back as one the boss may still change", () => {
	// A flow inherited from the board is neither the human's pin nor the boss's own pick. Read back as
	// the human's, it would lock a boss out of choosing a flow of its own.
	const thread = restoredThread(
		{ id: "t4", title: "run the flow", mode: "boss", path: "simple", pathChosenBy: "board", at: now, turns: [] },
		"/tmp/folder",
	)!;
	assert.equal(thread.path, "simple");
	assert.equal(thread.pathChosenBy, "board");
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

test("a thread with no mode of its own still says a choice made mid-run is waiting", () => {
	// A thread typed into being carries no mode, which is the agent the board has always been: a human who
	// picks `plan` while it is answering must see the choice waiting against the agent the run in flight
	// follows, not a dark chip that reads as obeyed.
	const thread: any = { id: "t10", title: "typed", at: now, status: "running", turns: [] };
	// Neither a mode nor a run behind one: the card wears the queue state of its last turn and no chip at all.
	const born = cardFor(thread, null);
	assert.equal(born.mode, "queue");
	assert.equal(born.modeAtRun, undefined);
	thread.mode = "plan";
	const waiting = cardFor(thread, null);
	assert.equal(waiting.mode, "plan");
	assert.equal(waiting.modeAtRun, "agent");
});

test("a plain card becomes a card of its own kind", () => {
	const card = plainCardFor({ id: "c7", type: "note", title: "n", at: now, markdown: "body" }, null) as any;
	assert.equal(card.id, "c7");
	assert.equal(card.type, "note");
	assert.equal(card.markdown, "body");
});

test("a card carries its lineage, its size and its pin to the browser and back from its file", () => {
	const card = plainCardFor(
		{ id: "c11", type: "note", title: "n", at: now, markdown: "| a | b |", after: ["c7"], size: "wide", pinned: true },
		null,
	) as any;
	assert.deepEqual(card.after, ["c7"]);
	assert.equal(card.size, "wide");
	assert.equal(card.pinned, true);
	// A card with none of them says nothing about them, so a board that never carried one reads the same.
	const bare = plainCardFor({ id: "c12", type: "note", title: "n", at: now, markdown: "body", after: [] }, null) as any;
	assert.equal(bare.after, undefined);
	assert.equal(bare.size, undefined);
	assert.equal(bare.pinned, undefined);
	// The file is the other half: what comes back has the three, and a shape nothing names is dropped.
	const saved = restoredPlainCard({
		id: "c13",
		type: "note",
		markdown: "body",
		after: ["c7", 4],
		size: "wide",
		pinned: true,
	}) as any;
	assert.deepEqual(saved.after, ["c7"]);
	assert.equal(saved.size, "wide");
	assert.equal(saved.pinned, true);
	const odd = restoredPlainCard({ id: "c14", type: "note", markdown: "body", size: "enormous", pinned: "yes" }) as any;
	assert.equal(odd.size, undefined);
	assert.equal(odd.pinned, undefined);
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
