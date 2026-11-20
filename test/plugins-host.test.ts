import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PluginFailure, pluginEnv, startPlugin } from "../server/plugins/host.ts";
import type { PluginHost } from "../server/plugins/host.ts";
import { loadPluginRegistry } from "../server/plugins/registry.ts";
import type { PluginCall } from "../server/plugins/host.ts";

// A plugin is any executable that speaks the line protocol, so the fixture here is one: a Node script
// run the way a plugin really is, by an absolute path, with an argument naming the behaviour the test
// wants. It is written into a throwaway folder so the repository keeps no executable of its own.
const root = mkdtempSync(join(tmpdir(), "pi-studio-plugins-"));
after(() => rmSync(root, { recursive: true, force: true }));

const FIXTURE = `
const mode = process.argv[2] ?? "echo";
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const refuse = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const waiting = new Map();
let remembered = null;

process.stdout.on("error", () => {});

require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
	if (mode === "silent") return;
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
		reply(message.id, { protocolVersion: mode === "old" ? 2 : 1, name: "fixture", version: "0.0.1" });
		return;
	}
	if (message.method === "echo") return reply(message.id, message.params);
	if (message.method === "remember") {
		remembered = message.params;
		return;
	}
	if (message.method === "recall") return reply(message.id, remembered);
	if (message.method === "env") {
		return reply(message.id, {
			token: process.env.PI_STUDIO_TOKEN ?? "absent",
			url: process.env.PI_STUDIO_URL ?? "absent",
			path: typeof process.env.PATH === "string",
		});
	}
	if (message.method === "unicode") {
		// Split the answer in the middle of its first multi-byte character, so the host has to carry
		// half a character into the next chunk.
		const frame = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.params.text }) + "\\n";
		const bytes = Buffer.from(frame, "utf8");
		let cut = bytes.length;
		for (let at = 0; at < bytes.length; at += 1) {
			if (bytes[at] >= 0x80) {
				cut = at + 1;
				break;
			}
		}
		process.stdout.write(bytes.subarray(0, cut));
		setTimeout(() => process.stdout.write(bytes.subarray(cut)), 10);
		return;
	}
	if (message.method === "reject") return refuse(message.id, -32001, "refused on purpose");
	if (message.method === "stall") return;
	if (message.method === "stderr") {
		process.stderr.write("fixture says hello\\n");
		return reply(message.id, true);
	}
	if (message.method === "crash") return process.exit(3);
	if (message.method === "ask") {
		// A call of the host's own, answered back as this call's result.
		waiting.set(900, (answer) => reply(message.id, answer.error ?? answer.result));
		return out({ jsonrpc: "2.0", id: 900, method: "double", params: { value: message.params.value } });
	}
	return refuse(message.id, -32601, "no such method");
});
`;

const fixture = join(root, "fixture.cjs");
writeFileSync(fixture, FIXTURE, { mode: 0o755 });

/** One plugin entry naming the fixture executable. */
function entry(mode = "echo") {
	return { name: "echo", command: process.execPath, args: [fixture, mode] };
}

const quiet = () => {};

/** A started plugin, closed when the test is done with it, whatever the test did. */
async function started(options: Parameters<typeof startPlugin>[1] = {}, mode = "echo"): Promise<PluginHost> {
	return startPlugin(entry(mode), { log: quiet, ...options });
}

// ---------- a call crossing the pipe ----------

test("a plugin is asked for work and asks the host back in the same connection", async () => {
	const host = await started({ onRequest: (call) => ({ value: Number((call.params as { value: number }).value) * 2 }) });
	try {
		assert.equal(host.running(), true);
		assert.deepEqual(host.info, { name: "fixture", version: "0.0.1" });
		// The plugin answers `ask` by calling the host's `double` first: both directions on one pipe.
		assert.deepEqual(await host.request("ask", { value: 21 }), { value: 42 });
	} finally {
		await host.close();
	}
});

test("a call the plugin makes reaches the callback with the plugin it came from", async () => {
	const calls: PluginCall[] = [];
	const host = await started({ onRequest: (call) => (calls.push(call), "answered") });
	try {
		assert.equal(await host.request("ask", { value: 1 }), "answered");
		assert.deepEqual(calls, [{ plugin: "echo", method: "double", params: { value: 1 } }]);
	} finally {
		await host.close();
	}
});

test("a notification is sent with nothing wanted back", async () => {
	const host = await started();
	try {
		host.notify("remember", { kept: true });
		assert.deepEqual(await host.request("recall"), { kept: true });
	} finally {
		await host.close();
	}
});

test("an answer split in the middle of a character still reads", async () => {
	const host = await started();
	try {
		assert.equal(await host.request("unicode", { text: "héllo 🌍 — åäö" }), "héllo 🌍 — åäö");
	} finally {
		await host.close();
	}
});

// ---------- what a plugin may see ----------

test("the daemon's own credentials never reach a plugin", async () => {
	const before = { token: process.env.PI_STUDIO_TOKEN, url: process.env.PI_STUDIO_URL };
	process.env.PI_STUDIO_TOKEN = "daemon-secret";
	process.env.PI_STUDIO_URL = "http://127.0.0.1:1";
	const host = await started();
	try {
		assert.deepEqual(await host.request("env"), { token: "absent", url: "absent", path: true });
	} finally {
		await host.close();
		process.env.PI_STUDIO_TOKEN = before.token;
		process.env.PI_STUDIO_URL = before.url;
	}
});

test("the environment a plugin inherits is an allowlist", () => {
	assert.deepEqual(pluginEnv({ PATH: "/bin", HOME: "/home/someone", PI_STUDIO_TOKEN: "secret", PI_STUDIO_WORKSPACE: "w", AWS_SECRET_ACCESS_KEY: "secret" }), {
		PATH: "/bin",
		HOME: "/home/someone",
	});
});

