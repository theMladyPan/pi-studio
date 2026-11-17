// Managed per-user installation: install from a staged tree, update from GitHub Releases, uninstall.
// Node stays external; the source clone is never written; app state under the state folder is
// never written or removed here (update only adds a prompt report through the prompt helper).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	APP_NAME, GITHUB_REPO, assertPlainDir, assertSafeUrl, assertSupportedNode, binDirOf, buildIdentity,
	compareVersions, ensurePlainDir, fail, formatVersion, githubApiRoot, installRootDir, isLoopbackHost,
	lstatOrNull, markerPath, parseVersion, readInstallMetadata, runningState, clearStaleMarker, sha256Hex, stateDirOf, writeJsonAtomic,
} from "./runtime.mjs";

const REQUIRED_FILES = ["server.js", "public/index.html", "bridge/child-bridge.mjs", "bin/pi-studio", "package.json", "build.json"];
const REQUIRED_DIRS = ["public", "bridge", "prompts"];
export const ASSET_TARBALL = (version) => `pi-studio-${version}.tar.gz`;
export const ASSET_CHECKSUM = (version) => `pi-studio-${version}.tar.gz.sha256`;

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		fail(`invalid JSON: ${path}`);
	}
}

/** Validate a staged/extracted tree. Returns its build identity. */
export function validateTree(dir) {
	const rootDir = resolve(dir);
	assertPlainDir(rootDir, "installation source");
	if (!existsSync(rootDir)) fail(`installation source does not exist: ${rootDir}`);
	const identity = buildIdentity(rootDir);
	if (!parseVersion(identity.version)) fail(`invalid package version in ${rootDir}: ${identity.version}`);
	assertSupportedNode(identity.engines?.node);
	const pkg = readJson(join(rootDir, "package.json"));
	if (pkg.name !== APP_NAME || pkg.version !== identity.version) fail("package.json name/version does not match build identity");
	for (const file of REQUIRED_FILES) {
		const held = lstatOrNull(join(rootDir, file));
		if (!held || held.isSymbolicLink() || !held.isFile()) fail(`staged tree is missing required file: ${file}`);
	}
	for (const folder of REQUIRED_DIRS) {
		const held = lstatOrNull(join(rootDir, folder));
		if (!held || held.isSymbolicLink() || !held.isDirectory()) fail(`staged tree is missing required folder: ${folder}`);
	}
	if (!existsSync(join(rootDir, "prompts"))) fail("staged tree is missing prompts/");
	return identity;
}

/** Copy a tree rejecting symlinks and special files, so a planted link is never followed. */
function copyTreeNoLinks(source, destination) {
	assertPlainDir(destination, "copy destination");
	mkdirSync(destination, { recursive: true });
	const walk = (from, to) => {
		for (const entry of readdirSync(from, { withFileTypes: true })) {
			const src = join(from, entry.name);
			const dst = join(to, entry.name);
			const held = lstatSync(src);
			if (held.isSymbolicLink()) fail(`refusing to copy symlink: ${src}`);
			if (held.isDirectory()) {
				assertPlainDir(dst, "copy destination");
				mkdirSync(dst, { mode: 0o755 });
				walk(src, dst);
			} else if (held.isFile()) {
				const heldDst = lstatOrNull(dst);
				if (heldDst && heldDst.isSymbolicLink()) fail(`refusing to write through a symlink: ${dst}`);
				writeFileSync(dst, readFileSync(src));
				try {
					if (held.mode & 0o111) chmodSync(dst, 0o755);
				} catch {
					// Mode is not load-bearing except for the launcher, fixed below.
				}
			} else {
				fail(`refusing to copy special file: ${src}`);
			}
		}
	};
	walk(source, destination);
	const launcher = join(destination, "bin", "pi-studio");
	if (existsSync(launcher)) chmodSync(launcher, 0o755);
}

function versionDirName(identity, buildBytes) {
	if (identity.official) return identity.version;
	const digest = createHash("sha256").update(buildBytes).digest("hex").slice(0, 8);
	return `${identity.version}-custom-${identity.commitShort}-${digest}`;
}

