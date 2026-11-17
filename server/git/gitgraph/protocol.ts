/**
 * The words the Git Graph page and this daemon say to each other.
 *
 * The page is mhutchie's own `out.min.js`, so every name here is its name and cannot be renamed for
 * taste: `heads`, `stash.untrackedFilesHash`, `moreCommitsAvailable`, `refreshId`, all of it. What the
 * page sends is checked before git is asked anything, which is why the request side is a union with
 * every command spelled out — a command that arrives with a field this module could not read is a
 * command that answers a reason instead of running.
 */
import {
	COMMIT_ORDERS,
	CONFIG_LOCATIONS,
	PUSH_MODES,
	RESET_MODES,
	TAG_TYPES,
	isHash,
	isOneOf,
	isRefName,
	isRemoteName,
	isRemoteUrl,
	isRepoRoot,
	isRevision,
	isStashSelector,
	repoPath,
} from "./validate.ts";
import { globalViewStateFrom, repoStateFrom, workspaceViewStateFrom } from "./state.ts";

// ---------- one commit and what it carries ----------

/**
 * The hash the graph draws for the uncommitted changes row. It is not a commit and has no id, so the
 * page and this daemon spell it the one way git never would: a command that names `*` is a command
 * about the working tree.
 */
export const UNCOMMITTED = "*";

/** A signature git checked, drawn beside the author of a signed commit. */
export type GitSignature = { key: string; signer: string; status: string };

/** The stash a commit row is, so the row can be applied, popped or dropped. */
export type GitStash = { selector: string; baseHash: string; untrackedFilesHash: string | null };

/** A tag as a commit row draws it: annotated tags carry a message of their own. */
export type GitTag = { name: string; annotated: boolean };

/** A remote-tracking ref, with the remote it came from when one of the known remotes names it. */
export type GitRemoteBranch = { name: string; remote: string | null };

/** One commit as the graph draws it: who, when, what it says, and every pill it carries. */
export type GitCommit = {
	hash: string;
	parents: string[];
	author: string;
	email: string;
	/** Seconds since the epoch, because that is what git prints and what the page formats. */
	date: number;
	message: string;
	heads: string[];
	tags: GitTag[];
	remotes: GitRemoteBranch[];
	stash: GitStash | null;
	signature?: GitSignature | null;
};

/** The letter git gives a changed file: added, copied, deleted, modified, renamed, unmerged. */
export type GitFileChangeType = "A" | "C" | "D" | "M" | "R" | "U";

/** One file a commit touched, with the two paths a rename needs and the line counts if known. */
export type GitFileChange = {
	oldFilePath: string;
	newFilePath: string;
	type: GitFileChangeType;
	additions: number | null;
	deletions: number | null;
};

/** Everything the commit details view shows about one commit, including its files. */
export type GitCommitDetails = {
	hash: string;
	parents: string[];
	author: string;
	authorEmail: string;
	authorDate: number;
	committer: string;
	committerEmail: string;
	committerDate: number;
	signature: GitSignature | null;
	body: string;
	fileChanges: GitFileChange[];
};

/** What the tag details view shows about one tag and the person who made it. */
export type GitTagDetails = {
	tagHash: string;
	name: string;
	email: string;
	date: string;
	message: string;
};

/** A code review in progress: which files are left, and the file that was open last. */
export type GitCodeReview = {
	id: string;
	lastActive: number;
	lastViewedFile: string | null;
	remainingFiles: string[];
};

// ---------- the repository itself ----------

/** What one repository has: its branches, the checked out one, its remotes and its stashes. */
export type GitRepoInfo = {
	branches: string[];
	head: string | null;
	remotes: string[];
	stashes: GitStash[];
	error: string | null;
};

/** One branch's upstream, as `.git/config` records it. */
export type GitBranchConfig = { remote: string | null; pushRemote: string | null };

/** One remote and the URLs git was told about it. */
export type GitRemoteConfig = { name: string; url: string | null; pushUrl: string | null };

/**
 * The repository's own configuration, read so the settings panel can show what the human's git would
 * do without writing anything: the diff tools, the push default, each remote's URLs, and the user
 * details at both scopes.
 */
export type GitRepoConfig = {
	branches: Record<string, GitBranchConfig>;
	diffTool: string | null;
	guiDiffTool: string | null;
	pushDefault: string | null;
	remotes: GitRemoteConfig[];
	user: {
		name: { local: string | null; global: string | null };
		email: { local: string | null; global: string | null };
	};
};

/** The one place a stored state may be extended with a pull request provider of the human's own. */
export type PullRequestProvider = { name: string; templateUrl: string };

/** What was remembered about creating a pull request from this repository. */
export type PullRequestConfig = {
	/** 0 = Bitbucket, 1 = a provider the human configured, 2 = GitHub, 3 = GitLab. */
	provider: 0 | 1 | 2 | 3;
	custom: PullRequestProvider | null;
	hostRootUrl: string;
	sourceOwner: string;
	sourceRepo: string;
	sourceRemote: string;
	destOwner: string;
	destRepo: string;
	destRemote: string | null;
	destBranch: string;
};

/** How issue numbers in a commit message become links, when the human configured it. */
export type IssueLinkingConfig = { issue: string; url: string };

/**
 * What was remembered about one repository between sessions: how the view was arranged (column widths,
 * the commit details pane), which branches and tags it showed, and the settings the settings panel owns.
 */
export type GitRepoState = {
	cdvDivider: number;
	cdvHeight: number;
	columnWidths: number[] | null;
	commitOrdering: "default" | (typeof COMMIT_ORDERS)[number];
	fileViewType: 0 | 1 | 2;
	hideRemotes: string[];
	includeCommitsMentionedByReflogs: 0 | 1;
	issueLinkingConfig: IssueLinkingConfig | null;
	lastImportAt: number;
	name: string | null;
	onlyFollowFirstParent: 0 | 1;
	onRepoLoadShowCheckedOutBranch: 0 | 1;
	onRepoLoadShowSpecificBranches: string[] | null;
	pullRequestConfig: PullRequestConfig | null;
	showRemoteBranches: boolean;
	showRemoteBranchesV2: 0 | 1 | 2;
	showStashes: 0 | 1;
	showTags: 0 | 1;
	workspaceFolderIndex: number | null;
};

// ---------- the view's own settings ----------

/** How a date is written: date and time, date only, or how long ago. */
export type DateFormatConfig = { type: 0 | 1 | 2; iso: boolean };

/** Which of the three table columns are drawn. */
export type ColumnVisibilityConfig = { author: boolean; commit: boolean; date: boolean };

/** The commit details view: where it opens and how its files are listed. */
export type CommitDetailsViewConfig = {
	autoCenter: boolean;
	fileTreeCompactFolders: boolean;
	/** 1 = file tree, 2 = file list. */
	fileViewType: 1 | 2;
	/** 0 = inline under the commit, 1 = docked to the bottom of the view. */
	location: 0 | 1;
};

