import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The state folder is resolved once, when `server/paths.ts` is first imported, so this file sets it
 * before any view code is loaded and then loads that code dynamically — the same reason
 * `test/gitgraph-state.test.ts` is a file of its own.
 */
const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-dispatch-"));
process.env.PI_STUDIO_STATE = stateHome;

const dispatch = await import("../server/git/gitgraph/dispatch.ts");
const state = await import("../server/git/gitgraph/state.ts");
const protocol = await import("../server/git/gitgraph/protocol.ts");
const { git, scratchRepo } = await import("../test-support/git.ts");

const repo = realpathSync(scratchRepo());
const board = { id: "w-dispatch", folder: repo, trees: [], threads: new Map(), children: new Map() };
const elsewhere = join(tmpdir(), "pi-studio-gitgraph-not-open");

/** One reply, for the commands that only ever answer once. */
async function one(request: unknown): Promise<Record<string, unknown>> {
	const replies = await dispatch.respond(board, request);
	assert.equal(replies.length, 1, `expected one reply, got ${replies.length}`);
	return replies[0];
}

test("a request that is not a request is answered with the reason, not thrown", async () => {
	assert.deepEqual(await dispatch.respond(board, "not an object"), [{ command: "", error: "a request must be an object" }]);
	const unknown = await one({ command: "frobnicate" });
	assert.equal(unknown.command, "frobnicate");
	assert.match(String(unknown.error), /Unsupported command: frobnicate/);
});

test("the loadCommits message the bundle sends is answered, and a stashed commit comes back marked", async () => {
	/**
	 * A repository of its own, because the graph of the one above is asserted without a stash in it. The
	 * request below is the page's message field for field: `this.gitStashes` is the list `loadRepoInfo`
	 * handed the page, and asking for the graph with it is what the page does on every refresh.
	 */
	const stashed = realpathSync(scratchRepo());
	try {
		writeFileSync(join(stashed, "wip.txt"), "not committed\n");
		writeFileSync(join(stashed, "kept-untracked.txt"), "neither\n");
		git(stashed, "add", "wip.txt");
		// Untracked files beside the change, so the stash's list entry carries the `^3` revision this
		// daemon hands out and the page hands straight back.
		git(stashed, "stash", "push", "-u", "-m", "wip");
		const graphs = { id: "w-stashed", folder: stashed, trees: [], threads: new Map(), children: new Map() };
		const info = await dispatch.respond(graphs, { command: "loadRepoInfo", repo: stashed, refreshId: 1, showRemoteBranches: false, showStashes: true, hideRemotes: [] });
		const stashes = info[0].stashes as Array<{ selector: string; baseHash: string; untrackedFilesHash: string | null }>;
		assert.equal(stashes.length, 1, "the page can only send what the repository info listed");
		assert.match(stashes[0].untrackedFilesHash ?? "", /^[0-9a-f]{40}\^3$/);

		const replies = await dispatch.respond(graphs, {
			command: "loadCommits",
			repo: stashed,
			refreshId: 2,
			branches: null,
			maxCommits: 300,
			showTags: true,
			showRemoteBranches: false,
			includeCommitsMentionedByReflogs: false,
			onlyFollowFirstParent: false,
			commitOrdering: "date",
			remotes: [],
			hideRemotes: [],
			stashes,
		});
		assert.equal(replies.length, 1);
		const reply = replies[0];
		assert.equal(reply.error, null);
		assert.equal(reply.refreshId, 2);
		const rows = reply.commits as Array<{ hash: string; stash: { selector: string; baseHash: string } | null }>;
		const marked = rows.find((row) => row.stash !== null);
		assert.equal(marked?.hash, stashes[0].baseHash);
		assert.equal(marked?.stash?.selector, "stash@{0}");
	} finally {
		rmSync(stashed, { recursive: true, force: true });
	}
});

test("a repository this tab no longer has is refused in one sentence", async () => {
	const reply = await one({ command: "loadRepoInfo", repo: elsewhere, refreshId: 1, showRemoteBranches: true, showStashes: false, hideRemotes: [] });
	assert.equal(reply.error, "That repository is no longer open in this tab.");
});