function launcherCheck(installRoot, binDir) {
	const launcher = join(binDir, APP_NAME);
	const held = lstatOrNull(launcher);
	if (!held) return { launcher, held: null, ours: false };
	if (held.isSymbolicLink()) {
		const target = resolve(binDir, readlinkSync(launcher));
		const inside = target === join(installRoot, "current", "bin", APP_NAME) || target.startsWith(join(installRoot, "versions") + sep);
		return { launcher, held, ours: inside && Boolean(readInstallMetadata(installRoot)) };
	}
	return { launcher, held, ours: false };
}

function currentTarget(installRoot) {
	const held = lstatOrNull(join(installRoot, "current"));
	if (!held) return null;
	if (!held.isSymbolicLink()) fail(`install root 'current' is not a symlink: ${join(installRoot, "current")}`);
	return basename(resolve(installRoot, readlinkSync(join(installRoot, "current"))));
}

function switchSymlink(target, linkPath) {
	mkdirSync(dirname(linkPath), { recursive: true });
	const temp = `${linkPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		unlinkSyncQuiet(temp);
		symlinkSync(target, temp);
		renameSync(temp, linkPath);
	} finally {
		unlinkSyncQuiet(temp);
	}
}

function unlinkSyncQuiet(path) {
	try {
		rmSync(path, { force: true });
	} catch {
		// Nothing to clean.
	}
}

function checkInstallOwnership(installRoot, binDir) {
	assertPlainDir(installRoot, "install root");
	assertPlainDir(binDir, "bin folder");
	if (existsSync(installRoot)) {
		const meta = readInstallMetadata(installRoot);
		const entries = readdirSync(installRoot);
		if (!meta && entries.length > 0) fail(`install root is not empty and is not owned by pi-studio: ${installRoot}`);
		if (meta && (!Array.isArray(meta.versions) || typeof meta.currentVersionDir !== "string")) fail(`install metadata is malformed: ${join(installRoot, "install.json")}`);
	} else {
		mkdirSync(installRoot, { recursive: true, mode: 0o700 });
	}
	if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true, mode: 0o755 });
	const check = launcherCheck(installRoot, binDir);
	if (check.held && !check.ours) fail(`refusing to overwrite foreign command: ${check.launcher}`);
	const currentHeld = lstatOrNull(join(installRoot, "current"));
	if (currentHeld && !currentHeld.isSymbolicLink()) fail(`install root 'current' is not a symlink: ${join(installRoot, "current")}`);
	return check;
}

/**
 * Install a validated staged tree as a new versioned directory and switch `current` and the
 * bin launcher to it. The staged tree is fully copied and re-validated before any switch.
 */
export function installFromDir(sourceDir, flags = {}) {
	const installRoot = installRootDir(flags);
	const binDir = binDirOf(flags);
	const identity = validateTree(sourceDir);
	const buildBytes = readFileSync(join(resolve(sourceDir), "build.json"));
	checkInstallOwnership(installRoot, binDir);
	// One rule for every entry that installs a tree (the download installer, `install:local`, the
	// update): an older tree never replaces a newer managed copy, so a stale installer left in a shell
	// history cannot walk an installation backwards.
	const installed = installedIdentity(installRoot);
	if (installed && compareVersions(identity.version, installed.identity.version) < 0) {
		fail(`refusing downgrade from ${installed.identity.version} to ${identity.version}; the installed copy is newer and was left unchanged`);
	}

	ensurePlainDir(join(installRoot, "versions"), "versions folder");
	let name = versionDirName(identity, buildBytes);
	let base = name;
	let counter = 1;
	while (existsSync(join(installRoot, "versions", name))) {
		const existing = lstatOrNull(join(installRoot, "versions", name));
		if (!existing || !existing.isDirectory() || existing.isSymbolicLink()) fail(`version folder is not a plain directory: ${join(installRoot, "versions", name)}`);
		let sameIdentity = false;
		try {
			const existingIdentity = buildIdentity(join(installRoot, "versions", name));
			sameIdentity = existingIdentity.version === identity.version && existingIdentity.commit === identity.commit && existingIdentity.official === identity.official;
		} catch {
			sameIdentity = false;
		}
		if (sameIdentity) break;
		counter++;
		name = `${base}-${counter}`;
	}
	const targetDir = join(installRoot, "versions", name);
	let alreadyInstalled = false;
	if (existsSync(targetDir)) {
		alreadyInstalled = true;
	} else {
		const staging = join(installRoot, `.staging-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
		try {
			copyTreeNoLinks(resolve(sourceDir), staging);
			validateTree(staging);
			renameSync(staging, targetDir);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}

	const meta = readInstallMetadata(installRoot) || { format: 1, versions: [] };
	const entry = { dir: name, version: identity.version, commit: identity.commit, commitShort: identity.commitShort, tag: identity.tag, official: identity.official, custom: identity.custom, source: identity.source };
	meta.versions = [...meta.versions.filter((v) => v.dir !== name), entry];
	meta.currentVersionDir = name;
	meta.launcher = join(binDir, APP_NAME);
	writeJsonAtomic(join(installRoot, "install.json"), meta);

	switchSymlink(join(installRoot, "versions", name), join(installRoot, "current"));
	switchSymlink(join(installRoot, "current", "bin", APP_NAME), join(binDir, APP_NAME));

	const verb = alreadyInstalled ? "already installed" : "installed";
	console.log(`pi-studio: ${verb} ${formatVersion(identity)}`);
	console.log(`pi-studio: version folder ${targetDir}`);
	console.log(`pi-studio: launcher ${join(binDir, APP_NAME)}`);
	console.log(`pi-studio: restart pi-studio to use ${identity.version}`);
	return { installRoot, binDir, identity, versionDir: targetDir, alreadyInstalled };
}

