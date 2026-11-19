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
 * No Node binary, node_modules, tests, or user data are staged. Git Graph stays external.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	cpSync(join(root, "docs", "boss-and-subagents.md"), join(out, "docs", "boss-and-subagents.md"));

	// Staged launcher only; the source bin/pi-studio keeps pointing at server.ts for dev.
	// The launcher imports its lifecycle helpers by relative path, so the staged tree must
	// carry them too; the source-only install entry (bin/install.mjs) stays out. The doctor the
	// launcher reaches for is compiled like the rest of the app, so its specifier is the second
	// rewrite: both name a module the staged tree holds as JavaScript.
	const launcher = readFileSync(join(root, "bin", "pi-studio"), "utf8")
		.replaceAll("server.ts", "server.js")
		.replaceAll("server/doctor.ts", "server/doctor.js");
	mkdirSync(join(out, "bin"), { recursive: true });
	writeFileSync(join(out, "bin", "pi-studio"), launcher);
	chmodSync(join(out, "bin", "pi-studio"), 0o755);
	for (const helper of ["runtime.mjs", "manage.mjs"]) {
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