test("loadRepoInfo and loadCommits echo the refreshId the page is waiting for", async () => {
	const info = await one({ command: "loadRepoInfo", repo, refreshId: 41, showRemoteBranches: true, showStashes: true, hideRemotes: [] });
	assert.equal(info.refreshId, 41);
	assert.equal(info.isRepo, true);
	assert.deepEqual(info.branches, ["dev"]);
	assert.equal(info.head, "dev");
	assert.equal(info.error, null);

	const commits = await one({
		command: "loadCommits",
		repo,
		refreshId: 42,
		branches: null,
		maxCommits: 10,
		showTags: true,
		showRemoteBranches: true,
		includeCommitsMentionedByReflogs: false,
		onlyFollowFirstParent: true,
		commitOrdering: "date",
		remotes: [],
		hideRemotes: [],
		stashes: [],
	});
	assert.equal(commits.refreshId, 42);
	assert.equal(commits.error, null);
	assert.equal(commits.onlyFollowFirstParent, true);
	const rows = commits.commits as Array<{ hash: string; message: string }>;
	assert.equal(rows[0].hash, protocol.UNCOMMITTED);
	assert.equal(rows[1].message, "first");
});

test("a command this tab still has no way to run is answered with one sentence and no git call at all", async () => {
	const reply = await one({ command: "createArchive", repo, ref: "HEAD" });
	assert.equal(reply.error, "This tab cannot do that yet.");
	for (const command of ["openTerminal", "createPullRequest", "exportRepoConfig", "deleteRemoteBranch"]) {
		assert.equal(dispatch.UNAVAILABLE[command], "This tab cannot do that yet.");
	}
});

test("the page's own copy and open commands are acknowledged without a daemon doing anything", async () => {
	for (const request of [
		{ command: "copyToClipboard", type: "hash", data: "abc1234" },
		{ command: "copyFilePath", repo, filePath: "readme.md", absolute: false },
		{ command: "openExternalUrl", url: "https://example.invalid/issue/1" },
	]) {
		const reply = await one(request);
		assert.deepEqual(reply, { command: request.command, error: null });
	}
});

test("the configuration is read for the repository the page named", async () => {
	const reply = await one({ command: "loadConfig", repo, remotes: [] });
	assert.equal(reply.command, "loadConfig");
	assert.equal(reply.repo, repo);
	assert.equal(reply.error, null);
	const config = reply.config as { user: { name: { local: string } } };
	assert.equal(config.user.name.local, "test");
});

test("a commit's details, a comparison and a tag are answered in the page's field names", async () => {
	const head = git(repo, "rev-parse", "HEAD");
	const details = await one({ command: "commitDetails", repo, commitHash: head, hasParents: false, stash: null, avatarEmail: null, refresh: false });
	assert.equal(details.error, null);
	assert.equal(details.avatar, null);
	assert.equal(details.codeReview, null);
	assert.equal(details.refresh, false);
	const held = details.commitDetails as { hash: string; fileChanges: unknown[] };
	assert.equal(held.hash, head);
	assert.ok(held.fileChanges.length > 0);

	const uncommitted = await one({ command: "commitDetails", repo, commitHash: protocol.UNCOMMITTED, hasParents: false, stash: null, avatarEmail: null, refresh: true });
	assert.equal(uncommitted.error, null);
	assert.equal((uncommitted.commitDetails as { hash: string }).hash, protocol.UNCOMMITTED);

	const comparison = await one({ command: "compareCommits", repo, commitHash: head, compareWithHash: head, fromHash: head, toHash: head, refresh: false });
	assert.equal(comparison.error, null);
	assert.equal(comparison.compareWithHash, head);

	git(repo, "tag", "-a", "a-tag", "-m", "a tag made by the test");
	const tag = await one({ command: "tagDetails", repo, tagName: "a-tag", commitHash: head });
	assert.equal(tag.error, null);
	assert.equal(tag.name, "test");
	assert.equal(tag.message, "a tag made by the test");
	assert.equal(tag.commitHash, head);
});

test("a view reply carries its text, and a refused one carries the sentence", async () => {
	const shown = await one({ command: "viewFileAtRevision", repo, hash: protocol.UNCOMMITTED, filePath: "readme.md" });
	assert.equal(shown.error, null);
	const view = shown.view as { kind: string; content: string; title: string };
	assert.equal(view.kind, "file");
	assert.equal(view.content, "hello\n");
	assert.match(view.title, /readme\.md/);

	const refused = await one({ command: "viewFileAtRevision", repo, hash: "HEAD", filePath: "no-such-file" });
	assert.equal(refused.view, undefined);
	assert.ok(typeof refused.error === "string" && refused.error.length > 0);

	// An untracked file has no revision on either side, and its diff is built from its own bytes.
	writeFileSync(join(repo, "just-made.txt"), "made a moment ago\n");
	const diff = await one({ command: "viewDiff", repo, fromHash: protocol.UNCOMMITTED, toHash: protocol.UNCOMMITTED, oldFilePath: "just-made.txt", newFilePath: "just-made.txt", type: "U" });
	assert.equal(diff.error, null);
	assert.match((diff.view as { content: string }).content, /^\+made a moment ago$/m);
});

