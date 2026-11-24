#!/usr/bin/env node
/**
 * Build and stage the ready-to-run JavaScript tree.
 *
 *   node bin/build-release.mjs [--out <dir>]   # default: dist/ at the repository root
 *
 * The compiler is the locked TypeScript dev dependency; the staged tree carries no dev
 * dependencies and runs on the declared Node (>=22.18) with native TypeScript support off.
 * `tsconfig.build.json` compiles `server.ts`/`server/**` to the same relative `.js` layout
 * (so `server/paths.ts`'s REPO_DIR/PUBLIC_DIR/BRIDGE still resolve) and rewrites `.ts`
 * import specifiers to `.js` via TypeScript's `rewriteRelativeImportExtensions`.
 *
 * The release build keeps the compiler's full check: `--noCheck` saves about 340 ms of a
 * 1.6 s build, and a release that was never type-checked is not worth that. A second
 * transpiler or a build cache would be a second way to produce the tree, so neither is used.
 *
 * Staged layout (the installer/CLI contract; keep this shape when extending):
 *
 *   server.js, server/<dirs>/*.js  compiled app, same relative paths as the sources
 *   public/, bridge/, prompts/  copied verbatim (browser assets, child extension, prompts)
 *   docs/boss-and-subagents.md  the one runtime document, at the path flow-diagrams reads
 *   docs/plugins.md             how an installed copy is given a plugin, which is one registration
 *   plugins/<name>/             a plugin this install ships: plugin.json, its panel and its README, plus
 *                                 every executable `npm run build:plugins` built for a platform
 *   bin/pi-studio               staged copy of the launcher, pointed at server.js
 *   bin/runtime.mjs, bin/manage.mjs  lifecycle helpers the launcher imports (no server code)
 *   package.json                name/version/type/bin/engines only; no dependencies at all
 *   build.json                  { name, version, commit, commitShort, tag, official, custom,
 *                                 dirty, source }
 *
 * `build.json` is what a later `--version` or installer reads instead of `buildHash()`: a
 * staged tree has no `.git`, so `buildHash()` answers "unknown" there. `official` is true
 * only when HEAD is exactly the clean `v<version>` tag; anything else is `custom`, never a
 * silent official release. No timestamp is recorded, so the same source produces the same
 * `build.json` bytes.
 *
 * No Node binary, node_modules, tests, or user data are staged. The Git Graph page and its client ride in
 * `public/` with everything else, so no editor extension is needed for it.
 *
 * A plugin a package of its own adds under `plugins/` is staged as what runs it and what draws it: the
 * manifest, the panel and the built executables, never its Go or Rust sources. That makes the plugin build a
 * step before this one (`npm run build:plugins`) for a package that ships one; without it the folder is
 * staged with no executable for the platform, and this says so rather than shipping a plugin that cannot
 * start. This repository carries no plugin of its own, so the loop finds nothing here.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function outDir() {
	const args = process.argv.slice(2);
	const flag = args.indexOf("--out");
	const value = flag >= 0 ? args[flag + 1] : args.find((arg) => !arg.startsWith("--"));
	if (flag >= 0 && !value) throw new Error("build-release: --out needs a directory");
	return resolve(value || join(root, "dist"));
}

function git(args) {
	try {
		return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

function buildIdentity(version) {
	const commit = git(["rev-parse", "HEAD"]) || "unknown";
	const tags = (git(["tag", "--points-at", "HEAD"]) || "").split("\n").filter(Boolean);
	const tag = tags.includes(`v${version}`) ? `v${version}` : null;
	const status = git(["status", "--porcelain"]);
	const dirty = status !== null && status.length > 0;
	const official = commit !== "unknown" && tag !== null && !dirty;
	return {
		name: "pi-studio",
		version,
		commit,
		commitShort: commit === "unknown" ? "unknown" : commit.slice(0, 7),
		tag,
		official,
		custom: !official,
		dirty,
		source: "source-build",
	};
}

/**
 * The plugins this install ships, staged so a registration can name one: each plugin's manifest and its panel's
 * files, plus every executable built for a platform. The sources they were built from are left behind, and so
 * is a binary built in the plugin's own folder for the machine that built the release.
 *
 * A release has to carry the executables, and it is `npm run build:plugins` that builds them: a staging run
 * without them stages the plugin's files and says which plugin has no executable yet.
 */
