/**
 * The wire between the Git Graph Libre page and this daemon.
 *
 * The page is Libre's `web.min.js`, so every name here is its name and cannot be renamed for taste:
 * `viewState`, `loadCommits`, `commitDetails`, `requestId`, all of it. What the page sends is
 * checked before git is asked anything, which is why the request side is broad and every command
 * the daemon answers is spelled out — a command that arrives with a field this module could not
 * read is a command that answers a reason instead of running.
 */
import { isHash, isOneOf, isRefName, isRemoteName, isRemoteUrl, isRepoRoot, isRevision, isStashSelector, repoPath } from "./validate.ts";

// ---------- shared ----------

/** The hash the graph draws for the uncommitted changes row. */
export const UNCOMMITTED = "*";

export type GitQueryError = { message: string; stderr: string | null; exitCode: number | null; task: string | null };

export function queryError(message: string): GitQueryError {
	return { message, stderr: null, exitCode: null, task: null };
}

export type GitRef = { hash: string; name: string; type: "head" | "tag" | "remote"; signed?: boolean };
export type GitCommitSignature = { status: "valid" | "valid-untrusted" | "bad" | "expired" | "expired-key" | "revoked-key" | "unverifiable" | "unknown"; key: string | null; signer: string | null };
export type GitCommitNode = { hash: string; parentHashes: string[]; author: string; email: string; date: number; message: string; refs: GitRef[]; signature?: GitCommitSignature | null; stash?: { ref: string } };
export type GitStash = { index: number; ref: string; hash: string; message: string; date: number | null; sourceHash: string | null };
export type GitFileChange = { oldFilePath: string; newFilePath: string; type: "A" | "M" | "D" | "R" | "T"; additions: number | null; deletions: number | null; untracked?: true };
export type GitCommitDetails = { hash: string; parents: string[]; author: string; email: string; authorDate: number; committer: string; committerEmail: string; committerDate: number; body: string; fileChanges: GitFileChange[] };
export type GitTagDetails = { tagName: string; type: "annotated" | "lightweight"; objectHash: string; targetHash: string; targetType: string; taggerName: string | null; taggerEmail: string | null; taggerDate: number | null; subject: string; body: string; signature: { status: "valid" | "bad" | "failed" | "unknown"; key: string | null; signer: string | null } | null };
export type GitRemote = { name: string; fetchUrls: string[]; pushUrls: string[] };
export type GitConfigValue = { local: string | null; global: string | null };
export type GitRepoInfo = { isRepo: boolean; head: string | null; headCommit: string | null; authors: string[]; tags: string[]; remotes: GitRemote[]; stashes: GitStash[]; stashCount: number; config: { userName: GitConfigValue; userEmail: GitConfigValue } };
export type GitWorktree = { path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; isMain: boolean; isCurrent: boolean; locked: { reason: string } | null; prunable: { reason: string } | null };
export type GitUncommittedFile = { path: string; oldPath: string | null; stagedKind: string | null; unstagedKind: string | null };
export type GitUncommittedChanges = { staged: GitUncommittedFile[]; unstaged: GitUncommittedFile[] };
export type GitCommitSearchResult = { hash: string; parentHashes: string[]; author: string; email: string; date: number; message: string; loadCount: number };

// ---------- repo state ----------

export type CommitOrdering = "date" | "author-date" | "topo";
export const COMMIT_ORDERINGS: readonly CommitOrdering[] = ["date", "author-date", "topo"];
export type RepoBooleanOverride = "default" | "enabled" | "disabled";
export type IssueLinkingConfig = { pattern: string; urlTemplate: string };
export type PullRequestCreationConfig = { remoteName: string; baseBranch: string; urlTemplate: string; pushBeforeCreate: boolean };
export type GitRepoState = {
	columnWidths: number[] | null;
	commitOrdering?: CommitOrdering;
	displayName?: string | null;
	hiddenRemotes?: string[];
	includeReflog?: RepoBooleanOverride;
	includeUnreachableCommits?: RepoBooleanOverride;
	issueLinking?: IssueLinkingConfig | null;
	lastConfigImportAt?: number;
	onlyFollowFirstParent?: RepoBooleanOverride;
	pullRequest?: PullRequestCreationConfig | null;
	showRemoteBranches?: RepoBooleanOverride;
	showStashes?: RepoBooleanOverride;
	showTags?: RepoBooleanOverride;
};
export type GitRepoSet = Record<string, GitRepoState>;
export type RepoWorktreeInfo = { commonDir: string; linked: boolean; branch: string | null; detached: boolean };
export type OutsideWorktree = { path: string; commonDir: string; linked: boolean; branch: string | null; detached: boolean; repo: string };
export type RepoLayout = { worktrees: Record<string, RepoWorktreeInfo>; outside: OutsideWorktree[]; bareGroups?: string[] };