// ---------- a plugin that will not answer ----------

test("a plugin's refusal reaches the caller with its code and its words", async () => {
	const host = await started();
	try {
		await assert.rejects(host.request("reject"), (error: unknown) => {
			assert.ok(error instanceof PluginFailure);
			assert.equal(error.code, -32001);
			assert.match(error.message, /echo refused reject: refused on purpose/);
			return true;
		});
		assert.equal(host.running(), true);
	} finally {
		await host.close();
	}
});

test("a call the plugin never answers runs out of time and leaves the plugin running", async () => {
	const host = await started({ requestTimeoutMs: 5_000 });
	try {
		await assert.rejects(host.request("stall", undefined, 100), /echo did not answer stall within 100 ms/);
		assert.equal(host.running(), true);
		assert.deepEqual(await host.request("echo", { still: "here" }), { still: "here" });
	} finally {
		await host.close();
	}
});

test("a plugin that dies takes its waiting call with it", async () => {
	const host = await started();
	const waiting = host.request("crash");
	await assert.rejects(waiting, /echo exited \(3\)/);
	assert.equal(host.running(), false);
	assert.deepEqual(await host.exited, { code: 3, signal: null });
	await assert.rejects(host.request("echo", {}), /echo is not running/);
	await host.close();
});

test("a plugin that is not there to start is refused", async () => {
	await assert.rejects(startPlugin({ name: "gone", command: join(root, "nowhere"), args: [] }, { log: quiet }), /could not start gone: spawn .*ENOENT/);
});

test("a plugin that never finishes its handshake is refused", async () => {
	await assert.rejects(startPlugin(entry("silent"), { log: quiet, handshakeTimeoutMs: 100 }), /did not answer initialize within 100 ms/);
});

test("a plugin that speaks another protocol version is refused", async () => {
	await assert.rejects(startPlugin(entry("old"), { log: quiet }), /echo speaks protocol 2; this daemon speaks 1/);
});

// ---------- what the plugin said on the way ----------

test("a plugin's stderr is logged and its tail kept for a caller", async () => {
	const lines: string[] = [];
	const host = await started({ log: (line) => lines.push(line) });
	try {
		assert.equal(await host.request("stderr"), true);
		// Stderr and stdout are separate pipes, so the reply can arrive before the log line does,
		// especially on a loaded machine. Wait for the line instead of assuming it beat the reply.
		for (let waited = 0; lines.length === 0 && waited < 2_000; waited += 10) {
			await new Promise((done) => setTimeout(done, 10));
		}
		assert.match(lines[0], /^\[plugin:echo\] fixture says hello/);
		assert.match(host.diagnostics(), /fixture says hello/);
	} finally {
		await host.close();
	}
});

test("closing a plugin ends it, quietly the second time", async () => {
	const host = await started();
	await host.close();
	assert.equal(host.running(), false);
	await host.close();
	const exit = await host.exited;
	assert.ok(exit.signal !== null || exit.code !== null, "the plugin is gone");
	await assert.rejects(host.request("echo", {}), /echo is not running/);
});

// ---------- the registration ----------

test("the daemon reads the plugins it was told about, and says why one is refused", () => {
	const file = join(root, "plugins.json");
	const plain = join(root, "plain.txt");
	writeFileSync(plain, "not a program\n");
	writeFileSync(
		file,
		JSON.stringify({
			plugins: [
				{ name: "echo", command: process.execPath, args: [fixture], title: "ignored for now" },
				{ name: "relative", command: "./plugin" },
				{ name: "missing", command: join(root, "nowhere") },
				{ name: "plain", command: plain },
				{ name: "echo", command: process.execPath },
				{ name: "bad-args", command: process.execPath, args: [1] },
				{ command: process.execPath },
				7,
			],
		}),
	);
	const registry = loadPluginRegistry(file);
	assert.deepEqual(registry.plugins, [{ name: "echo", command: process.execPath, args: [fixture] }]);
	assert.deepEqual(registry.problems, [
		{ name: "relative", problem: "command must be an absolute path to an executable, or bundled must name a plugin this install ships" },
		{ name: "missing", problem: `${join(root, "nowhere")} is not an executable file` },
		{ name: "plain", problem: `${plain} is not an executable file` },
		{ name: "echo", problem: "the name is used twice" },
		{ name: "bad-args", problem: "args must be a list of strings" },
		{ name: "", problem: "one row has no name" },
		{ name: "", problem: "one row is not an object" },
	]);
});

test("a daemon with no registration has no plugins", () => {
	assert.deepEqual(loadPluginRegistry(join(root, "nothing-here.json")), { plugins: [], problems: [] });
	const broken = join(root, "broken.json");
	writeFileSync(broken, "{ not json");
	assert.deepEqual(loadPluginRegistry(broken), { plugins: [], problems: [{ name: "", problem: "the file could not be read as JSON" }] });
	const shaped = join(root, "shaped.json");
	writeFileSync(shaped, JSON.stringify({ plugin: [] }));
	assert.deepEqual(loadPluginRegistry(shaped), { plugins: [], problems: [{ name: "", problem: 'the file must hold { "plugins": [ … ] }' }] });
});

test("a plugin the registration named can be started", async () => {
	const file = join(root, "started.json");
	writeFileSync(file, JSON.stringify({ plugins: [{ name: "echo", command: process.execPath, args: [fixture, "echo"] }] }));
	const [only] = loadPluginRegistry(file).plugins;
	const host = await startPlugin(only, { log: quiet });
	try {
		assert.deepEqual(await host.request("echo", { from: "file" }), { from: "file" });
	} finally {
		await host.close();
	}
});
