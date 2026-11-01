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

test("a spawned child is not given the bridge at all", () => {
	// It draws nothing, so the tools it would register are the ones the guard refuses. Loading them and
	// refusing the route is two places to keep in step; not loading them is one.
	const argv = childArgv(board, { ...thread, parentThread: "master-1" });
	assert.ok(!argv.includes(BRIDGE), "a spawned child was handed the board bridge");
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

test("a boss may not write, and a planner may not either", () => {
	// The mode is behaviour, not advice: a boss that can edit is a boss doing the work it was meant to
	// hand out, and a planner that can edit has stopped planning.
	const boss = childArgv(board, { ...thread, mode: "boss", path: "advanced" });
	const at = boss.indexOf("--exclude-tools");
	assert.ok(at > -1, "a boss got no excluded tools");
	assert.ok(boss[at + 1].includes("write") && boss[at + 1].includes("edit"), `a boss may still write: ${boss[at + 1]}`);
	const planner = childArgv(board, { ...thread, mode: "plan" });
	const planned = planner[planner.indexOf("--exclude-tools") + 1];
	assert.ok(planned.includes("write") && planned.includes("edit"), `a planner may still write: ${planned}`);
	// An agent is the baseline: it keeps the tools every thread had before modes existed.
	const agent = childArgv(board, { ...thread, mode: "agent" });
	const plain = agent.indexOf("--exclude-tools");
	assert.ok(plain === -1 || !agent[plain + 1].includes("write"), `an agent lost its write tool: ${agent[plain + 1]}`);
});

test("a boss carries the flow it runs, and an agent carries nothing", () => {
	const text = (argv: string[]) => argv[argv.indexOf("--append-system-prompt") + 1];
	assert.match(text(childArgv(board, { ...thread, mode: "boss", path: "simple" })), /scout/);
	assert.match(text(childArgv(board, { ...thread, mode: "plan" })), /no `write`/);
	assert.doesNotMatch(text(childArgv(board, { ...thread, mode: "agent" })), /You are the boss/);
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

test("a spawned child is told it draws nothing, and the pointer convention is not said to it", () => {
	const said = boardPrompt(board, { ...thread, parentThread: "master-1" });
	assert.match(said, /draw nothing/);
	assert.doesNotMatch(said, /board_note/, "a spawned child was told to write a card");
	assert.doesNotMatch(said, /\[\[/, "a spawned child was given the pointer convention");
	// Its folder is still its own, because that is where it reads and edits.
	assert.ok(said.includes(thread.worktree.path), "the child prompt does not name its tree");
});

test("the board's card settings reach the prompt, and a default board reads as normal for a programmer", () => {
	const plain = boardPrompt(board, thread);
	assert.match(plain, /Cards on this board: normal\./);
	assert.match(plain, /Cards are written for: programmer\./);
	for (const line of [/code fragments: some/, /math formulas: some/, /charts: some/, /references: some/]) assert.match(plain, line);
	// A mermaid diagram is not one of the four things a switch limits: it shows structure, and it says so.
	assert.match(plain, /mermaid block is fine at every level/);
	// A level is a default: the human asking for the thing by name outranks it, and the prompt says which
	// words do that, because a model told "none" and nothing else will refuse a direct request.
	assert.match(plain, /a default, not a refusal/);
	for (const ask of ["show me the function", "show me the formula", "show me the chart", "show me the source"]) {
		assert.ok(plain.includes(ask), `the prompt does not name the ask "${ask}"`);
	}
	const quiet = boardPrompt(
		{ ...board, config: { cardsVerbosity: "quiet", cardsAudience: "vibecoder", showCodeFragments: "none", showReferences: "none" } },
		thread,
	);
	assert.match(quiet, /Cards on this board: quiet\./);
	assert.match(quiet, /Cards are written for: vibecoder\./);
	assert.match(quiet, /code fragments: none/);
	assert.match(quiet, /references: none/);
	// A level is read rather than thrown away when the board file is older than three levels.
	const legacy = boardPrompt({ ...board, config: { showCodeFragments: false, showCharts: true } }, thread);
	assert.match(legacy, /code fragments: none/);
	assert.match(legacy, /charts: some/);
	// A board on the defaults says the same thing as a board that stored nothing, so an old board file is
	// the same prompt as a new one.
	assert.equal(boardPrompt({ ...board, config: {} }, thread), plain);
});
