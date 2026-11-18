/**
 * The settings the Git Graph Libre view is opened with, written out here rather than read from a
 * settings file, because this app has one place to look and a human with a broken JSON should still
 * get a view.
 *
 * Two things in here are deliberately unlike the extension this page came from. An action is offered
 * only once the daemon has the command behind it: the page draws its menus from these flags, and a
 * menu entry that answers "cannot do that yet" is worse than no entry at all. And `fetchAvatars` is
 * false, because an avatar is a request to GitHub or Gravatar made on behalf of a human who only
 * asked to see their own repository.
 */
import type { ContextMenuActionsVisibility, GitGraphViewState } from "./libre.ts";

// ---------- reading git ----------

/**
 * What our own `git log` and `git show` are asked for. These are not sent to the page: they decide the
 * format strings the graph modules build, and they are here so a later settings panel has one place to
 * change.
 */
export type GitReadFlags = {
	/** 0 = author date, 1 = commit date. */
	dateType: 0 | 1;
	/** Whether `.mailmap` renames the author of a commit. */
	useMailmap: boolean;
	/** Whether each commit's signature is asked for, which costs a `gpg` check per commit. */
	showSignatureStatus: boolean;
	/** Whether a commit reachable only from a tag is drawn. */
	showCommitsOnlyReferencedByTags: boolean;
	/** Whether the uncommitted changes row is drawn above the checked out commit. */
	showUncommittedChanges: boolean;
	/** Whether untracked files count as part of the uncommitted changes. */
	showUntrackedFiles: boolean;
	/** Whether commits and tags are signed when this app makes them, which starts off. */
	signCommits: boolean;
	signTags: boolean;
};

/** The defaults every read uses. */
export const DEFAULT_READ_FLAGS: GitReadFlags = {
	dateType: 0,
	useMailmap: false,
	showSignatureStatus: false,
	showCommitsOnlyReferencedByTags: true,
	showUncommittedChanges: true,
	showUntrackedFiles: true,
	signCommits: false,
	signTags: false,
};

// ---------- colours ----------

/**
 * The branch colours, in the order lanes are given them. Twelve hues that stay apart at 16 pixels and
 * that all carry enough contrast to read on the view's dark background, because a lane nobody can
 * tell from its neighbour is a graph nobody can read.
 */
export const BRANCH_COLOURS = [
	"#58a6ff",
	"#f778ba",
	"#3fb950",
	"#d29922",
	"#bc8cff",
	"#f85149",
	"#39d2c0",
	"#ff9b57",
	"#a5d84e",
	"#e879f9",
	"#79c0ff",
	"#8b6cff",
];

// ---------- what a menu may offer ----------

/**
 * The actions the view offers, which is the read side and every write that has a handler on the daemon.
 *
 * A false here is a menu entry the page does not draw, and a true is one it draws and sends. So this
 * table and the dispatch's table of refused commands are one decision written twice: a command that
 * `dispatch.ts` still answers with "This tab cannot do that yet." is false here, and a command that
 * has a real handler is true. `test/gitgraph-actions.test.ts` walks both and fails when they disagree.
 *
 * Worktree, remote-admin and editor-bound actions stay hidden: the drawer has no terminal, no
 * source-control panel, and no second window to open a worktree in, so offering them would only
 * strand a click. They remain answerable from a stale page with the same refused sentence.
 */
