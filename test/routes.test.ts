import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * One daemon on its own state folder, started the way a human starts it. Nothing is spawned from a
 * thread here, so no `pi` child ever runs and no model is called — except where a test passes `env` to
 * put a stub `pi` in the daemon's way.
 */
async function boot(folder: string, env: Record<string, string> = {}) {
	const child = spawn(process.execPath, [join(repo, "server.ts"), "--no-open"], {
		cwd: repo,
		env: { ...process.env, PI_STUDIO_STATE: folder, PI_STUDIO_PORT: "", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const noise: string[] = [];
	child.stderr.on("data", (chunk) => noise.push(String(chunk)));
	const url = await new Promise<string>((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(() => reject(new Error(`no listening line in 20s: ${noise.join("")}`)), 20_000);
		child.stdout.on("data", (chunk) => {
			seen += String(chunk);
			const match = seen.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/);
			if (!match) return;
			clearTimeout(timer);
			resolve(match[1]);
		});
		child.on("exit", (code) => reject(new Error(`the daemon exited with ${code}: ${noise.join("").slice(-400)}`)));
	});
	const parsed = new URL(url);
	return { child, noise, base: parsed.origin, token: parsed.searchParams.get("token") ?? "" };
}

type Daemon = { child: { kill: () => void }; noise: string[]; base: string; token: string };
const get = async (daemon: Daemon, path: string, init?: RequestInit) => {
	const res = await fetch(daemon.base + path, init);
	return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
};
const post = (daemon: Daemon, path: string, body?: unknown) =>
	get(daemon, `${path}?token=${daemon.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
/** A POST that names the board it is about, which every card route needs. */
const postTo = (daemon: Daemon, board: string, path: string, body?: unknown) =>
	get(daemon, `${path}?token=${daemon.token}&workspace=${board}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
/** The same, carrying someone else's token: a thread speaks for itself and not for the human. */
const postAs = (daemon: Daemon, token: string, board: string, path: string, body?: unknown) =>
	get(daemon, `${path}?token=${token}&workspace=${board}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});

/** The question card the daemon wrote, read back until it is on the board. */
async function questionCard(daemon: Daemon, board: string) {
	for (let tries = 0; tries < 100; tries++) {
		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board}`)).body);
		const card = (state.cards as any[]).find((one) => one.type === "question");
		if (card) return card;
		await new Promise((done) => setTimeout(done, 50));
	}
	return null;
}

