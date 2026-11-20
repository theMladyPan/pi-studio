/**
 * What a real daemon sees when it starts this example plugin.
 *
 * The daemon's own `PluginHost` spawns the built binary and speaks the line protocol to it, and a
 * stand-in answers the two methods the plugin calls. The plugin watches a throwaway Python project and
 * runs a fake `pytest` — a script that passes, until a FAIL file appears beside it — so editing a source
 * file earns a targeted run and a failing run says so on `state`.
 *
 *   cargo build --release
 *   node --test examples/plugins/bughound/check/against-host.mjs
 *
 * `BUGHOUND_BIN` names a binary built somewhere else, which is what a target folder outside the
 * checkout needs.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startPlugin } from "../../../../server/plugins/host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.env.BUGHOUND_BIN ?? join(here, "..", "target", "release", "pi-studio-bughound");

const root = mkdtempSync(join(tmpdir(), "pi-studio-bughound-host-"));
const folder = join(root, "project");
const WS = "workspace-watched";

// A fake pytest: it passes, until a FAIL file appears in the folder it runs in, and says why, in the
// words and the exit code the plugin parses. Whether it was asked for a file matters as much as passing.
const fakePytest = join(root, "fake-pytest");
writeFileSync(
	fakePytest,
	[
		"#!/bin/sh",
		'if [ -f "$PWD/FAIL" ]; then',
		'  echo "FAILED tests/test_calc.py::test_add - assert 1 == 2"',
		'  echo "1 failed in 0.01s"',
		"  exit 1",
		"fi",
		'for arg in "$@"; do case "$arg" in tests/*) echo "ran $arg" >> "$PWD/ran.txt";; esac; done',
		'echo "1 passed in 0.01s"',
		"exit 0",
		"",
	].join("\n"),
);
chmodSync(fakePytest, 0o755);

mkdirSync(join(folder, "pkg"), { recursive: true });
mkdirSync(join(folder, "tests"), { recursive: true });
writeFileSync(join(folder, "pkg", "calc.py"), "def add(a, b):\n    return a + b\n");
writeFileSync(join(folder, "tests", "test_calc.py"), "from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n");

const quiet = () => {};

/** A daemon's two methods, and every call the plugin makes of them. */
function daemon() {
	const calls = [];
	const answer = (call) => {
		calls.push(call);
		if (call.method === "events.subscribe") return { types: call.params.types };
		if (call.method === "workspace.list") {
			return {
				workspaces: [
					{ id: WS, name: "a project", folder, missing: false, scratch: false },
					{ id: "workspace-scratch", name: "scratch", folder: join(root, "scratch"), missing: false, scratch: true },
				],
			};
		}
		if (call.method === "cards.note") return { cardId: `card-${calls.length}`, card: {} };
		throw Object.assign(new Error(`${call.method} is not a method this daemon answers`), { code: -32601 });
	};
	return { calls, answer };
}

/** Wait for what the plugin does next, rather than for a duration. */
async function until(what, seen, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await seen()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`the plugin never did this: ${what}`);
}

async function started() {
	const server = daemon();
	const host = await startPlugin(
		{ name: "bughound", command: binary, args: ["--interval-ms", "250", "--debounce-ms", "100", "--pytest", fakePytest] },
		{ log: quiet, onRequest: server.answer },
	);
	return { host, ...server };
}

test("a daemon starts the plugin, and it asks for the workspaces and the settled runs", async () => {
	assert.ok(existsSync(binary), `no plugin binary at ${binary}; run cargo build --release in the example first`);
	const { host, calls } = await started();
	try {
		assert.equal(host.info.name, "bughound", "the name the plugin gave in its handshake");
		assert.match(host.info.version, /^\d+\.\d+\.\d+$/, "and the version it carries");
		await until("asked for the workspaces and the subscription", () => calls.some((call) => call.method === "workspace.list") && calls.some((call) => call.method === "events.subscribe"));
		assert.deepEqual(calls.find((call) => call.method === "events.subscribe")?.params, { types: ["thread.settled"] });
	} finally {
		await host.close();
	}
});

test("the panel's state names the watched workspace, and an edit runs its covering test", async (t) => {
	const { host } = await started();
	try {
		// The first scan is a baseline and runs nothing, so the edit below waits for it to have happened.
		await until("the baseline scanned", async () => {
			const state = await host.request("visual.request", { workspace: WS, method: "state", params: {} });
			return state.workspaces?.find((one) => one.id === WS)?.lastScanAt != null;
		});
		// An edit under the folder earns a targeted run of the test that imports the file.
		writeFileSync(join(folder, "pkg", "calc.py"), "def add(a, b):\n    return a + b + 0\n");
		await until("the run lands", async () => {
			const state = await host.request("visual.request", { workspace: WS, method: "state", params: {} });
			return state.workspaces?.find((one) => one.id === WS)?.lastRun?.status === "passed";
		});
		const ran = await readFile(join(folder, "ran.txt"));
		assert.match(ran, /ran tests\/test_calc\.py/, "the run named the covering test file");
		// The same edit with a failure beside it reports the failure by node id.
		writeFileSync(join(folder, "FAIL"), "");
		writeFileSync(join(folder, "pkg", "calc.py"), "def add(a, b):\n    return a + b + 1\n");
		await until("the failure lands", async () => {
			const state = await host.request("visual.request", { workspace: WS, method: "state", params: {} });
			return state.workspaces?.find((one) => one.id === WS)?.lastRun?.status === "failed";
		});
		const state = await host.request("visual.request", { workspace: WS, method: "state", params: {} });
		const failures = state.workspaces.find((one) => one.id === WS).lastRun.failures;
		assert.equal(failures[0].nodeid, "tests/test_calc.py::test_add");
		assert.match(failures[0].summary, /assert 1 == 2/);
	} finally {
		await host.close();
		// Reading what the run wrote happens after the plugin is gone, so the folder is kept until then.
		rmSync(root, { recursive: true, force: true });
	}
});

test("the plugin exits when the daemon closes it", async () => {
	const { host, calls } = await started();
	await until("asked for the workspaces", () => calls.some((call) => call.method === "workspace.list"));
	await host.close();
	const exit = await host.exited;
	assert.equal(host.running(), false);
	assert.equal(exit.code, 0, "a plugin told to shut down stops tidily rather than being killed");
});

async function readFile(path) {
	const { readFileSync } = await import("node:fs");
	return readFileSync(path, "utf8");
}
