import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { MAX_IMAGES, acceptedImages, cardFor, plainCardFor, promptImages, thumbImages } from "../server/cards.ts";
import { savedTurn, restoredTurns } from "../server/store.ts";
import { onMessage } from "../server/routes/board/message.ts";

/** One pixel of PNG, which is all a test needs of a picture. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const png = (over: Record<string, unknown> = {}) => ({
	data: PIXEL,
	mimeType: "image/png",
	thumb: `data:image/png;base64,${PIXEL}`,
	...over,
});

test("a picture is the bytes, the type and the thumbnail, and anything else is dropped", () => {
	const accepted = acceptedImages([
		png(),
		// A picture with no thumbnail is not remembered, so it is not one the board takes.
		{ data: PIXEL, mimeType: "image/png" },
		// A `data:` prefix in `data` is the shape pi's RPC already adds, so it is not the base64 alone.
		png({ data: `data:image/png;base64,${PIXEL}` }),
		png({ mimeType: "text/plain" }),
		// A thumbnail that is not an image data URL is one a browser could not draw.
		png({ thumb: `base64,${PIXEL}` }),
		png({ data: "" }),
		png({ data: "not base64!" }),
		png({ thumb: 42 }),
		"a string is not a picture",
		null,
	]);
	assert.deepEqual(accepted, [png()]);
});

test("a message carries at most four pictures", () => {
	const six = Array.from({ length: 6 }, (_, at) => png({ thumb: `data:image/png;base64,${at}${PIXEL}` }));
	assert.equal(MAX_IMAGES, 4);
	assert.equal(acceptedImages(six).length, 4);
	// The cap counts pictures rather than entries, so junk before them costs nobody a picture.
	assert.equal(acceptedImages([null, ...six]).length, 4);
	assert.deepEqual(acceptedImages(undefined), []);
	assert.deepEqual(acceptedImages("nope"), []);
});

test("a turn keeps the thumbnail and never the bytes", () => {
	const kept = thumbImages(acceptedImages([png()]));
	assert.deepEqual(kept, [{ thumb: `data:image/png;base64,${PIXEL}`, mimeType: "image/png" }]);
	assert.equal("data" in kept[0], false);
	// The same gate reads a board file: a thumb nothing vouches for is not drawn.
	assert.deepEqual(thumbImages([{ thumb: "javascript:alert(1)", mimeType: "image/png" }, { mimeType: "image/png" }]), []);
});

test("pi is handed the bytes in the shape its RPC takes, without the thumbnail", () => {
	assert.deepEqual(promptImages(acceptedImages([png()])), [{ type: "image", data: PIXEL, mimeType: "image/png" }]);
	assert.deepEqual(promptImages([]), []);
});

test("a saved turn comes back with its pictures, and a file full of junk comes back without them", () => {
	const turn = { text: "", status: "answered", mode: "queue", at: 1, images: acceptedImages([png()]) };
	const restored = restoredTurns([savedTurn(turn)]);
	assert.equal(restored.length, 1);
	assert.equal(restored[0].text, "");
	assert.deepEqual(restored[0].images, [{ thumb: `data:image/png;base64,${PIXEL}`, mimeType: "image/png" }]);
	// What is written down is the thumbnail: a board file with the whole picture in it would grow by a
	// megabyte a screenshot.
	assert.equal(JSON.stringify(savedTurn(turn)).includes(PIXEL.repeat(2)), false);
	assert.deepEqual(restoredTurns([{ text: "x", images: [{ data: PIXEL, mimeType: "image/png" }] }])[0].images, undefined);
	assert.deepEqual(restoredTurns([{ text: "x" }])[0].images, undefined);
});

test("a card carries each turn's pictures on the turn, not a count on the card", () => {
	const turns = [{ text: "", status: "answered", mode: "queue", at: 1, images: thumbImages(acceptedImages([png()])) }];
	const thread = {
		id: "t1",
		title: "look at this",
		at: 1,
		status: "idle",
		turns,
		provider: "klotilda",
		model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
	};
	const card = cardFor(thread) as any;
	assert.equal("images" in card, false, "the card itself counts no pictures");
	assert.deepEqual(card.turns[0].images, [{ thumb: `data:image/png;base64,${PIXEL}`, mimeType: "image/png" }]);
	const note = plainCardFor({ id: "c1", type: "note", title: "note", at: 1, markdown: "hi", turns }, null) as any;
	assert.equal("images" in note, false);
	assert.deepEqual(note.turns[0].images, card.turns[0].images);
});

/**
 * A board as a request finds it: one idle thread in its own tree-less folder, and a child that records
 * what it was written on stdin instead of being a process. Nothing is spawned and no model is called.
 */
