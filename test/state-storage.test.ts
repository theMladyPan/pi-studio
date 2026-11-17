import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
const { boardFor, flushBoard } = await import("../server/store.ts");
const { describeWorkspace } = await import("../server/workspaces.ts");
const { git, scratchRepo } = await import("../test-support/git.ts");

test("one opened folder holds one plain .pi-studio directory, whatever the global root", () => {
	assert.equal(paths.HAS_EXPLICIT_STATE, true);
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-single-state-"));
	try {
		assert.equal(paths.projectStateDir(folder), join(folder, ".pi-studio"));
		assert.equal(paths.boardFile({ id: "w1", folder }), join(folder, ".pi-studio", "board.json"));
		assert.equal(paths.gitgraphStateFile({ id: "w1", folder }), join(folder, ".pi-studio", "gitgraph.json"));
		// A caller that names only an id keeps the legacy global layout.
		assert.equal(paths.boardFile({ id: "w-unregistered" }), join(paths.STATE_DIR, "boards", "w-unregistered.json"));
		assert.equal(paths.gitgraphStateFile({ id: "w-unregistered" }), join(paths.STATE_DIR, "gitgraph", "w-unregistered.json"));
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
		const destSession = join(paths.projectStateDir(folder), "sessions", `2026-01-01_${id}.jsonl`);
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
		assert.equal(existsSync(join(elsewhere, "board.json")), false, "nothing was written through the link");
	} finally {
		rmSync(folder, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test("a refused import is not remembered, so fixing the path lets it retry", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-import-retry-"));
	const elsewhere = mkdtempSync(join(tmpdir(), "pi-studio-import-retry-target-"));
	try {
		const id = paths.workspaceId(folder);
		const workspace = { id, folder, name: "retry" };
		mkdirSync(join(stateHome, "boards"), { recursive: true });
		writeFileSync(join(stateHome, "boards", `${id}.json`), JSON.stringify({ version: 1, threads: [] }));
		symlinkSync(elsewhere, join(folder, ".pi-studio"));
		assert.throws(() => storage.importLegacyProjectState(workspace), /symlink/);
		unlinkSync(join(folder, ".pi-studio"));
		storage.importLegacyProjectState(workspace);
		assert.equal(readFileSync(paths.boardFile(workspace), "utf8"), JSON.stringify({ version: 1, threads: [] }), "the retry did not copy the legacy board");
	} finally {
		rmSync(folder, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test("a retired transcript is not copied back from the legacy original on a later start", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-retired-import-"));
	try {
		const id = paths.workspaceId(folder);
		const workspace = { id, folder, name: "retired" };
		mkdirSync(join(stateHome, "sessions", id), { recursive: true });
		const legacySession = join(stateHome, "sessions", id, `2026-01-01_${id}.jsonl`);
		const transcript = `${JSON.stringify({ type: "session", cwd: folder })}\n${JSON.stringify({ type: "message" })}\n`;
		writeFileSync(legacySession, transcript);

		storage.importLegacyProjectState(workspace);
		const copied = join(paths.projectStateDir(folder), "sessions", `2026-01-01_${id}.jsonl`);
		assert.equal(readFileSync(copied, "utf8"), transcript, "the transcript was not copied whole");
		assert.equal(lstatSync(paths.legacyImportMarker(workspace)).isFile(), true, "the completed import was not recorded on disk");

		// The human retires the transcript from the new home, which is the only copy they see.
		unlinkSync(copied);
		// A daemon started after that has no memory of the earlier pass, and the legacy original is still there.
		storage.resetImportCacheForTests();
		storage.importLegacyProjectState(workspace);

		assert.equal(existsSync(copied), false, "the retired transcript was copied back from the legacy original");
		assert.equal(readFileSync(legacySession, "utf8"), transcript, "the legacy original was not preserved");
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a marker that cannot be written leaves the import retryable", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-import-marker-"));
	try {
		const id = paths.workspaceId(folder);
		const workspace = { id, folder, name: "marker" };
		mkdirSync(join(stateHome, "boards"), { recursive: true });
		const boardJson = JSON.stringify({ version: 1, threads: [] });
		writeFileSync(join(stateHome, "boards", `${id}.json`), boardJson);
		// A directory standing where the marker belongs: the copy lands, the record of it cannot be written.
		const marker = paths.legacyImportMarker(workspace);
		mkdirSync(marker, { recursive: true });
		writeFileSync(join(marker, "keep.txt"), "keep\n");

		storage.resetImportCacheForTests();
		storage.importLegacyProjectState(workspace);
		assert.equal(readFileSync(paths.boardFile(workspace), "utf8"), boardJson, "the refused marker also refused the copy");

		// The obstruction is cleared, and the next start completes the pass and records it.
		rmSync(marker, { recursive: true, force: true });
		storage.resetImportCacheForTests();
		storage.importLegacyProjectState(workspace);
		assert.equal(lstatSync(marker).isFile(), true, "the retry did not write the marker");

		// And a deleted board stays deleted now that the pass is recorded.
		unlinkSync(paths.boardFile(workspace));
		storage.resetImportCacheForTests();
		storage.importLegacyProjectState(workspace);
		assert.equal(existsSync(paths.boardFile(workspace)), false, "a deleted board was copied back after the marker was written");
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a recent whose import completed is never answered for by the legacy files again", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-imported-described-"));
	try {
		const id = paths.workspaceId(folder);
		const workspace = { id, folder, name: "imported", openedAt: 1 };
		mkdirSync(join(stateHome, "boards"), { recursive: true });
		mkdirSync(join(stateHome, "sessions", id), { recursive: true });
		const legacyBoard = join(stateHome, "boards", `${id}.json`);
		writeFileSync(legacyBoard, JSON.stringify({ version: 1, threads: [{ id: "t1" }, { id: "t2" }], activity: [{ id: "a1", label: "old", at: 1 }] }));
		writeFileSync(join(stateHome, "sessions", id, `2026-01-01_${id}.jsonl`), `${JSON.stringify({ type: "message" })}\n`);
		storage.importLegacyProjectState(workspace);

		// The human deletes the imported board and its transcripts, keeping the project folder itself.
		unlinkSync(paths.boardFile(workspace));
		rmSync(join(paths.projectStateDir(folder), "sessions"), { recursive: true, force: true });
		const described = describeWorkspace(workspace);

		assert.equal(described.threadCount, 0, "the deleted board came back as old history");
		assert.equal(described.lastActivity, null, "the deleted board's last activity came back");
		assert.equal(described.sessions.count, 0, "the retired transcripts came back as old history");
		assert.ok(existsSync(legacyBoard), "the legacy original was not preserved");
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a save after the project folder is gone does not make the folder again", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-save-gone-"));
	try {
		const id = paths.workspaceId(folder);
		const board = { id, folder, name: "gone", threads: new Map(), cards: new Map(), activity: [], trees: [] };
		flushBoard(board);
		assert.ok(existsSync(paths.boardFile(board)), "the board of a folder that exists was not written");

		// The human deletes the project, and the shutdown flush reaches for its board anyway.
		rmSync(folder, { recursive: true, force: true });
		flushBoard(board);

		assert.equal(existsSync(folder), false, "a save made the deleted project folder again");
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a restored board gets local excludes too, and unrelated exclude lines are preserved", () => {
	const repo = scratchRepo();
	try {
		const excludePath = join(repo, ".git", "info", "exclude");
		writeFileSync(excludePath, `${readFileSync(excludePath, "utf8")}# mine\n*.log\n`);
		boardFor({ id: paths.workspaceId(repo), folder: repo, name: "restored" });
		const exclude = readFileSync(excludePath, "utf8");
		assert.ok(exclude.includes("# mine\n*.log\n"), "unrelated exclude content was lost");
		for (const line of ["/.agents/", "/.pi-studio/", "**/.pi-studio/"]) assert.ok(exclude.includes(line), `${line} missing`);
		assert.equal(existsSync(join(repo, ".gitignore")), false, "a tracked .gitignore was created");
		assert.equal(git(repo, "status", "--porcelain"), "", "the opened folder dirtied the tree");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a planted temporary path beside the git exclude is never written through", () => {
	const repo = scratchRepo();
	const elsewhere = mkdtempSync(join(tmpdir(), "pi-studio-exclude-target-"));
	try {
		const excludePath = join(repo, ".git", "info", "exclude");
		const outside = join(elsewhere, "keep.txt");
		writeFileSync(outside, "outside\n");
		// The name a temporary beside the exclude has carried, planted by someone else beforehand.
		const planted = `${excludePath}.${process.pid}.tmp`;
		symlinkSync(outside, planted);
		assert.equal(ensureStateExcludes(repo), true);
		assert.equal(readFileSync(outside, "utf8"), "outside\n", "the planted link's target was not written through");
		assert.equal(lstatSync(planted).isSymbolicLink(), true, "a link this call did not create is left alone");
		assert.equal(lstatSync(excludePath).isFile(), true, "the exclude is a plain file of its own");
		const exclude = readFileSync(excludePath, "utf8");
		for (const line of ["/.agents/", "/.pi-studio/", "**/.pi-studio/"]) assert.ok(exclude.includes(line), `${line} missing`);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test("the crossroads keeps legacy counts for a recent that was never reopened, and creates no state for it", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-legacy-described-"));
	const missing = join(folder, "gone-missing");
	try {
		for (const target of [folder, missing]) {
			const id = paths.workspaceId(target);
			mkdirSync(join(stateHome, "boards"), { recursive: true });
			mkdirSync(join(stateHome, "sessions", id), { recursive: true });
			writeFileSync(
				join(stateHome, "boards", `${id}.json`),
				JSON.stringify({ version: 1, threads: [{ id: "t1" }, { id: "t2" }], activity: [{ id: "a1", label: "did a thing", at: 123 }] }),
			);
			writeFileSync(join(stateHome, "sessions", id, `2026-01-01_${id}.jsonl`), `${JSON.stringify({ type: "message" })}\n`);
			const described = describeWorkspace({ id, folder: target, name: "legacy", openedAt: 1 });
			assert.equal(described.threadCount, 2, "the legacy thread count was lost");
			assert.deepEqual(described.lastActivity, { label: "did a thing", at: 123 });
			assert.equal(described.sessions.count, 1, "the legacy session count was lost");
		}
		assert.equal(existsSync(join(folder, ".pi-studio")), false, "describing a recent created project state");
		assert.equal(existsSync(missing), false, "describing a missing recent created its folder");
	} finally {
		rmSync(folder, { recursive: true, force: true });
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
