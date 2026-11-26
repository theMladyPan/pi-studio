import assert from "node:assert/strict";
import { test } from "node:test";
import { LOG_CAPACITY, LOG_MESSAGE_MAX, levelOf, levelPasses, log, redact, snapshot, subscribe } from "../server/logs.ts";
import type { LogEntry } from "../server/logs.ts";

/**
 * The daemon's log is the one place a human reads what a source said, so the three things that could
 * make it useless are pinned here: a buffer that grows without end, a secret written into it, and a
 * verbosity that shows the wrong lines.
 */

test("the ring keeps the newest lines and never more than it promises", () => {
	// The lines this file writes itself are in the buffer too, so what is read is the shape rather than
	// an absolute count: full, oldest first, and numbered without a gap.
	const first = log("info", "daemon", "the oldest line this test wrote");
	for (let i = 0; i < LOG_CAPACITY + 20; i += 1) log("debug", "daemon", `line ${i}`);
	const kept = snapshot();
	assert.equal(kept.length, LOG_CAPACITY, "the ring is full and no larger");
	assert.ok(!kept.some((entry) => entry.id === first.id), "the oldest line left the ring");
	const ids = kept.map((entry) => entry.id);
	assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "the ring stays in the order it was written");
	assert.equal(ids.length, new Set(ids).size, "no line is in the ring twice");
});

test("a message is capped, so one runaway print cannot become the whole buffer", () => {
	const entry = log("error", "git", "x".repeat(LOG_MESSAGE_MAX * 2));
	assert.equal(entry.message.length, LOG_MESSAGE_MAX);
});

test("every shape a secret wears is masked on the way in, and the rest of the line is kept", () => {
	const line = [
		"SWAN_API_KEY=sk-live-abc123",
		"OPENROUTER_API_KEY: sk-or-999",
		"GITHUB_TOKEN=ghp_2f8a",
		"authorization: Bearer eyJhbGciOi.abc.def",
		"claude-password=hunter2",
		"x-api-key: sk-ant-777",
	].join(" ");
	const masked = redact(line);
	for (const secret of ["sk-live-abc123", "sk-or-999", "ghp_2f8a", "eyJhbGciOi.abc.def", "hunter2", "sk-ant-777"]) {
		assert.ok(!masked.includes(secret), `${secret} is masked`);
	}
	// What named the secret stays: a redacted line still says which key or header was the problem.
	for (const name of ["SWAN_API_KEY", "OPENROUTER_API_KEY", "GITHUB_TOKEN", "authorization", "password", "x-api-key"]) {
		assert.ok(masked.includes(name), `${name} is kept`);
	}
});

test("a secret in a command, a folder or a meta value is masked as well", () => {
	// A meta grid is drawn from the same buffer as the message, so it is redacted by the same rule rather
	// than by a second one that a caller could forget.
	const entry = log("info", "daemon", "running", { cmd: "curl -H 'x-api-key: sk-abc' https://x", cwd: "/srv/app?password=s3cret", dur: 12 });
	assert.ok(!JSON.stringify(entry).includes("sk-abc"), "the header value in the command is masked");
	assert.ok(!JSON.stringify(entry).includes("s3cret"), "the value beside a password name is masked");
	assert.equal(entry.meta?.dur, 12, "a number is kept as a number");
});

test("a filter shows its own level and every worse one, and nothing better", () => {
	assert.equal(levelPasses("error", "error"), true);
	assert.equal(levelPasses("error", "warning"), true, "err+warn is one choice, so a warning stands with an error");
	assert.equal(levelPasses("error", "info"), false);
	assert.equal(levelPasses("info", "info"), true);
	assert.equal(levelPasses("info", "debug"), false, "info is the quiet end, so debug waits behind it");
	assert.equal(levelPasses("debug", "error"), true);
	assert.equal(levelPasses("debug", "debug"), true);
});

test("a level a caller wrote is read the way a level is spelled", () => {
	// A child writes `warn` because that is how it says it; the drawer has one word for it.
	assert.equal(levelOf("warn"), "warning");
	assert.equal(levelOf("WARNING"), "warning");
	assert.equal(levelOf("err"), "error");
	assert.equal(levelOf(undefined), "info");
	assert.equal(levelOf("whatever"), "info");
});

test("a subscriber sees the line as it is written, with the shape the drawer draws", () => {
	const seen: LogEntry[] = [];
	const stop = subscribe((entry) => seen.push(entry));
	const written = log("warning", "git", "git status · untracked", { cmd: "git status", cwd: "/tmp/x", exit: 0, dur: 42 });
	stop();
	log("warning", "git", "after the stream closed");

	assert.equal(seen.length, 1, "a line written after the stream closed reaches nobody");
	assert.deepEqual(seen[0], written);
	// The shape the client reads: an id to key a row by, an ISO stamp, the level as a word, a source and
	// the message. A stream that answered anything else would paint empty rows.
	assert.equal(typeof written.id, "number");
	assert.match(written.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assert.equal(written.level, "warning");
	assert.equal(written.source, "git");
	assert.equal(written.message, "git status · untracked");
	// An ISO stamp is what the snapshot and the stream both carry, so a row can be read in the browser
	// without a date the daemon never wrote.
	for (const entry of snapshot()) assert.equal(new Date(entry.ts).toISOString(), entry.ts);
});
