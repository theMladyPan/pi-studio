import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionImage, transcriptOf } from "../server/session.ts";

/** One pixel of PNG, which is all a test needs of a picture. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** A session file with a system prompt, a user turn holding a picture, and the answer to it. */
function sessionFolder(lines: unknown[]): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-studio-session-"));
	const file = join(dir, "2026-01-01T00-00-00-000Z_01a1ac1a-6bc5-746e-ad81-800dc587082c.jsonl");
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return { dir, file };
}

const said = (role: string, content: unknown[]) => ({ type: "message", message: { role, content } });
const TEXT = { type: "text", text: "[user message]\nwhat is wrong in this picture" };
const SHOT = { type: "image", data: PIXEL, mimeType: "image/png" };

test("a picture in a user turn is its own entry, so the drawer can draw it", () => {
	const { dir, file } = sessionFolder([
		said("system", [{ type: "text", text: "you are an agent" }]),
		said("user", [TEXT, SHOT]),
		said("assistant", [{ type: "text", text: "the button is off screen" }]),
	]);
	try {
		const entries = transcriptOf(file);
		assert.ok(entries);
		assert.deepEqual(entries, [
			{ kind: "user", text: TEXT.text },
			// An image block carries no words, so its place in the transcript is an entry of its own that
			// names which picture of the session it is.
			{ kind: "image", text: "", image: 0 },
			{ kind: "answer", text: "the button is off screen" },
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the second and third pictures of a session are numbered in the order they were sent", () => {
	const { dir, file } = sessionFolder([
		said("user", [TEXT, SHOT]),
		said("user", [{ type: "text", text: "[user message]\ntwo more" }, SHOT, { ...SHOT, mimeType: "image/jpeg" }]),
	]);
	try {
		const images = (transcriptOf(file) ?? []).filter((entry) => entry.kind === "image");
		assert.deepEqual(images.map((entry) => entry.image), [0, 1, 2]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a picture is read back by its number, and a number the session does not have is nothing", () => {
	const { dir, file } = sessionFolder([said("user", [TEXT, SHOT]), said("user", [{ type: "text", text: "again" }, { ...SHOT, mimeType: "image/jpeg" }])]);
	try {
		assert.deepEqual(sessionImage(file, 0), { mime: "image/png", data: PIXEL });
		assert.deepEqual(sessionImage(file, 1), { mime: "image/jpeg", data: PIXEL });
		assert.equal(sessionImage(file, 2), null);
		assert.equal(sessionImage(file, -1), null);
		assert.equal(sessionImage(join(dir, "no-such-session.jsonl"), 0), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a picture keeps its own type, and a block that names no type is served as a png", () => {
	const { dir, file } = sessionFolder([
		said("user", [TEXT, { type: "image", data: PIXEL }]),
		said("user", [{ type: "text", text: "again" }, { type: "image", data: PIXEL, mimeType: "" }]),
	]);
	try {
		assert.equal(sessionImage(file, 0)?.mime, "image/png");
		assert.equal(sessionImage(file, 1)?.mime, "image/png");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
