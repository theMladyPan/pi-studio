/**
 * Finding the human's own copy of the Git Graph webview, which we use rather than ship.
 *
 * Git Graph's licence allows using the extension and forbids redistributing it or a derivative of it,
 * so this app never carries its code: it points the view at the `mhutchie.git-graph-1.30.0` the human
 * already installed in VS Code and serves it from there. The version is pinned to 1.30.x because the
 * page and the daemon speak one protocol, and a newer extension would speak another. A miss is not
 * cached: an extension installed while the daemon runs is picked up the next time the view is opened.
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ---------- shapes ----------

/** What was found to serve, or why nothing was. */
export type VendorBundle =
	| { ok: true; version: string; dir: string; jsPath: string; cssPath: string }
	| { ok: false; reason: string };

// ---------- what a usable folder looks like ----------

/** The one major version whose protocol this view is written against. */
const REQUIRED_VERSION = /^1\.30\.\d+$/;

/** Any installed Git Graph folder, by the version it carries in its name. */
const ANY_INSTALL = /^mhutchie\.git-graph-(.+)$/;

/** The installed Git Graph folders this view can serve, capturing the patch number to sort by. */
const WANTED_INSTALL = /^mhutchie\.git-graph-(1\.30\.(\d+))$/;

/** The folders VS Code, its server build, and the editors that share its extension layout use. */
const EXTENSION_ROOTS = [
	".vscode/extensions",
	".vscode-server/extensions",
	".vscode-oss/extensions",
	".cursor/extensions",
	".windsurf/extensions",
];

// ---------- reading one folder ----------

/** A file this process can read, which is the only thing that makes a bundle servable. */
function readableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** The version an extension folder declares, or "" when it declares none that can be read. */
function declaredVersion(dir: string): string {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		if (!raw || typeof raw !== "object") return "";
		const version = (raw as { version?: unknown }).version;
		return typeof version === "string" ? version.trim() : "";
	} catch {
		return "";
	}
}

/** The version in a folder's own name, for a copy whose `package.json` was stripped. */
function namedVersion(dir: string): string {
	return ANY_INSTALL.exec(basename(dir))?.[1] ?? "";
}

/** The bundle an extension folder holds, or the reason it cannot be served. */
function bundleAt(dir: string, version: string): VendorBundle {
	const jsPath = join(dir, "media", "out.min.js");
	const cssPath = join(dir, "media", "out.min.css");
	if (!readableFile(jsPath) || !readableFile(cssPath)) {
		return { ok: false, reason: `${dir} holds no readable media/out.min.js and media/out.min.css` };
	}
	return { ok: true, version, dir, jsPath, cssPath };
}

// ---------- the search ----------

/** The folders to look in when the caller names none, in the order they are searched. */
function defaultRoots(): readonly string[] {
	const home = homedir();
	return EXTENSION_ROOTS.map((rel) => join(home, rel));
}

/**
 * The folder a human pointed at themselves. It is checked here with the same rules as an installed
 * one, because pointing at a folder is exactly as trustworthy as finding one, and a wrong version has
 * to be reported rather than served: a page and a daemon that disagree about the protocol fail in the
 * console of a human who did nothing wrong.
 */
function configuredBundle(dir: string): VendorBundle {
	if (!existsSync(dir)) return { ok: false, reason: `PI_STUDIO_GITGRAPH_DIR names ${dir}, which is not there` };
	const declared = declaredVersion(dir);
	const version = declared || namedVersion(dir);
	if (version && !REQUIRED_VERSION.test(version)) {
		return { ok: false, reason: `${dir} is mhutchie.git-graph ${version}; this view needs 1.30.x, which is the version its protocol was written against` };
	}
	return bundleAt(dir, version || "unknown");
}

/** Every installed Git Graph folder under the given roots, sorted newest patch first. */
function installedBundles(roots: readonly string[]): { wanted: Array<{ dir: string; version: string; patch: number }>; others: string[] } {
	const wanted: Array<{ dir: string; version: string; patch: number }> = [];
	const others: string[] = [];
	for (const root of roots) {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			// A root that is not on this machine is the normal case for most of them.
			continue;
		}
		for (const entry of entries) {
			const match = WANTED_INSTALL.exec(entry);
			if (match) {
				wanted.push({ dir: join(root, entry), version: match[1], patch: Number(match[2]) });
				continue;
			}
			const other = ANY_INSTALL.exec(entry);
			if (other) others.push(other[1]);
		}
	}
	wanted.sort((left, right) => right.patch - left.patch);
	return { wanted, others };
}

/** What to tell a human whose extension folders hold every version but the one this view speaks. */
function missReason(wanted: Array<{ dir: string }>, others: string[]): string {
	if (wanted.length > 0) {
		return `mhutchie.git-graph 1.30.x is installed at ${wanted.map((entry) => entry.dir).join(", ")}, but its media/out.min.js and media/out.min.css cannot be read`;
	}
	if (others.length > 0) {
		const found = [...new Set(others)].sort().join(", ");
		return `mhutchie.git-graph ${found} is installed, but this view needs 1.30.x, which is the version its protocol was written against`;
	}
	return "Git Graph 1.30.x was not found. Install mhutchie.git-graph 1.30.0 in VS Code, or set PI_STUDIO_GITGRAPH_DIR to a copy of it";
}

/** The last bundle found by a search of this machine, so a view that is opened and closed re-reads once. */
let cached: VendorBundle | null = null;

/**
 * The Git Graph bundle to serve: the folder `PI_STUDIO_GITGRAPH_DIR` names when it is set, otherwise
 * the best installed 1.30.x under the editor extension folders.
 *
 * A hit found that way is remembered, because reading five directories on every page load is work for
 * an answer that only changes when the human starts a new copy of the editor. A miss is not: the human
 * installing the extension while the daemon runs is the one case where the answer changes without the
 * daemon restarting.
 */
export function findBundle(searchRoots?: readonly string[]): VendorBundle {
	// A hit remembers two paths, not the files behind them. An editor retires an installed copy while the
	// daemon runs — VS Code marks the folder obsolete and deletes it on its next restart — and the cached
	// answer then names a file that is no longer there, which the page sees as a 404 on every reload. A
	// hit whose files cannot be read is no hit, so the search runs again and finds the copy that is left.
	if (!searchRoots && cached) {
		if (cached.ok && readableFile(cached.jsPath) && readableFile(cached.cssPath)) return cached;
		cached = null;
	}
	const configured = (process.env.PI_STUDIO_GITGRAPH_DIR ?? "").trim();
	if (configured) return configuredBundle(configured);
	const roots = searchRoots ?? defaultRoots();
	const { wanted, others } = installedBundles(roots);
	for (const candidate of wanted) {
		const declared = declaredVersion(candidate.dir);
		// A folder named for one version but declaring another is one a human renamed, and the file is
		// what the page will run, so the name alone is not enough to accept it.
		if (declared && !REQUIRED_VERSION.test(declared)) continue;
		const bundle = bundleAt(candidate.dir, candidate.version);
		if (!bundle.ok) continue;
		if (!searchRoots) cached = bundle;
		return bundle;
	}
	return { ok: false, reason: missReason(wanted, others) };
}

/** Forget what a previous search found, so a test starts from a machine with no extension installed. */
export function clearBundleCache(): void {
	cached = null;
}
