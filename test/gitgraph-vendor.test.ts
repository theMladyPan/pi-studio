import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearBundleCache, findBundle } from "../server/git/gitgraph/vendor.ts";

/** An extension folder as VS Code installs one, with the two files the page needs. */
function install(root: string, version: string, options: { js?: boolean; css?: boolean; declared?: string } = {}) {
	const dir = join(root, `mhutchie.git-graph-${version}`);
	mkdirSync(join(dir, "media"), { recursive: true });
	if (options.js !== false) writeFileSync(join(dir, "media", "out.min.js"), "var gitGraph = {};\n");
	if (options.css !== false) writeFileSync(join(dir, "media", "out.min.css"), "body {}\n");
	if (options.declared !== null) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "git-graph", version: options.declared ?? version }));
	return dir;
}

/** A folder of extension folders, torn down whatever a test did with it. */
function withRoots(work: (root: string, extra: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-vendor-root-"));
	const extra = mkdtempSync(join(tmpdir(), "pi-studio-vendor-extra-"));
	try {
		work(root, extra);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(extra, { recursive: true, force: true });
	}
}

test("the newest 1.30.x installed is the one that is served", () => {
	withRoots((root) => {
		clearBundleCache();
		install(root, "1.30.0");
		const newest = install(root, "1.30.2");
		const bundle = findBundle([root]);
		assert.equal(bundle.ok, true, bundle.ok ? "" : bundle.reason);
		if (!bundle.ok) return;
		assert.equal(bundle.version, "1.30.2");
		assert.equal(bundle.dir, newest);
		assert.equal(bundle.jsPath, join(newest, "media", "out.min.js"));
		assert.equal(bundle.cssPath, join(newest, "media", "out.min.css"));
	});
});

test("a version this view does not speak is named in the reason rather than served", () => {
	withRoots((root) => {
		clearBundleCache();
		install(root, "1.29.0");
		const older = findBundle([root]);
		assert.equal(older.ok, false);
		assert.match(older.ok ? "" : older.reason, /1\.29\.0/);
		assert.match(older.ok ? "" : older.reason, /1\.30\.x/, "the reason has to say which version is wanted");
	});
	withRoots((root) => {
		clearBundleCache();
		install(root, "1.31.0");
		const newer = findBundle([root]);
		assert.equal(newer.ok, false);
		assert.match(newer.ok ? "" : newer.reason, /1\.31\.0/);
	});
});

test("an installed 1.30.x whose files cannot be read is not served, and the next one is", () => {
	withRoots((root) => {
		clearBundleCache();
		install(root, "1.30.3", { js: false });
		install(root, "1.30.1");
		const bundle = findBundle([root]);
		assert.equal(bundle.ok, true, bundle.ok ? "" : bundle.reason);
		if (bundle.ok) assert.equal(bundle.version, "1.30.1");
	});
	withRoots((root) => {
		clearBundleCache();
		install(root, "1.30.0", { css: false });
		const missing = findBundle([root]);
		assert.equal(missing.ok, false);
		assert.match(missing.ok ? "" : missing.reason, /out\.min\.css/);
	});
});

test("a copy the editor has since deleted is not served from the memory of it", () => {
	// The daemon remembers a hit so it does not walk five folders per page load, but VS Code deletes an
	// extension folder on its next restart while the daemon keeps running. The remembered paths then name
	// files that are gone, which the page reads as a 404 on every reload until the daemon is restarted.
	const home = mkdtempSync(join(tmpdir(), "pi-studio-vendor-home-"));
	const before = process.env.HOME;
	try {
		process.env.HOME = home;
		clearBundleCache();
		const retired = install(join(home, ".vscode", "extensions"), "1.30.0");
		const left = install(join(home, ".vscode-server", "extensions"), "1.30.0");
		const first = findBundle();
		assert.equal(first.ok, true, first.ok ? "" : first.reason);
		if (first.ok) assert.equal(first.dir, retired, "the first copy found is the one served");
		rmSync(retired, { recursive: true, force: true });
		const second = findBundle();
		assert.equal(second.ok, true, second.ok ? "" : second.reason);
		if (second.ok) assert.equal(second.dir, left, "the copy still on disk is served instead of the dead one");
	} finally {
		if (before === undefined) delete process.env.HOME;
		else process.env.HOME = before;
		clearBundleCache();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a folder named 1.30.x but declaring another version is skipped", () => {
	withRoots((root) => {
		clearBundleCache();
		install(root, "1.30.8", { declared: "1.31.0" });
		const bundle = findBundle([root]);
		assert.equal(bundle.ok, false, "the package.json is what the page will run, so it has to agree");
	});
});

test("a machine with no Git Graph installed is told what to do about it", () => {
	withRoots((root) => {
		clearBundleCache();
		const bundle = findBundle([root]);
		assert.equal(bundle.ok, false);
		assert.match(bundle.ok ? "" : bundle.reason, /mhutchie\.git-graph 1\.30\.0/);
		assert.match(bundle.ok ? "" : bundle.reason, /PI_STUDIO_GITGRAPH_DIR/);
	});
});

test("a folder the human pointed at is served", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-vendor-env-"));
	const before = process.env.PI_STUDIO_GITGRAPH_DIR;
	try {
		clearBundleCache();
		const dir = install(root, "1.30.0");
		process.env.PI_STUDIO_GITGRAPH_DIR = dir;
		const found = findBundle();
		assert.equal(found.ok, true, found.ok ? "" : found.reason);
		if (found.ok) {
			assert.equal(found.version, "1.30.0");
			assert.equal(found.dir, dir);
		}
	} finally {
		if (before === undefined) delete process.env.PI_STUDIO_GITGRAPH_DIR;
		else process.env.PI_STUDIO_GITGRAPH_DIR = before;
		rmSync(root, { recursive: true, force: true });
	}
});

test("a folder that is not there yet is found once it is", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-vendor-late-"));
	const before = process.env.PI_STUDIO_GITGRAPH_DIR;
	const dir = join(root, "mhutchie.git-graph-1.30.0");
	try {
		clearBundleCache();
		process.env.PI_STUDIO_GITGRAPH_DIR = dir;
		const missing = findBundle();
		assert.equal(missing.ok, false);
		assert.match(missing.ok ? "" : missing.reason, /PI_STUDIO_GITGRAPH_DIR/);
		// The extension is copied in while the daemon runs, which is the case a remembered miss would lose.
		mkdirSync(join(dir, "media"), { recursive: true });
		writeFileSync(join(dir, "media", "out.min.js"), "var gitGraph = {};\n");
		writeFileSync(join(dir, "media", "out.min.css"), "body {}\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "git-graph", version: "1.30.0" }));
		const refound = findBundle();
		assert.equal(refound.ok, true, refound.ok ? "" : refound.reason);
	} finally {
		if (before === undefined) delete process.env.PI_STUDIO_GITGRAPH_DIR;
		else process.env.PI_STUDIO_GITGRAPH_DIR = before;
		rmSync(root, { recursive: true, force: true });
	}
});

test("a pointed-at folder of the wrong version is refused with the version it holds", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-vendor-env-wrong-"));
	const before = process.env.PI_STUDIO_GITGRAPH_DIR;
	try {
		clearBundleCache();
		const dir = install(root, "1.31.4");
		process.env.PI_STUDIO_GITGRAPH_DIR = dir;
		const bundle = findBundle();
		assert.equal(bundle.ok, false);
		assert.match(bundle.ok ? "" : bundle.reason, /1\.31\.4/);
	} finally {
		if (before === undefined) delete process.env.PI_STUDIO_GITGRAPH_DIR;
		else process.env.PI_STUDIO_GITGRAPH_DIR = before;
		rmSync(root, { recursive: true, force: true });
	}
});