// ---------- menus ----------

export type ContextMenuActionsVisibility = {
	branch: { checkout: boolean; rename: boolean; delete: boolean; merge: boolean; rebase: boolean; push: boolean; pull: boolean; viewIssue: boolean; createPullRequest: boolean; createArchive: boolean; createWorktree: boolean; compareWithHead: boolean; compareWith: boolean; copyName: boolean };
	commit: { addTag: boolean; createBranch: boolean; createWorktree: boolean; compareWithHead: boolean; compareWith: boolean; compareSelection: boolean; compareWithWorkingTree: boolean; checkout: boolean; cherryPick: boolean; revert: boolean; undoLastCommit: boolean; editMessage: boolean; drop: boolean; merge: boolean; rebase: boolean; reset: boolean; copyHash: boolean; copySubject: boolean; squashSelection: boolean; dropSelection: boolean };
	commitDetailsViewFile: { viewDiff: boolean; openDiffTab: boolean; viewFileAtRevision: boolean; compareWithWorkingTree: boolean; openFile: boolean; resetFileToRevision: boolean; copyAbsoluteFilePath: boolean; copyRelativeFilePath: boolean };
	remoteBranch: { checkout: boolean; delete: boolean; merge: boolean; fetchIntoLocalBranch: boolean; pull: boolean; viewIssue: boolean; createPullRequest: boolean; createArchive: boolean; createWorktree: boolean; compareWithHead: boolean; compareWith: boolean; copyName: boolean };
	stash: { apply: boolean; createBranch: boolean; pop: boolean; drop: boolean; copyName: boolean; copyHash: boolean };
	tag: { viewDetails: boolean; delete: boolean; push: boolean; fetchTags: boolean; createArchive: boolean; createWorktree: boolean; compareWithHead: boolean; compareWith: boolean; copyName: boolean };
	uncommittedChanges: { stash: boolean; reset: boolean; clean: boolean; openSourceControlView: boolean };
};

// ---------- view state ----------

export type GitGraphViewState = {
	autoCenterCommitDetailsView: boolean;
	commitDetailsCompactFolders: boolean;
	commitDetailsFileViewMode: "tree" | "list";
	uncommittedFileViewMode: "tree" | "list";
	contextMenuActionsVisibility: ContextMenuActionsVisibility;
	dateFormat: "Date & Time" | "Date Only" | "Relative";
	fetchAvatars: boolean;
	showSignatureColumn: boolean;
	graphColors: string[];
	graphFontSize: number;
	graphRowHeight: number;
	graphStyle: "rounded" | "angular";
	revealHighlightColor: string;
	customBranchGlobPatterns: Array<{ name: string; glob: string }>;
	initialLoadCommits: number;
	lastActiveRepo: string | null;
	loadMoreCommits: number;
	muteCommitsNotAncestorsOfHead: boolean;
	muteMergeCommits: boolean;
	boldCheckedOutCommit: boolean;
	fetchTagsByDefault: boolean;
	showTagRemotes: "off" | "origin" | "all";
	worktreePathTemplate?: string;
	mergeNoFastForward: boolean;
	pullBranchNoFastForward: boolean;
	createBranchCheckout: boolean;
	onlyFollowFirstParent: boolean;
	repos: GitRepoSet;
	repoLayout?: RepoLayout;
	showCurrentBranchByDefault: boolean;
	showRemoteBranches: boolean;
	showStashes: boolean;
	stashDisplay?: "table" | "graph" | "both";
	showTags: boolean;
	includeReflog: boolean;
	includeUnreachableCommits: boolean;
	shortHashLength: number;
	language: string;
	languages: Array<{ id: string; label: string }>;
};

export type GitGraphInitPayload = {
	available: boolean;
	reason: string | null;
	viewState: GitGraphViewState | null;
	version: string | null;
};

// ---------- text view ----------

export type GitTextView = { title: string; kind: "diff" | "file"; content: string; filePath: string; truncated: boolean; binary: boolean };

// ---------- request validation ----------

