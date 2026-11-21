/**
 * The panel a plugin may put on the board: what a registration may say about one, what the daemon serves
 * for it, and the single call its page can make.
 *
 * The reader is tested with no daemon at all, because what it refuses — a path that leaves the plugin's
 * folder, a file that is a link, an entry that was never declared — is a decision about a document, not
 * about a request. The routes are tested against a daemon started the way a human starts one, with the
 * real plugin process from `test-support/plugin-visual` behind them, so what is proved is the whole
 * path: the registration, the frame's files, and the answer a panel's call comes back with. Those files
 * are served to a frame that carries no credential, which is why every read of one asks for none.
 *
 * The state folder is a throwaway one, set before any daemon module is imported, so no human's workspace
 * is read and none is written.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeTree } from "../test-support/temp.ts";
import type { ChildProcess } from "node:child_process";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "pi-studio-plugin-visual-"));
const state = join(root, "state");
process.env.PI_STUDIO_STATE = state;
mkdirSync(state, { recursive: true });

// The example plugin the repository carries: an executable with a panel's three files beside it, which is
// exactly the layout a registration's panel is served from.
const example = join(repo, "test-support", "plugin-visual");
const exampleRow = {
	name: "example-panel",
	command: join(example, "panel-plugin.mjs"),
	args: [],
	visual: { title: "example panel", entry: "panel.html", files: ["panel.html", "panel.js", "panel.css"] },
};

const { loadAvailablePlugins, loadPluginRegistry } = await import("../server/plugins/registry.ts");
const { threadRefusal } = await import("../server/main.ts");

after(async () => {
	await removeTree(root);
});

/** A registration file holding these rows, and what the reader makes of it. */
function read(rows: unknown[]) {
	const file = join(root, `plugins-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify({ plugins: rows }));
	return loadPluginRegistry(file);
}

/** A plugin folder of this test's own: an executable, a panel beside it, and whatever a case adds to them. */
function folder(name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	const exe = join(path, "exe");
	writeFileSync(exe, "#!/bin/sh\nexit 0\n");
	chmodSync(exe, 0o755);
	writeFileSync(join(path, "panel.html"), "<!doctype html><title>panel</title>\n");
	return path;
}

// ---------- what a registration may say about a panel ----------

test("a registration that declares a panel is read with the files it named", () => {
	const { plugins, problems } = read([exampleRow]);
	assert.deepEqual(problems, []);
	assert.deepEqual(plugins, [{ name: exampleRow.name, command: exampleRow.command, args: [], visual: exampleRow.visual }]);
});

test("a row without a panel is a plugin like any other", () => {
	const { plugins, problems } = read([{ name: "plain", command: exampleRow.command, args: [] }]);
	assert.deepEqual(problems, []);
	assert.deepEqual(plugins, [{ name: "plain", command: exampleRow.command, args: [] }]);
	assert.equal("visual" in plugins[0], false, "a row that declared no panel is read with no panel");
});

test("a panel file that is not a plain file inside the plugin's folder is refused with the reason", () => {
	const path = folder("escaping");
	// A file that exists one level up, and a link to one: both are outside what the human installed.
	writeFileSync(join(root, "secret.html"), "<!doctype html><title>secret</title>\n");
	symlinkSync(join(root, "secret.html"), join(path, "link.html"));
	const cases: [string, unknown[], RegExp][] = [
		["a path out of the folder", ["panel.html", "../secret.html"], /is not a relative path/],
		["an absolute path", ["panel.html", "/etc/passwd"], /is not a relative path/],
		["a link", ["panel.html", "link.html"], /not a file inside/],
		["a file that is not there", ["panel.html", "gone.js"], /not a file inside/],
	];
	for (const [what, files, reason] of cases) {
		const { plugins, problems } = read([{ name: "escaping", command: join(path, "exe"), args: [], visual: { title: "escaping", entry: "panel.html", files } }]);
		assert.deepEqual(plugins, [], what);
		assert.equal(problems.length, 1, what);
		assert.match(problems[0].problem, reason, what);
	}
});

test("a panel whose title or entry makes no sense is refused rather than half read", () => {
	const exe = join(folder("half"), "exe");
	const cases: [string, unknown, RegExp][] = [
		["an empty title", { title: "  ", entry: "panel.html", files: ["panel.html"] }, /visual.title/],
		["a panel with no entry", { title: "half", files: ["panel.html"] }, /visual.entry/],
		["an entry it never declared", { title: "half", entry: "other.html", files: ["panel.html"] }, /one of visual.files/],
		["no files at all", { title: "half", entry: "panel.html", files: [] }, /at least one file/],
		["a panel that is not an object", "panel.html", /visual must be one object/],
	];
	for (const [what, visual, reason] of cases) {
		const { plugins, problems } = read([{ name: "half", command: exe, args: [], visual }]);
		assert.deepEqual(plugins, [], what);
		assert.match(problems[0]?.problem ?? "", reason, what);
	}
});

test("a panel that asks for the drawer is read with its place, and one that asks for something else is refused", () => {
	const exe = join(folder("placed"), "exe");
	const row = { name: "placed", command: exe, args: [], visual: { title: "placed", entry: "panel.html", files: ["panel.html"], place: "drawer" } };
	const { plugins, problems } = read([row]);
	assert.deepEqual(problems, []);
	assert.deepEqual(plugins, [{ name: "placed", command: exe, args: [], visual: row.visual }]);
	const bad = read([{ name: "placed", command: exe, args: [], visual: { title: "placed", entry: "panel.html", files: ["panel.html"], place: "sidebar" } }]);
	assert.deepEqual(bad.plugins, []);
	assert.match(bad.problems[0]?.problem ?? "", /visual\.place/);
});

test("a row's shortcut is one free letter, and a letter twice or the board's is refused", () => {
	const exe = join(folder("keyed"), "exe");
	const row = (name: string, shortcut: unknown) => ({ name, command: exe, args: [], shortcut });
	const { plugins, problems } = read([row("keyed", "b")]);
	assert.deepEqual(problems, []);
	assert.equal(plugins[0].shortcut, "b");
	const clash = read([row("one", "b"), row("two", "b")]);
	assert.equal(clash.plugins.length, 1, "the second row with the same letter is refused");
	assert.match(clash.problems[0].problem, /already assigned/);
	assert.match(read([row("board", "f")]).problems[0].problem, /belongs to the board/);
	assert.match(read([row("shaped", "bb")]).problems[0].problem, /one lowercase letter/);
	assert.match(read([row("capital", "B")]).problems[0].problem, /one lowercase letter/);
});

test("the settings list is read and written through the daemon, and only the human writes it", async () => {
	const daemon = await boot([exampleRow]);
	const gone = new Promise<void>((resolve) => daemon.child.once("exit", () => resolve()));
	try {
		// What the settings page reads: the row, the running roster beside it, and the letters a
		// shortcut may not take.
		const listed = await get(daemon, "/plugins/registry");
		assert.equal(listed.status, 200);
		const shown = JSON.parse(listed.body) as { plugins: { name: string }[]; taken: string[] };
		assert.deepEqual(shown.plugins.map((one) => one.name), ["example-panel"]);
		assert.ok(shown.taken.includes("f"));
		// A list the reader cannot use changes nothing: the daemon answers why and keeps what it runs.
		const refused = await post(daemon, "/plugins/registry", { plugins: [{ name: "broken" }] });
		assert.equal(refused.status, 400, "a row with no command is not written");
		assert.match(refused.body, /problems/);
		const still = await get(daemon, "/plugins/registry");
		assert.deepEqual((JSON.parse(still.body) as { plugins: { name: string }[] }).plugins.map((one) => one.name), ["example-panel"]);
		// A usable list replaces the file and restarts the roster under it, with no daemon restart.
		const written = await post(daemon, "/plugins/registry", { plugins: [{ ...exampleRow, shortcut: "b" }] });
		assert.equal(written.status, 200, written.body);
		const reread = (await get(daemon, "/plugins/registry")).body;
		const after = JSON.parse(reread) as { plugins: { name: string; shortcut?: string }[]; roster: { name: string; running: boolean; shortcut?: string }[] };
		assert.equal(after.plugins[0].shortcut, "b");
		assert.deepEqual(after.roster.map((one) => [one.name, one.running, one.shortcut]), [["example-panel", true, "b"]]);
		// A thread has no route here: writing a row starts whatever it names, so it stays the human's.
		const thread = { human: false, board: { id: "ws" }, thread: {} };
		assert.equal(threadRefusal(thread, "GET", "/plugins/registry", "ws"), "a thread may not use that");
		assert.equal(threadRefusal(thread, "POST", "/plugins/registry", "ws"), "a thread may not use that");
	} finally {
		daemon.child.kill("SIGTERM");
		await Promise.race([gone, new Promise((done) => setTimeout(done, 10_000))]);
	}
});

/** A folder `folder()` made, with its own name as the executable beside it, as an installed plugin is. */
function ownExe(name: string): string {
	const path = folder(name);
	writeFileSync(join(path, name), "#!/bin/sh\nexit 0\n");
	chmodSync(join(path, name), 0o755);
	return path;
}

test("an installed row takes its program, panel and version from its own plugin.json", () => {
	const path = ownExe("instlone");
	writeFileSync(join(path, "plugin.json"), JSON.stringify({
		name: "instlone",
		version: "2.1.0",
		protocol: 1,
		protocolMinor: 0,
		title: "installed one",
		start: "lazy",
		visual: { entry: "panel.html", files: ["panel.html"] },
	}));
	const file = join(root, "installed.json");
	writeFileSync(file, JSON.stringify({ plugins: [{ name: "instlone", installed: "instlone", args: [] }] }));
	const { plugins, problems } = loadPluginRegistry(file, undefined, root);
	assert.deepEqual(problems, []);
	assert.equal(plugins[0].installed, "instlone");
	assert.equal(plugins[0].version, "2.1.0");
	assert.equal(plugins[0].start, "lazy");
	assert.equal(plugins[0].visual?.title, "installed one", "the panel title falls back to the manifest's");
	assert.match(plugins[0].command, /instlone/);
});

test("a manifest that asks for more than this daemon carries is refused at read time", () => {
	const write = (folderName: string, manifest: object) => {
		const path = ownExe(folderName);
		writeFileSync(join(path, "plugin.json"), JSON.stringify(manifest));
		return join(root, `${folderName}.json`);
	};
	const fileFor = (folderName: string) => {
		const file = join(root, `${folderName}-row.json`);
		writeFileSync(file, JSON.stringify({ plugins: [{ name: folderName, installed: folderName, args: [] }] }));
		return file;
	};
	const cases: [string, object, RegExp][] = [
		["newer protocol", { name: "x", protocol: 2 }, /protocol/],
		["newer minor", { name: "x", protocol: 1, protocolMinor: 99 }, /protocol minor/],
		["newer daemon", { name: "x", protocol: 1, minPiStudio: "999.0.0" }, /pi-studio 999\.0\.0/],
		["wrong name", { name: "not-the-folder", protocol: 1 }, /not-the-folder/],
	];
	const base = { version: "1.0.0", visual: { entry: "panel.html", files: ["panel.html"] } };
	for (const [label, manifest, pattern] of cases) {
		const folderName = `bad-${label.replace(/\s+/g, "-")}`;
		write(folderName, { ...base, ...manifest });
		const { plugins, problems } = loadPluginRegistry(fileFor(folderName), undefined, root);
		assert.equal(plugins.length, 0, label);
		assert.match(problems[0].problem, pattern, label);
	}
	// A lazy plugin with no panel is refused: nothing would ever start it.
	const lazyFolder = "bad-lazy";
	write(lazyFolder, { name: lazyFolder, version: "1.0.0", protocol: 1, start: "lazy" });
	const { plugins, problems } = loadPluginRegistry(fileFor(lazyFolder), undefined, root);
	assert.equal(plugins.length, 0);
	assert.match(problems[0].problem, /lazily/, "lazy without a panel is refused");
});

test("folders in the plugins folder are offered to enable, and broken ones with the reason", () => {
	// Its own folder, so fixtures made above are not re-read: the scan only sees what this case put here.
	const found = join(root, "found");
	mkdirSync(found, { recursive: true });
	const leaf = (name: string, manifest: unknown) => {
		const path = join(found, name);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, name), "#!/bin/sh\nexit 0\n");
		chmodSync(join(path, name), 0o755);
		writeFileSync(join(path, "plugin.json"), JSON.stringify(manifest));
	};
	leaf("offered", {
		name: "offered",
		version: "3.0.0",
		protocol: 1,
		title: "offered one",
		description: "offered",
		shortcut: "y",
		visual: { entry: "panel.html", files: ["panel.html"], place: "drawer" },
	});
	leaf("broken", { name: "broken", protocol: 2 });
	leaf("middle", { name: "middle", version: "1.0.0", protocol: 1 });
	const { available, unavailable } = loadAvailablePlugins(["offered"], found, join(found, "absent"));
	assert.deepEqual(available.map((one) => one.name), ["middle"], "offered is registered already, so it is not offered twice");
	assert.equal(available[0].defaults.shortcut ?? "", "");
	assert.equal(unavailable.some((one) => one.folder === "broken" && /protocol/.test(one.problem)), true, "broken is shown with its reason");
});

test("a lazy plugin registers dormant, keeps its door, and starts on its first panel request", async () => {
	const path = join(state, "plugins", "lazyone");
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "lazyone"), readFileSync(join(example, "panel-plugin.mjs")));
	chmodSync(join(path, "lazyone"), 0o755);
	writeFileSync(join(path, "plugin.json"), JSON.stringify({
		name: "lazyone",
		version: "1.2.3",
		protocol: 1,
		title: "lazy one",
		start: "lazy",
		visual: { entry: "panel.html", files: ["panel.html", "panel.js", "panel.css"] },
	}));
	for (const file of ["panel.html", "panel.js", "panel.css"]) {
		writeFileSync(join(path, file), readFileSync(join(example, file)));
	}
	const daemon = await boot([{ name: "lazyone", installed: "lazyone", args: [] }]);
	const gone = new Promise<void>((resolve) => daemon.child.once("exit", () => resolve()));
	try {
		const listed = JSON.parse((await get(daemon, "/plugins/registry")).body) as {
			roster: { name: string; running: boolean; dormant?: boolean; version: string }[];
		};
		assert.deepEqual(listed.roster.map((one) => [one.name, one.running, one.dormant, one.version]), [["lazyone", false, true, "1.2.3"]], "registered from the manifest, not yet spawned");
		const panels = JSON.parse((await get(daemon, "/plugins/visual")).body) as { plugins: { name: string }[] };
		assert.deepEqual(panels.plugins.map((one) => one.name), ["lazyone"], "its door is offered while it sleeps");
		const opened = await post(daemon, "/workspace", { folder: root });
		assert.equal(opened.status, 200);
		const boardId = (JSON.parse(opened.body) as { workspace: { id: string } }).workspace.id;
		const first = await post(daemon, "/plugins/visual/request?plugin=lazyone", { workspace: boardId, method: "echo", params: { from: "lazy" } });
		assert.equal(first.status, 200, first.body);
		assert.deepEqual(JSON.parse(first.body), { result: { workspace: boardId, method: "echo", params: { from: "lazy" } } });
		const after = JSON.parse((await get(daemon, "/plugins/registry")).body) as {
			roster: { name: string; running: boolean; dormant?: boolean }[];
		};
		assert.deepEqual(after.roster.map((one) => [one.running, one.dormant ?? false]), [[true, false]], "the first request started it");
	} finally {
		daemon.child.kill("SIGTERM");
		await Promise.race([gone, new Promise((done) => setTimeout(done, 10_000))]);
	}
});

// ---------- the three routes, against a daemon ----------

/** One daemon on its own state folder, started the way a human starts it, with these plugins registered. */
async function boot(rows: unknown[]) {
	writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: rows }));
	const child = spawn(process.execPath, [join(repo, "server.ts"), "--no-open"], {
		cwd: repo,
		env: { ...process.env, PI_STUDIO_STATE: state, PI_STUDIO_PORT: "" },
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

type Daemon = { child: ChildProcess; noise: string[]; base: string; token: string };

/** One request, with what came back: the status, the two headers this file reads, and the body as text. */
async function get(daemon: Daemon, path: string, token = daemon.token) {
	const query = token ? `${path.includes("?") ? "&" : "?"}token=${token}` : "";
	const res = await fetch(`${daemon.base}${path}${query}`);
	return {
		status: res.status,
		type: res.headers.get("content-type") ?? "",
		csp: res.headers.get("content-security-policy") ?? "",
		body: await res.text(),
	};
}

async function post(daemon: Daemon, path: string, body: unknown, token = daemon.token) {
	const query = token ? `${path.includes("?") ? "&" : "?"}token=${token}` : "";
	const res = await fetch(`${daemon.base}${path}${query}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	return { status: res.status, body: await res.text() };
}

/**
 * The list of doors once the daemon's plugins are up. A plugin is started after the socket opens, so the
 * first listing can arrive before the roster does; this waits for the one the test reads.
 */
async function listedPanels(daemon: Daemon, ms = 10_000) {
	const until = Date.now() + ms;
	for (;;) {
		const listed = await get(daemon, "/plugins/visual");
		const count = listed.status === 200 ? ((JSON.parse(listed.body) as { plugins: unknown[] }).plugins ?? []).length : 0;
		if (count > 0 || Date.now() > until) return listed;
		await new Promise((done) => setTimeout(done, 50));
	}
}

test("the panels a daemon may show, its files, and the one call a panel makes", async () => {
	// A second plugin runs beside the example and declares no panel: it is a plugin a browser has no door to.
	const daemon = await boot([exampleRow, { name: "plain", command: exampleRow.command, args: [] }]);
	const gone = new Promise<void>((resolve) => daemon.child.once("exit", () => resolve()));
	try {
		const opened = await post(daemon, "/workspace", { folder: root });
		assert.equal(opened.status, 200);
		const workspace = (JSON.parse(opened.body) as { workspace: { id: string } }).workspace.id;

		// What the toolbox draws: one door, pointing at the entry the panel declared.
		const listed = await listedPanels(daemon);
		assert.equal(listed.status, 200);
		assert.deepEqual(JSON.parse(listed.body), {
			plugins: [{ name: "example-panel", title: "example panel", url: "/plugins/visual/example-panel/panel.html" }],
		});
		// Nobody at the keyboard gets the list, and a panel is one of the things a thread may not reach: the
		// roster names the doors and the one call a panel makes, and both are the human's alone.
		assert.equal((await get(daemon, "/plugins/visual", "")).status, 403);
		// The path is folded before it is routed, so the trailing slash reaches the same door and the same refusal.
		assert.equal((await get(daemon, "/plugins/visual/", "")).status, 403);
		const thread = { human: false, board: { id: workspace }, thread: {} };
		assert.equal(threadRefusal(thread, "GET", "/plugins/visual", workspace), "a thread may not use that");
		assert.equal(threadRefusal(thread, "POST", "/plugins/visual/request", workspace), "a thread may not use that");

		// The entry document, sandboxed by the daemon as well as by the frame that shows it. Every read here
		// carries no credential at all, because that is what the frame's own reads carry: the document has an
		// opaque origin, so `SameSite=Strict` keeps the session cookie out of the style and the script it asks
		// for, and a panel served only to a caller arrives as a page with no style and no script.
		const page = await get(daemon, "/plugins/visual/example-panel/panel.html", "");
		assert.equal(page.status, 200);
		assert.match(page.type, /text\/html/);
		assert.equal(page.csp, "sandbox allow-scripts");
		assert.match(page.body, /example panel/);
		// The script and the style the entry loads, from the same list of files.
		const script = await get(daemon, "/plugins/visual/example-panel/panel.js", "");
		assert.equal(script.status, 200);
		assert.match(script.type, /javascript/);
		const style = await get(daemon, "/plugins/visual/example-panel/panel.css", "");
		assert.equal(style.status, 200);
		assert.match(style.type, /text\/css/);
		// A token in the address changes nothing about these bytes: they are the same for a tab that has one.
		assert.equal((await get(daemon, "/plugins/visual/example-panel/panel.html")).status, 200);
		// Everything beside them is refused with no credential in hand: a file that exists and was never
		// declared, a path that leaves the folder however it is spelled, a plugin that declared no panel, a
		// plugin this daemon does not run, and a name or a file that is not spelled at all.
		for (const refused of [
			"/plugins/visual/example-panel/README.md",
			"/plugins/visual/example-panel/../panel-plugin.mjs",
			"/plugins/visual/example-panel/%2e%2e%2fpanel-plugin.mjs",
			"/plugins/visual/example-panel/panel.html%00.css",
			"/plugins/visual/plain/panel.html",
			"/plugins/visual/nobody/panel.html",
			"/plugins/visual/%zz/panel.html",
			"/plugins/visual/example-panel",
			"/plugins/visual/example-panel/",
		]) {
			assert.equal((await get(daemon, refused, "")).status, 404, refused);
		}

		// One call, answered by the plugin with the workspace the daemon resolved rather than one a page named.
		// The plugin echoes the envelope it was handed, so the whole of what reached it is visible here.
		const echoed = await post(daemon, "/plugins/visual/request?plugin=example-panel", { workspace, method: "echo", params: { from: "the test" } });
		assert.equal(echoed.status, 200);
		assert.deepEqual(JSON.parse(echoed.body), { result: { workspace, method: "echo", params: { from: "the test" } } });
		const clock = JSON.parse((await post(daemon, "/plugins/visual/request?plugin=example-panel", { workspace, method: "now" })).body) as {
			result: { workspace: string; at: number };
		};
		assert.equal(clock.result.workspace, workspace);
		assert.equal(typeof clock.result.at, "number");

		// A method the plugin does not answer is the plugin's own refusal, and travels as one.
		const refused = await post(daemon, "/plugins/visual/request?plugin=example-panel", { workspace, method: "zap" });
		assert.equal(refused.status, 200);
		assert.match((JSON.parse(refused.body) as { error: { message: string } }).error.message, /zap is not something this panel asks for/);

		// A workspace this daemon does not know, a plugin with no panel, and a caller with no token.
		assert.equal((await post(daemon, "/plugins/visual/request?plugin=example-panel", { workspace: "nope", method: "echo" })).status, 400);
		assert.equal((await post(daemon, "/plugins/visual/request?plugin=plain", { workspace, method: "echo" })).status, 404);
		assert.equal((await post(daemon, "/plugins/visual/request?plugin=example-panel", { workspace, method: "echo" }, "")).status, 403);
	} finally {
		daemon.child.kill("SIGTERM");
		await Promise.race([gone, new Promise((done) => setTimeout(done, 10_000))]);
	}
});

test("a panel that asks for the drawer is listed with its place", async () => {
	const row = { ...exampleRow, name: "example-drawer", visual: { ...exampleRow.visual, place: "drawer" } };
	const daemon = await boot([row]);
	const gone = new Promise<void>((resolve) => daemon.child.once("exit", () => resolve()));
	try {
		const listed = await listedPanels(daemon);
		assert.equal(listed.status, 200);
		assert.deepEqual(JSON.parse(listed.body), {
			plugins: [{ name: "example-drawer", title: "example panel", url: "/plugins/visual/example-drawer/panel.html", place: "drawer" }],
		});
	} finally {
		daemon.child.kill("SIGTERM");
		await Promise.race([gone, new Promise((done) => setTimeout(done, 10_000))]);
	}
});

// ---------- the reload route, against a daemon ----------

/** The roster once the daemon's plugins are up, waited for as panels are, because a daemon starts them after its socket opens. */
async function untilRoster(daemon: Daemon, count: number) {
	const until = Date.now() + 10_000;
	for (;;) {
		const { roster } = JSON.parse((await get(daemon, "/plugins/registry")).body) as { roster: unknown[] };
		if (roster.length >= count || Date.now() > until) return roster;
		await new Promise((done) => setTimeout(done, 50));
	}
}

test("a reload restarts every registered plugin from the file as it stands", async () => {
	const daemon = await boot([exampleRow]);
	const gone = new Promise<void>((resolve) => daemon.child.once("exit", () => resolve()));
	try {
		await untilRoster(daemon, 1);
		const reloaded = await post(daemon, "/plugins/reload", {});
		assert.equal(reloaded.status, 200);
		const body = JSON.parse(reloaded.body) as { roster: { name: string; running: boolean }[]; problems: unknown[] };
		assert.deepEqual(body.roster.map((one) => [one.name, one.running]), [["example-panel", true]]);
		assert.deepEqual(body.problems, []);

		// Emptying the file by hand and reloading closes the roster, with no daemon restart.
		writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: [] }));
		const emptied = await post(daemon, "/plugins/reload", {});
		assert.equal(emptied.status, 200);
		assert.deepEqual((JSON.parse(emptied.body) as { roster: unknown[] }).roster, []);

		// Bring the row back, then break the file: nothing in it can start, so the reload is refused
		// and the running roster stays as it is.
		writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: [exampleRow] }));
		await post(daemon, "/plugins/reload", {});
		await untilRoster(daemon, 1);
		writeFileSync(join(state, "plugins.json"), "not json");
		const refused = await post(daemon, "/plugins/reload", {});
		assert.equal(refused.status, 400);
		assert.equal((JSON.parse(refused.body) as { problems: unknown[] }).problems.length > 0, true);
		assert.deepEqual(
			(JSON.parse((await get(daemon, "/plugins/registry")).body) as { roster: { name: string }[] }).roster.map((one) => one.name),
			["example-panel"],
		);

		// The reload is the human's: no caller gets it.
		assert.equal((await post(daemon, "/plugins/reload", {}, "")).status, 403);
		const thread = { human: false, board: { id: "ws" }, thread: {} };
		assert.equal(threadRefusal(thread, "POST", "/plugins/reload", "ws"), "a thread may not use that");
	} finally {
		daemon.child.kill("SIGTERM");
		await Promise.race([gone, new Promise((done) => setTimeout(done, 10_000))]);
	}
});

