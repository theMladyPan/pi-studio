import assert from "node:assert/strict";
import { test } from "node:test";
import { namePrompt, plausibleTitle, titleFromRequest } from "../server/worktrees/name.ts";

/**
 * What the naming model is allowed to have said. The two answers below are the two the daemon refused in
 * the wild, and each one is a perfectly good card name: the gate, not the model, was wrong.
 */

test("a five word name the model echoed back from a short request is kept", () => {
	assert.equal(plausibleTitle("YT MCP server in /tmp\n"), "YT MCP server in /tmp");
});

test("a reply to a short request is not a name", () => {
	assert.equal(plausibleTitle("hi — how can I help?\n"), "");
});

test("the newline, quotes and dressing the model wraps a name in come off", () => {
	assert.equal(plausibleTitle("\n**board dark theme**\n"), "board dark theme");
	assert.equal(plausibleTitle('  "rail row detail."  '), "rail row detail");
	assert.equal(plausibleTitle("- empty input rejection"), "empty input rejection");
	assert.equal(plausibleTitle("1. parser tokenizer fix"), "parser tokenizer fix");
});

test("one word is a name, unless it names the kind of thing instead of the work", () => {
	assert.equal(plausibleTitle("tuist"), "tuist");
	assert.equal(plausibleTitle("greeting reply"), "greeting reply");
	assert.equal(plausibleTitle("bug"), "");
	assert.equal(plausibleTitle("work"), "");
	assert.equal(plausibleTitle("thread 1a2b3c4d"), "");
});

test("a sentence and an empty answer are both refused", () => {
	assert.equal(plausibleTitle("The Parser Rejects Empty Input Because The Tokenizer Splits Wrong"), "");
	assert.equal(plausibleTitle(""), "");
	assert.equal(plausibleTitle("\n\n"), "");
});

test("the prompt teaches the short request the model got wrong", () => {
	assert.match(namePrompt("hi"), /request: "hi" -> ok: greeting reply/);
});

test("the request's own words are the floor a card never falls below", () => {
	assert.equal(titleFromRequest("add a dark theme to the board"), "add a dark theme to the board");
	assert.equal(titleFromRequest("# why does the parser reject empty input?"), "why does the parser reject empty input?");
	assert.match(titleFromRequest("x ".repeat(60)), /…$/);
});
