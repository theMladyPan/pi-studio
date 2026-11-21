/**
 * The plugins a package of its own ships: a registration that names one of them, and the platform
 * executable the daemon picks for it. This repository carries no plugin of its own, so every folder here
 * is a fixture this test makes.
 *
 * A bundled row is one word in `plugins.json` — the name of a folder this install carries — and everything
 * else comes from that folder: the program to run, and the panel its own `plugin.json` declares. It is still
 * an explicit registration: a daemon whose file names no plugin starts none, whatever it was installed with.
 *
 * The state folder is a throwaway one, set before any daemon module is imported, so nothing here reads or
 * writes a human's records. The bundled folder is this test's own, so no plugin a checkout carries is used.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { removeTree } from "../test-support/temp.ts";

const root = mkdtempSync(join(tmpdir(), "pi-studio-plugins-bundled-"));
process.env.PI_STUDIO_STATE = join(root, "state");

const { loadPluginRegistry } = await import("../server/plugins/registry.ts");
const { startPlugins } = await import("../server/plugins/manager.ts");

/** The name a release gives one plugin's program on this machine, which is the file the daemon looks for. */
const PLATFORM = `${process.platform}-${process.arch}`;

/** The panel a bundled plugin declares in its own manifest, in the words the daemon's registration uses. */
const PANEL = { title: "example panel", entry: "assets/panel.html", files: ["assets/panel.html", "assets/panel.css"] };

/** A plugin the install ships: a manifest, a panel beside it, and a program for this platform. */
function bundled(name: string, manifest: unknown = { name, version: "1.2.3", protocol: 1, visual: PANEL }): string {
	const base = join(root, "install", "plugins");
	const folder = join(base, name);
	mkdirSync(join(folder, "assets"), { recursive: true });
	writeFileSync(join(folder, "plugin.json"), JSON.stringify(manifest));
	writeFileSync(join(folder, "assets", "panel.html"), "<!doctype html><title>panel</title>\n");
	writeFileSync(join(folder, "assets", "panel.css"), "body { margin: 0 }\n");
	const exe = join(folder, `${name}-${PLATFORM}`);
	writeFileSync(exe, "#!/bin/sh\nexit 0\n");
	chmodSync(exe, 0o755);
	return base;
}

