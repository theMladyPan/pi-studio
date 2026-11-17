/**
 * What the Git Graph view remembers for one workspace, and how it is written down.
 *
 * A view that forgot itself would be one nobody uses twice: the column widths, the commit details pane,
 * the branches each repository was looking at, and the code review in progress are the state a human
 * builds up by working. It lives in one file per workspace beside the board, is written on a debounce
 * so a resize drag does not write a file per pixel, and is read back defensively, because the file is
 * the one thing a human can edit while the daemon runs.
 */
import { existsSync } from "node:fs";
import { gitgraphStateFile, readJsonFile, writeJsonFile } from "../../paths.ts";
import { importLegacyProjectState } from "../../state-storage.ts";
import type {
	GitCodeReview,
	GitGraphViewState,
	GitRepoState,
	GlobalViewState,
	IssueLinkingConfig,
	PullRequestConfig,
	WorkspaceViewState,
} from "./protocol.ts";

// ---------- defaults ----------

/** What the view starts from when nothing has been remembered for a repository. */
export const DEFAULT_GLOBAL_VIEW_STATE: GlobalViewState = {
	alwaysAcceptCheckoutCommit: false,
	issueLinkingConfig: null,
	pushTagSkipRemoteCheck: false,
};

/** What the find bar starts from. */
export const DEFAULT_WORKSPACE_VIEW_STATE: WorkspaceViewState = {
	findIsCaseSensitive: false,
	findIsRegex: false,
	findOpenCommitDetailsView: false,
};

/** A repository nobody has arranged yet: every pane at its default size and nothing filtered out. */
export const DEFAULT_REPO_STATE: GitRepoState = {
	cdvDivider: 0.5,
	cdvHeight: 250,
	columnWidths: null,
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
};

// ---------- reading a value the page or the file gave ----------

/** A record, or an empty one, because every cleaner below reads fields rather than trusting a shape. */
function plain(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A flag as it was stored or sent, which may also have been written as 0 or 1 by an older version. */
function flag(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === 0 || value === 1) return value === 1;
	return fallback;
}

/** One of two stored numbers, both of which mean the same thing the page already knows. */
function tri(value: unknown, fallback: 0 | 1 | 2): 0 | 1 | 2 {
	return value === 0 || value === 1 || value === 2 ? value : fallback;
}