/** The branch and tag pills: which side they sit on and whether a local and its remote are one pill. */
export type ReferenceLabelsConfig = {
	branchLabelsAlignedToGraph: boolean;
	combineLocalAndRemoteBranchLabels: boolean;
	tagLabelsOnRight: boolean;
};

/** The graph's colours, its corner style, its cell grid and how uncommitted changes are drawn. */
export type GraphConfig = {
	colours: string[];
	/** 0 = rounded, 1 = angular. */
	style: 0 | 1;
	grid: { x: number; y: number; offsetX: number; offsetY: number; expandY: number };
	/** 0 = an open circle at the uncommitted changes, 1 = at the checked out commit. */
	uncommittedChanges: 0 | 1;
};

/** Commits that are drawn faded rather than left out. */
export type MuteConfig = { commitsNotAncestorsOfHead: boolean; mergeCommits: boolean };

/** What the view shows when a repository is opened. */
export type OnRepoLoadConfig = { scrollToHead: boolean; showCheckedOutBranch: boolean; showSpecificBranches: string[] };

/** The single-key shortcuts the page listens for. */
export type KeybindingsConfig = { find: string; refresh: string; scrollToHead: string; scrollToStash: string };

/** A branch pattern the branches dropdown offers as one choice, as `--glob` argument it becomes. */
export type CustomBranchGlobPattern = { name: string; glob: string };

/** A shortcode the human added to the emoji a commit message is drawn with. */
export type CustomEmojiShortcodeMapping = { shortcode: string; emoji: string };

/**
 * What every dialog opens with. The values are what the human last chose, and the page never asks
 * about them again once this is set.
 */
export type DialogDefaultsConfig = {
	addTag: { pushToRemote: boolean; type: 0 | 1 };
	applyStash: { reinstateIndex: boolean };
	cherryPick: { noCommit: boolean; recordOrigin: boolean };
	createBranch: { checkout: boolean };
	deleteBranch: { forceDelete: boolean };
	fetchIntoLocalBranch: { forceFetch: boolean };
	fetchRemote: { prune: boolean; pruneTags: boolean };
	general: { referenceInputSpaceSubstitution: "-" | "_" | null };
	merge: { noCommit: boolean; noFastForward: boolean; squash: boolean };
	popStash: { reinstateIndex: boolean };
	pullBranch: { noFastForward: boolean; squash: boolean };
	rebase: { ignoreDate: boolean; interactive: boolean };
	resetCommit: { mode: (typeof RESET_MODES)[number] };
	resetUncommitted: { mode: "mixed" | "hard" };
	stashUncommittedChanges: { includeUntracked: boolean };
};

/** The actions the context menu offers for a local branch. */
export type BranchActions = {
	checkout: boolean;
	rename: boolean;
	delete: boolean;
	merge: boolean;
	rebase: boolean;
	push: boolean;
	createPullRequest: boolean;
	createArchive: boolean;
	selectInBranchesDropdown: boolean;
	unselectInBranchesDropdown: boolean;
	copyName: boolean;
};

/** The actions the context menu offers for a commit. */
export type CommitActions = {
	addTag: boolean;
	createBranch: boolean;
	checkout: boolean;
	cherrypick: boolean;
	revert: boolean;
	drop: boolean;
	merge: boolean;
	rebase: boolean;
	reset: boolean;
	copyHash: boolean;
	copySubject: boolean;
};

/** The actions the context menu offers for a remote branch. */
export type RemoteBranchActions = {
	checkout: boolean;
	delete: boolean;
	fetch: boolean;
	merge: boolean;
	pull: boolean;
	createPullRequest: boolean;
	createArchive: boolean;
	selectInBranchesDropdown: boolean;
	unselectInBranchesDropdown: boolean;
	copyName: boolean;
};

/** The actions the context menu offers for a stash. */
export type StashActions = {
	apply: boolean;
	createBranch: boolean;
	pop: boolean;
	drop: boolean;
	copyName: boolean;
	copyHash: boolean;
};

/** The actions the context menu offers for a tag. */
export type TagActions = {
	viewDetails: boolean;
	delete: boolean;
	push: boolean;
	createArchive: boolean;
	copyName: boolean;
};

/** The actions the context menu offers for uncommitted changes. */
export type UncommittedChangesActions = {
	stash: boolean;
	reset: boolean;
	clean: boolean;
	openSourceControlView: boolean;
};

/**
 * The actions the commit details view offers for one file, and for an issue a commit message mentions.
 * The bundled page draws that menu unconditionally, so it is this app's own list: a false here is what
 * keeps a menu entry from being offered before the command behind it exists.
 */
export type FileViewActions = {
	viewIssue: boolean;
	viewDiff: boolean;
	viewFileAtThisRevision: boolean;
	viewDiffWithWorkingFile: boolean;
	openFile: boolean;
	markAsReviewed: boolean;
	markAsNotReviewed: boolean;
	copyAbsoluteFilePath: boolean;
	copyRelativeFilePath: boolean;
};

/** Which of the page's actions are offered at all, by the thing they act on. */
export type ContextMenuActionsVisibility = {
	branch: BranchActions;
	commit: CommitActions;
	remoteBranch: RemoteBranchActions;
	stash: StashActions;
	tag: TagActions;
	uncommittedChanges: UncommittedChangesActions;
	fileView: FileViewActions;
};

/** Everything the page needs to draw itself, read once when the view is opened. */
export type GitGraphViewConfig = {
	commitDetailsView: CommitDetailsViewConfig;
	commitOrdering: (typeof COMMIT_ORDERS)[number];
	contextMenuActionsVisibility: ContextMenuActionsVisibility;
	customBranchGlobPatterns: CustomBranchGlobPattern[];
	customEmojiShortcodeMappings: CustomEmojiShortcodeMapping[];
	customPullRequestProviders: PullRequestProvider[];
	dateFormat: DateFormatConfig;
	defaultColumnVisibility: ColumnVisibilityConfig;
	dialogDefaults: DialogDefaultsConfig;
	enhancedAccessibility: boolean;
	fetchAndPrune: boolean;
	fetchAndPruneTags: boolean;
	/** Always false here: an avatar is a request to a third party, and this daemon makes none. */
	fetchAvatars: boolean;
	graph: GraphConfig;
	includeCommitsMentionedByReflogs: boolean;
	initialLoadCommits: number;
	keybindings: KeybindingsConfig;
	loadMoreCommits: number;
	loadMoreCommitsAutomatically: boolean;
	markdown: boolean;
	mute: MuteConfig;
	onlyFollowFirstParent: boolean;
	onRepoLoad: OnRepoLoadConfig;
	referenceLabels: ReferenceLabelsConfig;
	repoDropdownOrder: 0 | 1 | 2;
	showRemoteBranches: boolean;
	showStashes: boolean;
	showTags: boolean;
};