test("the view state the page saves is kept, and the last repository it saved becomes the active one", async () => {
	const saved = state.stateFor(board);
	saved.repos[repo] = { ...state.DEFAULT_REPO_STATE, name: "mine" };
	const reply = await one({ command: "setRepoState", repo, state: { ...state.DEFAULT_REPO_STATE, name: "renamed by the page", showTags: 1 } });
	assert.deepEqual(reply, { command: "setRepoState", error: null });
	const kept = state.stateFor(board);
	assert.equal(kept.repos[repo].name, "renamed by the page");
	assert.equal(kept.repos[repo].showTags, 1);
	assert.equal(kept.lastActiveRepo, repo);

	const global = await one({ command: "setGlobalViewState", state: { alwaysAcceptCheckoutCommit: true, issueLinkingConfig: null, pushTagSkipRemoteCheck: false } });
	assert.deepEqual(global, { command: "setGlobalViewState", error: null });
	assert.equal(state.stateFor(board).globalViewState.alwaysAcceptCheckoutCommit, true);

	const workspace = await one({ command: "setWorkspaceViewState", state: { findIsCaseSensitive: true, findIsRegex: false, findOpenCommitDetailsView: false } });
	assert.deepEqual(workspace, { command: "setWorkspaceViewState", error: null });
	assert.equal(state.stateFor(board).workspaceViewState.findIsCaseSensitive, true);
});

test("a code review is started, updated and ended in the state the daemon keeps", async () => {
	const started = await one({
		command: "startCodeReview",
		repo,
		id: "abcdef1",
		commitHash: "abcdef1",
		compareWithHash: null,
		files: ["readme.md", "b.txt"],
		lastViewedFile: "readme.md",
	});
	assert.equal(started.error, null);
	const review = started.codeReview as { id: string; remainingFiles: string[]; lastViewedFile: string };
	assert.deepEqual(review.remainingFiles, ["readme.md", "b.txt"]);
	assert.equal(review.lastViewedFile, "readme.md");
	assert.equal(state.stateFor(board).codeReviews[repo].abcdef1.id, "abcdef1");

	const updated = await one({ command: "updateCodeReview", repo, id: "abcdef1", remainingFiles: ["b.txt"], lastViewedFile: "b.txt" });
	assert.deepEqual(updated, { command: "updateCodeReview", error: null });
	assert.deepEqual(state.stateFor(board).codeReviews[repo].abcdef1.remainingFiles, ["b.txt"]);

	// A commit id this repository does not have is answered with git's own reason, never with a throw.
	const missing = await one({ command: "commitDetails", repo, commitHash: "abcdef1", hasParents: true, stash: null, avatarEmail: null, refresh: false });
	assert.ok(typeof missing.error === "string" && missing.error.length > 0);

	const ended = await one({ command: "endCodeReview", repo, id: "abcdef1" });
	assert.deepEqual(ended, { command: "endCodeReview", error: null });
	assert.equal(state.stateFor(board).codeReviews[repo], undefined);
});

test("a review the state no longer keeps is not written back half-made", async () => {
	const reply = await one({ command: "updateCodeReview", repo, id: "abcdef9", remainingFiles: ["readme.md"], lastViewedFile: null });
	assert.equal(reply.error, "that code review is no longer kept");
});

test("the repository dropdown is answered with a state per repository and the one to open on", async () => {
	state.stateFor(board).repos[repo] = { ...state.DEFAULT_REPO_STATE, name: "renamed by the page" };
	state.stateFor(board).lastActiveRepo = repo;
	const reply = await one({ command: "loadRepos", check: true });
	assert.equal(reply.command, "loadRepos");
	const repos = reply.repos as Record<string, { name: string | null }>;
	assert.deepEqual(Object.keys(repos), [repo]);
	assert.equal(repos[repo].name, "renamed by the page");
	assert.equal(reply.lastActiveRepo, repo);
	assert.equal(reply.loadViewTo, null);
});
