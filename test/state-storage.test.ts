import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The state folder is resolved once, when `server/paths.ts` is first imported, so this file sets it
 * before any daemon code is loaded and then loads that code dynamically. Everything written here
 * lands under `tmpdir()`: the explicit root is a throwaway, and the legacy import for an explicit
 * root only ever reads inside that root, never the real user's home.
 */
const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-state-storage-"));
process.env.PI_STUDIO_STATE = stateHome;

const paths = await import("../server/paths.ts");
const storage = await import("../server/state-storage.ts");
const { ensureStateExcludes } = await import("../server/worktrees/make.ts");
const { boardFor } = await import("../server/store.ts");
const { git, scratchRepo } = await import("../test-support/git.ts");

test("an explicit state root namespaces project state by that root, not by a shared name", () => {
	const expected = createHash("sha256").update(paths.STATE_DIR).digest("hex").slice(0, 12);
	assert.equal(paths.HAS_EXPLICIT_STATE, true);
	assert.equal(paths.PROJECT_NAMESPACE, expected);
	assert.notEqual(paths.PROJECT_NAMESPACE, "default");
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-namespace-"));
	try {
		assert.equal(paths.projectStateDir(folder), join(folder, ".pi-studio", expected));
		assert.equal(paths.boardFile({ id: "w1", folder }), join(folder, ".pi-studio", expected, "boards", "w1.json"));
		assert.equal(paths.gitgraphStateFile({ id: "w1", folder }), join(folder, ".pi-studio", expected, "gitgraph", "w1.json"));
		// A caller that names only an id it never registered keeps the legacy global layout.
		assert.equal(paths.boardFile({ id: "w-unregistered" }), join(paths.STATE_DIR, "boards", "w-unregistered.json"));
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("the legacy import copies board, sessions and Git state whole, and never overwrites", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-import-project-"));
	try {
		const id = paths.workspaceId(folder);
		const workspace = { id, folder, name: "import" };
		mkdirSync(join(stateHome, "boards"), { recursive: true });
		mkdirSync(join(stateHome, "gitgraph"), { recursive: true });
		mkdirSync(join(stateHome, "sessions", id), { recursive: true });
		const boardJson = JSON.stringify({ version: 1, threads: [{ id: "t1" }] });
		const sessionJsonl = `${JSON.stringify({ type: "session", cwd: folder })}\n${JSON.stringify({ type: "message" })}\n`;
		writeFileSync(join(stateHome, "boards", `${id}.json`), boardJson);
		writeFileSync(join(stateHome, "gitgraph", `${id}.json`), "{}");
		writeFileSync(join(stateHome, "sessions", id, `2026-01-01_${id}.jsonl`), sessionJsonl);
		// An existing project file wins over the legacy copy.
		const destBoard = paths.boardFile(workspace);
		mkdirSync(join(destBoard, ".."), { recursive: true });
		writeFileSync(destBoard, "already here");

		storage.importLegacyProjectState(workspace);

		assert.equal(readFileSync(destBoard, "utf8"), "already here", "an existing project file was overwritten");
		const destSession = join(paths.projectStateDir(folder), "sessions", id, `2026-01-01_${id}.jsonl`);
		assert.equal(readFileSync(destSession, "utf8"), sessionJsonl, "the session transcript was not copied whole");
		assert.equal(readFileSync(paths.gitgraphStateFile(workspace), "utf8"), "{}");
		// Originals are retained.
		assert.equal(readFileSync(join(stateHome, "boards", `${id}.json`), "utf8"), boardJson);
		assert.ok(existsSync(join(stateHome, "sessions", id, `2026-01-01_${id}.jsonl`)));
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a planted symlink at the project state path is refused, and the board does not open", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-symlink-project-"));
	const elsewhere = mkdtempSync(join(tmpdir(), "pi-studio-symlink-target-"));
	try {
		symlinkSync(elsewhere, join(folder, ".pi-studio"));
		assert.throws(() => storage.ensureProjectStateDir(folder), /symlink/);
		assert.throws(() => boardFor({ id: paths.workspaceId(folder), folder, name: "unsafe" }), /symlink/);
		assert.equal(existsSync(join(elsewhere, "default")), false, "nothing was written through the link");
	} finally {
		rmSync(folder, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test("a repository gets local excludes, a non-Git folder answers false, and no tracked file is touched", () => {
	const repo = scratchRepo();
	const plain = mkdtempSync(join(tmpdir(), "pi-studio-plain-"));
	try {
		assert.equal(ensureStateExcludes(repo), true);
		const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
		for (const line of ["/.agents/", "/.pi-studio/", "**/.pi-studio/"]) assert.ok(exclude.includes(line), `${line} missing`);
		assert.equal(existsSync(join(repo, ".gitignore")), false, "a tracked .gitignore was created");
		assert.equal(git(repo, "status", "--porcelain"), "", "the exclude itself dirtied the tree");
		assert.equal(ensureStateExcludes(plain), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(plain, { recursive: true, force: true });
	}
});
