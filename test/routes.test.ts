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
const { writeFileSync } = require("node:fs");
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
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() || "";
	for (const line of lines) {
		if (!line.trim()) continue;
		const frame = JSON.parse(line);
		// The session id is the one thing the daemon cannot do without: it resumes the thread with it.
		if (frame.type === "get_state") say({ type: "response", command: "get_state", success: true, data: { sessionId: "stub-session" } });
		// Asked after the run settles, and the child is closed once it answers.
		if (frame.type === "get_session_stats") say({ type: "response", command: "get_session_stats", success: true, data: { tokens: { input: 1, output: 1, total: 2 }, totalMessages: 1 } });
		if (frame.type === "prompt") {
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
