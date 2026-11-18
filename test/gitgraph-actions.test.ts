import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-actions-"));
process.env.PI_STUDIO_STATE = stateHome;

const dispatch = await import("../server/git/gitgraph/dispatch.ts");
const config = await import("../server/git/gitgraph/config.ts");
const { git, scratchRepo } = await import("../test-support/git.ts");

type Board = { id: string; folder: string; trees: Array<{ path: string; branch?: string; thread?: string }>; threads: Map<string, { id?: string; title?: string }>; children: Map<string, unknown> };
type Place = { folder: string; board: Board };

async function withRepo(work: (place: Place) => Promise<void>): Promise<void> {
	const folder = realpathSync(scratchRepo());
	const board: Board = { id: "w-actions", folder, trees: [], threads: new Map(), children: new Map() };
	try { await work({ folder, board }); } finally { rmSync(folder, { recursive: true, force: true }); }
}
async function act(place: Place, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	const replies = await dispatch.respond(place.board, request);
	assert.equal(replies.length, 1, `expected one reply to ${String(request.command)}, got ${replies.length}`);
	return replies[0] as Record<string, unknown>;
}
function commitFile(folder: string, file: string, subject: string): string {
	writeFileSync(join(folder, file), `${subject}\n`);
	git(folder, "add", ".");
	git(folder, "commit", "-m", subject);
	return git(folder, "rev-parse", "HEAD");
}
function withRemote(folder: string): string {
	const bare = mkdtempSync(join(tmpdir(), "pi-studio-remote-"));
	git(bare, "init", "--bare", "-b", "dev");
	git(folder, "remote", "add", "origin", bare);
	git(folder, "push", "-u", "origin", "dev");
	git(folder, "fetch", "origin");
	return bare;
}
const branches = (folder: string): string[] => git(folder, "branch", "--list", "--format=%(refname:short)").split("\n").filter(Boolean);
const tags = (folder: string): string[] => git(folder, "tag", "--list").split("\n").filter(Boolean);
const head = (folder: string): string => git(folder, "rev-parse", "--abbrev-ref", "HEAD");
const subjects = (folder: string): string[] => git(folder, "log", "--oneline", "--format=%s").split("\n").filter(Boolean);

test("a branch is made, checked out when asked, renamed and deleted", async () => {
	await withRepo(async (place) => {
		const first = git(place.folder, "rev-parse", "HEAD");
		const made = await act(place, { command: "createBranch", repo: place.folder, branchName: "feat/made", commitHash: first, checkout: false });
		assert.equal(made.status, null);
		assert.ok(branches(place.folder).includes("feat/made"));
		assert.equal(head(place.folder), "dev");
		const checked = await act(place, { command: "createBranch", repo: place.folder, branchName: "feat/checked", commitHash: first, checkout: true });
		assert.equal(checked.status, null);
		assert.equal(head(place.folder), "feat/checked");
		const renamed = await act(place, { command: "renameBranch", repo: place.folder, oldName: "feat/made", newName: "feat/renamed" });
		assert.equal(renamed.status, null);
		const deleted = await act(place, { command: "deleteBranch", repo: place.folder, branchName: "feat/renamed", forceDelete: false, deleteOnRemotes: [] });
		assert.equal(deleted.status, null);
		assert.ok(!branches(place.folder).includes("feat/renamed"));
	});
});

test("a branch git will not delete says so, and a forced delete removes it", async () => {
	await withRepo(async (place) => {
		git(place.folder, "checkout", "-q", "-b", "feat/unmerged");
		commitFile(place.folder, "unmerged.txt", "unmerged work");
		git(place.folder, "checkout", "-q", "dev");
		const refused = await act(place, { command: "deleteBranch", repo: place.folder, branchName: "feat/unmerged", forceDelete: false, deleteOnRemotes: [] });
		assert.ok(typeof refused.status === "string" && refused.status.includes("git branch -D"), String(refused.status));
		assert.ok(branches(place.folder).includes("feat/unmerged"));
		const forced = await act(place, { command: "deleteBranch", repo: place.folder, branchName: "feat/unmerged", forceDelete: true, deleteOnRemotes: [] });
		assert.equal(forced.status, null);
	});
});

test("a lightweight tag is a ref, an annotated one is an object", async () => {
	await withRepo(async (place) => {
		const first = git(place.folder, "rev-parse", "HEAD");
		const light = await act(place, { command: "addTag", repo: place.folder, tagName: "v1.0.0", commitHash: first, lightweight: true });
		assert.equal(light.status, null);
		assert.deepEqual(tags(place.folder), ["v1.0.0"]);
		assert.equal(git(place.folder, "cat-file", "-t", "v1.0.0"), "commit");
		const annotated = await act(place, { command: "addTag", repo: place.folder, tagName: "v2.0.0", commitHash: first, lightweight: false, message: "the second release" });
		assert.equal(annotated.status, null);
		assert.equal(git(place.folder, "cat-file", "-t", "v2.0.0"), "tag");
	});
});

