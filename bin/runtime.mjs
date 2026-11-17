// Shared primitives for the pi-studio launcher and install manager.
// No server code is imported here, so this module is safe to load before the app starts.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const APP_NAME = "pi-studio";
export const GITHUB_REPO = "theMladyPan/pi-studio";

export function fail(message) {
	throw new Error(`pi-studio: ${message}`);
}

export function parseVersion(value) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || "").trim());
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a, b) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) fail(`invalid version (need X.Y.Z): ${a} / ${b}`);
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
	}
	return 0;
}

export function expandHome(path) {
	const value = String(path || "");
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

/** Parse --flag value / --flag=value pairs into an object; flags without value become true. */
export function parseFlags(argv) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq >= 0) {
				out[arg.slice(2, eq)] = arg.slice(eq + 1);
			} else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
				out[arg.slice(2)] = argv[++i];
			} else {
				out[arg.slice(2)] = true;
			}
		} else {
			rest.push(arg);
		}
	}
	return { flags: out, rest };
}

export function installRootDir(flags = {}) {
	const raw = flags["install-root"] || process.env.PI_STUDIO_INSTALL_ROOT || "";
	if (raw) return resolve(expandHome(raw));
	const xdg = process.env.XDG_DATA_HOME || "";
	return xdg && isAbsolute(xdg) ? join(xdg, "pi-studio") : join(homedir(), ".local", "share", "pi-studio");
}

export function binDirOf(flags = {}) {
	const raw = flags["bin-dir"] || process.env.PI_STUDIO_BIN_DIR || "";
	return raw ? resolve(expandHome(raw)) : join(homedir(), ".local", "bin");
}

/** The global state folder, mirroring server/paths.ts: --state, PI_STUDIO_STATE, then XDG state. */
export function stateDirOf(flags = {}) {
	const raw = flags.state || process.env.PI_STUDIO_STATE || "";
	if (raw) return resolve(expandHome(raw));
	const xdg = process.env.XDG_STATE_HOME || "";
	return xdg && isAbsolute(xdg) ? join(xdg, "pi-studio") : join(homedir(), ".local", "state", "pi-studio");
}