// ---------- what is remembered between sessions ----------

/** The two decisions the page remembers for every repository the human opens. */
export type GlobalViewState = {
	alwaysAcceptCheckoutCommit: boolean;
	issueLinkingConfig: IssueLinkingConfig | null;
	pushTagSkipRemoteCheck: boolean;
};

/** The three find-bar decisions the page remembers for this workspace. */
export type WorkspaceViewState = {
	findIsCaseSensitive: boolean;
	findIsRegex: boolean;
	findOpenCommitDetailsView: boolean;
};

/** Everything the Git Graph view keeps for one workspace, as it is written to disk. */
export type GitGraphViewState = {
	globalViewState: GlobalViewState;
	workspaceViewState: WorkspaceViewState;
	repos: Record<string, GitRepoState>;
	codeReviews: Record<string, Record<string, GitCodeReview>>;
	/** The repository the human was last looking at, so the dropdown opens where they left it. */
	lastActiveRepo: string | null;
};

/** Where the page should go once it has loaded, and the command it should run on arrival. */
export type GitLoadViewTo = {
	repo: string;
	commitDetails?: { commitHash: string; compareWithHash: string | null };
	runCommandOnLoad?: "fetch";
};

/**
 * What the page is handed once it is allowed to draw, which is everything except the three state
 * objects it keeps for itself.
 *
 * `repos` is keyed by real path and holds a repository's remembered arrangement, because the page
 * reads the arrangement (which branches it showed, how wide the panes are) before it asks git
 * anything: a repository it has never seen is listed with the defaults.
 */
export type GitGraphInitialState = {
	config: GitGraphViewConfig;
	lastActiveRepo: string | null;
	loadViewTo: GitLoadViewTo | null;
	repos: Record<string, GitRepoState>;
	loadRepoInfoRefreshId: number;
	loadCommitsRefreshId: number;
};

/**
 * The answer to `GET /git/init`: whether this tab can draw a graph at all, and the three globals the
 * bundled page reads the moment it runs.
 *
 * A page that cannot draw says why in `reason` rather than failing the request, because "the extension
 * is not installed" and "this workspace has no repository" are things the human can act on, and a 500
 * in a tab is not.
 */
export type GitGraphInitPayload = {
	available: boolean;
	reason: string | null;
	initialState: GitGraphInitialState | null;
	globalState: GlobalViewState | null;
	workspaceState: WorkspaceViewState | null;
};

/**
 * What a diff or a file is shown as.
 *
 * The bundled page asks an editor to open a diff document; this app has no editor, so the daemon
 * answers the text itself and the view draws it. `binary` says the bytes are not text at all, and
 * `truncated` says the file was longer than the view will read in one go.
 */
export type GitTextView = {
	title: string;
	kind: "diff" | "file";
	content: string;
	filePath: string;
	truncated: boolean;
	binary: boolean;
};

// ---------- what the daemon answers ----------

/** The answer to a command that only says whether it worked. */
export type GitGraphErrorReply = { command: string; error: string | null };

/** The answer to `loadRepoInfo`, which is what the page draws the branch dropdown from. */
export type GitGraphRepoInfoReply = {
	command: "loadRepoInfo";
	refreshId: number;
	branches: string[];
	head: string | null;
	remotes: string[];
	stashes: GitStash[];
	isRepo: boolean;
	error: string | null;
};

/** The answer to `loadCommits`, which is the graph itself. */
export type GitGraphCommitsReply = {
	command: "loadCommits";
	refreshId: number;
	onlyFollowFirstParent: boolean;
	commits: GitCommit[];
	head: string | null;
	tags: string[];
	moreCommitsAvailable: boolean;
	error: string | null;
};

/** The answer to `loadRepos`, which is the repository dropdown. */
export type GitGraphReposReply = {
	command: "loadRepos";
	repos: Record<string, GitRepoState>;
	lastActiveRepo: string | null;
	loadViewTo: GitLoadViewTo | null;
};

/** The answer to `loadConfig`, which is what the settings panel shows and writes from. */
export type GitGraphConfigReply = { command: "loadConfig"; repo: string; config: GitRepoConfig | null; error: string | null };

/** Every answer the page knows how to read, for the ones this app has a shape for. */
export type GitGraphResponseMessage =
	| GitGraphErrorReply
	| GitGraphRepoInfoReply
	| GitGraphCommitsReply
	| GitGraphReposReply
	| GitGraphConfigReply;

// ---------- what the view asks for ----------

/**
 * One command from the page, with every field checked. `repo` is the real path of a repository the
 * repository dropdown offered, and it is the folder each command runs in.
 */