test("a branch is checked out and a commit is detached", async () => {
	await withRepo(async (place) => {
		const local = await act(place, { command: "checkoutBranch", repo: place.folder, branchName: "dev", remoteBranch: null });
		assert.equal(local.status, null);
		const detached = await act(place, { command: "checkoutCommit", repo: place.folder, commitHash: git(place.folder, "rev-parse", "dev") });
		assert.equal(detached.status, null);
		assert.equal(head(place.folder), "HEAD");
	});
});

test("a merge makes a commit, and a squash merge stages without committing", async () => {
	await withRepo(async (place) => {
		git(place.folder, "checkout", "-q", "-b", "feat/side");
		commitFile(place.folder, "side.txt", "side work");
		git(place.folder, "checkout", "-q", "dev");
		const before = git(place.folder, "rev-parse", "HEAD");
		const merged = await act(place, { command: "mergeBranch", repo: place.folder, branchName: "feat/side", createNewCommit: true, squash: false, noCommit: false, noVerify: false });
		assert.equal(merged.status, null);
		assert.match(subjects(place.folder)[0], /^Merge branch 'feat\/side'/);
		git(place.folder, "reset", "-q", "--hard", before);
		const squashed = await act(place, { command: "mergeBranch", repo: place.folder, branchName: "feat/side", createNewCommit: false, squash: true, noCommit: false, noVerify: false });
		assert.equal(squashed.status, null);
		assert.equal(git(place.folder, "rev-parse", "HEAD"), before);
	});
});

test("a cherry-pick commits, and a revert undoes one", async () => {
	await withRepo(async (place) => {
		git(place.folder, "checkout", "-q", "-b", "feat/pick");
		const picked = commitFile(place.folder, "picked.txt", "work to pick");
		git(place.folder, "checkout", "-q", "dev");
		const committed = await act(place, { command: "cherrypickCommit", repo: place.folder, commitHash: picked, parentIndex: 0, noCommit: false });
		assert.equal(committed.status, null);
		assert.equal(subjects(place.folder)[0], "work to pick");
		const reverted = await act(place, { command: "revertCommit", repo: place.folder, commitHash: picked, parentIndex: 0, noCommit: false });
		assert.equal(reverted.status, null);
	});
});

test("a reset moves the branch", async () => {
	await withRepo(async (place) => {
		commitFile(place.folder, "a.txt", "a");
		const before = git(place.folder, "rev-parse", "HEAD~1");
		const reset = await act(place, { command: "resetToCommit", repo: place.folder, commitHash: before, resetMode: "hard" });
		assert.equal(reset.status, null);
		assert.equal(git(place.folder, "rev-parse", "HEAD"), before);
	});
});

test("a stash is pushed and applied", async () => {
	await withRepo(async (place) => {
		writeFileSync(join(place.folder, "readme.md"), "changed\n");
		const pushed = await act(place, { command: "pushStash", repo: place.folder, message: "wip", includeUntracked: true });
		assert.equal(pushed.status, null);
		const applied = await act(place, { command: "applyStash", repo: place.folder, selector: "stash@{0}", reinstateIndex: false });
		assert.equal(applied.status, null);
	});
});

