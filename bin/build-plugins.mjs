#!/usr/bin/env node
/**
 * Cross-build the Go plugin executables a package of pi-studio ships, so installing one needs no Go on the
 * machine.
 *
 *   node bin/build-plugins.mjs [--out <dir>] [--go <path>]
 *
 * This repository carries no plugin of its own, so a plain checkout has nothing here to build: the tool is
 * how a package that adds one under `plugins/` turns its Go source into the files an install runs. Every
 * folder under `plugins/` that holds a `go.mod` is built once per platform below and written to
 * `<out>/<plugin>/<plugin>-<platform>`, `--out` defaulting to `plugins/<plugin>/dist`. `bin/package-release.mjs`
 * copies those files into the staged tree beside the plugin's `plugin.json` and its panel, where the daemon
 * looks for `<plugin>-<platform>` when a registration names the plugin instead of a path.
 *
 * Only Linux and macOS on x86_64 and arm64 are built: they are the machines this daemon is installed on, and
 * a cross-compiled Go program with no cgo needs nothing from the machine that built it. The platform half of
 * each file name is Node's own `process.platform` and `process.arch`, so the daemon picks a file without a
 * table of its own. Building them is a release step, not an install step: a checkout runs the plugin it built
 * in place, and an installed release runs the file that was built for it.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** The platforms a release carries, in Go's words and in the words the daemon looks a file up by. */
export const TARGETS = [
	{ goos: "linux", goarch: "amd64", platform: "linux-x64" },
	{ goos: "linux", goarch: "arm64", platform: "linux-arm64" },
	{ goos: "darwin", goarch: "amd64", platform: "darwin-x64" },
	{ goos: "darwin", goarch: "arm64", platform: "darwin-arm64" },
];

/** A build that never returns must fail, not hang the run. */
const CHILD_TIMEOUT_MS = 300_000;

function fail(message) {
	throw new Error(`pi-studio: ${message}`);
}

function arg(flag) {
	const args = process.argv.slice(2);
	const at = args.indexOf(flag);
	return at >= 0 ? args[at + 1] : undefined;
}

/** The plugin folders that are Go programs, which are the ones this can build. */
function goPlugins() {
	const base = join(root, "plugins");
	if (!existsSync(base)) return [];
	const found = [];
	for (const entry of readdirSync(base, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const folder = join(base, entry.name);
		if (existsSync(join(folder, "go.mod"))) found.push({ name: entry.name, folder });
	}
	return found;
}

function build(plugin, go, out) {
	for (const target of TARGETS) {
		const file = join(out, `${plugin.name}-${target.platform}`);
		execFileSync(go, ["build", "-trimpath", "-o", file, "."], {
			cwd: plugin.folder,
			stdio: ["ignore", "ignore", "pipe"],
			timeout: CHILD_TIMEOUT_MS,
			// cgo would need a cross toolchain per target; these plugins use the standard library only.
			env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: "0" },
		});
		chmodSync(file, 0o755);
		console.log(`pi-studio: built ${plugin.name}-${target.platform} (${Math.round(statSync(file).size / 1024)} KiB)`);
	}
}

function main() {
	const go = arg("--go") ?? "go";
	try {
		execFileSync(go, ["version"], { stdio: "ignore", timeout: 30_000 });
	} catch {
		fail(`\`${go}\` was not found; install Go 1.22 or newer to build the plugins a release ships`);
	}
	const plugins = goPlugins();
	if (plugins.length === 0) fail(`no plugin under ${join(root, "plugins")} holds a go.mod to build`);
	for (const plugin of plugins) {
		const out = resolve(arg("--out") ?? join(plugin.folder, "dist"));
		if (out === root || out === "/") fail(`refusing to build into ${out}`);
		mkdirSync(out, { recursive: true });
		build(plugin, go, out);
	}
}

try {
	main();
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