function boardWith(thread: Record<string, unknown>) {
	const written: string[] = [];
	const board = {
		id: "w1",
		name: "w1",
		folder: "/tmp/does-not-matter",
		threads: new Map([[thread.id, thread]]),
		cards: new Map(),
		children: new Map([[thread.id, { exitCode: null, stdin: { writable: true, write: (line: string) => written.push(line) } }]]),
		clients: new Set(),
		activity: [],
		trees: [],
	};
	return { board: board as any, written };
}

/** A request as `readJson` reads it, and a response that keeps the status and the body. */
function request(body: unknown) {
	const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
	req.method = "POST";
	const res: any = {
		status: 0,
		body: "",
		writeHead(status: number) {
			this.status = status;
		},
		end(payload: string) {
			this.body = payload;
		},
	};
	return { req, res };
}

const idleThread = (): any => ({
	id: "1111aaaa",
	title: "look at this",
	status: "idle",
	mode: "agent",
	runMode: "agent",
	hidden: false,
	folder: "/tmp/does-not-matter",
	turns: [],
	queued: [],
	// A thread that already has its tree is not made one here, so the handler runs no git.
	worktree: { skipped: "this folder is not a git repository" },
});

test("a message of pictures alone is recorded and reaches the child", async () => {
	const thread = idleThread();
	const { board, written } = boardWith(thread);
	const { req, res } = request({ cardId: thread.id, text: "", images: [png()] });
	await onMessage(req, res, board);
	assert.equal(res.status, 200, res.body);
	assert.equal(thread.turns.length, 1);
	assert.equal(thread.turns[0].text, "");
	assert.deepEqual(thread.turns[0].images, [{ thumb: `data:image/png;base64,${PIXEL}`, mimeType: "image/png" }]);
	assert.equal("data" in thread.turns[0].images[0], false);
	const sent = JSON.parse(written[0]);
	assert.equal(sent.type, "prompt");
	assert.deepEqual(sent.images, [{ type: "image", data: PIXEL, mimeType: "image/png" }]);
});

test("a message with no words and no picture is still refused, and a malformed picture is dropped", async () => {
	const thread = idleThread();
	const { board, written } = boardWith(thread);
	const empty = request({ cardId: thread.id, text: "  ", images: [{ data: "not base64!" }] });
	await onMessage(empty.req, empty.res, board);
	assert.equal(empty.res.status, 400);
	assert.match(empty.res.body, /empty message/);
	assert.deepEqual(written, []);

	// One good picture beside a broken one: the message goes, carrying only what the board can vouch for.
	const six = Array.from({ length: 6 }, (_, at) => png({ thumb: `data:image/png;base64,${at}${PIXEL}` }));
	const asked = request({ cardId: thread.id, text: "these", images: [null, ...six] });
	await onMessage(asked.req, asked.res, board);
	assert.equal(asked.res.status, 200, asked.res.body);
	assert.equal(thread.turns.length, 1);
	assert.equal(thread.turns[0].images.length, MAX_IMAGES);
	assert.equal(JSON.parse(written[0]).images.length, MAX_IMAGES);
});

test("a steer carries its pictures to the child, and one waiting behind a run keeps them", async () => {
	const steering = { ...idleThread(), id: "2222bbbb", status: "running" };
	const { board, written } = boardWith(steering);
	const { req, res } = request({ cardId: steering.id, text: "this instead", mode: "steer", images: [png()] });
	await onMessage(req, res, board);
	assert.equal(res.status, 200, res.body);
	const sent = JSON.parse(written[0]);
	assert.equal(sent.type, "steer");
	assert.deepEqual(sent.images, [{ type: "image", data: PIXEL, mimeType: "image/png" }]);

	// The same message behind a run that is already answering waits with its pictures, because nothing has
	// read them yet: the queue is what the next prompt is built from.
	const queued = { ...idleThread(), id: "3333cccc", status: "running" };
	const behind = boardWith(queued);
	const waiting = request({ cardId: queued.id, text: "and this", images: [png()] });
	await onMessage(waiting.req, waiting.res, behind.board);
	assert.equal(waiting.res.status, 200, waiting.res.body);
	assert.deepEqual(behind.written, []);
	assert.deepEqual(queued.queued[0].images, acceptedImages([png()]));
	// The turn the card draws carries the thumbnail alone.
	assert.deepEqual(queued.turns[0].images, [{ thumb: `data:image/png;base64,${PIXEL}`, mimeType: "image/png" }]);
});


test("a message with no picture is written to the child exactly as before", async () => {
	const thread = idleThread();
	const { board, written } = boardWith(thread);
	const { req, res } = request({ cardId: thread.id, text: "hello" });
	await onMessage(req, res, board);
	assert.equal(res.status, 200, res.body);
	const sent = JSON.parse(written[0]);
	assert.deepEqual(Object.keys(sent).sort(), ["id", "message", "type"]);
	// The board's sections are there whatever the message carries, so the words arrive named as ever.
	assert.equal(sent.message, "[user message]\nhello");
	assert.equal(thread.turns[0].images, undefined);
	assert.equal(written[0].includes('"images"'), false);
});