export function installedIdentity(installRoot) {
	const meta = readInstallMetadata(installRoot);
	if (!meta) return null;
	const name = meta.currentVersionDir || currentTarget(installRoot);
	if (!name) return null;
	const dir = join(installRoot, "versions", name);
	if (!existsSync(dir)) fail(`installed version folder is missing: ${dir}`);
	return { meta, name, dir, identity: buildIdentity(dir) };
}

// ---------- tar.gz extraction (regular files and folders only) ----------

/** Bounds on what a release host may hand the launcher, so a hostile release cannot fill the disk. */
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAX_TAR_BYTES = 512 * 1024 * 1024;

function tarString(buffer, offset, length) {
	const slice = buffer.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return (end >= 0 ? slice.subarray(0, end) : slice).toString("utf8");
}

function parsePaxPath(data) {
	let result = "";
	let offset = 0;
	while (offset < data.length) {
		const lineEnd = data.indexOf(10, offset);
		if (lineEnd < 0) break;
		const line = data.subarray(offset, lineEnd).toString("utf8");
		const space = line.indexOf(" ");
		if (space < 0) break;
		const keyValue = line.slice(space + 1);
		const eq = keyValue.indexOf("=");
		if (eq > 0 && keyValue.slice(0, eq) === "path") result = keyValue.slice(eq + 1);
		offset = lineEnd + 1;
	}
	return result;
}

function safeArchivePath(name) {
	if (!name || name.includes("\0") || name.includes("\\")) fail(`invalid archive path: ${name}`);
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) fail(`absolute archive path: ${name}`);
	const cleaned = name.replace(/^\.\//, "").replace(/\/$/, "");
	if (!cleaned) return "";
	const parts = cleaned.split("/");
	for (const part of parts) {
		if (part === ".." || part === "") fail(`archive path escapes its folder: ${name}`);
	}
	return cleaned;
}