export type LibreRequest = { command: string; repo?: string; requestId?: number; [key: string]: unknown };
export type ParsedLibreRequest = { ok: true; request: LibreRequest } | { ok: false; command: string; error: string };

class RequestError extends Error {}

type Fields = Record<string, unknown>;

function repoField(raw: Fields): string | undefined {
	if (!("repo" in raw) || raw.repo === undefined || raw.repo === null) return undefined;
	if (!isRepoRoot(raw.repo)) throw new RequestError("repo must be the absolute path of a repository");
	return raw.repo as string;
}

function requestIdField(raw: Fields): number | undefined {
	if (!("requestId" in raw) || raw.requestId === undefined) return undefined;
	if (typeof raw.requestId !== "number" || !Number.isInteger(raw.requestId) || raw.requestId < 0) throw new RequestError("requestId must be a whole number that is not negative");
	return raw.requestId;
}

/**
 * Read one message from the Libre page. Unknown commands and unreadable fields
 * answer the reason, because a page that asked for something wrong is a page
 * whose human needs to be told which part of it was refused. Full per-field
 * validation happens in dispatch/read/actions; this is the gate.
 */
export function parseLibreRequest(raw: unknown): ParsedLibreRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, command: "", error: "a request must be an object" };
	const fields = raw as Fields;
	const command = fields.command;
	if (typeof command !== "string" || command.length === 0) return { ok: false, command: "", error: "a request must name a command" };
	try {
		const repo = repoField(fields);
		const requestId = requestIdField(fields);
		// Validate the strings that will become git argv words wherever they appear as known keys.
		for (const key of ["branchName", "newName", "oldName", "tagName", "commitHash", "hash", "ref", "target", "message", "name", "remote", "branch"] as const) {
			const v = fields[key];
			if (typeof v === "string" && v.length > 0) {
				if (key.includes("Name") || key === "branch" || key === "name") {
					if (key === "name" && /^(push|pull|fetch|reset|merge|rebase|checkout|create|delete|rename|copy|open|view|load|save)/.test(v)) continue;
					if (!isRefName(v) && v !== "-" && !/^(HEAD|@|stash@\{|--|[0-9a-f]{4,64})/.test(v)) throw new RequestError(`${key} is not a name git accepts for a branch or tag`);
				}
			}
		}
		for (const key of ["oldFilePath", "newFilePath", "filePath", "path", "newPath"] as const) {
			const v = fields[key];
			if (typeof v === "string" && v.length > 0 && !/^(stash@\{[0-9a-f]{4,64}\}|\/)/.test(v)) {
				if (key === "path" || key === "newPath") {
					if (!v.startsWith("/") && !/^[A-Za-z]:/.test(v)) throw new RequestError(`${key} must be an absolute path`);
				} else {
					const checked = repoPath(v);
					if (!checked.ok && !isRevision(v)) throw new RequestError(`${key} ${checked.ok ? "" : checked.error}`);
				}
			}
		}
		if (fields.fetchUrl !== undefined && fields.fetchUrl !== null && typeof fields.fetchUrl === "string" && !isRemoteUrl(fields.fetchUrl)) throw new RequestError("fetchUrl must be a URL git accepts");
		if (fields.url !== undefined && fields.url !== null && typeof fields.url === "string" && typeof fields.command === "string" && (fields.command === "addRemote" || fields.command === "editRemote")) {
			if (!isRemoteUrl(fields.url)) throw new RequestError("url must be a URL git accepts");
		}
		return { ok: true, request: { command, ...(repo !== undefined ? { repo } : {}), ...(requestId !== undefined ? { requestId } : {}), ...fields } as LibreRequest };
	} catch (error) {
		if (error instanceof RequestError) return { ok: false, command, error: error.message };
		return { ok: false, command, error: (error as Error).message };
	}
}

// ---------- small helpers for dispatch ----------

export function isHashField(value: unknown): boolean { return isHash(value, true); }
export function isRevisionField(value: unknown): boolean { return isRevision(value, true); }
export function isRefField(value: unknown): boolean { return isRefName(value); }
export function isRemoteField(value: unknown): boolean { return isRemoteName(value); }
export function isUrlField(value: unknown): boolean { return isRemoteUrl(value); }
export function isStashField(value: unknown): boolean { return isStashSelector(value); }
export function checkOneOf<T extends string | number>(allowed: readonly T[], value: unknown): value is T { return isOneOf(allowed, value); }
