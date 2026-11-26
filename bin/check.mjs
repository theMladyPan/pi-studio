#!/usr/bin/env node
/**
 * The check gate, run in parallel.
 *
 * What it proves is unchanged from the old `&&` chain in package.json: every shipped JavaScript
 * file parses, the import graph resolves and every client module is served, the TypeScript tree
 * type-checks, the whole test suite passes, and two daemons boot beside each other. The only
 * change is order: the five stages overlap instead of waiting on each other. A clean run used to
 * add up to about 42 seconds (1.8 syntax + 0.2 imports + 3.5 types + 32 tests + 4.4 smoke);
 * it now takes the longest stage, the tests, at about 27 seconds.
 *
 * Overlap is safe because no stage writes where another stage reads. The syntax checks, the
 * import check and `tsc` are read-only (`tsconfig.node.json` has `noEmit`). The tests and the
 * smoke run write only to throwaway folders under the system temp directory and boot daemons on
 * ephemeral ports, so two stages cannot take each other's port or state. A stage that fails
 * still fails the gate: every stage runs to the end, the summary names the ones that failed,
 * and the exit code is 1 if any of them did. Waiting for the tests after a syntax error is the
 * price of that; killing them mid-run could leave the daemons they started behind.
 *
 * Output is streamed with a `[stage]` prefix on every line, so a line during the run says which
 * stage wrote it. Each stage's own lines are otherwise untouched.
 *
 *   node bin/check.mjs    # the gate; exit 1 if any stage failed
 *
 * The test stage is hashed, see bin/test-cache.mjs. A whole-suite entry
 * skips the suite when nothing changed; per-file entries rerun only the test
 * files whose imports changed. `PI_STUDIO_NO_CACHE=1` forces a full run.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDir, cacheEnabled, listTestFiles, perFileKey, readCache, wholeKey, writeCache } from "./test-cache.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;

/** Every shipped JavaScript file, plus the entry the test suite type-checks. tsc never sees these. */
const syntaxFiles = [
	"server.ts",
	"public/client/board.js",
	"public/client/drawer-common.js",
	"public/client/git-drawer.js",
	"public/client/kontainer-drawer.js",
	"public/client/terminal-drawer.js",
	"public/client/text-preview.js",
	"public/client/diff-table.js",
	"public/client/chart-umd-min.js",
	"public/client/gitgraph/host.js",
	"bin/smoke.mjs",
	"bin/check.mjs",
	"bin/check-imports.mjs",
	"bin/test-cache.mjs",
	"bin/pi-studio",
	"bin/runtime.mjs",
	"bin/manage.mjs",
	"bin/install.mjs",
	"bin/build-release.mjs",
	"bin/build-plugins.mjs",
	"bin/package-release.mjs",
	"bin/auth.mjs",
	"bin/release-notes.mjs",
	"bin/service.mjs",
];

/**
 * Run one command, prefixing every output line with `[label]`, and answer with its exit code.
 * A command that cannot be started (a missing `sh`, a missing `tsc`) counts as a failure with
 * its reason, not as a thrown error that ends the other stages.
 */
function run(label, command, args) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
		let pending = "";
		const write = (chunk, out) => {
			const lines = (pending + String(chunk)).split("\n");
			pending = lines.pop();
			for (const line of lines) out.write(line ? `[${label}] ${line}\n` : "\n");
		};
		child.stdout.on("data", (chunk) => write(chunk, process.stdout));
		child.stderr.on("data", (chunk) => write(chunk, process.stdout));
		child.on("error", (error) => {
			process.stdout.write(`[${label}] could not start ${command}: ${error.message}\n`);
			resolve(1);
		});
		child.on("close", (code) => {
			if (pending) process.stdout.write(`[${label}] ${pending}\n`);
			resolve(code ?? 1);
		});
	});
}

/** The syntax stage: the same sequential `node --check` list the chain ran, plus `sh -n install.sh`. */
async function syntax() {
	for (const file of syntaxFiles) {
		if ((await run("syntax", node, ["--check", join(repo, file)])) !== 0) return false;
	}
	if ((await run("syntax", "sh", ["-n", join(repo, "install.sh")])) !== 0) return false;
	return true;
}

const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
/** The local typescript, or the `tsc` on PATH as the old chain used, so a tree without its own install still type-checks the way it did. */
const typesCommand = existsSync(tsc) ? [node, tsc] : ["tsc"];

/**
 * The test stage, cached. Each test file runs as its own `node --test`
 * process, the same way a single `node --test` discovers them, but only when
 * its per-file key misses. The pool matches the runner's own parallelism, so
 * a cold run is near the uncached time. Every file runs even when another
 * fails, so the summary names all of them.
 */
async function testStage() {
	if (!cacheEnabled()) return (await run("test", node, ["--test", "--test-timeout=90000"])) === 0;
	const dir = cacheDir(repo);
	const wkey = wholeKey(repo);
	const whole = readCache(dir, wkey);
	if (whole !== null) {
		process.stdout.write(`[test] whole cache hit ${wkey.slice(0, 12)} — suite skipped\n`);
		return whole.exitCode === 0;
	}
	const entries = listTestFiles(repo).map((file) => ({ file, key: perFileKey(repo, file) }));
	const pending = entries.filter((entry) => entry.key === null || readCache(dir, entry.key) === null);
	if (entries.length > pending.length) process.stdout.write(`[test] ${entries.length - pending.length}/${entries.length} files cached\n`);
	let ok = true;
	let next = 0;
	async function worker() {
		while (next < pending.length) {
			const entry = pending[next++];
			const code = await run("test", node, ["--test", "--test-timeout=90000", join(repo, entry.file)]);
			if (entry.key !== null) writeCache(dir, entry.key, code);
			if (code !== 0) ok = false;
		}
	}
	await Promise.all(Array.from({ length: Math.min(availableParallelism(), pending.length) }, worker));
	writeCache(dir, wkey, ok ? 0 : 1);
	return ok;
}

const stages = [
	{
		name: "syntax",
		work: syntax,
	},
	{
		name: "imports",
		work: () => run("imports", node, [join(repo, "bin/check-imports.mjs")]).then((code) => code === 0),
	},
	{
		name: "types",
		work: () => run("types", typesCommand[0], [...typesCommand.slice(1), "-p", join(repo, "tsconfig.node.json")]).then((code) => code === 0),
	},
	{
		name: "test",
		work: testStage,
	},
	{
		name: "smoke",
		work: () => run("smoke", node, [join(repo, "bin/smoke.mjs")]).then((code) => code === 0),
	},
];

const results = await Promise.all(
	stages.map(async (stage) => {
		const started = Date.now();
		const ok = await stage.work();
		return { name: stage.name, ok, seconds: (Date.now() - started) / 1000 };
	}),
);

console.log("");
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name} ${result.seconds.toFixed(1)}s`);
const failed = results.filter((result) => !result.ok).map((result) => result.name);
if (failed.length > 0) {
	console.log(`check failed: ${failed.join(", ")}`);
	process.exitCode = 1;
} else {
	console.log("all checks passed");
}