export type GitGraphRequest =
	| { command: "addRemote"; repo: string; name: string; url: string; pushUrl: string | null; fetch: boolean }
	| { command: "addTag"; repo: string; tagName: string; commitHash: string; type: 0 | 1; message: string; pushToRemote: string | null; force: boolean }
	| { command: "applyStash"; repo: string; selector: string; reinstateIndex: boolean }
	| { command: "branchFromStash"; repo: string; selector: string; branchName: string }
	| { command: "checkoutBranch"; repo: string; branchName: string; remoteBranch: string | null; pullAfterwards: CheckoutPull | null }
	| { command: "checkoutCommit"; repo: string; commitHash: string }
	| { command: "cherrypickCommit"; repo: string; commitHash: string; parentIndex: number; recordOrigin: boolean; noCommit: boolean }
	| { command: "cleanUntrackedFiles"; repo: string; directories: boolean }
	| { command: "commitDetails"; repo: string; commitHash: string; hasParents: boolean; stash: GitStash | null; avatarEmail: string | null; refresh: boolean }
	| { command: "compareCommits"; repo: string; commitHash: string; compareWithHash: string; fromHash: string; toHash: string; refresh: boolean }
	| { command: "copyFilePath"; repo: string; filePath: string; absolute: boolean }
	| { command: "copyToClipboard"; type: string; data: string }
	| { command: "createArchive"; repo: string; ref: string }
	| { command: "createBranch"; repo: string; branchName: string; commitHash: string; checkout: boolean; force: boolean }
	| {
			command: "createPullRequest";
			repo: string;
			/** The saved settings the dialog opened with, which is where the destination is written down. */
			config: PullRequestConfig;
			sourceRemote: string;
			sourceOwner: string;
			sourceRepo: string;
			sourceBranch: string;
			push: boolean;
	  }
	| { command: "deleteBranch"; repo: string; branchName: string; forceDelete: boolean; deleteOnRemotes: string[] | null }
	| { command: "deleteRemote"; repo: string; name: string }
	| { command: "deleteRemoteBranch"; repo: string; branchName: string; remote: string }
	| { command: "deleteTag"; repo: string; tagName: string; deleteOnRemote: string | null }
	| { command: "deleteUserDetails"; repo: string; name: boolean; email: boolean; location: (typeof CONFIG_LOCATIONS)[number] }
	| { command: "dropCommit"; repo: string; commitHash: string }
	| { command: "dropStash"; repo: string; selector: string }
	| { command: "editRemote"; repo: string; nameOld: string; nameNew: string; urlOld: string | null; urlNew: string | null; pushUrlOld: string | null; pushUrlNew: string | null }
	| { command: "editUserDetails"; repo: string; name: string; email: string; location: (typeof CONFIG_LOCATIONS)[number]; deleteLocalName: boolean; deleteLocalEmail: boolean }
	| { command: "endCodeReview"; repo: string; id: string }
	| { command: "exportRepoConfig"; repo: string }
	| { command: "fetch"; repo: string; name: string | null; prune: boolean; pruneTags: boolean }
	| { command: "fetchAvatar"; repo: string; remote: string | null; email: string; commits: string[] }
	| { command: "fetchIntoLocalBranch"; repo: string; remote: string; remoteBranch: string; localBranch: string; force: boolean }
	| {
			command: "loadCommits";
			repo: string;
			refreshId: number;
			branches: string[] | null;
			maxCommits: number;
			showTags: boolean;
			showRemoteBranches: boolean;
			includeCommitsMentionedByReflogs: boolean;
			onlyFollowFirstParent: boolean;
			commitOrdering: (typeof COMMIT_ORDERS)[number];
			remotes: string[];
			hideRemotes: string[];
			/** The stashes the page already holds, so the commits that belong to one can be marked, or `null`. */
			stashes: GitStash[] | null;
	  }
	| { command: "loadConfig"; repo: string; remotes: string[] }
	| { command: "loadRepoInfo"; repo: string; refreshId: number; showRemoteBranches: boolean; showStashes: boolean; hideRemotes: string[] }
	| { command: "loadRepos"; check: boolean }
	| { command: "merge"; repo: string; obj: string; actionOn: MergeTarget; createNewCommit: boolean; squash: boolean; noCommit: boolean }
	| { command: "openExtensionSettings" }
	| { command: "openExternalDirDiff"; repo: string; fromHash: string; toHash: string; isGui: boolean }
	| { command: "openExternalUrl"; url: string }
	| { command: "openFile"; repo: string; hash: string; filePath: string }
	| { command: "openTerminal"; repo: string; name: string }
	| { command: "popStash"; repo: string; selector: string; reinstateIndex: boolean }
	| { command: "pruneRemote"; repo: string; name: string }
	| { command: "pullBranch"; repo: string; branchName: string; remote: string; createNewCommit: boolean; squash: boolean }
	| {
			command: "pushBranch";
			repo: string;
			branchName: string;
			remotes: string[];
			setUpstream: boolean;
			mode: (typeof PUSH_MODES)[number];
			willUpdateBranchConfig: boolean;
	  }
	| { command: "pushStash"; repo: string; message: string; includeUntracked: boolean }
	| { command: "pushTag"; repo: string; tagName: string; remotes: string[] }
	| { command: "rebase"; repo: string; obj: string; actionOn: MergeTarget; ignoreDate: boolean; interactive: boolean }
	| { command: "renameBranch"; repo: string; oldName: string; newName: string }
	| { command: "resetToCommit"; repo: string; commit: string; resetMode: (typeof RESET_MODES)[number] }
	| { command: "revertCommit"; repo: string; commitHash: string; parentIndex: number }
	| { command: "setGlobalViewState"; state: GlobalViewState }
	| { command: "setRepoState"; repo: string; state: GitRepoState }
	| { command: "setWorkspaceViewState"; state: WorkspaceViewState }
	| { command: "showErrorMessage"; message: string }
	| { command: "startCodeReview"; repo: string; id: string; commitHash: string; compareWithHash: string | null; files: string[]; lastViewedFile: string | null }
	| { command: "tagDetails"; repo: string; tagName: string; commitHash: string }
	| { command: "updateCodeReview"; repo: string; id: string; remainingFiles: string[]; lastViewedFile: string | null }
	| { command: "viewDiff"; repo: string; fromHash: string; toHash: string; oldFilePath: string; newFilePath: string; type: GitFileChangeType }
	| { command: "viewDiffWithWorkingFile"; repo: string; hash: string; filePath: string }
	| { command: "viewFileAtRevision"; repo: string; hash: string; filePath: string }
	| { command: "viewScm" };

/** What `checkoutBranch` also does when the human asked for the pull in the same dialog. */
export type CheckoutPull = { branchName: string; remote: string; createNewCommit: boolean; squash: boolean };

/**
 * The thing a merge or a rebase acts on, in the three words the page's menus pass along: the words are
 * the page's own, and it builds its progress sentence out of them.
 */
export type MergeTarget = "Branch" | "Remote-tracking Branch" | "Commit";

/** Whether a request was read, or the command it named and why it was not. */
export type ParsedRequest = { ok: true; request: GitGraphRequest } | { ok: false; command: string; error: string };

// ---------- reading one field at a time ----------

/** A field that could not be read. Thrown inside the switch below and answered as the reason there. */
class RequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RequestError";
	}
}

/** A request field, as the page sent it. */
type Fields = Record<string, unknown>;

/** The field, or a reason the request cannot be read. */
function field(raw: Fields, key: string): unknown {
	if (!(key in raw)) throw new RequestError(`${key} is missing`);
	return raw[key];
}

/** A string of any length, with the control characters a config file cannot hold taken out of play. */
function text(raw: Fields, key: string, max = 2048): string {
	const value = field(raw, key);
	if (typeof value !== "string") throw new RequestError(`${key} must be a string`);
	if (value.length > max) throw new RequestError(`${key} cannot be longer than ${max} characters`);
	if (/[\u0000-\u001f\u007f]/.test(value)) throw new RequestError(`${key} cannot contain control characters`);
	return value;
}

/** A string, or `null` when the page sent nothing, which is how it says "not given". */
function optionalText(raw: Fields, key: string, max = 2048): string | null {
	const value = raw[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new RequestError(`${key} must be a string or null`);
	return text(raw, key, max);
}

/** A boolean the page always sends. */
function flag(raw: Fields, key: string): boolean {
	const value = field(raw, key);
	if (typeof value !== "boolean") throw new RequestError(`${key} must be true or false`);
	return value;
}

/** A number that is a count: how many commits, which parent, which refresh. */
function count(raw: Fields, key: string): number {
	const value = field(raw, key);
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new RequestError(`${key} must be a whole number that is not negative`);
	}
	return value;
}