export function githubApiRoot() {
	return (process.env.PI_STUDIO_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
}

export function isLoopbackHost(hostname) {
	const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

export function assertSafeUrl(value, { allowHttpLoopback = false } = {}) {
	let url;
	try {
		url = new URL(value);
	} catch {
		fail(`invalid URL: ${value}`);
	}
	if (url.protocol === "https:") return url;
	if (url.protocol === "http:" && allowHttpLoopback && isLoopbackHost(url.hostname)) return url;
	fail(`refusing non-HTTPS URL ${value} (HTTP is only allowed for an explicit loopback API override)`);
}

/** Minimum Node from an engines range such as ">=22.18"; falls back to 22.18. */
export function minimumNode(enginesNode) {
	const match = />=(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(enginesNode || ""));
	return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : [22, 18, 0];
}

export function assertSupportedNode(enginesNode) {
	const [major, minor, patch] = minimumNode(enginesNode);
	const current = parseVersion(process.versions.node);
	const minimum = [major, minor, patch];
	for (let i = 0; i < 3; i++) {
		if (current[i] !== minimum[i]) {
			if (current[i] < minimum[i]) fail(`Node >=${minimum.join(".")} is required, this is ${process.versions.node}`);
			return;
		}
	}
}

function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function gitCommitFromDotGit(appRoot) {
	try {
		const dotgit = join(appRoot, ".git");
		const stat = lstatSync(dotgit);
		let gitDir = dotgit;
		if (stat.isFile()) {
			const pointer = readFileSync(dotgit, "utf8").trim();
			if (!pointer.startsWith("gitdir: ")) return "unknown";
			gitDir = resolve(appRoot, pointer.slice("gitdir: ".length).trim());
		}
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		if (!head.startsWith("ref: ")) return head.slice(0, 7) || "unknown";
		const named = head.slice("ref: ".length).trim();
		const commonPath = join(gitDir, "commondir");
		const common = existsSync(commonPath) ? resolve(gitDir, readFileSync(commonPath, "utf8").trim()) : gitDir;
		const ref = existsSync(join(gitDir, named)) ? join(gitDir, named) : join(common, named);
		return readFileSync(ref, "utf8").trim().slice(0, 7) || "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * Package/build identity for a copy of the app. A staged copy answers from build.json;
 * a source clone answers from package.json plus its .git HEAD and reads custom, because
 * only a build can prove it is the clean official tag.
 */
export function buildIdentity(appRoot) {
	const rootDir = resolve(appRoot);
	const staged = readJsonFile(join(rootDir, "build.json"));
	const pkg = readJsonFile(join(rootDir, "package.json")) || {};
	if (staged && staged.name === APP_NAME && typeof staged.version === "string") {
		return {
			name: APP_NAME,
			version: staged.version,
			commit: staged.commit || "unknown",
			commitShort: staged.commitShort || "unknown",
			tag: staged.tag ?? null,
			official: staged.official === true,
			custom: staged.custom !== false || staged.official !== true,
			dirty: staged.dirty === true,
			source: staged.source || "build.json",
			engines: pkg.engines || {},
		};
	}
	if (pkg.name === APP_NAME && typeof pkg.version === "string") {
		const commit = gitCommitFromDotGit(rootDir);
		return {
			name: APP_NAME,
			version: pkg.version,
			commit,
			commitShort: commit,
			tag: null,
			official: false,
			custom: true,
			dirty: false,
			source: "source",
			engines: pkg.engines || {},
		};
	}
	fail(`no pi-studio package.json or build.json in ${rootDir}`);
}

export function sha256Hex(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

export function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

/** Refuse a planted symlink or non-directory at a path that must be a plain directory. */
export function assertPlainDir(path, label) {
	const held = lstatOrNull(path);
	if (!held) return false;
	if (held.isSymbolicLink() || !held.isDirectory()) fail(`${label} is not a plain directory: ${path}`);
	return true;
}

export function ensurePlainDir(path, label, mode = 0o755) {
	assertPlainDir(path, label);
	mkdirSync(path, { recursive: true, mode });
	assertPlainDir(path, label);
}

export function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

export function readInstallMetadata(installRoot) {
	const meta = readJsonFile(join(installRoot, "install.json"));
	if (!meta || meta.format !== 1 || !Array.isArray(meta.versions)) return null;
	return meta;
}

export function markerPath(installRoot) {
	return join(installRoot, "running.json");
}

/** Write this process as the managed app's runtime marker. Returns the path or null when not managed. */
export function registerRuntime(installRoot, versionDirName) {
	try {
		if (!readInstallMetadata(installRoot)) return null;
		const current = lstatOrNull(join(installRoot, "current"));
		if (!current || !current.isSymbolicLink()) return null;
		const path = markerPath(installRoot);
		writeJsonAtomic(path, { pid: process.pid, versionDir: versionDirName || basename(resolve(installRoot, "current")), startedAt: new Date().toISOString() });
		const cleanup = () => {
			try {
				const held = readJsonFile(path);
				if (held && held.pid === process.pid) unlinkSync(path);
			} catch {
				// The marker is best-effort; a stale one is handled by the reader.
			}
		};
		process.on("exit", cleanup);
		return path;
	} catch {
		return null;
	}
}

function pidAlive(pid) {
	// No process signals and no process scans: on Linux the /proc entry is the proof.
	// Where it cannot be proven dead, the marker is treated as live (conservative).
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (process.platform === "linux") return existsSync(`/proc/${pid}`);
	return null;
}

/**
 * Whether the managed app is running, from its owned marker only.
 * Answers "live", "stale" (proven dead, safe to clear), or "unknown" (cannot prove).
 */
export function runningState(installRoot) {
	const marker = readJsonFile(markerPath(installRoot));
	if (!marker || !Number.isInteger(marker.pid)) return { state: "none", marker: null };
	const alive = pidAlive(marker.pid);
	if (alive === true) return { state: "live", marker };
	if (alive === false) return { state: "stale", marker };
	return { state: "unknown", marker };
}

export function clearStaleMarker(installRoot) {
	const { state } = runningState(installRoot);
	if (state === "stale") {
		try {
			unlinkSync(markerPath(installRoot));
		} catch {
			// Already gone.
		}
		return true;
	}
	return false;
}

export function formatVersion(identity) {
	const kind = identity.official ? "official" : "custom";
	return `pi-studio ${identity.version} (commit ${identity.commitShort}, ${kind}, ${identity.source})`;
}
