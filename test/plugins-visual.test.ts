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
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

const { loadPluginRegistry } = await import("../server/plugins/registry.ts");
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
