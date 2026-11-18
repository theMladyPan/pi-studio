import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-state-"));
process.env.PI_STUDIO_STATE = stateHome;

const paths = await import("../server/paths.ts");
const state = await import("../server/git/gitgraph/state.ts");

const repoFolder = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-repo-"));
const otherFolder = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-repo-"));

function stored(ws: { id: string }): Record<string, unknown> {
	return JSON.parse(readFileSync(paths.gitgraphStateFile(ws), "utf8")) as Record<string, unknown>;
}
function freshWorkspace(id: string) {
	state.resetStateCacheForTests();
	return { id };
}

test("a stored showTags of disabled, or the legacy 0, reads back as default so tags stay visible", () => {
	assert.equal(state.repoStateFrom({ showTags: "disabled" }).showTags, "default");
	assert.equal(state.repoStateFrom({ showTags: 0 }).showTags, "default");
	assert.equal(state.repoStateFrom({ showTags: "enabled" }).showTags, "enabled");
	assert.equal(state.repoStateFrom({ showTags: 1 }).showTags, "enabled");
});

test("a workspace nobody has opened the view in starts from the defaults", () => {
	const ws = freshWorkspace("w-defaults");
	const loaded = state.stateFor(ws);
	assert.deepEqual(loaded.repos, {});
	assert.equal(loaded.lastActiveRepo, null);
	assert.equal(existsSync(paths.gitgraphStateFile(ws)), false, "reading a state must not write one");
});

test("a change is written once, on the debounce, and reads back after a restart", async () => {
	const ws = freshWorkspace("w-debounce");
	const loaded = state.stateFor(ws);
	loaded.repos[repoFolder] = { ...state.DEFAULT_REPO_STATE, displayName: "mine", showTags: "enabled" };
	state.scheduleStateSave(ws);
	state.scheduleStateSave(ws);
	assert.equal(existsSync(paths.gitgraphStateFile(ws)), false, "the write is on a timer, not immediate");
	await new Promise((resolve) => setTimeout(resolve, 700));
	const written = stored(ws);
	const repos = written.repos as Record<string, Record<string, unknown>>;
	assert.equal(repos[repoFolder].displayName, "mine");
	state.resetStateCacheForTests();
	const reloaded = state.stateFor(ws);
	assert.equal(reloaded.repos[repoFolder].displayName, "mine");
	assert.equal(reloaded.repos[repoFolder].showTags, "enabled");
});

test("flushing writes now, and cancels the write that was pending", async () => {
	const ws = freshWorkspace("w-flush");
	const loaded = state.stateFor(ws);
	loaded.repos[repoFolder] = { ...state.DEFAULT_REPO_STATE, displayName: "flushed" };
	state.scheduleStateSave(ws);
	state.flushState(ws.id);
	assert.equal((stored(ws).repos as Record<string, Record<string, unknown>>)[repoFolder].displayName, "flushed");
	loaded.repos[repoFolder].displayName = "changed";
	await new Promise((resolve) => setTimeout(resolve, 700));
	assert.equal((stored(ws).repos as Record<string, Record<string, unknown>>)[repoFolder].displayName, "flushed");
});

test("a repository that is gone is dropped when its state is read back", () => {
	const ws = freshWorkspace("w-missing-repo");
	paths.writeJsonFile(paths.gitgraphStateFile(ws), {
		repos: {
			"/no/such/folder/any/more": { displayName: "gone" },
			[repoFolder]: { displayName: "here" },
		},
	});
	const loaded = state.stateFor(ws);
	assert.deepEqual(Object.keys(loaded.repos), [repoFolder]);
	assert.equal(loaded.repos[repoFolder].displayName, "here");
});

test("a state file that says nonsense reads back as the defaults rather than as nonsense", () => {
	const ws = freshWorkspace("w-garbage");
	paths.writeJsonFile(paths.gitgraphStateFile(ws), {
		repos: { [otherFolder]: { columnWidths: ["a"], commitOrdering: "sideways", hiddenRemotes: "origin", displayName: 7 } },
		lastActiveRepo: 42,
	});
	const loaded = state.stateFor(ws);
	const repo = loaded.repos[otherFolder];
	assert.equal(repo.columnWidths, null);
	assert.equal(repo.commitOrdering, "date");
	assert.deepEqual(repo.hiddenRemotes, []);
	assert.equal(repo.displayName, null);
	assert.equal(loaded.lastActiveRepo, null);
});

test("two workspaces keep two files", () => {
	state.resetStateCacheForTests();
	const first = { id: "w-first" };
	const second = { id: "w-second" };
	state.stateFor(first).repos[repoFolder] = { ...state.DEFAULT_REPO_STATE, displayName: "first" };
	state.stateFor(second).repos[repoFolder] = { ...state.DEFAULT_REPO_STATE, displayName: "second" };
	state.flushState(first.id);
	state.flushState(second.id);
	assert.notEqual(paths.gitgraphStateFile(first), paths.gitgraphStateFile(second));
	const other = JSON.parse(readFileSync(paths.gitgraphStateFile(second), "utf8")) as Record<string, Record<string, unknown>>;
	assert.equal((other.repos as Record<string, Record<string, unknown>>)[repoFolder].displayName, "second");
});

test("a Git view save after the project folder is gone does not make the folder again", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-gone-"));
	try {
		const ws = freshWorkspace("w-gone-folder");
		const workspace = { id: ws.id, folder };
		state.stateFor(workspace);
		state.flushState(workspace.id);
		assert.ok(existsSync(paths.gitgraphStateFile(workspace)), "the state of a folder that exists was not written");
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
