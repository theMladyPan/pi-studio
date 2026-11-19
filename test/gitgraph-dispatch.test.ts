import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-dispatch-"));
process.env.PI_STUDIO_STATE = stateHome;

const dispatch = await import("../server/git/gitgraph/dispatch.ts");
const state = await import("../server/git/gitgraph/state.ts");
const { git, scratchRepo } = await import("../test-support/git.ts");

const repo = realpathSync(scratchRepo());
const board = { id: "w-dispatch", folder: repo, trees: [], threads: new Map(), children: new Map() };
const elsewhere = join(tmpdir(), "pi-studio-gitgraph-not-open");

async function one(request: unknown): Promise<Record<string, unknown>> {
	const replies = await dispatch.respond(board, request);
	assert.equal(replies.length, 1, `expected one reply, got ${replies.length}`);
	return replies[0] as Record<string, unknown>;
}

test("a request that is not a request is answered with the reason, not thrown", async () => {
	const replies = await dispatch.respond(board, "not an object");
	assert.equal(replies.length, 1);
	assert.equal(replies[0].command, "repositoryStatus");
	const unknown = await one({ command: "frobnicate" });
	assert.equal(unknown.command, "frobnicate");
	assert.equal(unknown.status, "This tab cannot do that yet.");
});

test("loadRepoInfo answers in the Libre shape", async () => {
	const info = await one({ command: "loadRepoInfo", requestId: 41, repo, showStashes: true });
	assert.equal(info.command, "loadRepoInfo");
	assert.equal(info.requestId, 41);
	const repoInfo = info.repoInfo as { isRepo: boolean; head: string | null; stashes: unknown[] };
	assert.equal(repoInfo.isRepo, true);
	assert.equal(repoInfo.head, "dev");
	assert.equal(info.error, null);
});

test("loadCommits answers in the Libre shape, with the uncommitted row only when the tree is dirty", async () => {
	const commits = await one({
		command: "loadCommits",
		requestId: 42,
		repo,
		branchName: "dev",
		maxCommits: 10,
		showRemoteBranches: true,
		showTags: true,
		includeReflog: false,
		onlyFollowFirstParent: false,
		commitOrdering: "date",
	});
	assert.equal(commits.command, "loadCommits");
	assert.equal(commits.requestId, 42);
	assert.equal(commits.error, null);
	const rows = commits.commits as Array<{ hash: string; message: string; parentHashes: string[]; refs: unknown[] }>;
	assert.ok(rows.every((row) => row.hash !== "*"), "a clean tree has no uncommitted row");
	assert.equal(rows[0].message, "first");
	writeFileSync(join(repo, "dirty.txt"), "not committed\n");
	try {
		const dirty = await one({ command: "loadCommits", requestId: 43, repo, branchName: "dev", maxCommits: 10, showRemoteBranches: true, showTags: true, includeReflog: false, onlyFollowFirstParent: false, commitOrdering: "date" });
		const dirtyRows = dirty.commits as Array<{ hash: string; message: string }>;
		assert.equal(dirtyRows[0].hash, "*");
		assert.equal(dirtyRows[0].message, "Uncommitted Changes (1)");
		assert.equal(dirtyRows[1].message, "first");
	} finally {
		rmSync(join(repo, "dirty.txt"));
	}
});

test("a repository this tab no longer has is refused in one sentence", async () => {
	const replies = await dispatch.respond(board, { command: "loadRepoInfo", requestId: 1, repo: elsewhere, showStashes: false });
	assert.equal(replies.length, 1);
	assert.equal(((replies[0] as unknown) as { error: { message: string } }).error.message, "That repository is no longer open in this tab.");
});

test("a command this tab still has no way to run is answered with one sentence", async () => {
	const reply = await one({ command: "createArchive", repo, ref: "HEAD" });
	assert.equal(reply.status, "This tab cannot do that yet.");
	assert.equal(dispatch.UNAVAILABLE["createArchive"], "This tab cannot do that yet.");
});

test("commit details and tag details answer in the Libre shape", async () => {
	const head = git(repo, "rev-parse", "HEAD");
	const details = await one({ command: "commitDetails", repo, commitHash: head });
	const held = details.commitDetails as { hash: string; fileChanges: unknown[] };
	assert.equal(held.hash, head);
	assert.ok(held.fileChanges.length > 0);
	git(repo, "tag", "-a", "a-tag", "-m", "a tag made by the test");
	const tag = await one({ command: "tagDetails", repo, tagName: "a-tag" });
	assert.equal(tag.error, null);
	assert.equal((tag.tagDetails as { tagName: string }).tagName, "a-tag");
});

test("the repository dropdown is answered with a state per repository and the one to open on", async () => {
	state.stateFor(board).repos[repo] = { ...state.DEFAULT_REPO_STATE, displayName: "renamed by the page" };
	state.stateFor(board).lastActiveRepo = repo;
	const reply = await one({ command: "loadRepos", check: true });
	assert.equal(reply.command, "loadRepos");
	const repos = reply.repos as Record<string, { displayName: string | null }>;
	assert.deepEqual(Object.keys(repos), [repo]);
	assert.equal(repos[repo].displayName, "renamed by the page");
	assert.equal(reply.lastActiveRepo, repo);
});

test("saveRepoState keeps the state the page sent", async () => {
	// saveRepoState answers no reply in Libre; the check is the persisted state.
	const replies = await dispatch.respond(board, { command: "saveRepoState", repo, state: { ...state.DEFAULT_REPO_STATE, displayName: "renamed again", showTags: "enabled" } });
	assert.equal(replies.length, 0);
	const kept = state.stateFor(board);
	assert.equal(kept.repos[repo].displayName, "renamed again");
	assert.equal(kept.lastActiveRepo, repo);
});
