/**
 * The staged JavaScript tree: compiled layout, runtime assets, and identity metadata.
 *
 * Builds into temporary directories only (never `dist/`, never the real state folder) and
 * imports staged modules without starting the daemon: no socket, no browser. A packaged
 * daemon boot stays a later chore with its own temp state fixture.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { test, after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(root, "bin", "build-release.mjs");
/** A build or a syntax check that never returns must fail the test, not hang it. */
const CHILD_TIMEOUT_MS = 120_000;

function buildInto() {
	const out = mkdtempSync(join(tmpdir(), "pi-studio-build-"));
	execFileSync(process.execPath, [helper, "--out", out], { cwd: root, stdio: "pipe", timeout: CHILD_TIMEOUT_MS });
	return out;
}

/** The same build without blocking the event loop, so the reproducibility test can build twice at once. */
function buildIntoAsync(): Promise<string> {
	const out = mkdtempSync(join(tmpdir(), "pi-studio-build-"));
	return new Promise((resolvePromise, reject) => {
		execFile(process.execPath, [helper, "--out", out], { cwd: root, timeout: CHILD_TIMEOUT_MS }, (error) => {
			if (error) reject(error);
			else resolvePromise(out);
		});
	});
}

/** One staged file parses, the way `node --check` on it alone would say. */
function checkParses(file: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		execFile(process.execPath, ["--check", file], { timeout: CHILD_TIMEOUT_MS }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${file} does not parse: ${stderr || stdout || error.message}`));
			else resolvePromise();
		});
	});
}

function filesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...filesUnder(full));
		else found.push(full);
	}
	return found;
}

/**
 * One build for the tests that only read the staged tree: they assert nothing about building, so a
 * second identical build would buy no coverage. The reproducibility test keeps two builds of its own,
 * because producing the same tree twice is exactly what it checks.
 */
let sharedStaged: string | null = null;

before(() => {
	sharedStaged = buildInto();
});

after(() => {
	if (sharedStaged) rmSync(sharedStaged, { recursive: true, force: true });
	sharedStaged = null;
});

function sharedBuild(): string {
	assert.ok(sharedStaged, "the shared staged build exists");
	return sharedStaged;
}

test("the staged tree carries the compiled app, runtime assets, and metadata — and nothing else", async () => {
	const out = sharedBuild();
	const sourcePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

	for (const file of [
		"server.js",
		"server/main.js",
		"server/paths.js",
		"server/child/modes.js",
		"server/child/roles.js",
		"server/flow-diagrams.js",
		"public/index.html",
		"public/client/board.js",
		"bridge/child-bridge.mjs",
		"prompts/modes/boss.md",
		"prompts/roles/scout.md",
		"prompts/flows/simple.md",
		"docs/boss-and-subagents.md",
		"docs/plugins.md",
		"bin/pi-studio",
		"bin/runtime.mjs",
		"bin/manage.mjs",
		"bin/plugin-add.mjs",
		"bin/plugins-reload.mjs",
		"bin/service.mjs",
		"bin/auth.mjs",
		"package.json",
		"build.json",
	]) {
		assert.ok(existsSync(join(out, file)), `staged tree is missing ${file}`);
	}

	// Same relative layout as the sources: every source module has a compiled twin.
	const sources = filesUnder(join(root, "server"))
		.filter((file) => file.endsWith(".ts"))
		.map((file) => relative(root, file).replace(/\.ts$/, ".js"));
	assert.ok(existsSync(join(out, "server.js")), "server.ts compiled to server.js");
	for (const file of sources) assert.ok(existsSync(join(out, file)), `no compiled twin for ${file}`);

	// No TypeScript, no tests/bench/mockups/site, no dependencies, no VCS or user data.
	const staged = filesUnder(out).map((file) => relative(out, file));
	for (const file of staged) {
		assert.ok(!file.endsWith(".ts"), `staged tree carries TypeScript: ${file}`);
		assert.ok(!/(^|\/)(node_modules|test|bench|mockups|site|\.git)(\/|$)/.test(file), `staged tree carries ${file}`);
	}

	// A plugin a package of its own ships is staged as what runs it and what draws it, never as the sources it
	// was built from. This repository carries none, so the loop below holds vacuously until one is added.
	for (const file of staged.filter((one) => one.startsWith("plugins/"))) {
		assert.ok(!/\.(go|mod|sum|rs|toml|lock)$/.test(file), `staged plugin carries a source file: ${file}`);
		assert.ok(!/(^|\/)dist(\/|$)/.test(file), `staged plugin carries the build folder: ${file}`);
	}

	// No `.ts` import specifiers survive compilation (other `.ts` string literals do, by design).
	const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'][^"']+\.ts["']/;
	const stagedJs = filesUnder(out).filter((one) => one.endsWith(".js"));
	for (const file of stagedJs) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			assert.ok(!specifier.test(line), `${relative(out, file)} still imports a .ts specifier: ${line.trim()}`);
		}
	}
	// Every staged file still parses on its own. One `node --check` per file, in small batches, so a
	// hundred process starts overlap instead of waiting one after another; the batches bound how many
	// node processes are alive at once on a loaded machine.
	for (let batch = 0; batch < stagedJs.length; batch += 8) {
		await Promise.all(stagedJs.slice(batch, batch + 8).map(checkParses));
	}

	// The staged launcher points at server.js; the source launcher still points at server.ts.
	const stagedLauncher = readFileSync(join(out, "bin", "pi-studio"), "utf8");
	assert.match(stagedLauncher, /server\.js/);
	assert.doesNotMatch(stagedLauncher, /server\.ts/);
	assert.ok(statSync(join(out, "bin", "pi-studio")).mode & 0o111, "staged launcher is executable");
	assert.match(readFileSync(join(root, "bin", "pi-studio"), "utf8"), /server\.ts/, "source launcher keeps the dev workflow");

	// Staged package.json: module type and version, zero dependencies of any kind.
	const stagedPkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
	assert.equal(stagedPkg.type, "module");
	assert.equal(stagedPkg.version, sourcePkg.version);
	assert.equal(stagedPkg.engines.node, sourcePkg.engines.node);
	assert.equal(stagedPkg.dependencies, undefined);
	assert.equal(stagedPkg.devDependencies, undefined);

	// Identity metadata: version/commit, and custom unless HEAD is exactly the clean v<version> tag.
	const identity = JSON.parse(readFileSync(join(out, "build.json"), "utf8"));
	assert.equal(identity.name, "pi-studio");
	assert.equal(identity.version, sourcePkg.version);
	assert.match(identity.commit, /^([0-9a-f]{40}|unknown)$/);
	assert.equal(identity.commitShort, identity.commit === "unknown" ? "unknown" : identity.commit.slice(0, 7));
	assert.equal(identity.source, "source-build");
	if (identity.official) {
		assert.equal(identity.custom, false);
		assert.equal(identity.dirty, false);
		assert.equal(identity.tag, `v${sourcePkg.version}`);
	} else {
		assert.equal(identity.custom, true, "a build that is not a clean official tag must read custom");
	}
});

/**
 * The Git Graph page, the modules it loads and the assets they reach for, all out of one build.
 *
 * A page that draws nothing after an install is the quietest packaging failure there is: every file is
 * valid on its own and the source tree serves them all, so only the archive shows the one path that was
 * never copied. This walks the staged page to the last module and the last font, and pins the retirement
 * of the pages that came before it, because a release that quietly carried one of those back would be a
 * second Git page nobody chose.
 */
test("the staged tree carries the Git Graph page, the modules it loads and the assets they reach for", () => {
	const out = sharedBuild();
	const staged = new Set(filesUnder(out).map((file) => relative(out, file).split(sep).join("/")));
	const page = readFileSync(join(out, "public", "gitgraph.html"), "utf8");

	for (const file of ["public/gitgraph.html", "public/client/gitgraph/host.js", "public/client/gitgraph/gitgraph.css"]) {
		assert.ok(staged.has(file), `staged tree is missing ${file}`);
	}

	// What the page itself names, resolved the way the daemon's static rules resolve a URL: the host module
	// is what draws the page, and the stylesheet is what gives it its lanes.
	const named = [...page.matchAll(/\b(?:src|href)="(\/[^"]+)"/g)].map(([, url]) => url);
	assert.ok(named.includes("/client/gitgraph/host.js"), `the page loads no host module: ${named.join(", ")}`);
	assert.ok(named.includes("/client/gitgraph/gitgraph.css"), `the page loads no stylesheet: ${named.join(", ")}`);
	for (const url of named) assert.ok(staged.has(`public${url}`), `the page asks for ${url}, which the archive does not carry`);

	// Every module the host reaches, to any depth, and every asset the stylesheet reaches for.
	const checked = new Set<string>();
	const queue = ["public/client/gitgraph/host.js"];
	while (queue.length) {
		const file = queue.pop() as string;
		if (checked.has(file)) continue;
		checked.add(file);
		for (const [, specifier] of readFileSync(join(out, file), "utf8").matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
			const resolved = specifier.startsWith("/") ? `public${specifier}` : posix.join(posix.dirname(file), specifier);
			assert.ok(staged.has(resolved), `${file} imports ${specifier}, which the archive does not carry as ${resolved}`);
			queue.push(resolved);
		}
	}
	assert.ok(checked.size > 1, `the host module was the only module read: ${[...checked].join(", ")}`);
	for (const [, url] of readFileSync(join(out, "public/client/gitgraph/gitgraph.css"), "utf8").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
		assert.ok(staged.has(`public${url}`), `the stylesheet reaches for ${url}, which the archive does not carry`);
	}

	// The borrowed extension's page and the failed `git-history` plugin are retired, so no part of either may
	// ride along: a release carries this app's own page and no second one beside it.
	for (const file of staged) {
		assert.ok(!/(^|\/)(web\.min\.js|base\.css)$/.test(file), `staged tree carries a retired Git Graph asset: ${file}`);
		assert.ok(!file.startsWith("public/client/gitgraph/vendor/"), `staged tree carries the retired vendor folder: ${file}`);
		assert.ok(!file.startsWith("plugins/git-history/"), `staged tree carries the retired git-history plugin: ${file}`);
	}
});

test("staged modules resolve the runtime layout from the staged root, with no .git in sight", async (t) => {
	const out = sharedBuild();
	const state = mkdtempSync(join(tmpdir(), "pi-studio-build-state-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	process.env.PI_STUDIO_STATE = state;

	const paths = (await import(pathToFileURL(join(out, "server", "paths.js")).href)) as {
		REPO_DIR: string;
		PUBLIC_DIR: string;
		BRIDGE: string;
		buildHash: () => string;
	};
	assert.equal(paths.REPO_DIR, out);
	assert.ok(existsSync(join(paths.PUBLIC_DIR, "index.html")), "PUBLIC_DIR resolves inside the staged tree");
	assert.ok(existsSync(paths.BRIDGE), "BRIDGE resolves inside the staged tree");
	assert.equal(paths.buildHash(), "unknown", "a staged tree has no .git, which is why build.json exists");

	const { flowDiagrams } = (await import(pathToFileURL(join(out, "server", "flow-diagrams.js")).href)) as {
		flowDiagrams: (root: string) => Promise<Array<{ path: string; svg: string }>>;
	};
	const flows = await flowDiagrams(out);
	assert.deepEqual(flows.map((one) => one.path), ["simple", "advanced", "complex"]);
	for (const one of flows) assert.ok(one.svg.startsWith("<svg"), `${one.path} drawing reads from staged docs/`);
});

test("the same source builds the same build.json twice", async (t) => {
	const [first, second] = await Promise.all([buildIntoAsync(), buildIntoAsync()]);
	t.after(() => rmSync(first, { recursive: true, force: true }));
	t.after(() => rmSync(second, { recursive: true, force: true }));
	assert.equal(
		readFileSync(join(first, "build.json"), "utf8"),
		readFileSync(join(second, "build.json"), "utf8"),
		"build.json carries no timestamp or absolute path",
	);
	assert.deepEqual(
		filesUnder(first).map((file) => relative(first, file)),
		filesUnder(second).map((file) => relative(second, file)),
	);
});
