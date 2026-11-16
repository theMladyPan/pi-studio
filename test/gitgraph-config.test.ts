import assert from "node:assert/strict";
import { test } from "node:test";
import { BRANCH_COLOURS, DEFAULT_CONFIG, DEFAULT_READ_FLAGS, ENABLED_CONTEXT_ACTIONS, buildViewConfig } from "../server/git/gitgraph/config.ts";

test("the view opens read-only: nothing that writes to a checkout or a remote is offered", () => {
	// The page draws its menus from these flags before the commands behind them exist. A true here is a
	// menu entry that does nothing, so the whole writing half starts off.
	for (const action of ["checkout", "rename", "delete", "merge", "rebase", "push", "createPullRequest", "createArchive"] as const) {
		assert.equal(ENABLED_CONTEXT_ACTIONS.branch[action], false, `branch.${action}`);
	}
	for (const action of ["addTag", "createBranch", "checkout", "cherrypick", "revert", "drop", "merge", "rebase", "reset"] as const) {
		assert.equal(ENABLED_CONTEXT_ACTIONS.commit[action], false, `commit.${action}`);
	}
	for (const action of ["checkout", "delete", "fetch", "merge", "pull", "createPullRequest", "createArchive"] as const) {
		assert.equal(ENABLED_CONTEXT_ACTIONS.remoteBranch[action], false, `remoteBranch.${action}`);
	}
	for (const action of ["apply", "createBranch", "pop", "drop"] as const) {
		assert.equal(ENABLED_CONTEXT_ACTIONS.stash[action], false, `stash.${action}`);
	}
	for (const action of ["delete", "push", "createArchive"] as const) {
		assert.equal(ENABLED_CONTEXT_ACTIONS.tag[action], false, `tag.${action}`);
	}
	for (const action of ["stash", "reset", "clean", "openSourceControlView"] as const) {
		assert.equal(ENABLED_CONTEXT_ACTIONS.uncommittedChanges[action], false, `uncommittedChanges.${action}`);
	}
	assert.equal(ENABLED_CONTEXT_ACTIONS.fileView.viewIssue, false);
});

test("what only reads, copies or opens is offered", () => {
	assert.equal(ENABLED_CONTEXT_ACTIONS.branch.copyName, true);
	assert.equal(ENABLED_CONTEXT_ACTIONS.commit.copyHash, true);
	assert.equal(ENABLED_CONTEXT_ACTIONS.commit.copySubject, true);
	assert.equal(ENABLED_CONTEXT_ACTIONS.tag.viewDetails, true);
	assert.equal(ENABLED_CONTEXT_ACTIONS.remoteBranch.selectInBranchesDropdown, true);
	assert.equal(ENABLED_CONTEXT_ACTIONS.remoteBranch.unselectInBranchesDropdown, true);
	for (const action of ["viewDiff", "viewFileAtThisRevision", "viewDiffWithWorkingFile", "openFile", "markAsReviewed", "markAsNotReviewed", "copyAbsoluteFilePath", "copyRelativeFilePath"] as const) {
		assert.equal(ENABLED_CONTEXT_ACTIONS.fileView[action], true, `fileView.${action}`);
	}
});

test("no avatar is fetched, so no third party hears about a repository", () => {
	assert.equal(DEFAULT_CONFIG.fetchAvatars, false);
	assert.equal(buildViewConfig().fetchAvatars, false);
});

test("twelve branch colours, all of them distinct", () => {
	assert.equal(BRANCH_COLOURS.length, 12);
	assert.equal(new Set(BRANCH_COLOURS).size, 12);
	for (const colour of BRANCH_COLOURS) assert.match(colour, /^#[0-9a-f]{6}$/);
	assert.deepEqual(DEFAULT_CONFIG.graph.colours, BRANCH_COLOURS);
});

test("a config built for one view does not share its menus with the next", () => {
	const first = buildViewConfig();
	first.contextMenuActionsVisibility.branch.delete = true;
	assert.equal(buildViewConfig().contextMenuActionsVisibility.branch.delete, false);
	assert.equal(ENABLED_CONTEXT_ACTIONS.branch.delete, false);
	// Everything else is the same view: the copy is of the menus, not of the settings.
	assert.equal(first.initialLoadCommits, DEFAULT_CONFIG.initialLoadCommits);
	assert.equal(first.graph, DEFAULT_CONFIG.graph);
});

test("our own git reads start from a graph a human can read", () => {
	assert.equal(DEFAULT_READ_FLAGS.dateType, 0);
	assert.equal(DEFAULT_READ_FLAGS.showUncommittedChanges, true);
	assert.equal(DEFAULT_READ_FLAGS.showCommitsOnlyReferencedByTags, true);
	assert.equal(DEFAULT_READ_FLAGS.signCommits, false);
	assert.equal(DEFAULT_READ_FLAGS.signTags, false);
});
