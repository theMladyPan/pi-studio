import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The check guard: `npm run check` refuses early, naming the installing command, when this tree's own
 * dev dependency is missing — a fresh thread worktree has no node_modules, and without the guard the
 * gate sails through its own precheck and only fails 29 tests deep in the install suite.
 *
 * The guard must say whether this tree's own copy is installed, not whether any copy can be found: a
 * worktree lives inside the main checkout, so a resolution that walks up parent folders finds the main
 * checkout's node_modules and never fires. Running the guard itself in a folder with no node_modules and
 * in the repo root keeps a walk-up resolution red here.
 */

/** A folder the guard must refuse: the guard runs with its cwd there, the way npm runs it at the package root. */
const bare = mkdtempSync(join(tmpdir(), "pi-studio-bare-"));
after(() => rmSync(bare, { recursive: true, force: true }));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const precheck = pkg.scripts?.precheck ?? "";
const guard = /^node -e "([\s\S]*)"$/.exec(precheck)?.[1] ?? "";

/** The guard as `npm run check` runs it, with a chosen cwd standing in for the package root. */
function runGuard(cwd: string) {
	const { status, stderr } = spawnSync(process.execPath, ["-e", guard], { cwd, encoding: "utf8", timeout: 30_000 });
	return { status, stderr };
}

test("the check guard fails where this tree has no node_modules, naming npm ci", () => {
	assert.ok(guard, `the precheck keeps the node -e shape this test runs, got: ${precheck}`);
	const { status, stderr } = runGuard(bare);
	assert.equal(status, 1, stderr);
	assert.match(stderr, /npm ci/, "the refusal names the installing command");
});

test("the check guard passes where the dev dependency is installed", () => {
	assert.ok(guard, `the precheck keeps the node -e shape this test runs, got: ${precheck}`);
	const { status, stderr } = runGuard(root);
	assert.equal(status, 0, stderr);
	assert.equal(stderr, "", "a passing guard says nothing");
});
