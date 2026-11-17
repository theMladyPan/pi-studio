import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseRequest } from "../server/git/gitgraph/protocol.ts";
import {
	COMMIT_ORDERS,
	CONFIG_LOCATIONS,
	PUSH_MODES,
	RESET_MODES,
	TAG_TYPES,
	containedReal,
	isConfigKey,
	isHash,
	isRefName,
	isRemoteName,
	isRemoteUrl,
	isRevision,
	isStashSelector,
	repoPath,
} from "../server/git/gitgraph/validate.ts";

// ---------- the pieces a command is built from ----------

test("a commit id is hex, long enough to be a commit, and never an option", () => {
	assert.equal(isHash("abc1234"), true);
	assert.equal(isHash("ABC1234"), true);
	assert.equal(isHash("0123456789abcdef0123456789abcdef01234567"), true);
	assert.equal(isHash(""), false);
	assert.equal(isHash("abc"), false);
	assert.equal(isHash("-abc1234"), false);
	assert.equal(isHash("xyz1234"), false);
	assert.equal(isHash("abc 1234"), false);
	assert.equal(isHash("a".repeat(65)), false);
	assert.equal(isHash(42), false);
	assert.equal(isHash(null), false);
	assert.equal(isHash("*"), false);
	assert.equal(isHash("*", true), true);
});

