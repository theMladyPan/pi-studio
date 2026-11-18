import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Read shipped defaults without any prompt overrides from the user's running studio.
const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-card-prompts-"));
const wasState = process.env.PI_STUDIO_STATE;
process.env.PI_STUDIO_STATE = stateHome;
const { boardPrompt } = await import("../server/child/prompts.ts");
const { childArgv } = await import("../server/child/argv.ts");
const { promptOverridePath, savePromptOverride } = await import("../server/prompt-overrides.ts");
if (wasState === undefined) delete process.env.PI_STUDIO_STATE;
else process.env.PI_STUDIO_STATE = wasState;
after(() => rmSync(stateHome, { recursive: true, force: true }));

const board = { id: "b1", folder: stateHome, name: "board", config: {} };
const thread = {
	id: "abcdef123456", title: "a thread", provider: "test", model: "test",
	worktree: { path: stateHome, base: "dev", repo: stateHome },
};
const oldRules = /Most answers belong on the board|The human reads cards on that board, not a chat log|put the work on cards anyway|Your chat reply is a pointer|the chat points at|Done: the change on a card|do not add a summary under the pointer|one clause; nothing more|A card whenever the work has something to show/;

test("the default prompt answers in the thread and reserves cards for continuing value", () => {
	const text = boardPrompt(board, thread);
	assert.match(text, /Answer in the thread by default/);
	assert.match(text, /One-shot answers/);
	assert.match(text, /worth revisiting or keeping visible/);
	assert.match(text, /Do not make the human open a card to get the answer/);
	assert.doesNotMatch(text, oldRules);
});

test("card guidance requires context, meaningful titles and reusable examples", () => {
	const text = boardPrompt(board, thread);
	assert.match(text, /self-contained context/);
	assert.match(text, /relation to\s+the conversation or another card/);
	assert.match(text, /Name the artifact/);
	assert.match(text, /Here is my response/);
	for (const input of ["Did the tests pass?", "Keep a release checklist visible", "Chart failures by hour"]) {
		assert.ok(text.includes(input), `missing example: ${input}`);
	}
	assert.match(text, /OK:/);
	assert.match(text, /NOK:/);
});

test("no mode, boss flow or verbosity setting restores pointer-only answers", () => {
	const modes = [
		{ mode: "agent" }, { mode: "discuss" }, { mode: "plan" },
		...(["auto", "simple", "advanced", "complex"].map((path) => ({ mode: "boss", path }))),
	];
	for (const cardsVerbosity of ["quiet", "normal", "verbose"]) {
		for (const mode of modes) {
			const argv = childArgv({ ...board, config: { cardsVerbosity } }, { ...thread, ...mode });
			const text = argv[argv.indexOf("--append-system-prompt") + 1];
			assert.match(text, /Answer in the thread by default/);
			assert.doesNotMatch(text, oldRules);
		}
	}
});

test("missing conventions keep thread answers as the fallback and preserve saved overrides", () => {
	try {
		assert.equal(savePromptOverride("board/conventions.md", "", stateHome).ok, true);
		const fallback = boardPrompt(board, thread);
		assert.match(fallback, /conventions file is missing/);
		assert.match(fallback, /answer in the thread by default/i);
		assert.doesNotMatch(fallback, oldRules);
		const custom = "Keep a release checklist beside this project's conversation.";
		assert.equal(savePromptOverride("board/conventions.md", custom, stateHome).ok, true);
		assert.ok(boardPrompt(board, thread).includes(custom));
	} finally {
		rmSync(promptOverridePath("board/conventions.md", stateHome), { force: true });
	}
});

test("card tool descriptions reinforce useful artifacts rather than one-shot answers", () => {
	const bridge = readFileSync(new URL("../bridge/child-bridge.mjs", import.meta.url), "utf8");
	assert.match(bridge, /normal: "[^"]*worth revisiting or keeping visible/);
	assert.match(bridge, /One-shot answers belong in the thread/);
	assert.doesNotMatch(bridge, /three-line answer/);
});