/** A registration file holding these rows, and what the reader makes of it. */
function read(rows: unknown[], bundledDir = join(root, "install", "plugins")) {
	const file = join(root, `plugins-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify({ plugins: rows }));
	return loadPluginRegistry(file, bundledDir);
}

after(async () => {
	await removeTree(root);
});

// ---------- what a bundled row is read as ----------

test("a row naming a plugin this install ships runs that plugin's own program, with the panel its manifest declares", () => {
	const base = bundled("history");
	const { plugins, problems } = read([{ name: "history", bundled: "history", args: [] }], base);
	assert.deepEqual(problems, []);
	assert.deepEqual(plugins, [
		{ name: "history", command: join(base, "history", `history-${PLATFORM}`), args: [], visual: PANEL, bundled: "history", version: "1.2.3" },
	]);
});

test("a bundled plugin with nothing built for this platform names the file a release would have shipped", () => {
	const base = bundled("history");
	// A release names its program after the platform it was built on, so this platform's file can be missing.
	rmSync(join(base, "history", `history-${PLATFORM}`));
	const { plugins, problems } = read([{ name: "history", bundled: "history" }], base);
	assert.deepEqual(plugins, []);
	assert.equal(problems.length, 1);
	assert.match(problems[0].problem, new RegExp(`holds no executable for ${PLATFORM}`));
	assert.match(problems[0].problem, new RegExp(`history-${PLATFORM}`));
});

test("a bundled row that also names a command, or its own panel, is refused rather than half read", () => {
	const base = bundled("history");
	const both = read([{ name: "history", bundled: "history", command: "/bin/sh" }], base);
	assert.equal(both.plugins.length, 0);
	assert.match(both.problems[0].problem, /either command or bundled/);

	const withPanel = read([{ name: "history", bundled: "history", visual: PANEL }], base);
	assert.equal(withPanel.plugins.length, 0);
	assert.match(withPanel.problems[0].problem, /plugin's own plugin\.json/);
});

test("a bundled name is one folder of this install, never a path to somewhere else", () => {
	const base = bundled("history");
	for (const name of ["../history", "/opt/plugin", "inst/plugins/history", "", ".hidden", 7]) {
		const { plugins, problems } = read([{ name: "history", bundled: name }], base);
		assert.deepEqual(plugins, [], `${JSON.stringify(name)} is not a folder name`);
		assert.match(problems[0].problem, /one folder inside the plugins folder/);
	}
});

test("a bundled plugin whose own manifest points at nothing is a problem on the row", () => {
	const base = bundled("history", { name: "history", visual: { title: "history", entry: "assets/missing.html", files: ["assets/panel.html"] } });
	const missingEntry = read([{ name: "history", bundled: "history" }], base);
	assert.deepEqual(missingEntry.plugins, []);
	assert.match(missingEntry.problems[0].problem, /entry has to be one of visual\.files/);

	const unreadable = bundled("broken");
	writeFileSync(join(unreadable, "broken", "plugin.json"), "not json at all");
	const broken = read([{ name: "broken", bundled: "broken" }], unreadable);
	assert.deepEqual(broken.plugins, []);
	assert.match(broken.problems[0].problem, /plugin\.json could not be read as one JSON object/);
});

// ---------- a bundled plugin as a process ----------

/** A bundled plugin that answers the handshake and reports its own life, so a start can be watched. */
const FIXTURE = `#!${process.execPath}
const fs = require("node:fs");
const marker = process.argv[2];
fs.appendFileSync(marker, "started\\n");
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "initialize") return out({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, name: "fixture", version: "1.2.3" } });
	if (message.method === "shutdown") return;
	if (message.id !== undefined) out({ jsonrpc: "2.0", id: message.id, result: message.params ?? null });
});
rl.on("close", () => {
	fs.appendFileSync(marker, "stopped\\n");
	process.exit(0);
});
`;

/** A bundled folder holding that fixture as this platform's program, and the marker it writes its life into. */
function startable(name: string): { base: string; marker: string } {
	const base = bundled(name);
	const marker = join(root, `${name}.log`);
	writeFileSync(join(base, name, `${name}-${PLATFORM}`), FIXTURE);
	chmodSync(join(base, name, `${name}-${PLATFORM}`), 0o755);
	return { base, marker };
}

test("a registration naming a bundled plugin starts it, and a registration naming none starts nothing", async () => {
	const { base, marker } = startable("reader");
	const file = join(root, "start.json");
	writeFileSync(file, JSON.stringify({ plugins: [{ name: "reader", bundled: "reader", args: [marker] }] }));

	// Nothing is started until a row names it, however much this install carries.
	const empty = await startPlugins({ file: join(root, "empty.json"), bundledDir: base, log: () => {} });
	await empty.close();
	assert.equal(existsSync(marker), false, "a daemon whose registration names no plugin starts none");

	const manager = await startPlugins({ file, bundledDir: base, log: () => {} });
	try {
		assert.deepEqual(manager.problems(), []);
		assert.deepEqual(manager.roster(), [
			{ name: "reader", command: join(base, "reader", `reader-${PLATFORM}`), version: "1.2.3", running: true, visual: PANEL },
		]);
		assert.deepEqual(await manager.request("reader", "echo", { from: "the daemon" }), { from: "the daemon" });
		assert.equal(readFileSync(marker, "utf8").trim(), "started");
	} finally {
		await manager.close();
	}
	assert.equal(readFileSync(marker, "utf8").trim(), "started\nstopped", "the program was told to stop and exited");
});

// ---------- a plugin a package of its own ships ----------

test("a plugin an install ships registers in one word and takes its panel from its own manifest", () => {
	// The layout a release stages: one folder under the install's `plugins/`, holding the manifest, the
	// panel and the executable built for this platform. This repository ships no plugin of its own, so the
	// folder is a fixture made here rather than a copy of one — the registration reader is the thing under
	// test, not the contents of a plugin anybody happens to carry.
	const base = bundled("shipped");
	const exe = join(base, "shipped", `shipped-${PLATFORM}`);
	const manifest = JSON.parse(readFileSync(join(base, "shipped", "plugin.json"), "utf8")) as { visual: unknown };

	const { plugins, problems } = read([{ name: "shipped", bundled: "shipped" }], base);
	assert.deepEqual(problems, []);
	assert.deepEqual(plugins, [{ name: "shipped", command: exe, args: [], visual: manifest.visual, bundled: "shipped", version: "1.2.3" }]);

	// A daemon whose registration names nothing starts nothing, even when this install ships a plugin.
	assert.deepEqual(loadPluginRegistry(join(root, "no-such-file.json"), base), { plugins: [], problems: [] });
});