test("a branch or tag name passes git's own rules", () => {
	for (const name of ["main", "feat/foo-1", "v1.0.0", "origin/main", "release/2024-05", "a_b.c"]) {
		assert.equal(isRefName(name), true, `${name} should be a name git accepts`);
	}
	for (const name of ["", "-D", "--force", "a b", "a\tb", "a\nb", "feat..bad", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{0}", "@", ".hidden", "a//b", "/a", "a/", "a.", "a.lock", "a/b.lock", "x".repeat(256)]) {
		assert.equal(isRefName(name), false, `${JSON.stringify(name)} should be refused`);
	}
	assert.equal(isRefName(7), false);
});

test("a stash is named the one way git names one, and a revision may be more than a name", () => {
	assert.equal(isStashSelector("stash@{0}"), true);
	assert.equal(isStashSelector("stash@{12}"), true);
	assert.equal(isStashSelector("stash@{}"), false);
	assert.equal(isStashSelector("stash@{x}"), false);
	assert.equal(isStashSelector("main"), false);
	assert.equal(isRevision("HEAD"), true);
	assert.equal(isRevision("stash@{1}"), true);
	assert.equal(isRevision("main"), true);
	assert.equal(isRevision("--upload-pack=x"), false);
	assert.equal(isRevision(".."), false);
});

test("a remote's name and its URL are what `git remote` will take", () => {
	assert.equal(isRemoteName("origin"), true);
	assert.equal(isRemoteName("my-remote_1.2"), true);
	assert.equal(isRemoteName("-bad"), false);
	assert.equal(isRemoteName("a/b"), false);
	assert.equal(isRemoteName(".."), false);
	assert.equal(isRemoteName("."), false);
	assert.equal(isRemoteName(""), false);
	assert.equal(isRemoteName("x".repeat(129)), false);
	assert.equal(isRemoteUrl("https://example.invalid/a/b.git"), true);
	assert.equal(isRemoteUrl("git@example.invalid:a/b.git"), true);
	assert.equal(isRemoteUrl("--upload-pack=touch /tmp/pwned"), false);
	assert.equal(isRemoteUrl(""), false);
	assert.equal(isRemoteUrl("https://example.invalid/a\n[core]\n\teditor=vim"), false);
	assert.equal(isRemoteUrl(`https://example.invalid/${"a".repeat(2048)}`), false);
	assert.equal(isConfigKey("user.name"), true);
	assert.equal(isConfigKey("user.name\n[core]"), false);
	assert.equal(isConfigKey("user name"), false);
});

test("a path inside the repository cannot leave it", () => {
	assert.deepEqual(repoPath("dir/file.ts"), { ok: true, value: "dir/file.ts" });
	assert.equal(repoPath("../etc/passwd").ok, false);
	assert.equal(repoPath("/etc/passwd").ok, false);
	assert.equal(repoPath("C:/Windows/system32").ok, false);
	assert.equal(repoPath("a/../b").ok, false);
	assert.equal(repoPath("./a").ok, false);
	assert.equal(repoPath("a//b").ok, false);
	assert.equal(repoPath("a/").ok, false);
	assert.equal(repoPath("a\\b").ok, false);
	assert.equal(repoPath("a\u0000b").ok, false);
	assert.equal(repoPath("").ok, false);
	assert.equal(repoPath(42).ok, false);
});

test("a path is only inside the repository when the kernel says so, which is what stops a symlink", () => {
	const outside = mkdtempSync(join(tmpdir(), "pi-studio-contained-"));
	const root = join(outside, "repo");
	mkdirSync(root);
	try {
		writeFileSync(join(outside, "secret.txt"), "not yours\n");
		writeFileSync(join(root, "real.txt"), "yours\n");
		// The checkout holds this link; the relative path is perfectly ordinary and the file it names is
		// not in the repository at all.
		symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
		const real = containedReal(root, "real.txt");
		assert.equal(real.ok, true, real.ok ? "" : real.error);
		assert.equal(real.ok ? real.fullPath : "", join(realpathSync(root), "real.txt"));
		const escaped = containedReal(root, "link.txt");
		assert.equal(escaped.ok, false);
		assert.match(escaped.ok ? "" : escaped.error, /outside the repository/);
		const climbing = containedReal(root, "../secret.txt");
		assert.equal(climbing.ok, false);
		const missing = containedReal(root, "gone.txt");
		assert.equal(missing.ok, false);
		assert.match(missing.ok ? "" : missing.error, /not there/);
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});

test("the words git and the page are held to are the ones they use", () => {
	assert.deepEqual([...RESET_MODES], ["soft", "mixed", "hard"]);
	assert.deepEqual([...CONFIG_LOCATIONS], ["local", "global"]);
	assert.deepEqual([...PUSH_MODES], ["", "force", "force-with-lease"]);
	assert.deepEqual([...COMMIT_ORDERS], ["date", "author-date", "topo"]);
	assert.deepEqual([...TAG_TYPES], [0, 1]);
});

// ---------- a command from the page ----------

/** One request the page really sends, and the command it should be read as. */
const validRequests: Array<Record<string, unknown> & { command: string }> = [
	{ command: "addRemote", repo: "/repo", name: "origin", url: "https://example.invalid/a/b.git", pushUrl: null, fetch: true },
	{ command: "addTag", repo: "/repo", tagName: "v2.0.0", commitHash: "abc1234", type: 0, message: "release", pushToRemote: "origin", force: false },
	{ command: "applyStash", repo: "/repo", selector: "stash@{0}", reinstateIndex: false },
	{ command: "branchFromStash", repo: "/repo", selector: "stash@{1}", branchName: "feat/from-stash" },
	{ command: "checkoutBranch", repo: "/repo", branchName: "feat/x", remoteBranch: null, pullAfterwards: null },
	{
		command: "checkoutBranch",
		repo: "/repo",
		branchName: "origin/feat/x",
		remoteBranch: "origin/feat/x",
		pullAfterwards: { branchName: "feat/x", remote: "origin", createNewCommit: false, squash: false },
	},
	{ command: "checkoutCommit", repo: "/repo", commitHash: "abc1234" },
	{ command: "cherrypickCommit", repo: "/repo", commitHash: "abc1234", parentIndex: 0, recordOrigin: false, noCommit: false },
	{ command: "cleanUntrackedFiles", repo: "/repo", directories: true },
	{ command: "commitDetails", repo: "/repo", commitHash: "abc1234", hasParents: true, stash: null, avatarEmail: null, refresh: false },
	{
		command: "commitDetails",
		repo: "/repo",
		commitHash: "abc1234",
		hasParents: false,
		stash: { selector: "stash@{0}", baseHash: "def5678", untrackedFilesHash: null },
		avatarEmail: "a@b.c",
		refresh: true,
	},
	{ command: "compareCommits", repo: "/repo", commitHash: "abc1234", compareWithHash: "def5678", fromHash: "def5678", toHash: "abc1234", refresh: false },
	{ command: "copyFilePath", repo: "/repo", filePath: "src/a.ts", absolute: true },
	{ command: "copyToClipboard", type: "Commit Hash", data: "abc1234" },
	{ command: "createArchive", repo: "/repo", ref: "feat/x" },
	{ command: "createBranch", repo: "/repo", branchName: "feat/x", commitHash: "abc1234", checkout: true, force: false },
	{
		command: "createPullRequest",
		repo: "/repo",
		config: {
			provider: 2,
			custom: null,
			hostRootUrl: "https://github.com",
			sourceOwner: "me",
			sourceRepo: "repo",
			sourceRemote: "origin",
			destOwner: "you",
			destRepo: "repo",
			destRemote: "upstream",
			destBranch: "main",
		},
		sourceRemote: "origin",
		sourceOwner: "me",
		sourceRepo: "repo",
		sourceBranch: "feat/x",
		push: false,
	},
	{ command: "deleteBranch", repo: "/repo", branchName: "feat/x", forceDelete: true, deleteOnRemotes: null },
	{ command: "deleteBranch", repo: "/repo", branchName: "feat/x", forceDelete: false, deleteOnRemotes: ["origin"] },
	{ command: "deleteRemote", repo: "/repo", name: "origin" },
	{ command: "deleteRemoteBranch", repo: "/repo", branchName: "main", remote: "origin" },
	{ command: "deleteTag", repo: "/repo", tagName: "v1.0.0", deleteOnRemote: "origin" },
	{ command: "deleteUserDetails", repo: "/repo", name: true, email: false, location: "local" },
	{ command: "dropCommit", repo: "/repo", commitHash: "abc1234" },
	{ command: "dropStash", repo: "/repo", selector: "stash@{0}" },
	{ command: "editRemote", repo: "/repo", nameOld: "origin", nameNew: "upstream", urlOld: "https://example.invalid/a.git", urlNew: null, pushUrlOld: null, pushUrlNew: null },
	{ command: "editUserDetails", repo: "/repo", name: "A Human", email: "a@b.c", location: "global", deleteLocalName: false, deleteLocalEmail: false },
	{ command: "endCodeReview", repo: "/repo", id: "abc1234" },
	{ command: "exportRepoConfig", repo: "/repo" },
	{ command: "fetch", repo: "/repo", name: null, prune: true, pruneTags: false },
	{ command: "fetch", repo: "/repo", name: "origin", prune: false, pruneTags: false },
	{ command: "fetchAvatar", repo: "/repo", remote: "origin", email: "a@b.c", commits: ["abc1234"] },
	{ command: "fetchIntoLocalBranch", repo: "/repo", remote: "origin", remoteBranch: "remotes/origin/x", localBranch: "x", force: false },
	{
		command: "loadCommits",
		repo: "/repo",
		refreshId: 2,
		branches: null,
		maxCommits: 300,
		showTags: true,
		showRemoteBranches: true,
		includeCommitsMentionedByReflogs: false,
		onlyFollowFirstParent: false,
		commitOrdering: "date",
		remotes: ["origin"],
		hideRemotes: [],
		stashes: null,
	},
	{
		command: "loadCommits",
		repo: "/repo",
		refreshId: 3,
		branches: ["feat/x", "--glob=release/*"],
		maxCommits: 400,
		showTags: false,
		showRemoteBranches: false,
		includeCommitsMentionedByReflogs: true,
		onlyFollowFirstParent: true,
		commitOrdering: "topo",
		remotes: [],
		hideRemotes: ["origin"],
		stashes: [
			{ selector: "stash@{0}", baseHash: "abc1234", untrackedFilesHash: null },
			{ selector: "stash@{1}", baseHash: "def5678", untrackedFilesHash: "9876fedc" },
		],
	},
	{ command: "loadConfig", repo: "/repo", remotes: ["origin"] },
	{ command: "loadRepoInfo", repo: "/repo", refreshId: 1, showRemoteBranches: true, showStashes: true, hideRemotes: [] },
	{ command: "loadRepos", check: true },
	{ command: "merge", repo: "/repo", obj: "abc1234", actionOn: "Commit", createNewCommit: true, squash: false, noCommit: false },
	// The page's remote-tracking branch menu merges a `remotes/origin/x` ref and says so in one word.
	{ command: "merge", repo: "/repo", obj: "remotes/origin/x", actionOn: "Remote-tracking Branch", createNewCommit: false, squash: true, noCommit: true },
	{ command: "openExtensionSettings" },
	{ command: "openExternalDirDiff", repo: "/repo", fromHash: "abc1234", toHash: "def5678", isGui: true },
	{ command: "openExternalUrl", url: "https://example.invalid/issue/1" },
	{ command: "openFile", repo: "/repo", hash: "*", filePath: "src/a.ts" },
	{ command: "openTerminal", repo: "/repo", name: "repo" },
	{ command: "popStash", repo: "/repo", selector: "stash@{0}", reinstateIndex: true },
	{ command: "pruneRemote", repo: "/repo", name: "origin" },
	{ command: "pullBranch", repo: "/repo", branchName: "feat/x", remote: "origin", createNewCommit: false, squash: false },
	{
		command: "pushBranch",
		repo: "/repo",
		branchName: "feat/x",
		remotes: ["origin"],
		setUpstream: true,
		mode: "force-with-lease",
		willUpdateBranchConfig: true,
	},
	{ command: "pushStash", repo: "/repo", message: "wip", includeUntracked: true },
	{ command: "pushTag", repo: "/repo", tagName: "v1.0.0", remotes: ["origin"] },
	{ command: "rebase", repo: "/repo", obj: "feat/x", actionOn: "Branch", ignoreDate: true, interactive: false },
	{ command: "rebase", repo: "/repo", obj: "remotes/origin/x", actionOn: "Remote-tracking Branch", ignoreDate: false, interactive: true },
	{ command: "renameBranch", repo: "/repo", oldName: "feat/x", newName: "feat/y" },
	{ command: "resetToCommit", repo: "/repo", commit: "abc1234", resetMode: "hard" },
	{ command: "revertCommit", repo: "/repo", commitHash: "abc1234", parentIndex: 0 },
	{ command: "setGlobalViewState", state: { alwaysAcceptCheckoutCommit: true, issueLinkingConfig: { issue: "#(\\d+)", url: "https://example.invalid/$1" }, pushTagSkipRemoteCheck: false } },
	{ command: "setRepoState", repo: "/repo", state: { showTags: 1, name: "mine", commitOrdering: "topo", cdvHeight: 300 } },
	{ command: "setWorkspaceViewState", state: { findIsCaseSensitive: true, findIsRegex: false, findOpenCommitDetailsView: true } },
	{ command: "showErrorMessage", message: "something went wrong" },
	{ command: "startCodeReview", repo: "/repo", id: "abc1234", commitHash: "abc1234", compareWithHash: null, files: ["a.ts", "b/c.ts"], lastViewedFile: null },
	{ command: "tagDetails", repo: "/repo", tagName: "v1.0.0", commitHash: "abc1234" },
	{ command: "updateCodeReview", repo: "/repo", id: "abc1234-def5678", remainingFiles: ["a.ts"], lastViewedFile: "a.ts" },
	{ command: "viewDiff", repo: "/repo", fromHash: "abc1234", toHash: "def5678", oldFilePath: "a.ts", newFilePath: "b.ts", type: "R" },
	{ command: "viewDiffWithWorkingFile", repo: "/repo", hash: "abc1234", filePath: "src/a.ts" },
	{ command: "viewFileAtRevision", repo: "/repo", hash: "abc1234", filePath: "src/a.ts" },
	{ command: "viewScm" },
];

test("every command the page sends is read, with its own name", () => {
	for (const request of validRequests) {
		const parsed = parseRequest(request);
		assert.equal(parsed.ok, true, `${request.command}: ${parsed.ok ? "" : parsed.error}`);
		if (parsed.ok) assert.equal(parsed.request.command, request.command);
	}
});

test("every command the page can send is covered by a request that parses", () => {
	// The list above is the page's own vocabulary; a command added there without a repair here is a
	// command the view draws a menu entry for and cannot run.
	const covered = new Set(validRequests.map((request) => request.command));
	assert.equal(covered.size, 60);
});

// ---------- the messages the bundled page really sends ----------

/**
 * `loadCommits` as `out.min.js` builds it, field for field, with the values a page in that state holds.
 * Copied from the bundle rather than from the union, because a literal written out of the union proves
 * only that the union agrees with itself — which is exactly how `stashes: true` survived a sweep.
 */
const bundleLoadCommits = {
	command: "loadCommits",
	repo: "/repo",
	refreshId: 3,
	branches: null,
	maxCommits: 300,
	showTags: true,
	showRemoteBranches: true,
	includeCommitsMentionedByReflogs: false,
	onlyFollowFirstParent: false,
	commitOrdering: "author-date",
	remotes: ["origin"],
	hideRemotes: [],
	stashes: [{ selector: "stash@{0}", baseHash: "abc1234", untrackedFilesHash: null }],
};

/**
 * The messages the page builds for the commands this daemon answers, each one copied from the bundle's
 * own call site: `requestLoadCommits`, `requestLoadRepoInfo`, `requestCommitDetails`,
 * `requestCommitComparison`, `requestLoadConfig`, `getTagContextMenuActions`, `saveRepoState`,
 * `deleteUserDetails`, the two `createPullRequest` sites, `cleanUntrackedFiles`, `mergeAction` and
 * `rebaseAction`. They are the evidence the union is measured against, so they are literals.
 */
const bundleRequests: Array<Record<string, unknown> & { command: string }> = [
	bundleLoadCommits,
	{ command: "loadRepoInfo", repo: "/repo", refreshId: 2, showRemoteBranches: true, showStashes: true, hideRemotes: [] },
	// A stash row's details carry the stash itself; every other row sends `null`.
	{ command: "commitDetails", repo: "/repo", commitHash: "abc1234", hasParents: true, stash: null, avatarEmail: null, refresh: false },
	{ command: "commitDetails", repo: "/repo", commitHash: "def5678", hasParents: false, stash: { selector: "stash@{0}", baseHash: "def5678", untrackedFilesHash: null }, avatarEmail: null, refresh: true },
	{ command: "compareCommits", repo: "/repo", commitHash: "abc1234", compareWithHash: "def5678", fromHash: "def5678", toHash: "abc1234", refresh: false },
	{ command: "loadConfig", repo: "/repo", remotes: ["origin"] },
	{ command: "tagDetails", repo: "/repo", tagName: "v1", commitHash: "abc1234" },
	{
		command: "setRepoState",
		repo: "/repo",
		state: {
			cdvDivider: 0.5,
			cdvHeight: 250,
			columnWidths: [300, 0, 200, 100],
			commitOrdering: "default",
			fileViewType: 0,
			hideRemotes: [],
			includeCommitsMentionedByReflogs: 0,
			issueLinkingConfig: null,
			lastImportAt: 0,
			name: null,
			onlyFollowFirstParent: 0,
			onRepoLoadShowCheckedOutBranch: 0,
			onRepoLoadShowSpecificBranches: null,
			pullRequestConfig: null,
			showRemoteBranches: true,
			showRemoteBranchesV2: 0,
			showStashes: 0,
			showTags: 0,
			workspaceFolderIndex: null,
		},
	},
	// The page says which of the two user details it is removing, and to which scope.
	{ command: "deleteUserDetails", repo: "/repo", name: true, email: false, location: "global" },
	// The destination is not beside the source: it is inside the settings object the page sends whole.
	{
		command: "createPullRequest",
		repo: "/repo",
		config: {
			provider: 2,
			custom: null,
			hostRootUrl: "https://github.com",
			sourceOwner: "me",
			sourceRepo: "repo",
			sourceRemote: "origin",
			destOwner: "you",
			destRepo: "repo",
			destRemote: "upstream",
			destBranch: "main",
		},
		sourceRemote: "origin",
		sourceOwner: "me",
		sourceRepo: "repo",
		sourceBranch: "feat/x",
		push: false,
	},
	// One checkbox: whether `git clean` descends into untracked directories.
	{ command: "cleanUntrackedFiles", repo: "/repo", directories: true },
	// `addTag`'s "Push to remote" field is the remote the dialog picked, or null for none of them.
	{ command: "addTag", repo: "/repo", tagName: "v1.2.3", commitHash: "abc1234", type: 0, message: "a tag", pushToRemote: "origin", force: true },
	{ command: "merge", repo: "/repo", obj: "remotes/origin/feat", actionOn: "Remote-tracking Branch", createNewCommit: true, squash: false, noCommit: false },
	{ command: "rebase", repo: "/repo", obj: "remotes/origin/feat", actionOn: "Remote-tracking Branch", ignoreDate: false, interactive: false },
];

test("the messages the bundled page really sends are the shapes this module reads", () => {
	for (const request of bundleRequests) {
		const parsed = parseRequest(request);
		assert.equal(parsed.ok, true, `${request.command}: ${parsed.ok ? "" : parsed.error}`);
	}
});

test("the stashes a page already holds are read as stashes, and nothing else is", () => {
	const read = parseRequest(bundleLoadCommits);
	assert.equal(read.ok, true, read.ok ? "" : read.error);
	if (read.ok && read.request.command === "loadCommits") {
		assert.deepEqual(read.request.stashes, [{ selector: "stash@{0}", baseHash: "abc1234", untrackedFilesHash: null }]);
	}
	// `null` is a page that knows of none, which is a different thing from a list of none.
	const none = parseRequest({ ...bundleLoadCommits, stashes: null });
	assert.equal(none.ok, true, none.ok ? "" : none.error);
	if (none.ok && none.request.command === "loadCommits") assert.equal(none.request.stashes, null);

	const flag = parseRequest({ ...bundleLoadCommits, stashes: true });
	assert.equal(flag.ok, false);
	assert.equal(flag.ok ? "" : flag.error, "stashes must be a list of stashes or null");
	const spelled = parseRequest({ ...bundleLoadCommits, stashes: [{ selector: "main", baseHash: "abc1234", untrackedFilesHash: null }] });
	assert.equal(spelled.ok ? "" : spelled.error, "stashes.selector must be a stash selector such as stash@{0}");
	const bare = parseRequest({ ...bundleLoadCommits, stashes: ["stash@{0}"] });
	assert.equal(bare.ok ? "" : bare.error, "stashes must be a stash");
	const missing = parseRequest({ ...bundleLoadCommits, stashes: undefined });
	assert.equal(missing.ok, true, "a page that omits the field knows nothing about it");
});

test("a request that leaves out a field the page always sends is refused by name", () => {
	const unflagged = parseRequest({ command: "cleanUntrackedFiles", repo: "/repo", directories: ["src"] });
	assert.equal(unflagged.ok ? "" : unflagged.error, "directories must be true or false");
	const named = parseRequest({ command: "deleteUserDetails", repo: "/repo", location: "local" });
	assert.equal(named.ok ? "" : named.error, "name is missing");
	const settings = parseRequest({ command: "createPullRequest", repo: "/repo", sourceRemote: "origin", sourceOwner: "me", sourceRepo: "repo", sourceBranch: "feat/x", push: false });
	assert.equal(settings.ok ? "" : settings.error, "config is missing");
	const target = parseRequest({ command: "merge", repo: "/repo", obj: "feat/x", actionOn: "Remote-tracking", createNewCommit: false, squash: false, noCommit: false });
	assert.equal(target.ok ? "" : target.error, "actionOn must be Branch, Remote-tracking Branch or Commit");
});

// ---------- what this daemon hands out is what comes back ----------

test("a stash's untracked files are asked for at the revision this daemon listed them under", () => {
	// `loadRepoInfo` names a stash's untracked files as `<stash hash>^3`, and the page sends that same
	// string back when a human opens one of them: it is a revision, so it is not a hash, and refusing it
	// would break the one file a stash row's untracked list is for.
	const stashHash = "abc1234abc1234abc1234abc1234abc1234abc1234";
	const untracked = `${stashHash}^3`;
	const listed = parseRequest({ ...bundleLoadCommits, stashes: [{ selector: "stash@{0}", baseHash: stashHash, untrackedFilesHash: untracked }] });
	assert.equal(listed.ok, true, listed.ok ? "" : listed.error);
	for (const [command, request] of [
		["viewDiff", { command: "viewDiff", repo: "/repo", fromHash: untracked, toHash: untracked, oldFilePath: "a.txt", newFilePath: "a.txt", type: "U" }],
		["viewFileAtRevision", { command: "viewFileAtRevision", repo: "/repo", hash: untracked, filePath: "a.txt" }],
		["viewDiffWithWorkingFile", { command: "viewDiffWithWorkingFile", repo: "/repo", hash: untracked, filePath: "a.txt" }],
		["openFile", { command: "openFile", repo: "/repo", hash: untracked, filePath: "a.txt" }],
	] as Array<[string, Record<string, unknown>]>) {
		assert.equal(parseRequest(request).ok, true, `${command} should read the revision a stash row listed`);
	}
	// A revision that is neither a commit id nor a stash's third parent is still refused.
	const invented = parseRequest({ command: "viewFileAtRevision", repo: "/repo", hash: `${stashHash}^2`, filePath: "a.txt" });
	assert.equal(invented.ok ? "" : invented.error, "hash is not a commit id");
});

test("a command that writes to a checkout refuses an option dressed as a value", () => {
	const reset = parseRequest({ command: "resetToCommit", repo: "/repo", commit: "abc1234", resetMode: "hard --exec=x" });
	assert.equal(reset.ok, false);
	assert.match(reset.ok ? "" : reset.error, /resetMode/);
	for (const branchName of ["-D", "--force", "feat..bad", "a b", "feat/x.lock"]) {
		const created = parseRequest({ command: "createBranch", repo: "/repo", branchName, commitHash: "abc1234", checkout: false, force: false });
		assert.equal(created.ok, false, `${branchName} should be refused`);
	}
	const renamed = parseRequest({ command: "renameBranch", repo: "/repo", oldName: "main", newName: "../evil" });
	assert.equal(renamed.ok, false);
	const pushed = parseRequest({ command: "pushBranch", repo: "/repo", branchName: "feat/x", remotes: ["origin"], setUpstream: false, mode: "--force", willUpdateBranchConfig: false });
	assert.equal(pushed.ok, false);
});

test("a remote cannot be added with an option where its URL goes", () => {
	const injected = parseRequest({ command: "addRemote", repo: "/repo", name: "origin", url: "--upload-pack=touch /tmp/pwned", pushUrl: null, fetch: true });
	assert.equal(injected.ok, false);
	assert.match(injected.ok ? "" : injected.error, /url/);
	const named = parseRequest({ command: "addRemote", repo: "/repo", name: "-bad", url: "https://example.invalid/a.git", pushUrl: null, fetch: true });
	assert.equal(named.ok, false);
	const newline = parseRequest({ command: "addRemote", repo: "/repo", name: "origin", url: "https://example.invalid/a\n[core]\n\teditor=vim", pushUrl: null, fetch: true });
	assert.equal(newline.ok, false);
	const edited = parseRequest({ command: "editRemote", repo: "/repo", nameOld: "origin", nameNew: "origin", urlOld: null, urlNew: "--upload-pack=x", pushUrlOld: null, pushUrlNew: null });
	assert.equal(edited.ok, false);
});

test("a file command cannot name a file outside the repository", () => {
	for (const filePath of ["../../etc/passwd", "/etc/passwd", "C:/Windows/win.ini", "a/../../b"]) {
		for (const command of ["openFile", "viewFileAtRevision", "viewDiffWithWorkingFile", "copyFilePath"]) {
			const parsed = parseRequest({ command, repo: "/repo", hash: "abc1234", filePath, absolute: false });
			assert.equal(parsed.ok, false, `${command} should refuse ${filePath}`);
			assert.match(parsed.ok ? "" : parsed.error, /filePath/);
		}
	}
	const diff = parseRequest({ command: "viewDiff", repo: "/repo", fromHash: "abc1234", toHash: "def5678", oldFilePath: "/etc/passwd", newFilePath: "a.ts", type: "M" });
	assert.equal(diff.ok, false);
	const review = parseRequest({ command: "startCodeReview", repo: "/repo", id: "abc1234", commitHash: "abc1234", compareWithHash: null, files: ["../../etc/passwd"], lastViewedFile: null });
	assert.equal(review.ok, false);
});

test("user details are only ever written to a repository or to the human's own config", () => {
	const edited = parseRequest({ command: "editUserDetails", repo: "/repo", name: "A", email: "a@b.c", location: "system", deleteLocalName: false, deleteLocalEmail: false });
	assert.equal(edited.ok, false);
	assert.match(edited.ok ? "" : edited.error, /location/);
	const deleted = parseRequest({ command: "deleteUserDetails", repo: "/repo", name: true, email: true, location: "system" });
	assert.equal(deleted.ok, false);
	assert.match(deleted.ok ? "" : deleted.error, /location/);
});

test("a command nobody knows, and a message that is not a request at all, answer why", () => {
	const unknown = parseRequest({ command: "runShell", args: ["rm", "-rf", "/"] });
	assert.deepEqual(unknown, { ok: false, command: "runShell", error: "Unsupported command: runShell" });
	for (const raw of [null, undefined, "loadRepos", 42, [], {}]) {
		const parsed = parseRequest(raw);
		assert.equal(parsed.ok, false, `${JSON.stringify(raw)} should be refused`);
	}
	const nameless = parseRequest({ command: 42 });
	assert.equal(nameless.ok, false);
	const missingRepo = parseRequest({ command: "loadRepoInfo", refreshId: 1, showRemoteBranches: true, showStashes: true, hideRemotes: [] });
	assert.equal(missingRepo.ok, false);
	assert.match(missingRepo.ok ? "" : missingRepo.error, /repo/);
	const relativeRepo = parseRequest({ command: "loadRepoInfo", repo: "repo", refreshId: 1, showRemoteBranches: true, showStashes: true, hideRemotes: [] });
	assert.equal(relativeRepo.ok, false);
});

test("a state the page sends keeps only the fields the view knows", () => {
	const parsed = parseRequest({ command: "setRepoState", repo: "/repo", state: { showTags: 1, cdvHeight: "tall", evil: "rm -rf /", name: 7 } });
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
	if (!parsed.ok || parsed.request.command !== "setRepoState") return;
	// A string where a number belongs, and a key the view never reads, both fall back to the default
	// rather than travelling into the file.
	assert.equal(parsed.request.state.cdvHeight, 250);
	assert.equal(parsed.request.state.name, null);
	assert.equal("evil" in parsed.request.state, false);
	assert.equal(parsed.request.state.showTags, 1);
	const global = parseRequest({ command: "setGlobalViewState", state: { alwaysAcceptCheckoutCommit: "yes" } });
	assert.equal(global.ok, true, global.ok ? "" : global.error);
	if (global.ok && global.request.command === "setGlobalViewState") assert.equal(global.request.state.alwaysAcceptCheckoutCommit, false);
});