/** A number that was stored, or the default. */
function number(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A number or nothing at all, which is how "not set" is written. */
function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A string the file or page gave, or nothing at all. */
function stringOrNull(value: unknown, max = 4096): string | null {
	return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

/** A list of strings, dropping anything else the file holds. */
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A list of numbers, dropping anything else. */
function numbers(value: unknown): number[] | null {
	if (!Array.isArray(value)) return null;
	const kept = value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
	return kept.length ? kept : null;
}

/** The issue linking settings, or nothing when they were never set. */
function issueLinkingFrom(value: unknown): IssueLinkingConfig | null {
	const raw = plain(value);
	const issue = stringOrNull(raw.issue);
	const url = stringOrNull(raw.url);
	return issue !== null && url !== null ? { issue, url } : null;
}

/** The pull request settings, as they were last saved. */
function pullRequestFrom(value: unknown): PullRequestConfig | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = plain(value);
	const custom = plain(raw.custom);
	const provider = raw.provider;
	return {
		provider: provider === 1 || provider === 2 || provider === 3 ? provider : 0,
		custom: typeof custom.name === "string" && typeof custom.templateUrl === "string" ? { name: custom.name, templateUrl: custom.templateUrl } : null,
		hostRootUrl: stringOrNull(raw.hostRootUrl) ?? "",
		sourceOwner: stringOrNull(raw.sourceOwner) ?? "",
		sourceRepo: stringOrNull(raw.sourceRepo) ?? "",
		sourceRemote: stringOrNull(raw.sourceRemote) ?? "",
		destOwner: stringOrNull(raw.destOwner) ?? "",
		destRepo: stringOrNull(raw.destRepo) ?? "",
		destRemote: stringOrNull(raw.destRemote),
		destBranch: stringOrNull(raw.destBranch) ?? "",
	};
}

/** The two global decisions, with anything the file cannot vouch for answered by the default. */
export function globalViewStateFrom(value: unknown): GlobalViewState {
	const raw = plain(value);
	return {
		alwaysAcceptCheckoutCommit: flag(raw.alwaysAcceptCheckoutCommit, DEFAULT_GLOBAL_VIEW_STATE.alwaysAcceptCheckoutCommit),
		issueLinkingConfig: issueLinkingFrom(raw.issueLinkingConfig),
		pushTagSkipRemoteCheck: flag(raw.pushTagSkipRemoteCheck, DEFAULT_GLOBAL_VIEW_STATE.pushTagSkipRemoteCheck),
	};
}

/** The three workspace decisions, likewise. */
export function workspaceViewStateFrom(value: unknown): WorkspaceViewState {
	const raw = plain(value);
	return {
		findIsCaseSensitive: flag(raw.findIsCaseSensitive, DEFAULT_WORKSPACE_VIEW_STATE.findIsCaseSensitive),
		findIsRegex: flag(raw.findIsRegex, DEFAULT_WORKSPACE_VIEW_STATE.findIsRegex),
		findOpenCommitDetailsView: flag(raw.findOpenCommitDetailsView, DEFAULT_WORKSPACE_VIEW_STATE.findOpenCommitDetailsView),
	};
}

/** One repository's remembered arrangement, filled out from the defaults. */
export function repoStateFrom(value: unknown): GitRepoState {
	const raw = plain(value);
	const ordering = raw.commitOrdering;
	return {
		cdvDivider: number(raw.cdvDivider, DEFAULT_REPO_STATE.cdvDivider),
		cdvHeight: number(raw.cdvHeight, DEFAULT_REPO_STATE.cdvHeight),
		columnWidths: numbers(raw.columnWidths),
		commitOrdering: ordering === "date" || ordering === "author-date" || ordering === "topo" ? ordering : "default",
		fileViewType: tri(raw.fileViewType, DEFAULT_REPO_STATE.fileViewType),
		hideRemotes: strings(raw.hideRemotes),
		includeCommitsMentionedByReflogs: raw.includeCommitsMentionedByReflogs === 1 ? 1 : 0,
		issueLinkingConfig: issueLinkingFrom(raw.issueLinkingConfig),
		lastImportAt: number(raw.lastImportAt, DEFAULT_REPO_STATE.lastImportAt),
		name: stringOrNull(raw.name, 255),
		onlyFollowFirstParent: raw.onlyFollowFirstParent === 1 ? 1 : 0,
		onRepoLoadShowCheckedOutBranch: raw.onRepoLoadShowCheckedOutBranch === 1 ? 1 : 0,
		onRepoLoadShowSpecificBranches: Array.isArray(raw.onRepoLoadShowSpecificBranches) ? strings(raw.onRepoLoadShowSpecificBranches) : null,
		pullRequestConfig: pullRequestFrom(raw.pullRequestConfig),
		showRemoteBranches: flag(raw.showRemoteBranches, DEFAULT_REPO_STATE.showRemoteBranches),
		showRemoteBranchesV2: tri(raw.showRemoteBranchesV2, DEFAULT_REPO_STATE.showRemoteBranchesV2),
		showStashes: raw.showStashes === 1 ? 1 : 0,
		showTags: raw.showTags === 1 ? 1 : 0,
		workspaceFolderIndex: numberOrNull(raw.workspaceFolderIndex),
	};
}

// ---------- pruning ----------

/** A code review nobody has opened in three months is one nobody is coming back to. */
const REVIEW_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** How many reviews one repository keeps; the rest are the oldest and go first. */
const REVIEWS_PER_REPO = 50;

/** One review as it was stored, or nothing when the file's record cannot be read. */
function reviewFrom(id: string, value: unknown): GitCodeReview | null {
	const raw = plain(value);
	const lastActive = raw.lastActive;
	if (typeof lastActive !== "number" || !Number.isFinite(lastActive)) return null;
	const lastViewedFile = stringOrNull(raw.lastViewedFile);
	return {
		id,
		lastActive,
		lastViewedFile,
		remainingFiles: strings(raw.remainingFiles),
	};
}

/**
 * The reviews worth keeping: those from the last ninety days, and the fifty most recent of those per
 * repository. A review is a note about work in progress, and keeping one for a branch that was merged
 * last year only makes the file grow.
 */
function prunedReviews(value: unknown, now: number): Record<string, Record<string, GitCodeReview>> {
	const kept: Record<string, Record<string, GitCodeReview>> = {};
	for (const [repo, reviewsRaw] of Object.entries(plain(value))) {
		const reviews = Object.entries(plain(reviewsRaw))
			.map(([id, review]) => reviewFrom(id, review))
			.filter((review): review is GitCodeReview => review !== null && now - review.lastActive <= REVIEW_LIFETIME_MS)
			.sort((left, right) => right.lastActive - left.lastActive)
			.slice(0, REVIEWS_PER_REPO);
		if (reviews.length === 0) continue;
		const forRepo: Record<string, GitCodeReview> = {};
		for (const review of reviews) forRepo[review.id] = review;
		kept[repo] = forRepo;
	}
	return kept;
}

/** The repositories that are still on disk, each with its remembered arrangement. */
function prunedRepos(value: unknown): Record<string, GitRepoState> {
	const kept: Record<string, GitRepoState> = {};
	for (const [repo, state] of Object.entries(plain(value))) {
		// A folder that is gone is a repository whose state can never be shown again, and a state file
		// that kept it would grow with every project the human has finished with.
		if (!repo || !existsSync(repo)) continue;
		kept[repo] = repoStateFrom(state);
	}
	return kept;
}

/** A whole state file, read as the defaults plus whatever the file can still vouch for. */
function stateFrom(value: unknown): GitGraphViewState {
	const raw = plain(value);
	const repos = prunedRepos(raw.repos);
	const lastActiveRepo = stringOrNull(raw.lastActiveRepo);
	return {
		globalViewState: globalViewStateFrom(raw.globalViewState),
		workspaceViewState: workspaceViewStateFrom(raw.workspaceViewState),
		repos,
		codeReviews: prunedReviews(raw.codeReviews, Date.now()),
		// A repository the human was last looking at is the one the dropdown opens on, and a folder that
		// is gone or was never listed can never be opened again, so the answer is then "nothing".
		lastActiveRepo: lastActiveRepo !== null && lastActiveRepo in repos ? lastActiveRepo : null,
	};
}

// ---------- the cache ----------

/** One workspace's state, and the timer that would write it. */
type LoadedState = { state: GitGraphViewState; timer: NodeJS.Timeout | null; workspace: { id: string; folder?: string } };

/**
 * The states this daemon has loaded, by workspace id. Loaded lazily on the first read, so a workspace
 * nobody opened the Git Graph view in costs no file: there is nothing about it to remember.
 */
const loaded = new Map<string, LoadedState>();

/** The state of one workspace, read from disk the first time it is asked for. */
export function stateFor(workspace: { id: string; folder?: string }): GitGraphViewState {
	const hit = loaded.get(workspace.id);
	if (hit) return hit.state;
	importLegacyProjectState(workspace);
	const state = stateFrom(readJsonFile<unknown>(gitgraphStateFile(workspace), null));
	loaded.set(workspace.id, { state, timer: null, workspace });
	return state;
}

/**
 * Write this workspace's state soon. A burst of changes — a column drag, then the pane height, then
 * which branches are shown — costs one write, the way a board does.
 */
export function scheduleStateSave(workspace: { id: string; folder?: string }): void {
	const hit = loaded.get(workspace.id);
	if (!hit || hit.timer) return;
	hit.timer = setTimeout(() => {
		hit.timer = null;
		writeJsonFile(gitgraphStateFile(hit.workspace), hit.state);
	}, 500);
	hit.timer.unref();
}

/** Write this workspace's state now, which is what a shutdown and a test need. */
export function flushState(workspaceId: string): void {
	const hit = loaded.get(workspaceId);
	if (!hit) return;
	if (hit.timer) clearTimeout(hit.timer);
	hit.timer = null;
	writeJsonFile(gitgraphStateFile(hit.workspace), hit.state);
}

/** Forget every loaded state, so a test reads its own file rather than the previous test's. */
export function resetStateCacheForTests(): void {
	for (const hit of loaded.values()) if (hit.timer) clearTimeout(hit.timer);
	loaded.clear();
}
