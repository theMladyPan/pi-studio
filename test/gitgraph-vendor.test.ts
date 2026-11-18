import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearBundleCache, findBundle } from "../server/git/gitgraph/vendor.ts";

function install(root: string, version: string, options: { web?: boolean; declared?: string } = {}) {
	const dir = join(root, `plohnensoftware.git-graph-libre-${version}`);
	mkdirSync(join(dir, "out"), { recursive: true });
	mkdirSync(join(dir, "media"), { recursive: true });
	mkdirSync(join(dir, "l10n"), { recursive: true });
	if (options.web !== false) writeFileSync(join(dir, "out", "web.min.js"), "var gitGraphLibre = {};\n");
	writeFileSync(join(dir, "out", "startup.min.js"), "var s = 1;\n");
	writeFileSync(join(dir, "out", "diffTab.min.js"), "var d = 1;\n");
	writeFileSync(join(dir, "media", "base.css"), "body {}\n");
	for (const css of ["tokens.css", "checkbox.css", "table.css", "commit-details.css", "refs.css", "toolbar.css", "settings.css", "dialogs.css", "dropdown.css"]) writeFileSync(join(dir, "media", css), "body {}\n");
	writeFileSync(join(dir, "l10n", "bundle.l10n.json"), "{}\n");
	if (options.declared !== null) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "git-graph-libre", version: options.declared ?? version, publisher: "PlohnenSoftware" }));
	return dir;
}

function withRoots(work: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-vendor-root-"));
	try { work(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("the newest installed Libre is the one that is served", () => {
	withRoots((root) => {
		clearBundleCache();
		install(root, "1.9.0");
		const newest = install(root, "1.10.0");
		const bundle = findBundle([root]);
		assert.equal(bundle.ok, true, bundle.ok ? "" : bundle.reason);
		if (!bundle.ok) return;
		assert.equal(bundle.version, "1.10.0");
		assert.equal(bundle.dir, newest);
		assert.equal(bundle.webPath, join(newest, "out", "web.min.js"));
		assert.equal(bundle.cssPath, join(newest, "media", "base.css"));
	});
});

test("a version this view does not speak is named in the reason rather than served", () => {
	withRoots((root) => {
		clearBundleCache();
		install(root, "2.0.0");
		const older = findBundle([root]);
		assert.equal(older.ok, false);
		assert.match(older.ok ? "" : older.reason, /2\.0\.0/);
	});
	withRoots((root) => {
		clearBundleCache();
		install(root, "0.1.0");
		const newer = findBundle([root]);
		assert.equal(newer.ok, false);
		assert.match(newer.ok ? "" : newer.reason, /0\.1\.0/);
	});
});

test("an installed Libre whose files cannot be read is not served, and the next one is", () => {
	withRoots((root) => {
		clearBundleCache();
		install(root, "1.10.0", { web: false });
		install(root, "1.9.0");
		const bundle = findBundle([root]);
		assert.equal(bundle.ok, true, bundle.ok ? "" : bundle.reason);
		if (bundle.ok) assert.equal(bundle.version, "1.9.0");
	});
});

test("a copy the editor has since deleted is not served from the memory of it", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-studio-vendor-home-"));
	const before = process.env.HOME;
	try {
		process.env.HOME = home;
		clearBundleCache();
		const retired = install(join(home, ".vscode", "extensions"), "1.10.0");
		const left = install(join(home, ".vscode-server", "extensions"), "1.10.0");
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

test("a folder named 1.x but declaring another version is skipped", () => {
	withRoots((root) => {
		clearBundleCache();
		install(root, "1.10.0", { declared: "2.0.0" });
		const bundle = findBundle([root]);
		assert.equal(bundle.ok, false, "the package.json is what the page will run, so it has to agree");
	});
});

test("a machine with no Git Graph Libre installed is told what to do about it", () => {
	withRoots((root) => {
		clearBundleCache();
		const bundle = findBundle([root]);
		assert.equal(bundle.ok, false);
		assert.match(bundle.ok ? "" : bundle.reason, /Git Graph Libre was not found/);
		assert.match(bundle.ok ? "" : bundle.reason, /PI_STUDIO_GITGRAPH_DIR/);
	});
});

test("a folder the human pointed at is served", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-vendor-env-"));
	const before = process.env.PI_STUDIO_GITGRAPH_DIR;
	try {
		clearBundleCache();
		const dir = install(root, "1.10.0");
		process.env.PI_STUDIO_GITGRAPH_DIR = dir;
		const found = findBundle();
		assert.equal(found.ok, true, found.ok ? "" : found.reason);
		if (found.ok) assert.equal(found.version, "1.10.0");
	} finally {
		if (before === undefined) delete process.env.PI_STUDIO_GITGRAPH_DIR;
		else process.env.PI_STUDIO_GITGRAPH_DIR = before;
		rmSync(root, { recursive: true, force: true });
	}
});

test("a folder that is not there yet is found once it is", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-vendor-late-"));
	const before = process.env.PI_STUDIO_GITGRAPH_DIR;
	const dir = join(root, "plohnensoftware.git-graph-libre-1.10.0");
	try {
		clearBundleCache();
		process.env.PI_STUDIO_GITGRAPH_DIR = dir;
		const missing = findBundle();
		assert.equal(missing.ok, false);
		assert.match(missing.ok ? "" : missing.reason, /PI_STUDIO_GITGRAPH_DIR/);
		mkdirSync(join(dir, "out"), { recursive: true });
		mkdirSync(join(dir, "media"), { recursive: true });
		mkdirSync(join(dir, "l10n"), { recursive: true });
		writeFileSync(join(dir, "out", "web.min.js"), "var x=1;\n");
		writeFileSync(join(dir, "out", "startup.min.js"), "var x=1;\n");
		writeFileSync(join(dir, "out", "diffTab.min.js"), "var x=1;\n");
		for (const css of ["tokens.css", "base.css", "checkbox.css", "table.css", "commit-details.css", "refs.css", "toolbar.css", "settings.css", "dialogs.css", "dropdown.css"]) writeFileSync(join(dir, "media", css), "body {}\n");
		writeFileSync(join(dir, "l10n", "bundle.l10n.json"), "{}\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "git-graph-libre", version: "1.10.0" }));
		const refound = findBundle();
		assert.equal(refound.ok, true, refound.ok ? "" : refound.reason);
	} finally {
		if (before === undefined) delete process.env.PI_STUDIO_GITGRAPH_DIR;
		else process.env.PI_STUDIO_GITGRAPH_DIR = before;
		rmSync(root, { recursive: true, force: true });
	}
});