test("the daemon boots, opens a workspace, and answers for its board", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-"));
	const daemon = await boot(folder);
	try {
		const page = await get(daemon, "/");
		assert.equal(page.status, 200);
		assert.match(page.type, /text\/html/);

		const opened = await post(daemon, "/workspace", { folder });
		assert.equal(opened.status, 200);
		const board = JSON.parse(opened.body).board;
		assert.ok(board?.id, "no board came back");

		const state = await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`);
		assert.equal(state.status, 200);
		assert.ok(Array.isArray(JSON.parse(state.body).threads));

		const workspaces = await get(daemon, `/workspaces?token=${daemon.token}`);
		assert.equal(workspaces.status, 200);
		assert.ok(workspaces.body.includes(board.id));

		const models = await get(daemon, `/models?token=${daemon.token}`);
		assert.equal(models.status, 200);
		assert.ok(Array.isArray(JSON.parse(models.body).models));

		const tools = await get(daemon, `/tools?token=${daemon.token}`);
		assert.equal(tools.status, 200);

		const browse = await get(daemon, `/browse?token=${daemon.token}&path=${encodeURIComponent(folder)}`);
		assert.equal(browse.status, 200);

		const layout = await post(daemon, "/layout", { id: board.id, view: { x: 1, y: 2, k: 1 } });
		// 409 is the honest answer for a card that is not on this board, and it means the route was reached.
		assert.ok([200, 409].includes(layout.status), `layout answered ${layout.status}`);

		const detail = await get(daemon, `/transcript?token=${daemon.token}&workspace=${board.id}&thread=nope`);
		assert.ok([200, 400, 404].includes(detail.status), `transcript answered ${detail.status}`);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("the crossroads defaults can be changed and are read back", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-"));
	const daemon = await boot(folder);
	try {
		const before = await get(daemon, `/defaults?token=${daemon.token}`);
		assert.equal(before.status, 200);
		const levels = JSON.parse(before.body).levels;
		assert.ok(Array.isArray(levels) && levels.length > 0, "no thinking levels came back");

		const saved = await post(daemon, "/defaults", { thinking: levels[0], dimOthers: false });
		assert.equal(saved.status, 200, saved.body.slice(0, 200));
		const answered = JSON.parse(saved.body).defaults;
		assert.equal(answered.thinking, levels[0]);
		assert.equal(answered.dimOthers, false);

		// Written to the state folder, so the next daemon on this folder starts with them.
		const written = JSON.parse(readFileSync(join(folder, "workspaces.json"), "utf8"));
		assert.equal(written.defaults.thinking, levels[0]);
		assert.equal(written.defaults.dimOthers, false);

		const after = JSON.parse((await get(daemon, `/defaults?token=${daemon.token}`)).body).defaults;
		assert.equal(after.thinking, levels[0]);
		assert.equal(after.dimOthers, false);

		const refused = await post(daemon, "/defaults", { thinking: "shouting" });
		assert.equal(refused.status, 400);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a route without the token is refused, and the page is not", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-"));
	const daemon = await boot(folder);
	try {
		assert.equal((await get(daemon, "/state")).status, 403);
		assert.equal((await get(daemon, "/")).status, 200);
		// Every client module is served under /client/; the entry is the only one the page names.
		const script = await get(daemon, "/client/board.js");
		assert.equal(script.status, 200);
		assert.match(script.type, /javascript/);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a question that takes several answers keeps all of them", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		// The daemon holds this request open until the question is settled, so it is not awaited yet.
		const held = postTo(daemon, board.id, "/card/ask", {
			question: "which of these?",
			options: ["a", "b", "c"],
			multiple: true,
			allowFreeText: false,
		});
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the question never reached the board");
		assert.equal(card.multiple, true);
		assert.equal(card.status, "open");

		// An option list is closed when free text is off, so a pick that is not on it is refused and
		// the question stays open rather than being answered with something nobody offered.
		const stray = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", "z"] });
		assert.equal(stray.status, 400);
		const empty = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: [] });
		assert.equal(empty.status, 400);

		const sent = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", "c"] });
		assert.equal(sent.status, 200);
		// The child that asked reads one line, and the card keeps the two picks apart for the reader.
		const answered = await held;
		assert.equal(answered.status, 200);
		const reply = JSON.parse(answered.body);
		assert.equal(reply.answer, "a, c");
		assert.deepEqual(reply.answers, ["a", "c"]);

		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const settled = (state.cards as any[]).find((one) => one.id === card.id);
		assert.equal(settled.status, "answered");
		assert.deepEqual(settled.answers, ["a", "c"]);

		// A second answer is still the 409 it always was.
		const again = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["b"] });
		assert.equal(again.status, 409);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a question that takes one answer is answered by one click, as before", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-one-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		const held = postTo(daemon, board.id, "/card/ask", { question: "which one?", options: ["a", "b"] });
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the question never reached the board");
		assert.equal(card.multiple, false);
		const sent = await postTo(daemon, board.id, "/answer", { cardId: card.id, answer: "b" });
		assert.equal(sent.status, 200);
		const reply = JSON.parse((await held).body);
		assert.equal(reply.answer, "b");
		assert.equal(reply.answers, undefined);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a card asks up to five questions on tabs, and settles them all at once", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-tabs-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		// A card of six tabs is a form rather than a question, so the daemon refuses it and the card is
		// never written.
		const tooMany = await postTo(daemon, board.id, "/card/ask", {
			questions: Array.from({ length: 6 }, (_, at) => ({ question: `q${at}?`, options: ["a", "b"] })),
		});
		assert.equal(tooMany.status, 400);

		const held = postTo(daemon, board.id, "/card/ask", {
			title: "three things",
			questions: [
				{ question: "which one?", options: ["a", "b"] },
				{ question: "which of these?", options: ["x", "y"], multiple: true, allowFreeText: false },
				{ question: "any words?", options: ["yes", "no"] },
			],
		});
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the questions never reached the board");
		assert.equal(card.questions.length, 3);
		assert.equal(card.questions[1].multiple, true);
		assert.equal(card.questions[1].allowFreeText, false);

		// Every tab sends its own answer, in tab order: a card of tabs is one call and half a form is not
		// a card the child can read.
		const short = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", ["x"]] });
		assert.equal(short.status, 400);
		const stray = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", ["x", "z"], "yes"] });
		assert.equal(stray.status, 400);
		const empty = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", ["x"], ""] });
		assert.equal(empty.status, 400);

		const sent = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["b", ["x", "y"], "my own words"] });
		assert.equal(sent.status, 200);
		const reply = JSON.parse((await held).body);
		assert.deepEqual(reply.answers, ["b", "x, y", "my own words"]);
		assert.equal(reply.answer, "b; x, y; my own words");

		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const settled = (state.cards as any[]).find((one) => one.id === card.id);
		assert.equal(settled.status, "answered");
		assert.deepEqual(settled.answers, ["b", "x, y", "my own words"]);
		// The tabs are still on the card once it is settled, so a reader sees what was asked as well as
		// what was answered.
		assert.equal(settled.questions.length, 3);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a closed note comes back on /undo, with its id and its key", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-undo-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		const made = await postTo(daemon, board.id, "/card/note", { key: "kept", title: "a note", markdown: "as written" });
		assert.equal(made.status, 200);
		const id = JSON.parse(made.body).cardId;

		assert.equal((await postTo(daemon, board.id, "/close", { cardId: id })).status, 200);
		const gone = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		assert.equal(gone.cards.some((card: any) => card.id === id), false, "the note was not closed");

		const undone = await postTo(daemon, board.id, "/undo", {});
		assert.equal(undone.status, 200);
		assert.equal(JSON.parse(undone.body).restored, id);
		const back = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const restored = (back.cards as any[]).find((card) => card.id === id);
		assert.ok(restored, "the note did not come back");
		// The key is what a `[[key]]` resolves to, so a card back with a different one is a dead link.
		assert.equal(restored.key, "kept");
		assert.equal(restored.markdown, "as written");

		// Nothing else was closed, so the second press has nothing to give and says so.
		const empty = await postTo(daemon, board.id, "/undo", {});
		assert.equal(empty.status, 409);
		assert.equal(empty.body, "nothing to undo");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a thread card closed with nothing behind it is put back by /undo", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-undo-thread-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		// A thread with no message never spawns a child, so this is a card and nothing else.
		const made = await postTo(daemon, board.id, "/thread", { title: "a thread" });
		const threadId = JSON.parse(made.body).threadId;
		assert.equal((await postTo(daemon, board.id, "/close", { cardId: threadId })).status, 200);

		const closed = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		assert.equal(closed.threads.some((thread: any) => thread.id === threadId), false, "the thread was not closed");

		assert.equal((await postTo(daemon, board.id, "/undo", {})).status, 200);
		const back = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const restored = (back.cards as any[]).find((card) => card.id === threadId);
		assert.ok(restored, "the thread card did not come back");
		assert.equal(restored.title, "a thread");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("the event stream opens with a snapshot the client can draw from", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-events-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		const controller = new AbortController();
		const response = await fetch(`${daemon.base}/events?token=${daemon.token}&workspace=${board.id}`, { signal: controller.signal });
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /event-stream/);
		assert.ok(response.body, "no stream body");
		const reader = response.body.getReader();
		const { value } = await reader.read();
		controller.abort();
		const text = new TextDecoder().decode(value ?? new Uint8Array());
		const line = text.split("\n").find((each) => each.startsWith("data: "));
		assert.ok(line, `no data line in the first chunk: ${text.slice(0, 120)}`);
		const payload = JSON.parse(line.slice("data: ".length));
		// The whole client renders from this one message: the cards, what was closed, the rail's rows,
		// the board's meta and the git strip.
		assert.equal(payload.type, "snapshot");
		assert.ok(Array.isArray(payload.cards));
		assert.ok(Array.isArray(payload.closed));
		assert.ok(Array.isArray(payload.activity));
		assert.ok(payload.meta, "the snapshot carries no meta");
		assert.ok("git" in payload, "the snapshot carries no git picture");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

/**
 * A `pi` that is not pi, at the path the daemon looks for one.
 *
 * A thread's token is minted inside the spawn and handed to the child alone: `/state` does not carry it
 * and neither does the board file. So the only way for a test to hold a real one is to be the child.
 * This stub writes down the three variables the daemon gave it, answers the frames the daemon waits on,
 * and exits when its stdin closes. It is a string rather than a file of its own because `node --test`
 * runs every file it finds under `test/`, and a stub waiting on stdin would sit in the suite as a test
 * that never ends.
 */
const STUB_PI = String.raw`
const { appendFileSync, existsSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

// A naming run is the other shape of invocation and carries no thread token, so it has nothing to say
// here and leaves rather than wait on a stdin nobody will write.
if (!process.env.PI_STUDIO_TOKEN) process.exit(0);

writeFileSync(join(__dirname, "child-env.json"), JSON.stringify({
	token: process.env.PI_STUDIO_TOKEN,
	workspace: process.env.PI_STUDIO_WORKSPACE,
	thread: process.env.PI_STUDIO_THREAD,
}));

const say = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
// Every frame this child was sent, so a test can say what reached it rather than what the answer was.
const wrote = (frame) => appendFileSync(join(__dirname, "frames.jsonl"), JSON.stringify(frame) + "\n");
// A file in the stub's own folder stands in for the state a real child keeps: compaction writes it,
// and the stats answer reads it, which is how the smaller context reaches the board.
const flag = (name) => join(__dirname, name);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() || "";
	for (const line of lines) {
		if (!line.trim()) continue;
		const frame = JSON.parse(line);
		wrote(frame);
		// The session id is the one thing the daemon cannot do without: it resumes the thread with it.
		if (frame.type === "get_state") say({ type: "response", command: "get_state", success: true, data: { sessionId: "stub-session" } });
		// Asked after the run settles, and the child is closed once it answers.
		if (frame.type === "get_session_stats") {
			const tokens = existsSync(flag("compacted")) ? 32000 : 150000;
			say({ type: "response", command: "get_session_stats", success: true, data: { tokens: { input: 1, output: 1, total: 2 }, totalMessages: 1, contextUsage: { tokens, contextWindow: 200000, percent: Math.round((tokens / 200000) * 100) } } });
		}
		// Compaction: the summary a real child writes, and the flag the next stats answer reads.
		if (frame.type === "compact") {
			// A "die" file is a child that exits without answering, which the board must not wait out.
			if (existsSync(flag("die"))) process.exit(0);
			writeFileSync(flag("compacted"), "1");
			say({ type: "response", command: "compact", success: true, data: { summary: "a shorter conversation", tokensBefore: 150000, estimatedTokensAfter: 32000 } });
		}
		if (frame.type === "prompt") {
			// A "hold" file keeps the run open, which is the state a compaction has to refuse.
			if (existsSync(flag("hold"))) continue;
			// A "slow" file delays one answer, which is the window a second message is queued in. It is
			// spent on the first prompt so the rest of the run answers at once.
			if (existsSync(flag("slow"))) {
				unlinkSync(flag("slow"));
				setTimeout(() => {
					say({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "the stub answered" }] } });
					say({ type: "agent_settled" });
				}, 600);
				continue;
			}
			say({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "the stub answered" }] } });
			say({ type: "agent_settled" });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