export const ENABLED_CONTEXT_ACTIONS: ContextMenuActionsVisibility = {
	branch: {
		checkout: true,
		rename: true,
		delete: true,
		merge: true,
		rebase: true,
		push: true,
		pull: true,
		viewIssue: false,
		createPullRequest: false,
		createArchive: false,
		createWorktree: false,
		compareWithHead: true,
		compareWith: true,
		copyName: true,
	},
	commit: {
		addTag: true,
		createBranch: true,
		createWorktree: false,
		compareWithHead: true,
		compareWith: true,
		compareSelection: true,
		compareWithWorkingTree: true,
		checkout: true,
		cherryPick: true,
		revert: true,
		undoLastCommit: true,
		editMessage: false,
		drop: true,
		merge: true,
		rebase: true,
		reset: true,
		copyHash: true,
		copySubject: true,
		squashSelection: false,
		dropSelection: false,
	},
	commitDetailsViewFile: {
		viewDiff: true,
		openDiffTab: false,
		viewFileAtRevision: true,
		compareWithWorkingTree: true,
		openFile: true,
		resetFileToRevision: true,
		copyAbsoluteFilePath: true,
		copyRelativeFilePath: true,
	},
	remoteBranch: {
		checkout: true,
		delete: true,
		merge: true,
		fetchIntoLocalBranch: true,
		pull: true,
		viewIssue: false,
		createPullRequest: false,
		createArchive: false,
		createWorktree: false,
		compareWithHead: true,
		compareWith: true,
		copyName: true,
	},
	stash: {
		apply: true,
		createBranch: true,
		pop: true,
		drop: true,
		copyName: true,
		copyHash: true,
	},
	tag: {
		viewDetails: true,
		delete: true,
		push: true,
		fetchTags: true,
		createArchive: false,
		createWorktree: false,
		compareWithHead: true,
		compareWith: true,
		copyName: true,
	},
	uncommittedChanges: {
		stash: true,
		reset: true,
		clean: true,
		openSourceControlView: false,
	},
};

// ---------- the defaults ----------

/**
 * Everything the page is handed when it opens.
 *
 * `initialLoadCommits` is the one number a large repository feels: 250 rows is a graph a human can
 * scroll to the end of before deciding to load more.
 */
export const DEFAULT_VIEW_STATE: Omit<GitGraphViewState, "repos" | "lastActiveRepo" | "repoLayout"> & { repos: GitGraphViewState["repos"]; lastActiveRepo: GitGraphViewState["lastActiveRepo"] } = {
	repos: {},
	lastActiveRepo: null,
	autoCenterCommitDetailsView: true,
	commitDetailsCompactFolders: false,
	commitDetailsFileViewMode: "tree",
	uncommittedFileViewMode: "tree",
	contextMenuActionsVisibility: ENABLED_CONTEXT_ACTIONS,
	dateFormat: "Date & Time",
	fetchAvatars: false,
	showSignatureColumn: false,
	graphColors: BRANCH_COLOURS,
	graphFontSize: 13,
	graphRowHeight: 24,
	graphStyle: "rounded",
	revealHighlightColor: "oklch(90% 0.25 150 / 0.42)",
	customBranchGlobPatterns: [],
	initialLoadCommits: 250,
	loadMoreCommits: 750,
	muteCommitsNotAncestorsOfHead: false,
	muteMergeCommits: false,
	boldCheckedOutCommit: false,
	fetchTagsByDefault: true,
	showTagRemotes: "off",
	worktreePathTemplate: "",
	mergeNoFastForward: true,
	pullBranchNoFastForward: false,
	createBranchCheckout: true,
	onlyFollowFirstParent: false,
	showCurrentBranchByDefault: false,
	showRemoteBranches: true,
	showStashes: true,
	stashDisplay: "both",
	showTags: true,
	includeReflog: false,
	includeUnreachableCommits: false,
	shortHashLength: 7,
	language: "en",
	languages: [{ id: "en", label: "English" }],
};

/**
 * The settings a view is opened with, given the menus it may offer. Each menu is copied rather than
 * shared, so a later stage that enables one action cannot change the defaults for every other tab.
 */
export function buildViewState(
	actions: ContextMenuActionsVisibility = ENABLED_CONTEXT_ACTIONS,
	overrides: Partial<GitGraphViewState> = {},
): GitGraphViewState {
	return {
		...DEFAULT_VIEW_STATE,
		...overrides,
		lastActiveRepo: overrides.lastActiveRepo ?? null,
	contextMenuActionsVisibility: {
			branch: { ...actions.branch },
			commit: { ...actions.commit },
			commitDetailsViewFile: { ...actions.commitDetailsViewFile },
			remoteBranch: { ...actions.remoteBranch },
			stash: { ...actions.stash },
			tag: { ...actions.tag },
			uncommittedChanges: { ...actions.uncommittedChanges },
		},
		graphColors: [...(overrides.graphColors ?? DEFAULT_VIEW_STATE.graphColors)],
		languages: [...(overrides.languages ?? DEFAULT_VIEW_STATE.languages)],
	};
}

/** Backwards-compatible alias for the older callers that built a config object. */
export const DEFAULT_CONFIG = DEFAULT_VIEW_STATE;
export function buildViewConfig(actions?: ContextMenuActionsVisibility) {
	return buildViewState(actions);
}
