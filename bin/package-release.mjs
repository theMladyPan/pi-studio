#!/usr/bin/env node
/**
 * Pack a release: the staged app as one tarball, its checksum, and the installer that names it.
 *
 *   node bin/package-release.mjs [--out <dir>]   # default: release/ at the repository root
 *
 * Writes, for the version in package.json:
 *
 *   release/pi-studio-<version>.tar.gz          the staged tree under one top-level folder
 *   release/pi-studio-<version>.tar.gz.sha256   "<hex>  pi-studio-<version>.tar.gz"
 *   release/install.sh                          install.sh with its version token filled in
 *
 * Those names are the ones the update path in bin/manage.mjs already expects. The payload is the
 * tree `npm run build` stages (bin/build-release.mjs is called, never reproduced here): the
 * compiled app, its relative assets, prompts and docs, an executable launcher, package.json and
 * build.json. No Node binary, no node_modules, no tests, no user data.
 *
 * The published installer pins this exact version: it downloads that release's assets from the
 * release base, and each download is checksum-verified by the manager's own rules. Only a build
 * from the clean `v<version>` tag reads official in build.json; packaging anything else still
 * writes the files and says so, because the release workflow is the place that has to be right.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./runtime.mjs";
import { validateTree } from "./manage.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = join(root, "install.sh");
const VERSION_TOKEN = "@@PI_STUDIO_VERSION@@";
/** A build, an archive or a checksum that never returns must fail, not hang the release. */
const CHILD_TIMEOUT_MS = 120_000;
const RELEASE_ARTIFACT = /^(?:pi-studio-.*\.tar\.gz(?:\.sha256)?|install\.sh)$/;

function fail(message) {
	throw new Error(`pi-studio: ${message}`);
}

function outDir() {
	const args = process.argv.slice(2);
	const flag = args.indexOf("--out");
	const value = flag >= 0 ? args[flag + 1] : args.find((arg) => !arg.startsWith("--"));
	if (flag >= 0 && !value) fail("--out needs a directory");
	return resolve(value || join(root, "release"));
}

function filesUnder(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...filesUnder(full));
		else found.push(full);
	}
	return found;
}

/**
 * The staged tree is the payload, so it is held to the same rules the installer applies, plus the
 * two things a release must never ship: a Node binary or a dependency tree.
 */
function assertPayload(staged) {
	const identity = validateTree(staged);
	if (!existsSync(join(staged, "docs", "boss-and-subagents.md"))) fail("staged tree is missing docs/boss-and-subagents.md");
	for (const file of filesUnder(staged)) {
		const path = relative(staged, file);
		if (/(^|\/)node_modules(\/|$)/.test(path)) fail(`staged tree carries node_modules: ${path}`);
		if (/(^|\/)(node|node\.exe)$/.test(path)) fail(`staged tree carries a Node binary: ${path}`);
	}
	if (!(statSync(join(staged, "bin", "pi-studio")).mode & 0o111)) fail("staged launcher is not executable");
	return identity;
}

/** The published installer keeps the template's behaviour and carries this release's version. */
function writeInstaller(out, version) {
	const template = readFileSync(TEMPLATE, "utf8");
	const expanded = template.replaceAll(VERSION_TOKEN, version);
	if (expanded.includes(VERSION_TOKEN)) fail(`${TEMPLATE} still holds ${VERSION_TOKEN}`);
	const path = join(out, "install.sh");
	writeFileSync(path, expanded);
	chmodSync(path, 0o755);
	return path;
}

function clearOldArtifacts(out) {
	for (const entry of readdirSync(out)) {
		if (RELEASE_ARTIFACT.test(entry)) rmSync(join(out, entry), { force: true });
	}
}

function packageRelease(out, pkg) {
	const version = String(pkg.version || "");
	if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version is not a release version: ${version}`);
	if (!existsSync(TEMPLATE)) fail(`missing installer template: ${TEMPLATE}`);

	const staging = mkdtempSync(join(tmpdir(), "pi-studio-package-"));
	try {
		// The build helper owns the staged layout; the folder name here becomes the archive's one
		// top-level entry, which both the installer and the manager's extractor strip.
		const folder = `pi-studio-${version}`;
		const staged = join(staging, folder);
		execFileSync(process.execPath, [join(root, "bin", "build-release.mjs"), "--out", staged], {
			cwd: root,
			stdio: "inherit",
			timeout: CHILD_TIMEOUT_MS,
		});
		const identity = assertPayload(staged);

		mkdirSync(out, { recursive: true, mode: 0o755 });
		clearOldArtifacts(out);
		const archiveName = `${folder}.tar.gz`;
		const archivePath = join(out, archiveName);
		execFileSync("tar", ["-czf", archivePath, "-C", staging, folder], { cwd: root, stdio: "pipe", timeout: CHILD_TIMEOUT_MS });
		const checksum = sha256Hex(readFileSync(archivePath));
		const checksumPath = join(out, `${archiveName}.sha256`);
		writeFileSync(checksumPath, `${checksum}  ${archiveName}\n`);
		const installerPath = writeInstaller(out, version);
		return { version, identity, archivePath, checksumPath, checksum, installerPath };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

function main() {
	const out = outDir();
	if (out === root || out === "/") fail(`refusing to package into ${out}`);
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const packed = packageRelease(out, pkg);
	if (!packed.identity.official) {
		console.error(
			`pi-studio: warning: this build reads custom (tag ${packed.identity.tag ?? "none"}, commit ${packed.identity.commitShort}); a release asset has to be built from the clean v${packed.version} tag`,
		);
	}
	console.log(`pi-studio: packaged ${packed.version} (commit ${packed.identity.commitShort}, ${packed.identity.official ? "official" : "custom"})`);
	console.log(`pi-studio: archive ${packed.archivePath}`);
	console.log(`pi-studio: checksum ${packed.checksumPath}`);
	console.log(`pi-studio: installer ${packed.installerPath}`);
}

try {
	main();
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