`;

/** Write that stub into a temp folder shaped like the managed install the daemon drives. */
function stubPi(root: string) {
	const version = "0.0.0-test";
	const packageDir = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	const bundle = join(packageDir, "dist", "bundle");
	const cli = join(bundle, "cli.js");
	mkdirSync(bundle, { recursive: true });
	writeFileSync(join(root, "current-version"), `${version}\n`);
	// The install carries its own manifest, so the stub is read as CommonJS whatever folder the temp
	// root happened to be made in.
	writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "commonjs" })}\n`);
	writeFileSync(cli, STUB_PI);
	// A stub that was not written would leave the daemon falling back to a real `pi` on PATH, which is
	// the one thing a test may not start.
	assert.ok(existsSync(cli), `the stub pi was not written to ${cli}`);
	return { root, envFile: join(bundle, "child-env.json") };
}

/**
 * The token the daemon minted for a thread, read back from the child that was handed it. The file is
 * written by that child, so finding it is waiting for the spawn the token belongs to rather than for a
 * guessed number of milliseconds.
 */
async function childEnvOf(daemon: Daemon, file: string) {
	for (let tries = 0; tries < 100; tries++) {
		try {
			const env = JSON.parse(readFileSync(file, "utf8"));
			if (env?.token) return env as { token: string; workspace: string; thread: string };
		} catch {
			// The child has not written it yet.
		}
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`no child token was written to ${file}: ${daemon.noise.join("").slice(-400)}`);
}