function stagePlugins(out) {
	const base = join(root, "plugins");
	if (!existsSync(base)) return;
	for (const entry of readdirSync(base, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const from = join(base, entry.name);
		if (!existsSync(join(from, "plugin.json"))) continue;
		const to = join(out, "plugins", entry.name);
		mkdirSync(to, { recursive: true });
		cpSync(join(from, "plugin.json"), join(to, "plugin.json"));
		if (existsSync(join(from, "README.md"))) cpSync(join(from, "README.md"), join(to, "README.md"));
		if (existsSync(join(from, "assets"))) cpSync(join(from, "assets"), join(to, "assets"), { recursive: true });
		const dist = join(from, "dist");
		const built = existsSync(dist) ? readdirSync(dist).sort() : [];
		for (const file of built) {
			cpSync(join(dist, file), join(to, file));
			chmodSync(join(to, file), 0o755);
		}
		if (built.length === 0) console.log(`pi-studio: staged plugin ${entry.name} with no executable; run \`npm run build:plugins\` before packaging a release`);
	}
}

function main() {
	const out = outDir();
	if (out === root || out === "/") throw new Error(`build-release: refusing to build into ${out}`);
	const sourcePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

	const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
	if (!existsSync(tsc)) throw new Error("build-release: typescript is not installed; run `npm ci` first");

	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json"), "--outDir", out], {
		cwd: root,
		stdio: "inherit",
	});

	// Runtime assets verbatim: the relative layout is load-bearing (see server/paths.ts).
	for (const dir of ["public", "bridge", "prompts"]) cpSync(join(root, dir), join(out, dir), { recursive: true });
	mkdirSync(join(out, "docs"), { recursive: true });
	for (const doc of ["boss-and-subagents.md", "plugins.md"]) cpSync(join(root, "docs", doc), join(out, "docs", doc));
	stagePlugins(out);

	// Staged launcher only; the source bin/pi-studio keeps pointing at server.ts for dev.
	// The launcher imports its lifecycle helpers by relative path, so the staged tree must
	// carry them too; the source-only install entry (bin/install.mjs) stays out. The doctor the
	// launcher reaches for is compiled like the rest of the app, so its specifier is the second
	// rewrite: both name a module the staged tree holds as JavaScript. The list itself is read
	// off the launcher, so the next helper cannot be forgotten the way two already were.
	const launcher = readFileSync(join(root, "bin", "pi-studio"), "utf8")
		.replaceAll("server.ts", "server.js")
		.replaceAll("server/doctor.ts", "server/doctor.js");
	mkdirSync(join(out, "bin"), { recursive: true });
	writeFileSync(join(out, "bin", "pi-studio"), launcher);
	chmodSync(join(out, "bin", "pi-studio"), 0o755);
	const helpers = new Set();
	const queue = [...launcher.matchAll(/\.\/([a-z0-9._-]+\.mjs)/g)].map((found) => found[1]);
	while (queue.length) {
		// Each helper's own imports ride along, so a helper imported only by another helper cannot
		// be left behind either; a name the launcher mentions but the tree does not hold fails loudly.
		const helper = queue.shift();
		if (helpers.has(helper)) continue;
		helpers.add(helper);
		const text = readFileSync(join(root, "bin", helper), "utf8");
		queue.push(...[...text.matchAll(/\.\/([a-z0-9._-]+\.mjs)/g)].map((found) => found[1]));
	}
	for (const helper of helpers) {
		cpSync(join(root, "bin", helper), join(out, "bin", helper));
		chmodSync(join(out, "bin", helper), 0o755);
	}

	const stagedPkg = {
		name: sourcePkg.name,
		version: sourcePkg.version,
		description: sourcePkg.description,
		private: true,
		type: "module",
		bin: sourcePkg.bin,
		engines: sourcePkg.engines,
	};
	writeFileSync(join(out, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);

	const identity = buildIdentity(sourcePkg.version);
	writeFileSync(join(out, "build.json"), `${JSON.stringify(identity, null, 2)}\n`);
	console.log(
		`pi-studio: staged ${identity.version} at ${out} (commit ${identity.commitShort}, ${identity.official ? "official" : "custom"}${identity.dirty ? ", dirty" : ""})`,
	);
}

main();
