/**
 * What a boss is told it is running. The words are files a human edits, so these read them: `auto` hands
 * the boss the roster of agents and leaves the steps to it, and a named path hands it that recipe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { modeSystemPrompt, promptText } from "../server/child/modes.ts";
import { ROLE_NAMES } from "../server/child/roles.ts";

test("a boss on auto reads the roster of agents and no recipe", () => {
	const auto = modeSystemPrompt("boss", "auto");
	assert.ok(auto.includes(promptText("modes", "boss")), "the boss prompt comes first");
	assert.ok(auto.trimEnd().endsWith(promptText("flows", "auto")), "and the roster file is what is appended");
	for (const role of ROLE_NAMES) assert.ok(auto.includes(`\`${role}\``), `the roster names ${role}`);
	// Nothing to report and nothing to pick from: the tool that used to announce a flow is gone.
	assert.ok(!auto.includes("board_path"), "a boss on auto has no flow to announce");
});

test("a boss on a named path reads that recipe instead", () => {
	const simple = modeSystemPrompt("boss", "simple");
	assert.ok(simple.includes(promptText("modes", "boss")), "the boss prompt comes first");
	assert.ok(simple.includes(promptText("flows", "simple")), "and the simple flow is appended whole");
	assert.ok(!simple.includes(promptText("flows", "auto")), "the roster does not arrive beside a recipe");
});

test("a discuss thread is told to stay short and to change nothing", () => {
	const discuss = modeSystemPrompt("discuss");
	assert.ok(discuss.trim().length > 0, "a discuss thread is told something");
	assert.ok(discuss.includes(promptText("modes", "discuss")), "and the discuss file is what it reads");
	assert.match(discuss, /Answer short and bite sized/);
	assert.match(discuss, /you change nothing/);
});