export function extractTarGz(buffer, destination) {
	ensurePlainDir(destination, "extraction folder");
	if (buffer.length > MAX_DOWNLOAD_BYTES) fail(`release archive is larger than ${MAX_DOWNLOAD_BYTES} bytes; refusing`);
	let tar;
	try {
		tar = gunzipSync(buffer, { maxOutputLength: MAX_TAR_BYTES });
	} catch (error) {
		if (error && error.code === "ERR_BUFFER_TOO_LARGE") fail(`release archive unpacks to more than ${MAX_TAR_BYTES} bytes; refusing`);
		fail("release asset is not a valid gzip archive");
	}
	if (tar.length > MAX_TAR_BYTES) fail(`release archive unpacks to more than ${MAX_TAR_BYTES} bytes; refusing`);
	const entries = [];
	let offset = 0;
	let pendingLongName = "";
	let pendingPaxPath = "";
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const sizeText = tarString(header, 124, 12).trim();
		if (sizeText && !/^[0-7]{1,12}$/.test(sizeText)) fail("invalid tar entry size");
		const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
		if (!Number.isFinite(size) || size < 0) fail("invalid tar entry size");
		let name = tarString(header, 0, 100);
		const prefix = tarString(header, 345, 155);
		if (prefix) name = `${prefix}/${name}`;
		const type = String.fromCharCode(header[156] || 48);
		// A short file, or a header that claims more than the archive can hold, must not be read
		// as a smaller entry: the declared size has to fit before any of it is trusted.
		if (size > MAX_TAR_BYTES) fail(`tar entry ${name} declares ${size} bytes, more than ${MAX_TAR_BYTES}; refusing`);
		if (offset + 512 + size > tar.length) fail(`tar entry ${name} is truncated: it declares ${size} bytes and the archive ends early`);
		const data = tar.subarray(offset + 512, offset + 512 + size);

		if (type === "L") {
			pendingLongName = data.toString("utf8").replace(/\0.*$/, "");
		} else if (type === "x") {
			pendingPaxPath = parsePaxPath(data);
		} else if (type === "g" || type === "p" || type === "V" || type === "M" || type === "D" || type === "K" || type === "S") {
			fail(`unsupported tar entry type '${type}' for ${name}`);
		} else {
			const effective = pendingPaxPath || pendingLongName || name;
			pendingLongName = "";
			pendingPaxPath = "";
			if (type === "1" || type === "2") fail(`archive contains a link entry: ${effective} (links are not allowed)`);
			if (type !== "0" && type !== "\0" && type !== "5") fail(`archive contains a special entry: ${effective}`);
			const clean = safeArchivePath(effective);
			if (clean) entries.push({ path: clean, type: type === "5" ? "dir" : "file", data: type === "5" ? Buffer.alloc(0) : Buffer.from(data) });
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	// Strip a single top-level folder (pi-studio-<version>/...) or a leading ./ tree.
	let strip = "";
	const firstParts = new Set(entries.map((entry) => entry.path.split("/")[0]));
	if (firstParts.size === 1 && entries.some((entry) => entry.path.includes("/"))) strip = [...firstParts][0];
	for (const entry of entries) {
		const rel = strip && entry.path.startsWith(`${strip}/`) ? entry.path.slice(strip.length + 1) : strip ? "" : entry.path;
		if (!rel) continue;
		const target = join(destination, rel);
		if (relative(destination, target).startsWith("..")) fail(`archive path escapes its folder: ${entry.path}`);
		if (entry.type === "dir") {
			ensurePlainDir(target, "archive folder");
		} else {
			ensurePlainDir(dirname(target), "archive folder");
			const held = lstatOrNull(target);
			if (held && (held.isSymbolicLink() || !held.isFile())) fail(`archive entry would overwrite a non-file: ${entry.path}`);
			const fd = openSync(target, "w", 0o644);
			try {
				writeFileSync(fd, entry.data);
			} finally {
				closeSync(fd);
			}
		}
	}
	const launcher = join(destination, "bin", "pi-studio");
	if (existsSync(launcher)) chmodSync(launcher, 0o755);
}

// ---------- GitHub Releases update ----------

/** No release host may hold the launcher forever: every request is bounded. */
const FETCH_TIMEOUT_MS = 60_000;
/** The staged package's own checks share the same rule: a check that hangs must not hang the update. */
const EXEC_TIMEOUT_MS = 60_000;

async function fetchChecked(url, { allowHttpLoopback }) {
	assertSafeUrl(url, { allowHttpLoopback });
	let response;
	try {
		response = await fetch(url, {
			headers: { accept: "application/vnd.github+json", "user-agent": APP_NAME },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		fail(`download failed for ${url}: ${error.message}`);
	}
	if (!response.ok) fail(`download failed for ${url}: HTTP ${response.status}`);
	const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
	if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) fail(`download from ${url} is larger than ${MAX_DOWNLOAD_BYTES} bytes; refusing`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > MAX_DOWNLOAD_BYTES) fail(`download from ${url} is larger than ${MAX_DOWNLOAD_BYTES} bytes; refusing`);
	return bytes;
}

function parseChecksum(text, tarballName) {
	const lines = String(text).split("\n").map((line) => line.trim()).filter(Boolean);
	for (const line of lines) {
		const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
		if (match && match[2] === tarballName) return match[1].toLowerCase();
	}
	fail(`checksum file does not name ${tarballName}`);
}

async function createPromptReport(fromApp, toApp, stateDir, fromVersion, toVersion) {
	// The prompt helper is TypeScript in a source tree and compiled JavaScript in a staged
	// tree; either copy is imported from the tree being read, never from the app server.
	const candidates = [join(toApp, "server", "prompt-overrides.js"), join(toApp, "server", "prompt-overrides.ts")];
	const helper = candidates.find((candidate) => existsSync(candidate));
	if (!helper) return null;
	const module = await import(pathToFileURL(helper).href);
	if (typeof module.createPromptUpdateReport !== "function") return null;
	// The helper compares shipped prompt roots (the folders holding board/, modes/, …), so it is
	// handed each app's `prompts/`, never the app root itself.
	return module.createPromptUpdateReport({
		fromRoot: join(fromApp, "prompts"),
		toRoot: join(toApp, "prompts"),
		stateDir,
		fromVersion,
		toVersion,
	});
}

export async function update(flags = {}) {
	const installRoot = installRootDir(flags);
	const stateDir = stateDirOf(flags);
	const installed = installedIdentity(installRoot);
	if (!installed) fail(`pi-studio is not installed under ${installRoot}; install it first`);
	const current = installed.identity;

	const apiRoot = githubApiRoot();
	const apiUrl = assertSafeUrl(apiRoot, { allowHttpLoopback: true });
	const loopbackApi = apiUrl.protocol === "http:" && isLoopbackHost(apiUrl.hostname);
	const releaseUrl = `${apiRoot}/repos/${GITHUB_REPO}/releases/latest`;
	const release = JSON.parse((await fetchChecked(releaseUrl, { allowHttpLoopback: true })).toString("utf8"));
	if (release.draft) fail("latest release is a draft; refusing");
	if (release.prerelease) fail("latest release is a prerelease; refusing");
	const tag = String(release.tag_name || "").trim();
	const latestVersion = parseVersion(tag) ? tag.replace(/^v/, "") : null;
	if (!latestVersion || tag !== `v${latestVersion}`) fail(`invalid release tag: ${tag}`);

	const tarballName = ASSET_TARBALL(latestVersion);
	const checksumName = ASSET_CHECKSUM(latestVersion);
	const assets = new Map((release.assets || []).map((asset) => [asset.name, asset.browser_download_url]));
	if (!assets.get(tarballName) || !assets.get(checksumName)) fail(`release ${tag} is missing ${tarballName} or ${checksumName}`);

	const order = compareVersions(latestVersion, current.version);
	if (order < 0) fail(`refusing downgrade from ${current.version} to ${latestVersion}`);
	const sameOfficial = order === 0 && current.official && current.tag === tag;
	if (sameOfficial) {
		console.log(`pi-studio: already up to date at ${formatVersion(current)}`);
		return { noop: true, installRoot, identity: current };
	}
	if (current.custom && !flags["replace-custom"]) {
		fail(`installed copy is custom (${current.version}); pass --replace-custom to replace it with official ${latestVersion}`);
	}
	if (order === 0 && !current.custom && current.tag !== tag) fail(`installed ${current.version} does not match release tag ${tag}; refusing`);

	const tarball = await fetchChecked(assets.get(tarballName), { allowHttpLoopback: loopbackApi });
	const checksumText = (await fetchChecked(assets.get(checksumName), { allowHttpLoopback: loopbackApi })).toString("utf8");
	const expected = parseChecksum(checksumText, tarballName);
	if (sha256Hex(tarball) !== expected) fail(`checksum mismatch for ${tarballName}; the current installation is unchanged`);

	const extracted = mkdtempSync(join(tmpdir(), "pi-studio-update-"));
	try {
		extractTarGz(tarball, extracted);
		const identity = validateTree(extracted);
		if (identity.version !== latestVersion) fail(`archive version ${identity.version} does not match release tag ${tag}`);
		if (!identity.official || identity.tag !== tag) fail("release archive is not an official build of its tag; refusing");
		assertSupportedNode(identity.engines?.node);
		// Stage/test the new package before switching: syntax-check and run --version.
		for (const file of ["server.js", "bin/pi-studio", "bin/runtime.mjs", "bin/manage.mjs"]) {
			execFileSync(process.execPath, ["--check", join(extracted, file)], { stdio: "pipe", timeout: EXEC_TIMEOUT_MS, killSignal: "SIGKILL" });
		}
		const versionOut = execFileSync(process.execPath, [join(extracted, "bin", "pi-studio"), "--version"], {
			encoding: "utf8",
			stdio: "pipe",
			timeout: EXEC_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		if (!versionOut.includes(identity.version)) fail("staged package --version did not report its version; refusing");

		let promptReport = null;
		try {
			promptReport = await createPromptReport(installed.dir, extracted, stateDir, current.version, identity.version);
		} catch (error) {
			console.error(`pi-studio: prompt update report skipped: ${error.message}`);
		}

		const running = runningState(installRoot);
		const result = installFromDir(extracted, flags);
		if (promptReport) console.log(`pi-studio: prompt update report ${promptReport}`);
		if (running.state === "live") console.log(`pi-studio: restart-needed: pi-studio is running from ${current.version}; restart it to use ${identity.version}`);
		else if (running.state === "stale" || running.state === "unknown") console.log("pi-studio: restart pi-studio to use the new version if it is running");
		return { ...result, promptReport, previous: current };
	} finally {
		rmSync(extracted, { recursive: true, force: true });
	}
}

export function uninstall(flags = {}) {
	const installRoot = installRootDir(flags);
	const binDir = binDirOf(flags);
	const stateDir = stateDirOf(flags);
	// The state folder is never written or removed here: if it sits inside the root being removed,
	// removing the root would delete it, so stop instead.
	const removedRoot = resolve(installRoot);
	const statePath = resolve(stateDir);
	if (statePath === removedRoot || statePath.startsWith(removedRoot + sep)) {
		fail(`app state ${statePath} is inside the install root ${removedRoot}; refusing to remove it`);
	}
	const meta = readInstallMetadata(installRoot);
	if (!meta) fail(`pi-studio is not installed under ${installRoot}`);
	assertPlainDir(installRoot, "install root");
	assertPlainDir(binDir, "bin folder");
	const check = launcherCheck(installRoot, binDir);
	if (check.held && !check.ours) fail(`refusing to remove foreign command: ${check.launcher}`);

	const running = runningState(installRoot);
	if (running.state === "live") fail(`pi-studio is running (pid ${running.marker.pid}, marker ${markerPath(installRoot)}); stop it before uninstalling`);
	if (running.state === "unknown") fail(`a pi-studio running marker at ${markerPath(installRoot)} cannot be proven stale; stop pi-studio, then remove that marker and run uninstall again`);
	clearStaleMarker(installRoot);

	if (check.held) rmSync(check.launcher, { force: true });
	rmSync(installRoot, { recursive: true, force: true });
	console.log(`pi-studio: uninstalled from ${installRoot}`);
	console.log(`pi-studio: removed launcher ${check.launcher}`);
	console.log(`pi-studio: app state is preserved at ${stateDir}`);
	return { installRoot, binDir, stateDir };
}

export { cpSync };
