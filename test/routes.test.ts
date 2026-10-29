import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * One daemon on its own state folder, started the way a human starts it. Nothing is spawned from a
 * thread here, so no `pi` child ever runs and no model is called.
 */
async function boot(folder: string) {
	const child = spawn(process.execPath, [join(repo, "server.ts"), "--no-open"], {
		cwd: repo,
		env: { ...process.env, PI_STUDIO_STATE: folder, PI_STUDIO_PORT: "" },
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
