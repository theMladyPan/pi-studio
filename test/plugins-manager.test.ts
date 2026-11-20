/**
 * The plugins this daemon runs, as processes: registered ones start, one that will not start does not
 * take the others with it, an unregistered executable never runs, and closing ends them.
 *
 * The state folder is a throwaway one, set before any daemon module is imported, so no human's
 * workspace is read and none is written. Each fixture is a Node script in that folder, started the way
 * a plugin really is — by an absolute path, with an argument naming what the test wants of it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeTree } from "../test-support/temp.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "pi-studio-plugin-manager-"));
process.env.PI_STUDIO_STATE = join(root, "state");

const { notifyPlugin, pluginManager, startPlugins, stopPlugins } = await import("../server/plugins/manager.ts");
const { createPluginService } = await import("../server/plugins/service.ts");
const { threadSettled } = await import("../server/bus.ts");
const { streamTick } = await import("../server/child/run.ts");

// A plugin is any executable that speaks the line protocol. This one answers `initialize`, echoes what
// it is asked, records the events the daemon sends it, and writes what it did to a file, so a test can
// read the process's own account of starting and stopping.
const FIXTURE = `
const fs = require("node:fs");
const marker = process.argv[2];
const mode = process.argv[3] ?? "echo";
const say = (line) => fs.appendFileSync(marker, line + "\\n");
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const refuse = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const waiting = new Map();
let nextId = 1000;
let lastEvent = null;
say("started");
process.stdout.on("error", () => {});
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === undefined) {
		const settle = waiting.get(message.id);
		if (settle) {
			waiting.delete(message.id);
			settle(message);
		}
		return;
	}
	if (message.method === "initialize") {
		const said = { protocolVersion: mode === "old" ? 2 : 1, name: "fixture", version: "0.0.1" };
		// A plugin that is slow to come up answers its handshake late, so a test can signal the daemon
		// while this one is still on its way up.
		if (mode === "slow") return void setTimeout(() => reply(message.id, said), 1_500);
		return reply(message.id, said);
	}
	// The daemon's own notice on its way out, told apart from the pipe simply closing behind a dead daemon.
	if (message.method === "shutdown") return say("told");
	if (message.method === "echo") return reply(message.id, message.params);
	// An event the daemon sends: a notification, so nothing is answered, and the last one is kept.
	if (message.method === "event") {
		lastEvent = message.params;
		return;
	}
	if (message.method === "subscribe") {
		// The plugin asks the daemon for events over the same pipe, and answers its own caller with what
		// the daemon said back.
		const id = (nextId += 1);
		waiting.set(id, (answer) => (answer.error ? refuse(message.id, answer.error.code, answer.error.message) : reply(message.id, answer.result)));
		return out({ jsonrpc: "2.0", id, method: "events.subscribe", params: message.params });
	}
	if (message.method === "recall") return reply(message.id, lastEvent);
	return refuse(message.id, -32601, "no such method");
});
rl.on("close", () => {
	say("stopped");
	process.exit(0);
});
`;

const fixture = join(root, "fixture.cjs");
writeFileSync(fixture, FIXTURE, { mode: 0o755 });

/** One row of a registration file, with the marker this fixture writes its own life into. */
function entry(name: string, mode = "echo") {
	const marker = join(root, `${name}.log`);
	return { entry: { name, command: process.execPath, args: [fixture, marker, mode] }, marker };
}

/** A registration file holding these rows, written where the manager is told to read it. */
function register(name: string, rows: { name: string; command: string; args: string[] }[]) {
	const file = join(root, `${name}.json`);
	writeFileSync(file, JSON.stringify({ plugins: rows }));
	return file;
}

/** What the fixture wrote about its own life, or nothing when it never ran. */
function life(marker: string): string[] {
	return existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : [];
}

/** Wait for a fixture to say it did something, because a process reaches its marker on its own clock. */
async function waitForLife(marker: string, line: string, ms = 10_000): Promise<string[]> {
	const until = Date.now() + ms;
	for (;;) {
		const lines = life(marker);
		if (lines.includes(line) || Date.now() > until) return lines;
		await new Promise((done) => setTimeout(done, 50));
	}
}

const quiet = () => {};

after(async () => {
	await stopPlugins();
	await removeTree(root);
});

// ---------- a registered process ----------