/** A commit id, or `*` for the uncommitted changes row when the command can act on it. */
function hash(raw: Fields, key: string, allowUncommitted = false): string {
	const value = field(raw, key);
	if (!isHash(value, allowUncommitted)) throw new RequestError(`${key} is not a commit id`);
	return value;
}

/**
 * The third parent a stash keeps its untracked files in, spelled the way this daemon hands it out: the
 * selector's commit and `^3`. It is a revision rather than a hash, so `isHash` is right to refuse it.
 */
function isStashParentRevision(value: unknown): value is string {
	return typeof value === "string" && value.endsWith("^3") && isHash(value.slice(0, -2));
}

/**
 * A commit id the page may have been handed by a stash row, where the file a human opened is the one the
 * stash kept untracked and its revision is `<stash hash>^3`. Anything else is refused as a commit id.
 */
function stashHash(raw: Fields, key: string): string {
	const value = field(raw, key);
	if (isHash(value, true) || isStashParentRevision(value)) return value;
	throw new RequestError(`${key} is not a commit id`);
}

/** A revision: a commit, a stash, `HEAD`, or a branch or tag name. */
function revision(raw: Fields, key: string): string {
	const value = field(raw, key);
	if (!isRevision(value)) throw new RequestError(`${key} is not a revision git can resolve`);
	return value;
}

/** A branch or tag name git will accept. */
function refName(raw: Fields, key: string): string {
	const value = field(raw, key);
	if (!isRefName(value)) throw new RequestError(`${key} is not a name git accepts for a branch or tag`);
	return value;
}

/** A remote's name. */
function remoteName(raw: Fields, key: string): string {
	const value = field(raw, key);
	if (!isRemoteName(value)) throw new RequestError(`${key} is not a remote git accepts`);
	return value;
}

/** A list of remote names. */
function remoteNames(raw: Fields, key: string): string[] {
	return list(raw, key, (value) => {
		if (!isRemoteName(value)) throw new RequestError(`${key} holds a name git does not accept as a remote`);
		return value;
	});
}

/** A list whose every entry is read by `each`. */
function list<T>(raw: Fields, key: string, each: (value: unknown) => T): T[] {
	const value = field(raw, key);
	if (!Array.isArray(value)) throw new RequestError(`${key} must be a list`);
	return value.map(each);
}

/** A path inside the repository, which is the only kind of path a command may name. */
function insideRepo(raw: Fields, key: string): string {
	const checked = repoPath(raw[key]);
	if (!checked.ok) throw new RequestError(`${key} ${checked.error}`);
	return checked.value;
}

/** A list of paths inside the repository. */
function insideRepoList(raw: Fields, key: string): string[] {
	return list(raw, key, (value) => {
		const checked = repoPath(value);
		if (!checked.ok) throw new RequestError(`${key} ${checked.error}`);
		return checked.value;
	});
}

/** A hash the page sends as a field it may leave empty, such as the file list of a code review. */
function hashList(raw: Fields, key: string): string[] {
	return list(raw, key, (value) => {
		if (!isHash(value) && !isStashSelector(value)) throw new RequestError(`${key} holds a value that is not a commit id`);
		return value;
	});
}

/** The repository a command runs in, which is a real path this daemon handed out itself. */
function repoRoot(raw: Fields): string {
	const value = field(raw, "repo");
	if (!isRepoRoot(value)) throw new RequestError("repo must be the absolute path of a repository");
	return value;
}

/** The state object a view-state command carries, which is only ever a plain object. */
function stateObject(raw: Fields, key: string): Fields {
	const value = field(raw, key);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(`${key} must be an object`);
	return value as Fields;
}

