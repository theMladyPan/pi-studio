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
		const script = await get(daemon, "/board.js");
		assert.equal(script.status, 200);
		assert.match(script.type, /javascript/);
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