test("a thread's own token reaches /card/ask over http and is refused the human's routes", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-thread-token-"));
	// A plain temp folder: a thread there works in place, so the run leaves no worktree behind.
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-thread-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	// Naming a thread is a second `pi` the daemon would start for it, and the stub is not one.
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		// A message is what starts the child, and the child is what a token is minted for.
		const said = await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" });
		assert.equal(said.status, 200);
		const child = await childEnvOf(daemon, stub.envFile);
		assert.notEqual(child.token, daemon.token, "a thread was handed the daemon's own token");
		assert.equal(child.workspace, board.id);
		assert.equal(child.thread, threadId);

		// What belongs to the human stays out of a thread's reach, over the real wire this time.
		const read = await get(daemon, `/state?token=${child.token}&workspace=${board.id}`);
		assert.equal(read.status, 403);
		assert.equal(read.body, "a thread may not use that");
		const layout = await postAs(daemon, child.token, board.id, "/layout", { id: board.id, view: { x: 1, y: 1, k: 1 } });
		assert.equal(layout.status, 403);
		assert.equal(layout.body, "a thread may not use that");

		// The route board_ask uses, asked by the thread itself. The daemon holds this request open until
		// the human answers it, so it is not awaited yet.
		const held = postAs(daemon, child.token, board.id, "/card/ask", { question: "which way?", options: ["left", "right"] });
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the thread's question never reached the board");
		assert.equal(card.question, "which way?");
		assert.equal(card.status, "open");
		const early = await Promise.race([
			held.then(() => "settled" as const),
			new Promise<"held">((done) => setTimeout(() => done("held"), 250)),
		]);
		assert.equal(early, "held", "the question settled before the human answered it");

		const clicked = await postTo(daemon, board.id, "/answer", { cardId: card.id, answer: "right" });
		assert.equal(clicked.status, 200);
		const reply = await held;
		assert.equal(reply.status, 200);
		assert.equal(JSON.parse(reply.body).answer, "right");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

/** One thread as `/state` reports it, which is where its numbers are read. */
async function threadState(daemon: Daemon, board: string, id: string) {
	const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board}`)).body);
	return (state.threads as any[]).find((one) => one.id === id) ?? null;
}

/** The frames the stub child was sent, in order. A child that was never started has written nothing. */
function framesOf(stub: { root: string; envFile: string }) {
	const file = join(dirname(stub.envFile), "frames.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a compaction reaches the thread's child, and the context comes back smaller", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-compact-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-compact-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		// The run has to be over and its child gone: a compaction starts a child rather than interrupting one.
		for (let tries = 0; tries < 100; tries++) {
			const thread = await threadState(daemon, board.id, threadId);
			if (thread && thread.status === "idle" && thread.live === false) break;
			await new Promise((done) => setTimeout(done, 50));
		}
		const before = await threadState(daemon, board.id, threadId);
		assert.equal(before?.stats?.context, 150000, "the stub's first context never reached the board");

		// A card no thread answers has nothing to compact, and says so rather than starting a child.
		const nowhere = await postTo(daemon, board.id, "/compact", { cardId: "no-such-card" });
		assert.equal(nowhere.status, 409);
		assert.equal(nowhere.body, "no thread answers this card");

		const compacted = await postTo(daemon, board.id, "/compact", { cardId: threadId });
		assert.equal(compacted.status, 200, compacted.body);
		const said = JSON.parse(compacted.body);
		assert.equal(said.threadId, threadId);
		assert.equal(said.tokensBefore, 150000);
		assert.equal(said.estimatedTokensAfter, 32000);
		assert.ok(framesOf(stub).some((frame: any) => frame.type === "compact"), "no compact frame reached the child");

		// The figures are read again after the summary, so the button has a smaller number to show.
		let after = await threadState(daemon, board.id, threadId);
		for (let tries = 0; tries < 100 && after?.stats?.context !== 32000; tries++) {
			await new Promise((done) => setTimeout(done, 50));
			after = await threadState(daemon, board.id, threadId);
		}
		assert.equal(after?.stats?.context, 32000);
		assert.equal(after?.stats?.contextMax, 200000);
		// pi reports the window as `contextWindow`, which is the denominator the meter needs.
		assert.equal(after?.stats?.contextPercent, 16);

		// The card the composer sends is not always the thread: a note the thread wrote carries the
		// thread in `ownerThread`, and that is the walk the model and thinking chips already use.
		const note = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "a note", key: "under-test", threadRoot: threadId })).body);
		// The child that answered is closing, and a frame written now would never be read.
		for (let tries = 0; tries < 100; tries++) {
			if ((await threadState(daemon, board.id, threadId))?.live === false) break;
			await new Promise((done) => setTimeout(done, 50));
		}
		const throughNote = await postTo(daemon, board.id, "/compact", { cardId: note.cardId });
		assert.equal(throughNote.status, 200, throughNote.body);
		assert.equal(JSON.parse(throughNote.body).threadId, threadId);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a compaction is refused while the thread is answering, and nothing reaches the child", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-compact-busy-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-compact-busy-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	// The stub holds the run open, which is the one state a compaction may not cut into.
	writeFileSync(join(dirname(stub.envFile), "hold"), "1");
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "keep working" })).status, 200);
		for (let tries = 0; tries < 100; tries++) {
			const thread = await threadState(daemon, board.id, threadId);
			if (thread?.status === "running") break;
			await new Promise((done) => setTimeout(done, 50));
		}
		const refused = await postTo(daemon, board.id, "/compact", { cardId: threadId });
		assert.equal(refused.status, 409);
		assert.equal(refused.body, "this thread is answering: compact when it is idle");
		assert.ok(!framesOf(stub).some((frame: any) => frame.type === "compact"), "a compaction reached a busy child");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a compaction is refused before a thread has run, because there is no context yet", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-compact-fresh-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-compact-fresh-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		const refused = await postTo(daemon, board.id, "/compact", { cardId: threadId });
		assert.equal(refused.status, 409);
		assert.equal(refused.body, "this thread has not run yet, so there is nothing to compact");
		assert.deepEqual(framesOf(stub), [], "a child was started for a thread with no session");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a child that dies before it answers is reported, not waited out", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-compact-die-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-compact-die-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		for (let tries = 0; tries < 100; tries++) {
			const thread = await threadState(daemon, board.id, threadId);
			if (thread && thread.status === "idle" && thread.live === false && thread.sessionId) break;
			await new Promise((done) => setTimeout(done, 50));
		}
		writeFileSync(join(dirname(stub.envFile), "die"), "1");
		// The next child exits without answering the compaction, and the press hears about it at once
		// rather than sitting on the route until the ceiling gives up on it.
		const started = Date.now();
		const gone = await postTo(daemon, board.id, "/compact", { cardId: threadId });
		assert.equal(gone.status, 409);
		assert.match(gone.body, /the child exited before it answered/);
		assert.ok(Date.now() - started < 20_000, "the press waited on a child that was already gone");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

/** Wait until a thread has run everything asked of it, which is where its turns can be read. */
async function settledThread(daemon: Daemon, board: string, id: string, turns: number) {
	let seen = null;
	for (let tries = 0; tries < 200; tries++) {
		seen = await threadState(daemon, board, id);
		const done = (seen?.turns ?? []).length >= turns && (seen?.turns ?? []).every((turn: any) => turn.status !== "sent" && turn.status !== "queued");
		if (done && seen?.status === "idle") return seen;
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`thread ${id} never settled: ${JSON.stringify(seen?.turns ?? seen)}`);
}

/** One card as `/state` draws it. */
async function cardState(daemon: Daemon, board: string, id: string) {
	const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board}`)).body);
	return (state.cards as any[]).find((one) => one.id === id) ?? null;
}