test("a registered plugin is started, asked for work, and closed", async () => {
	const good = entry("good");
	const manager = await startPlugins({ file: register("lifecycle", [good.entry]), log: quiet });
	try {
		assert.deepEqual(manager.roster(), [{ name: "good", command: process.execPath, version: "0.0.1", running: true }]);
		assert.deepEqual(manager.problems(), []);
		assert.deepEqual(await manager.request("good", "echo", { from: "the daemon" }), { from: "the daemon" });
		assert.deepEqual(life(good.marker), ["started"]);
	} finally {
		await manager.close();
	}
	// The process was told to stop and is gone, so nothing it was holding is left behind.
	assert.deepEqual(life(good.marker), ["started", "told", "stopped"]);
	assert.deepEqual(manager.roster(), []);
	await assert.rejects(manager.request("good", "echo", {}), /good is not a plugin this daemon runs/);
});

test("the manager the daemon holds is the one a caller asks for", async () => {
	const good = entry("current");
	await startPlugins({ file: register("current", [good.entry]), log: quiet });
	const manager = pluginManager();
	assert.ok(manager, "the daemon has a manager once it started one");
	assert.deepEqual(await manager.request("current", "echo", { value: 7 }), { value: 7 });
	assert.equal(notifyPlugin("current", "event", { type: "nothing" }), true, "a running plugin is one this daemon can tell");
	assert.equal(notifyPlugin("absent", "event", {}), false, "a plugin nobody registered cannot be told anything");
	await stopPlugins();
	assert.equal(pluginManager(), null);
	assert.deepEqual(life(good.marker), ["started", "told", "stopped"]);
});

// ---------- one plugin's failure is its own ----------

test("a plugin that will not start is reported and the rest of the roster runs", async () => {
	const good = entry("survivor");
	const wrong = entry("wrong", "old");
	const manager = await startPlugins({ file: register("isolation", [wrong.entry, good.entry]), log: quiet });
	try {
		assert.deepEqual(
			manager.roster().map((one) => one.name),
			["survivor"],
		);
		assert.equal(manager.problems().length, 1);
		assert.equal(manager.problems()[0].name, "wrong");
		assert.match(manager.problems()[0].problem, /speaks protocol 2; this daemon speaks 1/);
		assert.deepEqual(await manager.request("survivor", "echo", { still: "here" }), { still: "here" });
	} finally {
		await manager.close();
	}
	// The one that could not speak the protocol was closed rather than left running, so its own account
	// of the attempt ends where a closed plugin's does.
	assert.deepEqual(life(wrong.marker), ["started", "told", "stopped"]);
});

// ---------- nothing starts on its own ----------

test("a daemon with no registration starts no plugin at all", async () => {
	const absent = join(root, "nothing-registered.json");
	const stray = entry("stray");
	const manager = await startPlugins({ file: absent, log: quiet });
	try {
		assert.deepEqual(manager.roster(), []);
		assert.deepEqual(manager.problems(), []);
		await assert.rejects(manager.request("stray", "echo", {}), /stray is not a plugin this daemon runs/);
	} finally {
		await manager.close();
	}
	assert.deepEqual(life(stray.marker), [], "a plugin nobody registered never ran");
});

// ---------- the daemon the human starts ----------

/** A daemon started the way a human starts it, reading its registration from its own state folder. */
function startDaemon(state: string, rows: { name: string; command: string; args: string[] }[]) {
	// The daemon reads its registration from its own state folder, under the name it asks for.
	mkdirSync(state, { recursive: true });
	writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: rows }));
	const daemon = spawn(process.execPath, [join(repo, "server.ts"), "--no-open"], {
		cwd: repo,
		env: { ...process.env, PI_STUDIO_STATE: state, PI_STUDIO_PORT: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const noise: string[] = [];
	daemon.stderr.on("data", (chunk) => noise.push(String(chunk)));
	return { daemon, noise };
}

/** Wait until the daemon says on stdout that it listens, which is also proof it started without waiting. */
function listening(daemon: ReturnType<typeof spawn>, noise: string[]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`the daemon did not listen: ${noise.join("")}`)), 20_000);
		daemon.stdout?.on("data", (chunk) => {
			if (!String(chunk).includes("listening on")) return;
			clearTimeout(timer);
			resolve();
		});
		daemon.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`the daemon exited with ${code}: ${noise.join("")}`));
		});
	});
}

test("a daemon started the way a human starts it stops its plugins on a signal", async () => {
	const good = entry("signal");
	const state = join(root, "signal-state");
	const { daemon, noise } = startDaemon(state, [good.entry]);
	try {
		await listening(daemon, noise);
		assert.deepEqual(await waitForLife(good.marker, "started"), ["started"], `the registered plugin ran: ${noise.join("")}`);
		const gone = new Promise<number | null>((resolve) => daemon.on("exit", (code) => resolve(code)));
		daemon.kill("SIGTERM");
		assert.equal(await gone, 0, "a signalled daemon exits cleanly");
		// The plugin was asked to stop on the way out — the daemon's own notice, not merely the pipe
		// closing behind a process that is gone — instead of being left running behind a dead daemon.
		assert.deepEqual(await waitForLife(good.marker, "stopped", 5_000), ["started", "told", "stopped"]);
	} finally {
		if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
		await removeTree(state);
	}
});

