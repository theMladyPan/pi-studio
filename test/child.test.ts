import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { childArgv } from "../server/child/argv.ts";
import { ensureChild, wireText } from "../server/child/run.ts";
import { modeChangeNote } from "../server/child/modes.ts";
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

test("a mode change is announced, and only when the mode really changed", () => {
	// The new mode's own words arrive through the system prompt the next process is started with. This
	// note is the other half: the conversation keeps the turns the old mode wrote, so the model has to be
	// told that they stopped being instructions.
	const note = modeChangeNote("boss", "agent");
	assert.match(note, /mode has changed/);
	assert.match(note, /started as a boss/);
	assert.match(note, /You are an agent now/);
	// The same mode twice is nothing to say, and neither is a thread that never ran or one with no mode.
	assert.equal(modeChangeNote("boss", "boss"), "");
	assert.equal(modeChangeNote(undefined, "agent"), "");
	assert.equal(modeChangeNote("agent", ""), "");
	// A mode that is not the baseline is pointed at its own instructions rather than told it is an agent.
	assert.match(modeChangeNote("agent", "plan"), /the plan instructions in your system prompt/);
});

test("a message on a thread whose mode changed carries the note, and every other is sent as typed", () => {
	const changed = wireText({ id: "t1", mode: "agent", runMode: "boss" }, "hello");
	assert.ok(changed.startsWith("[this thread's mode has changed]"), changed.slice(0, 60));
	assert.ok(changed.endsWith("\n\nhello"), "the human's own words are not at the end of the message");
	assert.equal(wireText({ id: "t2", mode: "boss", runMode: "boss" }, "hello"), "hello");
	assert.equal(wireText({ id: "t3", mode: "agent" }, "hello"), "hello");
	// A spawned child carries a role instead of a mode, so there is no mode change it could be told about.
	assert.equal(wireText({ id: "t4", mode: "agent", runMode: "boss", parentThread: "p" }, "hello"), "hello");
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

test("the board's conventions are the file a human edits, whole, and only once", () => {
	const plain = boardPrompt(board, thread);
	const file = readFileSync(new URL("../prompts/board/conventions.md", import.meta.url), "utf8").trim();
	assert.ok(file.length > 0, "the conventions file is empty");
	// Verbatim: the settings page saves these bytes and the prompt is built from them, so an edit there
	// reaches the next thread with no second copy in code to disagree with it.
	assert.ok(plain.includes(file), "the conventions file is not the text the thread reads");
	// One copy only. Advice written in both the file and the prompt is advice a human's edit half reaches.
	assert.equal(plain.match(/Do not narrate/g)?.length, 1, "the no-narration rule is said twice");
	// The mechanics stay in code, where the file cannot take them away.
	assert.match(plain, /pass a short key to board_note/);
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
	// A board that stored nothing brings a child's work back by merging, and it says so where the prompt
	// can be read rather than leaving the boss to guess.
	assert.match(plain, /brings a child's work back with: merge/);
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

const git = (folder: string, ...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();

/** A throwaway repository with one commit on `dev`. Never the human's. */
function scratchRepo() {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-child-git-"));
	git(folder, "init", "-b", "dev");
	git(folder, "config", "user.email", "test@example.invalid");
	git(folder, "config", "user.name", "test");
	writeFileSync(join(folder, "readme.md"), "hello\n");
	git(folder, "add", ".");
	git(folder, "commit", "-m", "first");
	return folder;
}

/**
 * A `pi` that is not pi: it writes down the folder it was started in, then waits on stdin so the daemon
 * never sees a child that died mid-write. It is a string rather than a file of its own because
 * `node --test` runs every file it finds under `test/`.
 */
const STUB_PI = String.raw`
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(__dirname, "cwd.txt"), process.cwd());
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

/** Write that stub where the daemon looks for pi, so no real child is ever started. */
function stubPi(root: string) {
	const version = "0.0.0-test";
	const packageDir = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	const bundle = join(packageDir, "dist", "bundle");
	mkdirSync(bundle, { recursive: true });
	writeFileSync(join(root, "current-version"), `${version}\n`);
	// The install carries its own manifest, so the stub is read as CommonJS whatever folder it was made in.
	writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "commonjs" })}\n`);
	writeFileSync(join(bundle, "cli.js"), STUB_PI);
	return { root, cwdFile: join(bundle, "cwd.txt") };
}

/** The folder the child was started in, once it has written it down. */
async function startedIn(file: string) {
	for (let tries = 0; tries < 100; tries++) {
		if (existsSync(file)) return readFileSync(file, "utf8");
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`the stub child never wrote ${file}`);
}

test("a child with no tree of its own is given one before it starts", async () => {
	const repo = scratchRepo();
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-child-")));
	// The only pi this process may start is the stub.
	const was: string | undefined = process.env.PI_MANAGED_INSTALL_ROOT;
	process.env.PI_MANAGED_INSTALL_ROOT = stub.root;
	let started: any;
	try {
		const board: any = { id: "b1", folder: repo, name: "scratch", config: {}, children: new Map(), trees: [], threads: new Map() };
		// A thread back from undo: its tree was retired, so the record it works from is gone.
		const thread: any = { id: "abcdef123456", title: "a thread", folder: repo, provider: "p", model: "m" };
		board.threads.set(thread.id, thread);
		started = ensureChild(board, thread);
		const cwd = await startedIn(stub.cwdFile);
		assert.notEqual(cwd, repo, "the child was started in the folder the human works in");
		// The folder it was started in is the tree the thread now records, in the board's own tree folder.
		assert.equal(cwd, thread.worktree?.path, `the child was started in ${cwd}, not its tree`);
		assert.match(cwd, /\.agents[\\/]abcdef12$/);
	} finally {
		started?.stdin?.end();
		started?.kill();
		if (was === undefined) delete process.env.PI_MANAGED_INSTALL_ROOT;
		else process.env.PI_MANAGED_INSTALL_ROOT = was;
		for (const gone of [repo, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a thread whose mode changed is not served by the process started under the old one", async () => {
	// A mode is in the prompt and in the tool list a process is started with, so a boss that was made an
	// agent mid-run cannot keep answering as the boss: the next message starts a new process instead.
	const repo = scratchRepo();
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-mode-")));
	const was: string | undefined = process.env.PI_MANAGED_INSTALL_ROOT;
	process.env.PI_MANAGED_INSTALL_ROOT = stub.root;
	const started: any[] = [];
	try {
		const board: any = { id: "b1", folder: repo, name: "scratch", config: {}, children: new Map(), trees: [], threads: new Map() };
		const thread: any = { id: "abcdef123456", title: "a boss", folder: repo, provider: "p", model: "m", mode: "boss", path: "simple" };
		board.threads.set(thread.id, thread);
		const boss = ensureChild(board, thread);
		started.push(boss);
		assert.equal(thread.runMode, "boss", "the mode the process was started with was not recorded");
		thread.mode = "agent";
		const agent = ensureChild(board, thread);
		started.push(agent);
		assert.notEqual(agent, boss, "the boss's own process was kept to answer as an agent");
		assert.equal(thread.runMode, "agent");
		assert.equal(board.children.get(thread.id), agent);
		// A mode that did not change is the same process: this is a change, not a restart on every message.
		assert.equal(ensureChild(board, thread), agent);
	} finally {
		for (const child of started) {
			child?.stdin?.end();
			child?.kill();
		}
		if (was === undefined) delete process.env.PI_MANAGED_INSTALL_ROOT;
		else process.env.PI_MANAGED_INSTALL_ROOT = was;
		for (const gone of [repo, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});
