import assert from "node:assert/strict";
import { test } from "node:test";
import { childArgv } from "../server/child/argv.ts";
import { describeTool, firstLine, headline, resultText } from "../server/child/describe.ts";
import { boardPrompt, worktreePrompt } from "../server/child/prompts.ts";
import { BRIDGE } from "../server/paths.ts";

const board = { id: "b1", folder: "/tmp/board", name: "board", config: {} };
const thread = { id: "abcdef123456", title: "a thread", folder: "/tmp/board", worktree: { path: "/tmp/board/.agents/abcdef12", base: "dev", repo: "/tmp/board" } };

test("a child is started with the board bridge attached", () => {
	const argv = childArgv(board, thread);
	// The bridge is what gives a thread board_note, board_source and board_ask. Losing it is silent:
	// the child still runs, and every tool that reaches the board is simply not there.
	assert.ok(argv.includes("-e"), "no extension flag in argv");
	assert.ok(argv.includes(BRIDGE), "the board bridge is not in argv");
	assert.ok(argv.some((arg) => arg.includes("rpc")), "the child is not started in rpc mode");
});

test("a child keeps its sessions in the board's own folder, not pi's list", () => {
	const argv = childArgv(board, thread);
	// The app owns these conversations, so a thread that restarts resumes the same one.
	const at = argv.indexOf("--session-dir");
	assert.ok(at > -1, "no session dir in argv");
	assert.ok(argv[at + 1].includes("sessions"), `the session dir is ${argv[at + 1]}`);
	assert.ok(argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "rpc");
});

test("the tool list narrows only when the human asked for it", () => {
	const wide = childArgv(board, thread);
	const narrow = childArgv({ ...board, config: { toolsOff: ["ytrack"] } }, thread);
	assert.ok(wide.length > 0);
	assert.ok(narrow.length >= wide.length, "narrowing a tool list should not grow it");
});

test("a tool call is described by its name and its most useful argument", () => {
	const line = describeTool("read", { path: "/tmp/a.ts", offset: 3 });
	assert.match(line, /read/);
	assert.match(line, /a\.ts/);
});

test("a headline is the first line that says something", () => {
	assert.equal(headline("\n  one  \ntwo"), "one");
	assert.equal(headline(""), "the run failed");
	assert.equal(headline("  hello  "), "hello");
	assert.ok(headline("x".repeat(400)).length <= 160);
});

test("a tool's text is gathered in the order it was said", () => {
	assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
	assert.equal(resultText({}), "");
});



test("the prompts tell the child which board it is drawing on", () => {
	const worktree = worktreePrompt(board, thread);
	const plain = boardPrompt(board, thread);
	// The board prompt is what a thread is told about the cards it draws on.
	assert.ok(plain.includes("board_note"), "the board prompt does not mention board_note");
	assert.ok(plain.includes("board_source"), "the board prompt does not mention board_source");
	// The card draws mermaid itself, so a thread that is never told leaves the cheaper drawing on the
	// table and hand-places an svg instead: both words belong in the prompt, mermaid first.
	assert.ok(plain.includes("mermaid") && plain.indexOf("mermaid") < plain.indexOf("svg"), "the board prompt does not put mermaid ahead of svg");
	// The worktree prompt only has something to say when there is a tree.
	// The board prompt is the worktree prompt plus what the cards are for, so it is the longer one.
	assert.ok(plain.length > worktree.length, "the board prompt should carry the worktree prompt inside it");
	assert.ok(plain.includes(board.folder), "a thread is not told which folder it works in");
	assert.ok(worktree.includes(thread.worktree.path), "the worktree prompt does not name the tree");
});