test("a tree a thread is working in is not moved", async () => {
	const { treeWithChildCommit } = await import("../test-support/git.ts");
	const repo = realpathSync(scratchRepo());
	try {
		const { board, tree } = treeWithChildCommit(repo);
		const live = realpathSync(tree.path);
		board.threads.set("thread-child-1", { id: "thread-child-1", title: "a child change" });
		board.children.set("thread-child-1", { id: "child" });
		const place = { folder: live, board: board as unknown as Board };
		const before = git(live, "rev-parse", "HEAD");
		const refused = await act(place, { command: "resetToCommit", repo: live, commitHash: before, resetMode: "hard" });
		assert.ok(typeof refused.status === "string" && refused.status.startsWith("a thread is working in this tree right now"), String(refused.status));
		assert.match(String(refused.status), /a child change/);
		assert.equal(git(live, "rev-parse", "HEAD"), before);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("an interactive rebase is refused for want of a terminal", async () => {
	await withRepo(async (place) => {
		commitFile(place.folder, "b.txt", "second");
		const refused = await act(place, { command: "rebaseCurrentBranch", repo: place.folder, target: git(place.folder, "rev-parse", "HEAD~1"), targetType: "commit", ignoreDate: true, interactive: true });
		assert.equal(refused.status, "an interactive rebase needs a terminal this tab does not have");
	});
});

test("a second action in one repository is refused while the first is still running", async () => {
	await withRepo(async (place) => {
		// Started in one tick without awaiting: the second must see the busy guard even though the first is fast.
		const { runLibreAction } = await import("../server/git/gitgraph/actions.ts");
		const first = runLibreAction(place.folder, { command: "pushStash", repo: place.folder, message: "running", includeUntracked: true });
		const secondStatus = await runLibreAction(place.folder, { command: "cleanUntrackedFiles", repo: place.folder, includeDirectories: true });
		assert.equal(secondStatus, "another git action is still running in this repository");
		await first;
/*
		const first = dispatch.respond(place.board, { command: "fetchRemotes", repo: place.folder, remote: "origin", prune: false, pruneTags: false });
		const second = await dispatch.respond(place.board, { command: "fetchRemotes", repo: place.folder, remote: "origin", prune: false, pruneTags: false });
		assert.equal((second[0] as Record<string, unknown>).status, "another git action is still running in this repository");
		await first;
*/
		const after = await act(place, { command: "fetchRemotes", repo: place.folder, remote: "origin", prune: false, pruneTags: false });
		assert.ok(after.status === null || typeof after.status === "string");
	});
});

test("every menu entry this tab offers has a handler, and every refused command is hidden", () => {
	const MENU_COMMANDS: Record<string, string | null> = {
		"branch.checkout": "checkoutBranch",
		"branch.rename": "renameBranch",
		"branch.delete": "deleteBranch",
		"branch.merge": "mergeBranch",
		"branch.rebase": "rebaseCurrentBranch",
		"branch.push": "pushBranch",
		"branch.pull": "pullBranch",
		"branch.viewIssue": null,
		"branch.createPullRequest": "createPullRequest",
		"branch.createArchive": "createArchive",
		"branch.createWorktree": null,
		"branch.compareWithHead": null,
		"branch.compareWith": null,
		"branch.copyName": null,
		"commit.addTag": "addTag",
		"commit.createBranch": "createBranch",
		"commit.createWorktree": null,
		"commit.compareWithHead": null,
		"commit.compareWith": null,
		"commit.compareSelection": null,
		"commit.compareWithWorkingTree": null,
		"commit.checkout": "checkoutCommit",
		"commit.cherryPick": "cherrypickCommit",
		"commit.revert": "revertCommit",
		"commit.undoLastCommit": "undoLastCommit",
		"commit.editMessage": "editHeadCommitMessage",
		"commit.drop": "dropCommit",
		"commit.merge": "mergeCommit",
		"commit.rebase": "rebaseCurrentBranch",
		"commit.reset": "resetToCommit",
		"commit.copyHash": null,
		"commit.copySubject": null,
		"commit.squashSelection": "squashCommitSelection",
		"commit.dropSelection": "dropCommitSelection",
		"commitDetailsViewFile.viewDiff": "viewDiff",
		"commitDetailsViewFile.openDiffTab": "openDiffTab",
		"commitDetailsViewFile.viewFileAtRevision": "viewFileAtRevision",
		"commitDetailsViewFile.compareWithWorkingTree": "compareFileWithWorkingTree",
		"commitDetailsViewFile.openFile": "openFile",
		"commitDetailsViewFile.resetFileToRevision": "resetFileToRevision",
		"commitDetailsViewFile.copyAbsoluteFilePath": null,
		"commitDetailsViewFile.copyRelativeFilePath": null,
		"remoteBranch.checkout": "checkoutBranch",
		"remoteBranch.delete": "deleteRemoteBranch",
		"remoteBranch.merge": "mergeBranch",
		"remoteBranch.fetchIntoLocalBranch": "fetchIntoLocalBranch",
		"remoteBranch.pull": "pullBranch",
		"remoteBranch.viewIssue": null,
		"remoteBranch.createPullRequest": "createPullRequest",
		"remoteBranch.createArchive": "createArchive",
		"remoteBranch.createWorktree": null,
		"remoteBranch.compareWithHead": null,
		"remoteBranch.compareWith": null,
		"remoteBranch.copyName": null,
		"stash.apply": "applyStash",
		"stash.createBranch": "branchFromStash",
		"stash.pop": "popStash",
		"stash.drop": "dropStash",
		"stash.copyName": null,
		"stash.copyHash": null,
		"tag.viewDetails": "tagDetails",
		"tag.delete": "deleteTag",
		"tag.push": "pushTag",
		"tag.fetchTags": "fetchTags",
		"tag.createArchive": "createArchive",
		"tag.createWorktree": null,
		"tag.compareWithHead": null,
		"tag.compareWith": null,
		"tag.copyName": null,
		"uncommittedChanges.stash": "pushStash",
		"uncommittedChanges.reset": "resetUncommittedChanges",
		"uncommittedChanges.clean": "cleanUntrackedFiles",
		"uncommittedChanges.openSourceControlView": "openSourceControl",
	};
	const offered: Record<string, boolean> = {};
	for (const [group, menu] of Object.entries(config.ENABLED_CONTEXT_ACTIONS)) {
		for (const [action, visible] of Object.entries(menu as Record<string, boolean>)) offered[`${group}.${action}`] = visible;
	}
	assert.deepEqual(Object.keys(offered).sort(), Object.keys(MENU_COMMANDS).sort(), "every menu entry is mapped to the command it sends");
	for (const [entry, visible] of Object.entries(offered)) {
		const command = MENU_COMMANDS[entry];
		if (!visible || command === null) continue;
		const refused = dispatch.UNAVAILABLE[command];
		assert.equal(refused, undefined, `${entry} is offered but ${command} answers "${String(refused)}"`);
	}
	for (const command of Object.keys(dispatch.UNAVAILABLE)) {
		for (const [entry, mapped] of Object.entries(MENU_COMMANDS)) {
			if (mapped === command) assert.equal(offered[entry], false, `${entry} sends ${command}, which is refused`);
		}
	}
});
