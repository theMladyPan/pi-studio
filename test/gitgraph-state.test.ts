import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The state folder is resolved once, when `server/paths.ts` is first imported, so this file sets it
 * before any view code is loaded and then loads that code dynamically — the same reason
 * `test/store-load.test.ts` is a file of its own. Everything written here lands under `tmpdir()`.
 */
const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-state-"));
process.env.PI_STUDIO_STATE = stateHome;

const paths = await import("../server/paths.ts");
const state = await import("../server/git/gitgraph/state.ts");

/** A folder that exists, which is what a repository path in the state file has to be. */
const repoFolder = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-repo-"));
const otherFolder = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-repo-"));

const day = 24 * 60 * 60 * 1000;

/** What is on disk for one workspace, read the way a restarted daemon would read it. */
function stored(ws: { id: string }): Record<string, unknown> {
	return JSON.parse(readFileSync(paths.gitgraphStateFile(ws), "utf8")) as Record<string, unknown>;
}

/** A fresh workspace id per test, so one test's cached state is never another's. */
function freshWorkspace(id: string) {
	state.resetStateCacheForTests();
	return { id };
}

test("a workspace nobody has opened the view in starts from the defaults", () => {
	const ws = freshWorkspace("w-defaults");
	const loaded = state.stateFor(ws);
	assert.deepEqual(loaded.globalViewState, state.DEFAULT_GLOBAL_VIEW_STATE);
	assert.deepEqual(loaded.workspaceViewState, state.DEFAULT_WORKSPACE_VIEW_STATE);
	assert.deepEqual(loaded.repos, {});
	assert.deepEqual(loaded.codeReviews, {});
	assert.equal(existsSync(paths.gitgraphStateFile(ws)), false, "reading a state must not write one");
});

test("a change is written once, on the debounce, and reads back after a restart", async () => {
	const ws = freshWorkspace("w-debounce");
	const loaded = state.stateFor(ws);
	loaded.workspaceViewState.findIsRegex = true;
	loaded.repos[repoFolder] = { ...state.DEFAULT_REPO_STATE, name: "mine", showTags: 1 };
	state.scheduleStateSave(ws);
	state.scheduleStateSave(ws);
	assert.equal(existsSync(paths.gitgraphStateFile(ws)), false, "the write is on a timer, not immediate");
	await new Promise((resolve) => setTimeout(resolve, 700));
	const written = stored(ws);
	assert.equal((written.workspaceViewState as Record<string, unknown>).findIsRegex, true);
	const repos = written.repos as Record<string, Record<string, unknown>>;
	assert.equal(repos[repoFolder].name, "mine");
	// A restart reads the same file back, which is the whole point of writing it.
	state.resetStateCacheForTests();
	const reloaded = state.stateFor(ws);
	assert.equal(reloaded.workspaceViewState.findIsRegex, true);
	assert.equal(reloaded.repos[repoFolder].name, "mine");
});

test("flushing writes now, and cancels the write that was pending", async () => {
	const ws = freshWorkspace("w-flush");
	const loaded = state.stateFor(ws);
	loaded.workspaceViewState.findIsCaseSensitive = true;
	state.scheduleStateSave(ws);
	state.flushState(ws.id);
	assert.equal((stored(ws).workspaceViewState as Record<string, unknown>).findIsCaseSensitive, true);
	loaded.workspaceViewState.findIsCaseSensitive = false;
	await new Promise((resolve) => setTimeout(resolve, 700));
	// The pending timer was cleared by the flush, so the file still says what the flush wrote.
	assert.equal((stored(ws).workspaceViewState as Record<string, unknown>).findIsCaseSensitive, true);
});

test("a repository that is gone is dropped when its state is read back", () => {
	const ws = freshWorkspace("w-missing-repo");
	paths.writeJsonFile(paths.gitgraphStateFile(ws), {
		repos: {
			"/no/such/folder/any/more": { name: "gone", showTags: 1 },
			[repoFolder]: { name: "here", showTags: 1 },
		},
		codeReviews: {},
	});
	const loaded = state.stateFor(ws);
	assert.deepEqual(Object.keys(loaded.repos), [repoFolder]);
	assert.equal(loaded.repos[repoFolder].name, "here");
});

