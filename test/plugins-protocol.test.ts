import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FrameReader,
	INTERNAL_ERROR,
	INVALID_REQUEST,
	MAX_FRAME_BYTES,
	PARSE_ERROR,
	encodeFrame,
	errorFrame,
	notificationFrame,
	parseMessage,
	requestFrame,
	resultFrame,
} from "../server/plugins/protocol.ts";

// ---------- writing a frame ----------

test("a frame is one JSON message on one line", () => {
	assert.equal(encodeFrame(requestFrame(1, "echo", { text: "hi" })), '{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"hi"}}\n');
	assert.equal(encodeFrame(notificationFrame("shutdown")), '{"jsonrpc":"2.0","method":"shutdown"}\n');
	assert.equal(encodeFrame(resultFrame(2, null)), '{"jsonrpc":"2.0","id":2,"result":null}\n');
	assert.equal(encodeFrame(errorFrame(null, { code: INVALID_REQUEST, message: "no" })), '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"no"}}\n');
});

test("a frame past the limit is refused where it is built", () => {
	assert.throws(() => encodeFrame(requestFrame(1, "echo", { text: "x".repeat(MAX_FRAME_BYTES) })), /exceeds the 1048576 byte limit/);
});

// ---------- reading a frame ----------

test("a frame is read back as the message it is", () => {
	assert.deepEqual(parseMessage('{"jsonrpc":"2.0","id":7,"method":"echo","params":{"a":1}}'), { kind: "request", id: 7, method: "echo", params: { a: 1 } });
	assert.deepEqual(parseMessage('{"jsonrpc":"2.0","method":"ready"}'), { kind: "notification", method: "ready", params: undefined });
	assert.deepEqual(parseMessage('{"jsonrpc":"2.0","id":"a","result":42}'), { kind: "response", id: "a", result: 42 });
	assert.deepEqual(parseMessage('{"jsonrpc":"2.0","id":3,"error":{"code":-32001,"message":"no"}}'), { kind: "response", id: 3, error: { code: -32001, message: "no" } });
});

test("a frame that is not a message is read as the reason it is not one", () => {
	assert.deepEqual(parseMessage("not json"), { kind: "invalid", id: null, error: { code: PARSE_ERROR, message: "the frame is not JSON" } });
	assert.deepEqual(parseMessage("[]"), { kind: "invalid", id: null, error: { code: INVALID_REQUEST, message: "a frame must be one JSON object" } });
	assert.equal((parseMessage('{"id":1,"method":"echo"}') as { error: { message: string } }).error.message, 'every frame must say "jsonrpc": "2.0"');
	// A request whose id is an object cannot be answered, so it is refused with a null id.
	assert.deepEqual(parseMessage('{"jsonrpc":"2.0","id":{"a":1},"method":"echo"}'), { kind: "invalid", id: null, error: { code: INVALID_REQUEST, message: "an id must be a string or a number" } });
	assert.equal((parseMessage('{"jsonrpc":"2.0","id":1}') as { error: { message: string } }).error.message, "a response carries a result or an error");
	assert.equal((parseMessage('{"jsonrpc":"2.0","method":"  "}') as { error: { message: string } }).error.message, "a frame is a request, a response or a notification");
});

test("an error a plugin wrote in another shape is read as an internal error", () => {
	assert.deepEqual(parseMessage('{"jsonrpc":"2.0","id":3,"error":"boom"}'), {
		kind: "response",
		id: 3,
		error: { code: INTERNAL_ERROR, message: "the plugin answered an error that is not an object" },
	});
	assert.deepEqual(parseMessage('{"jsonrpc":"2.0","id":3,"error":{"message":"boom"}}'), {
		kind: "response",
		id: 3,
		error: { code: INTERNAL_ERROR, message: "boom" },
	});
});

// ---------- bytes into lines ----------

test("a chunk may end in the middle of a character", () => {
	const reader = new FrameReader();
	const text = '{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"héllo 🌍"}}';
	const bytes = Buffer.from(`${text}\n`, "utf8");
	const frames: string[] = [];
	for (const byte of bytes) frames.push(...reader.push(Buffer.from([byte])).frames);
	assert.deepEqual(frames, [text]);
	assert.equal(JSON.parse(frames[0]).params.text, "héllo 🌍");
});

test("two frames in one chunk read as two, and one frame in two chunks reads as one", () => {
	const reader = new FrameReader();
	assert.deepEqual(reader.push(Buffer.from('{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc"')), { frames: ['{"jsonrpc":"2.0","method":"a"}'], dropped: 0 });
	assert.deepEqual(reader.push(Buffer.from(':"2.0","method":"b"}\n')), { frames: ['{"jsonrpc":"2.0","method":"b"}'], dropped: 0 });
});

test("one CR before the LF is stripped, and a frame keeps any other", () => {
	const reader = new FrameReader();
	assert.deepEqual(reader.push('{"method":"a"}\r\n'), { frames: ['{"method":"a"}'], dropped: 0 });
	assert.deepEqual(reader.push('{"method":"a"}\r\r\n'), { frames: ['{"method":"a"}\r'], dropped: 0 });
});

test("a line that has not ended yet is not a frame", () => {
	const reader = new FrameReader();
	assert.deepEqual(reader.push('{"jsonrpc":"2.0","method":"a"}'), { frames: [], dropped: 0 });
	assert.deepEqual(reader.push("\n"), { frames: ['{"jsonrpc":"2.0","method":"a"}'], dropped: 0 });
});

test("blank lines are not messages", () => {
	const reader = new FrameReader();
	assert.deepEqual(reader.push("\n\n\n"), { frames: [], dropped: 0 });
});

test("a frame past the limit is dropped and the next one still reads", () => {
	const reader = new FrameReader();
	const huge = `{"jsonrpc":"2.0","method":"a","params":"${"x".repeat(MAX_FRAME_BYTES)}"}`;
	assert.deepEqual(reader.push(`${huge}\n{"jsonrpc":"2.0","method":"ok"}\n`), { frames: ['{"jsonrpc":"2.0","method":"ok"}'], dropped: 1 });
});

test("a frame that outgrows the buffer is dropped whole, up to its line end", () => {
	const reader = new FrameReader();
	// No LF yet, and already past the limit: the rest of this frame cannot be kept either.
	assert.deepEqual(reader.push("x".repeat(MAX_FRAME_BYTES + 1)), { frames: [], dropped: 0 });
	assert.deepEqual(reader.push('\n{"jsonrpc":"2.0","method":"after"}\n'), { frames: ['{"jsonrpc":"2.0","method":"after"}'], dropped: 1 });
});
