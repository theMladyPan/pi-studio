/**
 * The settings the Git Graph view is opened with, written out here rather than read from a settings
 * file, because this app has one place to look and a human with a broken JSON should still get a view.
 *
 * Two things in here are deliberately unlike the extension this page came from. Every action that
 * writes to a checkout, a remote or a config starts hidden: the page draws its menus from these flags
 * before any command behind them exists, and a menu entry that does nothing is worse than no entry.
 * And `fetchAvatars` is false, because an avatar is a request to GitHub or Gravatar made on behalf of
 * a human who only asked to see their own repository.
 */
import type { ContextMenuActionsVisibility, DialogDefaultsConfig, GitGraphViewConfig } from "./protocol.ts";

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
 * that all carry enough contrast to read on the view's `#0d1117`, because a lane nobody can tell from
 * its neighbour is a graph nobody can read. Neighbouring entries differ in hue first and lightness
 * second, so the two lanes a human compares most often are never the two that look alike.
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
 * The actions the view offers on its first day: everything that reads, copies or opens, and nothing
 * that writes. A false here is a menu entry the page does not draw, so enabling one is the same act as
 * shipping the command behind it.
 */
export const ENABLED_CONTEXT_ACTIONS: ContextMenuActionsVisibility = {
	branch: {
		checkout: false,
		rename: false,
		delete: false,
		merge: false,
		rebase: false,
		push: false,
		createPullRequest: false,
		createArchive: false,
		selectInBranchesDropdown: true,
		unselectInBranchesDropdown: true,
		copyName: true,
	},
	commit: {
		addTag: false,
		createBranch: false,
		checkout: false,
		cherrypick: false,
		revert: false,
		drop: false,
		merge: false,
		rebase: false,
		reset: false,
		copyHash: true,
		copySubject: true,
	},
	remoteBranch: {
		checkout: false,
		delete: false,
		fetch: false,
		merge: false,
		pull: false,
		createPullRequest: false,
		createArchive: false,
		selectInBranchesDropdown: true,
		unselectInBranchesDropdown: true,
		copyName: true,
	},
	stash: {
		apply: false,
		createBranch: false,
		pop: false,
		drop: false,
		copyName: true,
		copyHash: true,
	},
	tag: {
		viewDetails: true,
		delete: false,
		push: false,
		createArchive: false,
		copyName: true,
	},
	uncommittedChanges: {
		stash: false,
		reset: false,
		clean: false,
		openSourceControlView: false,
	},
	fileView: {
		viewIssue: false,
		viewDiff: true,
		viewFileAtThisRevision: true,
		viewDiffWithWorkingFile: true,
		openFile: true,
		markAsReviewed: true,
		markAsNotReviewed: true,
		copyAbsoluteFilePath: true,
		copyRelativeFilePath: true,
	},
};

// ---------- the defaults ----------

/** What every dialog opens with, which is what the page's own defaults are. */
const DIALOG_DEFAULTS: DialogDefaultsConfig = {
	addTag: { pushToRemote: false, type: 0 },
	applyStash: { reinstateIndex: false },
	cherryPick: { noCommit: false, recordOrigin: false },
	createBranch: { checkout: false },
	deleteBranch: { forceDelete: false },
	fetchIntoLocalBranch: { forceFetch: false },
	fetchRemote: { prune: false, pruneTags: false },
	general: { referenceInputSpaceSubstitution: null },
	merge: { noCommit: false, noFastForward: true, squash: false },
	popStash: { reinstateIndex: false },
	pullBranch: { noFastForward: false, squash: false },
	rebase: { ignoreDate: true, interactive: false },
	resetCommit: { mode: "mixed" },
	resetUncommitted: { mode: "mixed" },
	stashUncommittedChanges: { includeUntracked: true },
};

/**
 * Everything the page is handed when it opens, which is the whole of its settings.
 *
 * `initialLoadCommits` is the one number a large repository feels: 300 rows is a graph a human can
 * scroll to the end of before deciding to load more.
 */
export const DEFAULT_CONFIG: GitGraphViewConfig = {
	commitDetailsView: { autoCenter: false, fileTreeCompactFolders: true, fileViewType: 1, location: 0 },
	commitOrdering: "date",
	contextMenuActionsVisibility: ENABLED_CONTEXT_ACTIONS,
	customBranchGlobPatterns: [],
	customEmojiShortcodeMappings: [],
	customPullRequestProviders: [],
	dateFormat: { type: 0, iso: false },
	defaultColumnVisibility: { author: true, commit: true, date: true },
	dialogDefaults: DIALOG_DEFAULTS,
	enhancedAccessibility: false,
	fetchAndPrune: false,
	fetchAndPruneTags: false,
	fetchAvatars: false,
	graph: { colours: BRANCH_COLOURS, style: 0, grid: { x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 }, uncommittedChanges: 0 },
	includeCommitsMentionedByReflogs: false,
	initialLoadCommits: 300,
	keybindings: { find: "f", refresh: "r", scrollToHead: "h", scrollToStash: "s" },
	loadMoreCommits: 100,
	loadMoreCommitsAutomatically: true,
	markdown: true,
	mute: { commitsNotAncestorsOfHead: false, mergeCommits: true },
	onlyFollowFirstParent: false,
	onRepoLoad: { scrollToHead: false, showCheckedOutBranch: false, showSpecificBranches: [] },
	referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: true, tagLabelsOnRight: false },
	repoDropdownOrder: 2,
	showRemoteBranches: true,
	showStashes: true,
	showTags: true,
};

/**
 * The settings a view is opened with, given the menus it may offer. Each menu is copied rather than
 * shared, so a later stage that enables one action cannot change the defaults for every other tab.
 */
export function buildViewConfig(actions: ContextMenuActionsVisibility = ENABLED_CONTEXT_ACTIONS): GitGraphViewConfig {
	return {
		...DEFAULT_CONFIG,
		contextMenuActionsVisibility: {
			branch: { ...actions.branch },
			commit: { ...actions.commit },
			remoteBranch: { ...actions.remoteBranch },
			stash: { ...actions.stash },
			tag: { ...actions.tag },
			uncommittedChanges: { ...actions.uncommittedChanges },
			fileView: { ...actions.fileView },
		},
	};
}
