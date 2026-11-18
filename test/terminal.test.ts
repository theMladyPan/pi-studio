import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { attachTerminal, stopTerminal, terminalSize } from "../server/terminal.ts";
import type { TerminalEvent } from "../server/terminal.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/** Whether the pty helper this daemon relies on is on this machine at all. */
function helperHere(): boolean {
	try {
		execFileSync("which", ["script"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

test("a size is clamped to cells a pty can hold, or the default", () => {
	assert.deepEqual(terminalSize({ cols: 120, rows: 40 }), { cols: 120, rows: 40 });
	assert.deepEqual(terminalSize({ cols: 0, rows: -3 }), { cols: 80, rows: 24 });
	assert.deepEqual(terminalSize({ cols: 99999, rows: 99999 }), { cols: 80, rows: 24 });
	assert.deepEqual(terminalSize(undefined), { cols: 80, rows: 24 });
	assert.deepEqual(terminalSize({ cols: 80.9, rows: 24.2 }), { cols: 80, rows: 24 });
});

test("a shell is born in the folder, in a pty, and answers typed keys", async (t) => {
	if (!helperHere()) return t.skip("no `script` helper on this machine");
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-terminal-"));
	const workspaceId = `terminal-test-${Date.now()}`;
	const seen: TerminalEvent[] = [];
	const handle = attachTerminal(workspaceId, folder, (event) => seen.push(event));
	try {
		handle.resize({ cols: 111, rows: 33 });
		handle.write("pwd; tty; echo hello-terminal\n");
		const deadline = Date.now() + 10_000;
		let text = "";
		while (Date.now() < deadline) {
			text = seen.filter((event) => event.type === "output").map((event) => (event as { data: string }).data).join("");
			if (text.includes("hello-terminal") && text.includes("/dev/pts/")) break;
			await new Promise((done) => setTimeout(done, 50));
		}
		assert.match(text, /hello-terminal/, "the typed command ran");
		assert.match(text, /\/dev\/pts\//, "the shell's stdout is a pty, not a pipe");
		assert.ok(text.includes(folder) || text.includes("pi-studio-terminal-"), "the shell works in the workspace folder");
	} finally {
		handle.detach();
		stopTerminal(workspaceId);
	}
});

test("a tab that attaches to a running shell hears its scrollback", async (t) => {
	if (!helperHere()) return t.skip("no `script` helper on this machine");
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-terminal-"));
	const workspaceId = `terminal-test-replay-${Date.now()}`;
	const first: TerminalEvent[] = [];
	const one = attachTerminal(workspaceId, folder, (event) => first.push(event));
	one.resize({ cols: 80, rows: 24 });
	one.write("echo scrollback-check\n");
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const text = first.filter((event) => event.type === "output").map((event) => (event as { data: string }).data).join("");
		if (text.includes("scrollback-check")) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	one.detach();
	const second: TerminalEvent[] = [];
	const two = attachTerminal(workspaceId, folder, (event) => second.push(event));
	try {
		// The replay arrives at attach, so no waiting is needed: the scrollback was drained
		// while the first tab was detached and is handed to the second on attach.
		const replay = second.filter((event) => event.type === "output").map((event) => (event as { data: string }).data).join("");
		assert.match(replay, /scrollback-check/, "the new tab sees what the shell already said");
	} finally {
		two.detach();
		stopTerminal(workspaceId);
	}
});

/** One daemon on its own state folder, started the way a human starts it. */
test("an emptied board's shell ends, and the old handle cannot revive it", async (t) => {
	if (!helperHere()) return t.skip("no `script` helper on this machine");
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-terminal-"));
	const workspaceId = `terminal-test-clear-${Date.now()}`;
	const seen: TerminalEvent[] = [];
	const handle = attachTerminal(workspaceId, folder, (event) => seen.push(event));
	handle.resize({ cols: 80, rows: 24 });
	// The board is emptied while the tab is still attached: the shell ends and the tab hears it.
	stopTerminal(workspaceId);
	assert.ok(seen.some((event) => event.type === "exit"), "the attached tab hears the shell end");
	// And the next keystroke starts nothing: a new shell would have answered.
	handle.write("echo resurrected\n");
	handle.resize({ cols: 80, rows: 24 });
	await new Promise((done) => setTimeout(done, 400));
	const text = seen.filter((event) => event.type === "output").map((event) => (event as { data: string }).data).join("");
	assert.doesNotMatch(text, /resurrected/, "the emptied board's shell stayed dead");
	handle.detach();
});

test("a thread may not open the terminal socket", async () => {
	// `threadRefusal` is the same one-line guard the `/terminal` upgrade runs, and the route
	// test above already proves the human reaches it; this proves the thread does not.
	const { threadRefusal } = (await import("../server/main.ts")) as {
		threadRefusal: (caller: unknown, method: string, pathname: string, workspace: string) => string | null;
	};
	const child = { human: false, board: { id: "board-a" }, thread: { parentThread: "master" } };
	assert.equal(threadRefusal(child, "GET", "/terminal", "board-a"), "a spawned child has no board tools");
	const master = { human: false, board: { id: "board-a" }, thread: { parentThread: null } };
	assert.equal(threadRefusal(master, "GET", "/terminal", "board-a"), "a thread may not use that");
	assert.equal(threadRefusal({ human: true }, "GET", "/terminal", "board-a"), null);
});

/** One daemon on its own state folder, started the way a human starts it. */
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
	return { child, base: parsed.origin, token: parsed.searchParams.get("token") ?? "" };
}

test("the terminal socket is refused without a token and answers a human", async (t) => {
	if (!helperHere()) return t.skip("no `script` helper on this machine");
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-terminal-"));
	const daemon = await boot(folder);
	try {
		const opened = await fetch(`${daemon.base}/workspace?token=${daemon.token}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ folder }),
		});
		const board = (await opened.json() as { board?: { id?: string } }).board as { id: string };
		assert.ok(board?.id, "no board came back");

		// A socket with no token is refused before a handshake, like the live stream.
		const refused = await new Promise<number>((resolve, reject) => {
			const socket = new WebSocket(`${daemon.base.replace(/^http:/, "ws:")}/terminal?workspace=${board.id}`);
			socket.addEventListener("open", () => reject(new Error("a tokenless socket opened")));
			socket.addEventListener("error", () => resolve(403));
			setTimeout(() => reject(new Error("the refused socket never answered")), 5_000);
		});
		assert.equal(refused, 403);

		const socket = new WebSocket(`${daemon.base.replace(/^http:/, "ws:")}/terminal?token=${daemon.token}&workspace=${board.id}`);
		const heard: TerminalEvent[] = [];
		socket.addEventListener("message", (event) => {
			try {
				heard.push(JSON.parse(String(event.data)));
			} catch {
				// A frame that is not JSON is not the daemon's, and this check ignores it.
			}
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("the terminal socket did not open")), { once: true });
		});
		socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
		socket.send(JSON.stringify({ type: "input", data: "echo over-the-socket\n" }));
		const deadline = Date.now() + 10_000;
		let text = "";
		while (Date.now() < deadline) {
			text = heard.filter((event) => event.type === "output").map((event) => (event as { data: string }).data).join("");
			if (text.includes("over-the-socket")) break;
			await new Promise((done) => setTimeout(done, 50));
		}
		assert.match(text, /over-the-socket/, "typed keys reached the shell and its output came back");
		socket.close();
	} finally {
		daemon.child.kill();
	}
});
