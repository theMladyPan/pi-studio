/**
 * Finding the human's own copy of the Git Graph Libre webview, which we use rather than ship.
 *
 * Git Graph Libre 1.x is AGPL-3.0-or-later, so this app never carries its code: it points the view at
 * the `plohnensoftware.git-graph-libre-*` the human already installed in VS Code and serves it from
 * there. A miss is not cached: an extension installed while the daemon runs is picked up the next time
 * the view is opened. Nothing is distributed with this app, so the AGPL source-offer question never
 * arises for pi-studio itself; the daemon only reads bytes already on the machine, like the old
 * mhutchie borrowing did.
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ---------- shapes ----------

/**
 * What was found to serve, or why nothing was.
 *
 * `dir` is the extension folder. `files` maps the single safe name a page may ask for onto the real
 * path inside that folder, so nothing a page sends is ever joined onto a path.
 */
export type VendorBundle =
	| { ok: true; version: string; dir: string; files: Record<string, string>; webPath: string; cssPath: string }
	| { ok: false; reason: string };

// ---------- what a usable folder looks like ----------

/** Any installed Git Graph Libre folder, by the version it carries in its name. */
const ANY_INSTALL = /^plohnensoftware\.git-graph-libre-(.+)$/i;

/** The installed Git Graph Libre folders this view can serve, capturing the semver to sort by. */
const WANTED_INSTALL = /^plohnensoftware\.git-graph-libre-(1\.\d+\.\d+)$/i;

/** The folders VS Code, its server build, and the editors that share its extension layout use. */
const EXTENSION_ROOTS = [
	".vscode/extensions",
	".vscode-server/extensions",
	".vscode-oss/extensions",
	".cursor/extensions",
	".windsurf/extensions",
];

/** The vendor files the page may fetch, and the path inside a usable extension folder for each. */
const VENDOR_FILES: Record<string, string> = {
	"web.min.js": "out/web.min.js",
	"startup.min.js": "out/startup.min.js",
	"diffTab.min.js": "out/diffTab.min.js",
	"tokens.css": "media/tokens.css",
	"base.css": "media/base.css",
	"checkbox.css": "media/checkbox.css",
	"table.css": "media/table.css",
	"commit-details.css": "media/commit-details.css",
	"refs.css": "media/refs.css",
	"toolbar.css": "media/toolbar.css",
	"settings.css": "media/settings.css",
	"dialogs.css": "media/dialogs.css",
	"dropdown.css": "media/dropdown.css",
	"bundle.l10n.json": "l10n/bundle.l10n.json",
};

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
	const files: Record<string, string> = {};
	for (const [name, rel] of Object.entries(VENDOR_FILES)) {
		const full = join(dir, rel);
		if (!readableFile(full)) {
			return { ok: false, reason: `${dir} holds no readable ${rel}` };
		}
		files[name] = full;
	}
	return { ok: true, version, dir, files, webPath: files["web.min.js"], cssPath: files["base.css"] };
}

// ---------- the search ----------

/** The folders to look in when the caller names none, in the order they are searched. */
function defaultRoots(): readonly string[] {
	const home = homedir();
	return EXTENSION_ROOTS.map((rel) => join(home, rel));
}

/**
 * The folder a human pointed at themselves. It is checked with the same rules as an installed one,
 * because pointing at a folder is exactly as trustworthy as finding one.
 */
function configuredBundle(dir: string): VendorBundle {
	if (!existsSync(dir)) return { ok: false, reason: `PI_STUDIO_GITGRAPH_DIR names ${dir}, which is not there` };
	const declared = declaredVersion(dir);
	const version = declared || namedVersion(dir);
	// Libre is a fork that happened after the old 1.30.x line: any 1.x of the new publisher is the
	// protocol this view is written against, and a 1.30.x folder from the old publisher is a different
	// product and is refused by name rather than served.
	const isLibre = /^1\.\d+\.\d+$/.test(version) || /^1\.\d+$/.test(version);
	if (version && !isLibre) {
		return { ok: false, reason: `${dir} is git-graph-libre ${version}; this view needs a 1.x git-graph-libre` };
	}
	return bundleAt(dir, version || "unknown");
}

/** Compare two semver-ish versions newest-first: numeric segments, then lexicographic. */
function compareVersion(a: string, b: string): number {
	const parts = (v: string) => v.split(".").map((p) => {
		const n = Number(p);
		return Number.isFinite(n) ? n : p;
	});
	const pa = parts(a);
	const pb = parts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const x = pa[i];
		const y = pb[i];
		if (x === y) continue;
		if (typeof x === "number" && typeof y === "number") return y - x;
		return String(y).localeCompare(String(x));
	}
	return b.localeCompare(a);
}

/** Every installed Git Graph Libre folder under the given roots, sorted newest first. */
function installedBundles(roots: readonly string[]): { wanted: Array<{ dir: string; version: string }>; others: string[] } {
	const wanted: Array<{ dir: string; version: string }> = [];
	const others: string[] = [];
	for (const root of roots) {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const match = WANTED_INSTALL.exec(entry);
			if (match) {
				wanted.push({ dir: join(root, entry), version: match[1] });
				continue;
			}
			const other = ANY_INSTALL.exec(entry);
			if (other) others.push(other[1]);
		}
	}
	wanted.sort((a, b) => compareVersion(a.version, b.version));
	return { wanted, others };
}

/** What to tell a human whose extension folders hold every version but the one this view speaks. */
function missReason(wanted: Array<{ dir: string }>, others: string[]): string {
	if (wanted.length > 0) {
		return `git-graph-libre is installed at ${wanted.map((entry) => entry.dir).join(", ")}, but some of its webview files cannot be read`;
	}
	if (others.length > 0) {
		const found = [...new Set(others)].sort().join(", ");
		return `git-graph-libre ${found} is installed, but this view needs a 1.x git-graph-libre, which is the version its protocol was written against`;
	}
	return "Git Graph Libre was not found. Install git-graph-libre 1.x (PlohnenSoftware) in VS Code, or set PI_STUDIO_GITGRAPH_DIR to a copy of it";
}

/** The last bundle found by a search of this machine, so a view that is opened and closed re-reads once. */
let cached: VendorBundle | null = null;

/**
 * The Git Graph Libre bundle to serve: the folder `PI_STUDIO_GITGRAPH_DIR` names when it is set,
 * otherwise the newest installed 1.x under the editor extension folders.
 *
 * A hit found that way is remembered, because reading five directories on every page load is work for
 * an answer that only changes when the human starts a new copy of the editor. A miss is not: the human
 * installing the extension while the daemon runs is the one case where the answer changes without the
 * daemon restarting.
 */
export function findBundle(searchRoots?: readonly string[]): VendorBundle {
	if (!searchRoots && cached) {
		if (cached.ok && readableFile(cached.webPath) && readableFile(cached.cssPath)) return cached;
		cached = null;
	}
	const configured = (process.env.PI_STUDIO_GITGRAPH_DIR ?? "").trim();
	if (configured) return configuredBundle(configured);
	const roots = searchRoots ?? defaultRoots();
	const { wanted, others } = installedBundles(roots);
	for (const candidate of wanted) {
		const declared = declaredVersion(candidate.dir);
		if (declared && !/^1\.\d+\.\d+$/.test(declared)) continue;
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
