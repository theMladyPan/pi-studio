/**
 * The example plugin, started the way the daemon starts one.
 *
 * This goes through the whole daemon side below HTTP: the registration file is read, the plugin is
 * spawned, the daemon's own service answers its calls, and a failing run leaves the one card it was
 * configured to leave. The state folder is a throwaway one, so no board the human has open is read or
 * written. The plugin is registered with its panel in the drawers, as this example documents.
 *
 *   cargo build --release
 *   node --test examples/plugins/bughound/check/against-service.mjs
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pi-studio-bughound-service-"));
// Set before a daemon module is imported: the state folder is resolved once, at import.
const state = join(root, "state");
process.env.PI_STUDIO_STATE = state;

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.env.BUGHOUND_BIN ?? join(here, "..", "target", "release", "pi-studio-bughound");

const { startPlugins, stopPlugins } = await import("../../../../server/plugins/manager.ts");
const { createPluginService } = await import("../../../../server/plugins/service.ts");
const { rememberWorkspace } = await import("../../../../server/workspaces.ts");

after(async () => {
	await stopPlugins();
	rmSync(root, { recursive: true, force: true });
});

const quiet = () => {};

/** Wait for what the plugin does next, rather than for a duration. */
async function until(what, seen, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await seen()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`the plugin never did this: ${what}`);
}

test("a failing run leaves the one card it was configured to leave, and no other run leaves one", async () => {
	assert.ok(existsSync(binary), `no plugin binary at ${binary}; run cargo build --release in the example first`);

	// The example project: one source file, the test that imports it, and a fake pytest that fails
	// whenever a FAIL marker is beside it.
	const folder = join(root, "project");
	mkdirSync(join(folder, "pkg"), { recursive: true });
	mkdirSync(join(folder, "tests"), { recursive: true });
	writeFileSync(join(folder, "pkg", "calc.py"), "def add(a, b):\n    return a + b\n");
	writeFileSync(join(folder, "tests", "test_calc.py"), "from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n");
	// The project is a workspace the daemon knows before the plugin starts, so the plugin's first
	// workspace.list names its folder and the baseline scan says what is there.
	const project = rememberWorkspace(folder);
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
			'echo "1 passed in 0.01s"',
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(fakePytest, 0o755);

	// Registering the plugin is the human's deliberate act, and this is the file they write: the panel
	// lives in the left drawers, and a failing run is the one thing worth a card.
	mkdirSync(state, { recursive: true });
	writeFileSync(
		join(state, "plugins.json"),
		JSON.stringify({
			plugins: [
				{
					name: "bughound",
					command: binary,
					args: ["--interval-ms", "250", "--debounce-ms", "100", "--pytest", fakePytest, "--post-failures"],
					visual: { title: "bughound", place: "drawer", entry: "assets/panel.html", files: ["assets/panel.html", "assets/panel.js", "assets/panel.css"] },
				},
			],
		}),
	);

	const service = createPluginService();
	const asked = [];
	const manager = await startPlugins({
		log: quiet,
		onRequest: (call) => {
			asked.push(call.method);
			return service.handle(call);
		},
	});
	try {
		assert.deepEqual(manager.problems(), [], "the registration named a plugin the daemon can start");
		assert.deepEqual(
			manager.roster().map((plugin) => [plugin.name, plugin.running]),
			[["bughound", true]],
		);
		assert.equal(manager.roster()[0].visual?.place, "drawer", "the panel asked for the drawers");
		await until("asked which workspaces exist", () => asked.includes("workspace.list"));
		// The first scan is a baseline; an edit made before it would be part of it and run nothing.
		await new Promise((resolve) => setTimeout(resolve, 1_000));

		const read = (workspace) => service.handle({ plugin: "a-check", method: "workspace.read", params: { workspace } });

		// A passing run is logged only where the panel reads it.
		writeFileSync(join(folder, "pkg", "calc.py"), "def add(a, b):\n    return a + b + 0\n");
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const quietBoard = await read(project.id);
		assert.deepEqual(quietBoard.cards, [], "a passing run leaves no card");

		// A failing run leaves exactly one card, keyed by the workspace so a second failure revises it.
		writeFileSync(join(folder, "FAIL"), "");
		writeFileSync(join(folder, "pkg", "calc.py"), "def add(a, b):\n    return a + b + 1\n");
		await until("the failing run left its card", async () => {
			const board = await read(project.id);
			return board.cards.some((card) => card.key === `bughound:${project.id}`);
		});
		const notes = (await read(project.id)).cards.filter((card) => card.type === "note");
		assert.equal(notes.length, 1, "one note, revised in place rather than stacked");
		assert.match(notes[0].markdown, /failed/);
		assert.match(notes[0].markdown, /tests\/test_calc\.py::test_add/);
	} finally {
		await manager.close();
	}
});