test("the plugins reload command asks the running daemon to restart its roster", async () => {
	const daemon = await boot([exampleRow]);
	const gone = new Promise<void>((resolve) => daemon.child.once("exit", () => resolve()));
	const cli = (args: string[], stateDir: string) =>
		new Promise<{ code: number | null; out: string }>((resolve) => {
			const child = spawn(process.execPath, [join(repo, "bin/pi-studio"), ...args], { cwd: repo, env: { ...process.env, PI_STUDIO_STATE: stateDir }, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			child.stdout.on("data", (chunk) => (out += String(chunk)));
			child.stderr.on("data", (chunk) => (out += String(chunk)));
			child.on("exit", (code) => resolve({ code, out }));
		});
	try {
		await untilRoster(daemon, 1);
		const reloaded = await cli(["plugins", "reload"], state);
		assert.equal(reloaded.code, 0, reloaded.out);
		assert.match(reloaded.out, /example-panel — running/);
		// No daemon has run against a fresh state folder: the command says so and exits 1.
		const nowhere = mkdtempSync(join(tmpdir(), "pi-studio-plugin-reload-"));
		try {
			const missing = await cli(["plugins", "reload"], nowhere);
			assert.equal(missing.code, 1, missing.out);
			assert.match(missing.out, /no daemon has run/);
		} finally {
			await removeTree(nowhere);
		}
		// And a verb nobody knows is usage, exit 2.
		const usage = await cli(["plugins"], state);
		assert.equal(usage.code, 2, usage.out);
		assert.match(usage.out, /usage: pi-studio plugins reload/);
	} finally {
		daemon.child.kill("SIGTERM");
		await Promise.race([gone, new Promise((done) => setTimeout(done, 10_000))]);
	}
});