test("a code review nobody has touched in three months is dropped", () => {
	const ws = freshWorkspace("w-old-reviews");
	const now = Date.now();
	paths.writeJsonFile(paths.gitgraphStateFile(ws), {
		repos: {},
		codeReviews: {
			[repoFolder]: {
				stale: { lastActive: now - 91 * day, lastViewedFile: null, remainingFiles: ["a.ts"] },
				fresh: { lastActive: now - 89 * day, lastViewedFile: "b.ts", remainingFiles: ["b.ts"] },
			},
		},
	});
	const loaded = state.stateFor(ws);
	assert.deepEqual(Object.keys(loaded.codeReviews[repoFolder]), ["fresh"]);
	assert.equal(loaded.codeReviews[repoFolder].fresh.lastViewedFile, "b.ts");
});

test("one repository keeps only its fifty newest reviews", () => {
	const ws = freshWorkspace("w-many-reviews");
	const now = Date.now();
	const reviews: Record<string, Record<string, unknown>> = {};
	for (let at = 0; at < 55; at += 1) {
		reviews[`review-${at}`] = { lastActive: now - at * 1000, lastViewedFile: null, remainingFiles: [`f${at}.ts`] };
	}
	paths.writeJsonFile(paths.gitgraphStateFile(ws), { repos: {}, codeReviews: { [repoFolder]: reviews } });
	const kept = state.stateFor(ws).codeReviews[repoFolder];
	assert.equal(Object.keys(kept).length, 50);
	assert.equal(typeof kept["review-0"], "object", "the newest review is kept");
	assert.equal(kept["review-49"] !== undefined, true);
	assert.equal(kept["review-50"], undefined, "the oldest reviews are the ones that go");
	assert.equal(kept["review-54"], undefined);
});

test("a state file that says nonsense reads back as the defaults rather than as nonsense", () => {
	const ws = freshWorkspace("w-garbage");
	paths.writeJsonFile(paths.gitgraphStateFile(ws), {
		globalViewState: "yes please",
		workspaceViewState: { findIsRegex: "sometimes" },
		repos: { [otherFolder]: { cdvHeight: "tall", commitOrdering: "sideways", fileViewType: 9, hideRemotes: "origin", columnWidths: ["a"] } },
		codeReviews: { [otherFolder]: { "abc1234": { lastActive: "yesterday" } } },
	});
	const loaded = state.stateFor(ws);
	assert.deepEqual(loaded.globalViewState, state.DEFAULT_GLOBAL_VIEW_STATE);
	assert.equal(loaded.workspaceViewState.findIsRegex, false);
	const repo = loaded.repos[otherFolder];
	assert.equal(repo.cdvHeight, state.DEFAULT_REPO_STATE.cdvHeight);
	assert.equal(repo.commitOrdering, "default");
	assert.equal(repo.fileViewType, 0);
	assert.deepEqual(repo.hideRemotes, []);
	assert.equal(repo.columnWidths, null);
	assert.deepEqual(loaded.codeReviews, {});
});

test("two workspaces keep two files", () => {
	state.resetStateCacheForTests();
	const first = { id: "w-first" };
	const second = { id: "w-second" };
	state.stateFor(first).workspaceViewState.findOpenCommitDetailsView = true;
	state.stateFor(second).workspaceViewState.findOpenCommitDetailsView = false;
	state.flushState(first.id);
	state.flushState(second.id);
	assert.notEqual(paths.gitgraphStateFile(first), paths.gitgraphStateFile(second));
	assert.equal((stored(first).workspaceViewState as Record<string, unknown>).findOpenCommitDetailsView, true);
	const other = JSON.parse(readFileSync(paths.gitgraphStateFile(second), "utf8")) as Record<string, Record<string, unknown>>;
	assert.equal(other.workspaceViewState.findOpenCommitDetailsView, false);
});

test("a Git view save after the project folder is gone does not make the folder again", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-gone-"));
	try {
		const ws = freshWorkspace("w-gone-folder");
		const workspace = { id: ws.id, folder };
		state.stateFor(workspace);
		state.flushState(workspace.id);
		assert.ok(existsSync(paths.gitgraphStateFile(workspace)), "the state of a folder that exists was not written");

		// The human deletes the project, and the shutdown flush reaches for its view state anyway.
		rmSync(folder, { recursive: true, force: true });
		state.flushState(workspace.id);

		assert.equal(existsSync(folder), false, "a flush made the deleted project folder again");
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("the file lives under the state folder, one per workspace", () => {
	const ws = { id: "w-path" };
	assert.equal(paths.gitgraphStateFile(ws), join(paths.STATE_DIR, "gitgraph", "w-path.json"));
	mkdirSync(join(stateHome, "gitgraph"), { recursive: true });
	assert.equal(paths.STATE_DIR, stateHome, "the temporary folder is the one the view code reads");
});