test("a signal waits for a plugin that is still on its way up and stops it too", async () => {
	const slow = entry("slow-start", "slow");
	const state = join(root, "slow-signal-state");
	const { daemon, noise } = startDaemon(state, [slow.entry]);
	try {
		await listening(daemon, noise);
		// The plugin is a process already, still answering its handshake: the signal lands mid-start, when
		// no manager holds it yet.
		assert.deepEqual(await waitForLife(slow.marker, "started"), ["started"], `the registered plugin ran: ${noise.join("")}`);
		const gone = new Promise<number | null>((resolve) => daemon.on("exit", (code) => resolve(code)));
		daemon.kill("SIGTERM");
		assert.equal(await gone, 0, "a signalled daemon exits cleanly");
		// It was waited for and then told to stop, rather than left running behind the daemon that
		// started it with nothing left to close it.
		assert.deepEqual(await waitForLife(slow.marker, "stopped", 10_000), ["started", "told", "stopped"]);
	} finally {
		if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
		await removeTree(state);
	}
});

// ---------- the events a plugin subscribes to ----------

test("a subscribed plugin is told with the envelope, and one that never asked hears nothing", async () => {
	const watching = entry("watcher");
	const other = entry("silent");
	const service = createPluginService();
	const manager = await startPlugins({
		file: register("events", [watching.entry, other.entry]),
		log: quiet,
		onRequest: (call) => service.handle(call),
	});
	try {
		assert.deepEqual(await manager.request("watcher", "subscribe", { types: ["thread.settled"] }), { types: ["thread.settled"] });
		// A run ends where the board says it ends; the plugin's own event is built from that announcement.
		const board = { id: "workspace-1" };
		const thread = { id: "thread-1", title: "fix the parser", status: "idle" };
		threadSettled(board, thread, { status: "answered" });
		const event = (await manager.request("watcher", "recall")) as any;
		// The envelope a subscriber reads: the event's type, the workspace it happened in, and its own fields.
		assert.deepEqual(Object.keys(event).sort(), ["at", "thread", "type", "workspace"]);
		assert.equal(event.type, "thread.settled");
		assert.equal(event.workspace, "workspace-1");
		assert.equal(typeof event.at, "number");
		assert.deepEqual(event.thread, { id: "thread-1", title: "fix the parser", status: "idle", answered: true });
		// The plugin that never subscribed is not sent an event it did not ask for.
		assert.equal(await manager.request("silent", "recall"), null);
	} finally {
		await manager.close();
	}
});

test("a subscribed plugin hears a running answer as it is written", async () => {
	const watching = entry("streamer");
	const settling = entry("settler");
	const service = createPluginService();
	const manager = await startPlugins({
		file: register("stream", [watching.entry, settling.entry]),
		log: quiet,
		onRequest: (call) => service.handle(call),
	});
	try {
		assert.deepEqual(await manager.request("streamer", "subscribe", { types: ["thread.stream"] }), { types: ["thread.stream"] });
		assert.deepEqual(await manager.request("settler", "subscribe", { types: ["thread.settled"] }), { types: ["thread.settled"] });
		// The flush a browser's card is repainted with is the flush a subscriber reads, so the event is
		// raised by the same tick and carries the same words.
		const board = { id: "workspace-1", name: "board", folder: "/tmp", activity: [], cards: new Map(), threads: new Map(), clients: new Set() };
		const thread = {
			id: "thread-2",
			title: "say something",
			status: "running",
			hidden: false,
			answering: { turn: 0 },
			turns: [{ text: "say something", status: "sent", streaming: true }],
			streamInterim: ["reading the file"],
			streamLast: "",
			streamParts: new Map([["part-1", "half a sen"]]),
		};
		board.threads.set(thread.id, thread);
		streamTick(board, thread);
		const event = (await manager.request("streamer", "recall")) as any;
		assert.deepEqual(Object.keys(event).sort(), ["at", "interim", "reply", "thread", "turn", "type", "workspace"]);
		assert.equal(event.type, "thread.stream");
		assert.equal(event.workspace, "workspace-1");
		assert.equal(typeof event.at, "number");
		assert.deepEqual(event.thread, { id: "thread-2", title: "say something" });
		assert.equal(event.turn, 0);
		assert.deepEqual(event.interim, ["reading the file"]);
		assert.equal(event.reply, "half a sen");
		// A plugin that asked only for the settled run is not sent the words on the way there.
		assert.equal(await manager.request("settler", "recall"), null);
	} finally {
		await manager.close();
	}
});
