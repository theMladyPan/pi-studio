import assert from "node:assert/strict";
import { test } from "node:test";
import { BRANCH_COLOURS, DEFAULT_READ_FLAGS, DEFAULT_VIEW_STATE, ENABLED_CONTEXT_ACTIONS, buildViewState } from "../server/git/gitgraph/config.ts";

test("the menus still hide every action this tab cannot run", () => {
	for (const action of ["createPullRequest", "createArchive", "createWorktree"] as const) {
		if (action in ENABLED_CONTEXT_ACTIONS.branch) assert.equal(ENABLED_CONTEXT_ACTIONS.branch[action as keyof typeof ENABLED_CONTEXT_ACTIONS.branch], false, `branch.${action}`);
		if (action in ENABLED_CONTEXT_ACTIONS.remoteBranch) assert.equal(ENABLED_CONTEXT_ACTIONS.remoteBranch[action as keyof typeof ENABLED_CONTEXT_ACTIONS.remoteBranch], false, `remoteBranch.${action}`);
		if (action in ENABLED_CONTEXT_ACTIONS.tag) assert.equal(ENABLED_CONTEXT_ACTIONS.tag[action as keyof typeof ENABLED_CONTEXT_ACTIONS.tag], false, `tag.${action}`);
	}
	assert.equal(ENABLED_CONTEXT_ACTIONS.uncommittedChanges.openSourceControlView, false);
	assert.equal(ENABLED_CONTEXT_ACTIONS.branch.viewIssue, false);
	assert.equal(ENABLED_CONTEXT_ACTIONS.commitDetailsViewFile.openDiffTab, false);
	// Worktree actions would strand a click: there is no second window here.
	assert.equal(ENABLED_CONTEXT_ACTIONS.commit.createWorktree, false);
});

test("what only reads, copies or opens is offered", () => {
	assert.equal(ENABLED_CONTEXT_ACTIONS.branch.copyName, true);
	assert.equal(ENABLED_CONTEXT_ACTIONS.commit.copyHash, true);
	assert.equal(ENABLED_CONTEXT_ACTIONS.commit.copySubject, true);
	assert.equal(ENABLED_CONTEXT_ACTIONS.tag.viewDetails, true);
	for (const action of ["viewDiff", "viewFileAtRevision", "compareWithWorkingTree", "openFile", "resetFileToRevision", "copyAbsoluteFilePath", "copyRelativeFilePath"] as const) {
		assert.equal(ENABLED_CONTEXT_ACTIONS.commitDetailsViewFile[action], true, `commitDetailsViewFile.${action}`);
	}
});

test("no avatar is fetched, so no third party hears about a repository", () => {
	assert.equal(DEFAULT_VIEW_STATE.fetchAvatars, false);
	assert.equal(buildViewState().fetchAvatars, false);
});

test("twelve branch colours, all of them distinct", () => {
	assert.equal(BRANCH_COLOURS.length, 12);
	assert.equal(new Set(BRANCH_COLOURS).size, 12);
	for (const colour of BRANCH_COLOURS) assert.match(colour, /^#[0-9a-f]{6}$/);
	assert.deepEqual(DEFAULT_VIEW_STATE.graphColors, BRANCH_COLOURS);
});

test("a config built for one view does not share its menus with the next", () => {
	const first = buildViewState();
	first.contextMenuActionsVisibility.branch.delete = false;
	assert.equal(buildViewState().contextMenuActionsVisibility.branch.delete, true);
	assert.equal(ENABLED_CONTEXT_ACTIONS.branch.delete, true);
	assert.equal(first.initialLoadCommits, DEFAULT_VIEW_STATE.initialLoadCommits);
	assert.deepEqual(first.graphColors, DEFAULT_VIEW_STATE.graphColors);
});

test("our own git reads start from a graph a human can read", () => {
	assert.equal(DEFAULT_READ_FLAGS.dateType, 0);
	assert.equal(DEFAULT_READ_FLAGS.showUncommittedChanges, true);
	assert.equal(DEFAULT_READ_FLAGS.showCommitsOnlyReferencedByTags, true);
	assert.equal(DEFAULT_READ_FLAGS.signCommits, false);
	assert.equal(DEFAULT_READ_FLAGS.signTags, false);
});