/** A URL the human will be sent to, limited to the two schemes a browser can open safely. */
function externalUrl(raw: Fields, key: string): string {
	const value = text(raw, key);
	if (!/^https?:\/\//i.test(value)) throw new RequestError(`${key} must be an http or https address`);
	return value;
}

/** A branch selector: a name, or one of the `--glob=…` patterns the branches dropdown offers. */
function branchSelector(value: unknown): string {
	if (typeof value === "string" && /^--glob=[A-Za-z0-9._/*?[\]]+$/.test(value)) return value;
	if (isRefName(value)) return value;
	throw new RequestError("branches holds a value git cannot be asked for");
}

/** One of the three orders a `git log` may be asked for. */
function commitOrder(raw: Fields, key: string): (typeof COMMIT_ORDERS)[number] {
	const value = field(raw, key);
	if (!isOneOf(COMMIT_ORDERS, value)) throw new RequestError(`${key} must be one of ${COMMIT_ORDERS.join(", ")}`);
	return value;
}

/** One of the two scopes user details may be written to. */
function configLocation(raw: Fields, key: string): (typeof CONFIG_LOCATIONS)[number] {
	const value = field(raw, key);
	if (!isOneOf(CONFIG_LOCATIONS, value)) throw new RequestError(`${key} must be one of ${CONFIG_LOCATIONS.join(", ")}`);
	return value;
}

/** One of the three ways `git reset` moves a branch. */
function resetMode(raw: Fields, key: string): (typeof RESET_MODES)[number] {
	const value = field(raw, key);
	if (!isOneOf(RESET_MODES, value)) throw new RequestError(`${key} must be one of ${RESET_MODES.join(", ")}`);
	return value;
}

/** One of the three ways a branch may be pushed. */
function pushMode(raw: Fields, key: string): (typeof PUSH_MODES)[number] {
	const value = field(raw, key);
	if (!isOneOf(PUSH_MODES, value)) throw new RequestError(`${key} must be one of "", force, force-with-lease`);
	return value;
}

/** What an action acts on, which is what its error message says. */
function actionOn(raw: Fields, key: string): MergeTarget {
	const value = field(raw, key);
	if (value !== "Branch" && value !== "Remote-tracking Branch" && value !== "Commit") {
		throw new RequestError(`${key} must be Branch, Remote-tracking Branch or Commit`);
	}
	return value;
}

/** The pull request settings, kept as one object and re-read field by field when it is used. */
function pullRequestConfig(raw: Fields, key: string): PullRequestConfig {
	const value = stateObject(raw, key);
	const custom = value.custom;
	return {
		provider: isOneOf([0, 1, 2, 3] as const, value.provider) ? value.provider : 0,
		custom: custom && typeof custom === "object" ? (custom as PullRequestProvider) : null,
		hostRootUrl: typeof value.hostRootUrl === "string" ? value.hostRootUrl : "",
		sourceOwner: typeof value.sourceOwner === "string" ? value.sourceOwner : "",
		sourceRepo: typeof value.sourceRepo === "string" ? value.sourceRepo : "",
		sourceRemote: typeof value.sourceRemote === "string" ? value.sourceRemote : "",
		destOwner: typeof value.destOwner === "string" ? value.destOwner : "",
		destRepo: typeof value.destRepo === "string" ? value.destRepo : "",
		destRemote: typeof value.destRemote === "string" ? value.destRemote : null,
		destBranch: typeof value.destBranch === "string" ? value.destBranch : "",
	};
}

/** A stash selector the page named, which is the one spelling `stash@{n}` has. */
function stashSelector(raw: Fields): string {
	const value = field(raw, "selector");
	if (!isStashSelector(value)) throw new RequestError("selector must be a stash selector such as stash@{0}");
	return value;
}

/** A code review's id, which is a commit id or the two ids of a comparison joined by a dash. */
function reviewId(raw: Fields, key: string): string {
	const value = field(raw, key);
	if (typeof value !== "string" || value.length > 200) throw new RequestError(`${key} must be a string`);
	const ids = value.split("-");
	if (ids.length > 2 || !ids.every((id) => isHash(id, true))) throw new RequestError(`${key} is not a code review id`);
	return value;
}

/** An owner or repository name as a hosting site spells it, which is never a path or an option. */
function ownerName(raw: Fields, key: string): string {
	const value = field(raw, key);
	if (typeof value !== "string" || value.length === 0 || value.length > 255) throw new RequestError(`${key} must be a name of 1 to 255 characters`);
	if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new RequestError(`${key} holds characters a repository name cannot have`);
	return value;
}

/**
 * One stash as the page spells it: the selector it is dropped by, the commit it sits on, and the commit
 * holding the files it kept untracked. `where` is the field it arrived in, so the reason names it.
 */
function stashEntry(value: unknown, where: string): GitStash {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(`${where} must be a stash`);
	const stash = value as Fields;
	if (!isStashSelector(stash.selector)) throw new RequestError(`${where}.selector must be a stash selector such as stash@{0}`);
	if (!isHash(stash.baseHash)) throw new RequestError(`${where}.baseHash is not a commit id`);
	// `untrackedFilesHash` is the one this daemon hands out as `<stash hash>^3`, so it is read back as that.
	if (!isHash(stash.untrackedFilesHash) && !isStashParentRevision(stash.untrackedFilesHash) && stash.untrackedFilesHash !== null) {
		throw new RequestError(`${where}.untrackedFilesHash is not a commit id`);
	}
	return { selector: stash.selector, baseHash: stash.baseHash, untrackedFilesHash: stash.untrackedFilesHash };
}

/** The stash a commit row is, when the page asks about one: `null` for an ordinary commit. */
function stashOf(raw: Fields): GitStash | null {
	const value = raw.stash;
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) throw new RequestError("stash must be a stash or null");
	return stashEntry(value, "stash");
}

/**
 * The stashes the page already holds, which it sends with `loadCommits` so the commits that belong to one
 * are marked with the selector it knows. `null` is not an empty list: it is a page that knows nothing
 * about this repository's stashes yet, and the reader then asks git itself rather than seeing none.
 */
function stashList(raw: Fields, key: string): GitStash[] | null {
	const value = raw[key];
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) throw new RequestError(`${key} must be a list of stashes or null`);
	return value.map((entry) => stashEntry(entry, key));
}

/** The pull the checkout branch dialog may ask for in the same breath. */
function checkoutPull(raw: Fields): CheckoutPull | null {
	const value = raw.pullAfterwards;
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) throw new RequestError("pullAfterwards must be an object or null");
	const pull = value as Fields;
	const branchName = pull.branchName;
	const remote = pull.remote;
	if (!isRefName(branchName)) throw new RequestError("pullAfterwards.branchName is not a name git accepts");
	if (!isRemoteName(remote)) throw new RequestError("pullAfterwards.remote is not a name git accepts as a remote");
	if (typeof pull.createNewCommit !== "boolean" || typeof pull.squash !== "boolean") {
		throw new RequestError("pullAfterwards must say whether it creates a commit and whether it squashes");
	}
	return { branchName, remote, createNewCommit: pull.createNewCommit, squash: pull.squash };
}

// ---------- reading the whole request ----------

/**
 * One command from the page, read. Every field a command carries is checked here, so a command that
 * gets past this point can be run: the alternative is a validator per command inside the module that
 * runs it, and one of those is always the one nobody wrote.
 */
function readRequest(command: string, raw: Fields): GitGraphRequest | null {
	switch (command) {
		case "addRemote": {
			const pushUrl = optionalText(raw, "pushUrl");
			if (pushUrl !== null && !isRemoteUrl(pushUrl)) throw new RequestError("pushUrl must be a URL git accepts");
			const url = text(raw, "url");
			if (!isRemoteUrl(url)) throw new RequestError("url must be a URL git accepts");
			return { command, repo: repoRoot(raw), name: remoteName(raw, "name"), url, pushUrl, fetch: flag(raw, "fetch") };
		}
		case "addTag": {
			const type = field(raw, "type");
			if (!isOneOf(TAG_TYPES, type)) throw new RequestError("type must be 0 for an annotated tag or 1 for a lightweight one");
			// The page's "Push to remote" field is the remote it named, or `null` for none: a repository with
			// one remote sends that remote's name, and one with several sends the one the human picked.
			const pushToRemote = optionalText(raw, "pushToRemote", 128);
			if (pushToRemote !== null && !isRemoteName(pushToRemote)) throw new RequestError("pushToRemote is not a name git accepts as a remote");
			return {
				command,
				repo: repoRoot(raw),
				tagName: refName(raw, "tagName"),
				commitHash: hash(raw, "commitHash"),
				type,
				message: text(raw, "message", 8192),
				pushToRemote,
				force: flag(raw, "force"),
			};
		}
		case "applyStash":
			return { command, repo: repoRoot(raw), selector: stashSelector(raw), reinstateIndex: flag(raw, "reinstateIndex") };
		case "branchFromStash":
			return { command, repo: repoRoot(raw), selector: stashSelector(raw), branchName: refName(raw, "branchName") };
		case "checkoutBranch": {
			const remoteBranch = optionalText(raw, "remoteBranch");
			if (remoteBranch !== null && !isRefName(remoteBranch)) throw new RequestError("remoteBranch is not a name git accepts");
			return { command, repo: repoRoot(raw), branchName: refName(raw, "branchName"), remoteBranch, pullAfterwards: checkoutPull(raw) };
		}
		case "checkoutCommit":
			return { command, repo: repoRoot(raw), commitHash: hash(raw, "commitHash") };
		case "cherrypickCommit":
			return {
				command,
				repo: repoRoot(raw),
				commitHash: hash(raw, "commitHash"),
				parentIndex: count(raw, "parentIndex"),
				recordOrigin: flag(raw, "recordOrigin"),
				noCommit: flag(raw, "noCommit"),
			};
		case "cleanUntrackedFiles":
			// The page's one checkbox: whether the clean descends into untracked directories.
			return { command, repo: repoRoot(raw), directories: flag(raw, "directories") };
		case "commitDetails":
			return {
				command,
				repo: repoRoot(raw),
				commitHash: hash(raw, "commitHash", true),
				hasParents: flag(raw, "hasParents"),
				stash: stashOf(raw),
				avatarEmail: optionalText(raw, "avatarEmail"),
				refresh: flag(raw, "refresh"),
			};
		case "compareCommits":
			return {
				command,
				repo: repoRoot(raw),
				commitHash: hash(raw, "commitHash", true),
				compareWithHash: hash(raw, "compareWithHash", true),
				fromHash: hash(raw, "fromHash", true),
				toHash: hash(raw, "toHash", true),
				refresh: flag(raw, "refresh"),
			};
		case "copyFilePath":
			return { command, repo: repoRoot(raw), filePath: insideRepo(raw, "filePath"), absolute: flag(raw, "absolute") };
		case "copyToClipboard":
			return { command, type: text(raw, "type", 128), data: text(raw, "data", 8192) };
		case "createArchive":
			return { command, repo: repoRoot(raw), ref: revision(raw, "ref") };
		case "createBranch":
			return {
				command,
				repo: repoRoot(raw),
				branchName: refName(raw, "branchName"),
				commitHash: hash(raw, "commitHash", true),
				checkout: flag(raw, "checkout"),
				force: flag(raw, "force"),
			};
		case "createPullRequest":
			// The destination is not sent beside the source: the page sends the saved settings whole, and
			// `config.destOwner`, `config.destRepo` and `config.destRemote` are where it is written down.
			return {
				command,
				repo: repoRoot(raw),
				config: pullRequestConfig(raw, "config"),
				sourceRemote: remoteName(raw, "sourceRemote"),
				sourceOwner: ownerName(raw, "sourceOwner"),
				sourceRepo: ownerName(raw, "sourceRepo"),
				sourceBranch: refName(raw, "sourceBranch"),
				push: flag(raw, "push"),
			};
		case "deleteBranch": {
			const deleteOnRemotes = raw.deleteOnRemotes === undefined || raw.deleteOnRemotes === null ? null : remoteNames(raw, "deleteOnRemotes");
			return {
				command,
				repo: repoRoot(raw),
				branchName: refName(raw, "branchName"),
				forceDelete: flag(raw, "forceDelete"),
				deleteOnRemotes,
			};
		}
		case "deleteRemote":
			return { command, repo: repoRoot(raw), name: remoteName(raw, "name") };
		case "deleteRemoteBranch":
			return { command, repo: repoRoot(raw), branchName: refName(raw, "branchName"), remote: remoteName(raw, "remote") };
		case "deleteTag": {
			const deleteOnRemote = optionalText(raw, "deleteOnRemote");
			if (deleteOnRemote !== null && !isRemoteName(deleteOnRemote)) throw new RequestError("deleteOnRemote is not a name git accepts as a remote");
			return { command, repo: repoRoot(raw), tagName: refName(raw, "tagName"), deleteOnRemote };
		}
		case "deleteUserDetails":
			return {
				command,
				repo: repoRoot(raw),
				name: flag(raw, "name"),
				email: flag(raw, "email"),
				location: configLocation(raw, "location"),
			};
		case "dropCommit":
			return { command, repo: repoRoot(raw), commitHash: hash(raw, "commitHash") };
		case "dropStash":
			return { command, repo: repoRoot(raw), selector: stashSelector(raw) };
		case "editRemote": {
			const urlOld = optionalText(raw, "urlOld");
			const urlNew = optionalText(raw, "urlNew");
			const pushUrlOld = optionalText(raw, "pushUrlOld");
			const pushUrlNew = optionalText(raw, "pushUrlNew");
			for (const [key, url] of [["urlOld", urlOld], ["urlNew", urlNew], ["pushUrlOld", pushUrlOld], ["pushUrlNew", pushUrlNew]] as const) {
				if (url !== null && !isRemoteUrl(url)) throw new RequestError(`${key} must be a URL git accepts`);
			}
			return {
				command,
				repo: repoRoot(raw),
				nameOld: remoteName(raw, "nameOld"),
				nameNew: remoteName(raw, "nameNew"),
				urlOld,
				urlNew,
				pushUrlOld,
				pushUrlNew,
			};
		}
		case "editUserDetails":
			return {
				command,
				repo: repoRoot(raw),
				name: text(raw, "name", 255),
				email: text(raw, "email", 255),
				location: configLocation(raw, "location"),
				deleteLocalName: flag(raw, "deleteLocalName"),
				deleteLocalEmail: flag(raw, "deleteLocalEmail"),
			};
		case "endCodeReview":
			return { command, repo: repoRoot(raw), id: reviewId(raw, "id") };
		case "exportRepoConfig":
			return { command, repo: repoRoot(raw) };
		case "fetch": {
			const name = optionalText(raw, "name", 128);
			if (name !== null && !isRemoteName(name)) throw new RequestError("name is not a name git accepts as a remote");
			return { command, repo: repoRoot(raw), name, prune: flag(raw, "prune"), pruneTags: flag(raw, "pruneTags") };
		}
		case "fetchAvatar": {
			const remote = optionalText(raw, "remote", 128);
			if (remote !== null && !isRemoteName(remote)) throw new RequestError("remote is not a name git accepts as a remote");
			return { command, repo: repoRoot(raw), remote, email: text(raw, "email", 320), commits: hashList(raw, "commits") };
		}
		case "fetchIntoLocalBranch":
			return {
				command,
				repo: repoRoot(raw),
				remote: remoteName(raw, "remote"),
				remoteBranch: refName(raw, "remoteBranch"),
				localBranch: refName(raw, "localBranch"),
				force: flag(raw, "force"),
			};
		case "loadCommits": {
			const branches = raw.branches === undefined || raw.branches === null ? null : list(raw, "branches", branchSelector);
			return {
				command,
				repo: repoRoot(raw),
				refreshId: count(raw, "refreshId"),
				branches,
				maxCommits: count(raw, "maxCommits"),
				showTags: flag(raw, "showTags"),
				showRemoteBranches: flag(raw, "showRemoteBranches"),
				includeCommitsMentionedByReflogs: flag(raw, "includeCommitsMentionedByReflogs"),
				onlyFollowFirstParent: flag(raw, "onlyFollowFirstParent"),
				commitOrdering: commitOrder(raw, "commitOrdering"),
				remotes: remoteNames(raw, "remotes"),
				hideRemotes: remoteNames(raw, "hideRemotes"),
				stashes: stashList(raw, "stashes"),
			};
		}
		case "loadConfig":
			return { command, repo: repoRoot(raw), remotes: remoteNames(raw, "remotes") };
		case "loadRepoInfo":
			return {
				command,
				repo: repoRoot(raw),
				refreshId: count(raw, "refreshId"),
				showRemoteBranches: flag(raw, "showRemoteBranches"),
				showStashes: flag(raw, "showStashes"),
				hideRemotes: remoteNames(raw, "hideRemotes"),
			};
		case "loadRepos":
			return { command, check: flag(raw, "check") };
		case "merge":
			return {
				command,
				repo: repoRoot(raw),
				obj: revision(raw, "obj"),
				actionOn: actionOn(raw, "actionOn"),
				createNewCommit: flag(raw, "createNewCommit"),
				squash: flag(raw, "squash"),
				noCommit: flag(raw, "noCommit"),
			};
		case "openExtensionSettings":
			return { command };
		case "openExternalDirDiff":
			return {
				command,
				repo: repoRoot(raw),
				fromHash: hash(raw, "fromHash", true),
				toHash: hash(raw, "toHash", true),
				isGui: flag(raw, "isGui"),
			};
		case "openExternalUrl":
			return { command, url: externalUrl(raw, "url") };
		case "openFile":
			return { command, repo: repoRoot(raw), hash: stashHash(raw, "hash"), filePath: insideRepo(raw, "filePath") };
		case "openTerminal":
			return { command, repo: repoRoot(raw), name: text(raw, "name", 255) };
		case "popStash":
			return { command, repo: repoRoot(raw), selector: stashSelector(raw), reinstateIndex: flag(raw, "reinstateIndex") };
		case "pruneRemote":
			return { command, repo: repoRoot(raw), name: remoteName(raw, "name") };
		case "pullBranch":
			return {
				command,
				repo: repoRoot(raw),
				branchName: refName(raw, "branchName"),
				remote: remoteName(raw, "remote"),
				createNewCommit: flag(raw, "createNewCommit"),
				squash: flag(raw, "squash"),
			};
		case "pushBranch":
			return {
				command,
				repo: repoRoot(raw),
				branchName: refName(raw, "branchName"),
				remotes: remoteNames(raw, "remotes"),
				setUpstream: flag(raw, "setUpstream"),
				mode: pushMode(raw, "mode"),
				willUpdateBranchConfig: flag(raw, "willUpdateBranchConfig"),
			};
		case "pushStash":
			return { command, repo: repoRoot(raw), message: text(raw, "message", 8192), includeUntracked: flag(raw, "includeUntracked") };
		case "pushTag":
			return { command, repo: repoRoot(raw), tagName: refName(raw, "tagName"), remotes: remoteNames(raw, "remotes") };
		case "rebase":
			return {
				command,
				repo: repoRoot(raw),
				obj: revision(raw, "obj"),
				actionOn: actionOn(raw, "actionOn"),
				ignoreDate: flag(raw, "ignoreDate"),
				interactive: flag(raw, "interactive"),
			};
		case "renameBranch":
			return { command, repo: repoRoot(raw), oldName: refName(raw, "oldName"), newName: refName(raw, "newName") };
		case "resetToCommit":
			return { command, repo: repoRoot(raw), commit: revision(raw, "commit"), resetMode: resetMode(raw, "resetMode") };
		case "revertCommit":
			return { command, repo: repoRoot(raw), commitHash: hash(raw, "commitHash"), parentIndex: count(raw, "parentIndex") };
		case "setGlobalViewState":
			return { command, state: globalViewStateFrom(stateObject(raw, "state")) };
		case "setRepoState":
			return { command, repo: repoRoot(raw), state: repoStateFrom(stateObject(raw, "state")) };
		case "setWorkspaceViewState":
			return { command, state: workspaceViewStateFrom(stateObject(raw, "state")) };
		case "showErrorMessage":
			return { command, message: text(raw, "message", 4096) };
		case "startCodeReview": {
			const compareWithHash = optionalText(raw, "compareWithHash");
			if (compareWithHash !== null && !isHash(compareWithHash, true)) throw new RequestError("compareWithHash is not a commit id");
			const lastViewedFile = optionalText(raw, "lastViewedFile");
			return {
				command,
				repo: repoRoot(raw),
				id: reviewId(raw, "id"),
				commitHash: hash(raw, "commitHash", true),
				compareWithHash,
				files: insideRepoList(raw, "files"),
				lastViewedFile: lastViewedFile === null ? null : insideRepo(raw, "lastViewedFile"),
			};
		}
		case "tagDetails":
			return { command, repo: repoRoot(raw), tagName: refName(raw, "tagName"), commitHash: hash(raw, "commitHash") };
		case "updateCodeReview": {
			const lastViewedFile = optionalText(raw, "lastViewedFile");
			return {
				command,
				repo: repoRoot(raw),
				id: reviewId(raw, "id"),
				remainingFiles: insideRepoList(raw, "remainingFiles"),
				lastViewedFile: lastViewedFile === null ? null : insideRepo(raw, "lastViewedFile"),
			};
		}
		case "viewDiff": {
			const type = field(raw, "type");
			if (!isOneOf(["A", "C", "D", "M", "R", "U"] as const, type)) throw new RequestError("type must be one of A, C, D, M, R, U");
			return {
				command,
				repo: repoRoot(raw),
				fromHash: stashHash(raw, "fromHash"),
				toHash: stashHash(raw, "toHash"),
				oldFilePath: insideRepo(raw, "oldFilePath"),
				newFilePath: insideRepo(raw, "newFilePath"),
				type,
			};
		}
		case "viewDiffWithWorkingFile":
			return { command, repo: repoRoot(raw), hash: stashHash(raw, "hash"), filePath: insideRepo(raw, "filePath") };
		case "viewFileAtRevision":
			return { command, repo: repoRoot(raw), hash: stashHash(raw, "hash"), filePath: insideRepo(raw, "filePath") };
		case "viewScm":
			return { command };
		default:
			return null;
	}
}

/**
 * Read one message from the page. An unknown command and a command with a field that cannot be read
 * both answer the reason, because a page that asked for something wrong is a page whose human needs to
 * be told which part of it was refused.
 */
export function parseRequest(raw: unknown): ParsedRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, command: "", error: "a request must be an object" };
	const fields = raw as Fields;
	const command = fields.command;
	if (typeof command !== "string" || command.length === 0) return { ok: false, command: "", error: "a request must name a command" };
	try {
		const request = readRequest(command, fields);
		if (!request) return { ok: false, command, error: `Unsupported command: ${command}` };
		return { ok: true, request };
	} catch (error) {
		if (error instanceof RequestError) return { ok: false, command, error: error.message };
		return { ok: false, command, error: (error as Error).message };
	}
}