test("a question about a note is answered on the thread's card, and the note keeps no turn", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-note-reply-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-note-reply-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		await settledThread(daemon, board.id, threadId, 1);

		// The note the thread made is the artifact the human reads, and the card the composer sends.
		const note = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "the artifact", key: "an-artifact", threadRoot: threadId })).body);
		assert.equal(note.card.ownerThread, threadId, "the note was not owned by the thread that wrote it");

		const asked = await postTo(daemon, board.id, "/message", { cardId: note.cardId, text: "what does this show?" });
		assert.equal(asked.status, 200);
		const settled = await settledThread(daemon, board.id, threadId, 2);

		// The answer is the thread's own turn, next to the words that asked for it.
		assert.equal(settled.turns.length, 2, "the thread's conversation has one turn too many or too few");
		assert.equal(settled.turns[1].text, "what does this show?");
		assert.equal(settled.turns[1].status, "answered");
		assert.equal(settled.turns[1].reply, "the stub answered");
		// The card stays the artifact it was: it is quoted at the child, and written on by nobody.
		const card = await cardState(daemon, board.id, note.cardId);
		assert.deepEqual(card.turns ?? [], [], "the note kept the turn");
		const prompts = framesOf(stub).filter((frame: any) => frame.type === "prompt");
		assert.match(prompts[1].message, /The card says: the artifact/, "the child was not told which card it is about");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a fork answers on a card of its own, and the note keeps its owner and its turns", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-fork-thread-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-fork-thread-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		await settledThread(daemon, board.id, threadId, 1);
		const note = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "the artifact", key: "a-forked-artifact", threadRoot: threadId })).body);

		const asked = await postTo(daemon, board.id, "/message", { cardId: note.cardId, fork: true, text: "what does this show?" });
		assert.equal(asked.status, 200);
		const forkId = JSON.parse(asked.body).id;
		assert.notEqual(forkId, threadId, "the fork was answered by the thread that made the card");

		// A fork is a thread of its own, read in a card of its own that cascades under the card asked about.
		const settled = await settledThread(daemon, board.id, forkId, 1);
		assert.equal(settled.hidden ?? false, false, "the fork is not drawn as a card");
		assert.equal(settled.threadRoot, note.cardId, "the fork does not hang under the card it was asked about");
		assert.equal(settled.turns[0].text, "what does this show?");
		assert.equal(settled.turns[0].reply, "the stub answered");
		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		assert.ok(
			state.cards.some((one: any) => one.id === forkId),
			"the fork answers where nothing is drawn",
		);

		// The card was only asked about: it keeps its owner and gains no turn of another thread.
		const card = await cardState(daemon, board.id, note.cardId);
		assert.equal(card.ownerThread, threadId, "the fork took the card over");
		assert.deepEqual(card.turns ?? [], [], "the note kept the fork's turn");
		const prompts = framesOf(stub).filter((frame: any) => frame.type === "prompt");
		assert.match(prompts[1].message, /The card says: the artifact/, "the fork was not told which card it is about");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a message queued behind a run lands on its own turn, once", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-queue-turns-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-queue-turns-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	// The first answer is held back, which is the window the second message is queued in.
	writeFileSync(join(dirname(stub.envFile), "slow"), "1");
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		const note = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "the artifact", key: "queued-artifact", threadRoot: threadId })).body);
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "first" })).status, 200);
		for (let tries = 0; tries < 100; tries++) {
			if ((await threadState(daemon, board.id, threadId))?.status === "running") break;
			await new Promise((done) => setTimeout(done, 20));
		}
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: note.cardId, text: "second" })).status, 200);

		const settled = await settledThread(daemon, board.id, threadId, 2);
		// One turn per message: the queued one is marked where it waits, not pushed a second time.
		assert.deepEqual(settled.turns.map((turn: any) => turn.text), ["first", "second"]);
		assert.ok(settled.turns.every((turn: any) => turn.status === "answered"), `turns were left waiting: ${JSON.stringify(settled.turns.map((turn: any) => turn.status))}`);
		assert.deepEqual((await cardState(daemon, board.id, note.cardId))?.turns ?? [], [], "the note kept the queued turn");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});
