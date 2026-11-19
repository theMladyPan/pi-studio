/**
 * The staged JavaScript tree: compiled layout, runtime assets, and identity metadata.
 *
 * Builds into temporary directories only (never `dist/`, never the real state folder) and
 * imports staged modules without starting the daemon: no socket, no browser. A packaged
 * daemon boot stays a later chore with its own temp state fixture.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

function filesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...filesUnder(full));
		else found.push(full);
	}
	return found;
}

function stagedBuild(t: { after: (fn: () => void) => void }) {
	const out = buildInto();
	t.after(() => rmSync(out, { recursive: true, force: true }));
	return out;
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

test("the staged tree carries the compiled app, runtime assets, and metadata — and nothing else", () => {
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
		"plugins/git-history/plugin.json",
		"plugins/git-history/README.md",
		"plugins/git-history/assets/history.html",
		"bin/pi-studio",
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

	// A plugin is staged as what runs it and what draws it, never as the sources it was built from.
	for (const file of staged.filter((one) => one.startsWith("plugins/"))) {
		assert.ok(!/\.(go|mod|sum|rs|toml|lock)$/.test(file), `staged plugin carries a source file: ${file}`);
		assert.ok(!/(^|\/)dist(\/|$)/.test(file), `staged plugin carries the build folder: ${file}`);
	}

	// No `.ts` import specifiers survive compilation (other `.ts` string literals do, by design).
	const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'][^"']+\.ts["']/;
	for (const file of filesUnder(out).filter((one) => one.endsWith(".js"))) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			assert.ok(!specifier.test(line), `${relative(out, file)} still imports a .ts specifier: ${line.trim()}`);
		}
		execFileSync(process.execPath, ["--check", file], { timeout: CHILD_TIMEOUT_MS });
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

test("the same source builds the same build.json twice", (t) => {
	const first = stagedBuild(t);
	const second = stagedBuild(t);
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
