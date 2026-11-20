/**
 * What the Git Graph page remembers for one workspace, and how it is written down.
 * Lives in one file per workspace beside the board, is written on a debounce, and is read back
 * defensively, because the file is the one thing a human can edit while the daemon runs.
 */
import { existsSync } from "node:fs";
import { gitgraphStateFile, readJsonFile, writeJsonFile } from "../../paths.ts";
import { importLegacyProjectState, projectFolderGone } from "../../state-storage.ts";
import type { GitRepoState } from "./libre.ts";

// ---------- defaults ----------

/** A repository nobody has arranged yet. */
export const DEFAULT_REPO_STATE: GitRepoState = {
	columnWidths: null,
	commitOrdering: "date",
	displayName: null,
	hiddenRemotes: [],
	includeReflog: "default",
	includeUnreachableCommits: "default",
	issueLinking: null,
	lastConfigImportAt: undefined,
	onlyFollowFirstParent: "default",
	pullRequest: null,
	showRemoteBranches: "default",
	showStashes: "default",
	showTags: "default",
};

/** Backwards-compatible names for the older callers that read the defaults. */
export const DEFAULT_GLOBAL_VIEW_STATE = {};
export const DEFAULT_WORKSPACE_VIEW_STATE = {};

// ---------- reading ----------

function plain(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((e): e is string => typeof e === "string") : [];
}
function numbersOrNull(value: unknown): number[] | null {
	if (!Array.isArray(value)) return null;
	const kept = value.filter((e): e is number => typeof e === "number" && Number.isFinite(e));
	return kept.length ? kept : null;
}
function override(value: unknown): "default" | "enabled" | "disabled" {
	return value === "enabled" || value === "disabled" ? value : "default";
}
function ordering(value: unknown): "date" | "author-date" | "topo" {
	return value === "author-date" || value === "topo" ? value : "date";
}

/** One repository's remembered arrangement, from the new Libre shape or an older file. */
export function repoStateFrom(value: unknown): GitRepoState {
	const raw = plain(value);
	// Old files used 0/1 flags and different names (showRemoteBranches boolean, etc).
	const showRemoteOld = typeof raw.showRemoteBranches === "boolean" ? (raw.showRemoteBranches ? "enabled" : "disabled") : raw.showRemoteBranchesV2 === 1 ? "enabled" : raw.showRemoteBranchesV2 === 0 ? "disabled" : override(raw.showRemoteBranches);
	const showStashesOld = raw.showStashes === 1 ? "enabled" : raw.showStashes === 0 ? "disabled" : override(raw.showStashes);
	// Tags are always drawn: a stored "disabled" (or the legacy 0 that migrated to it) hid every
	// tag pill while the tag dropdown still listed the tags, so picking one filtered the graph
	// to nothing. Neutralise both to "default", which the view reads as shown.
	const showTagsOld = raw.showTags === 1 || raw.showTags === "enabled" ? "enabled" : "default";
	const colRaw = raw.columnWidths;
	let columnWidths: number[] | null = null;
	if (Array.isArray(colRaw)) {
		const kept = colRaw.filter((e): e is number => typeof e === "number" && Number.isFinite(e));
		columnWidths = kept.length ? kept : null;
	}
	const orderingRaw = raw.commitOrdering;
	const commitOrdering = orderingRaw === "default" ? "date" : ordering(orderingRaw);
	let displayName: string | null = null;
	if (typeof raw.displayName === "string" && raw.displayName.length <= 255 && !/[\u0000-\u001f\u007f]/.test(raw.displayName) && raw.displayName) displayName = raw.displayName;
	else if (typeof raw.name === "string" && raw.name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(raw.name) && raw.name) displayName = raw.name;
	const issue = raw.issueLinking && typeof raw.issueLinking === "object" ? raw.issueLinking as { pattern: string; urlTemplate: string } : raw.issueLinkingConfig && typeof raw.issueLinkingConfig === "object" ? raw.issueLinkingConfig : null;
	const issueLinking = issue && typeof (issue as { pattern?: unknown }).pattern === "string" && typeof (issue as { urlTemplate?: unknown }).urlTemplate === "string"
		? { pattern: (issue as { pattern: string }).pattern, urlTemplate: (issue as { urlTemplate: string }).urlTemplate }
		: null;
	return {
		columnWidths,
		commitOrdering,
		displayName,
		hiddenRemotes: strings(raw.hiddenRemotes),
		includeReflog: raw.includeCommitsMentionedByReflogs === 1 ? "enabled" : raw.includeCommitsMentionedByReflogs === 0 ? "disabled" : override(raw.includeReflog),
		includeUnreachableCommits: override(raw.includeUnreachableCommits),
		issueLinking,
		lastConfigImportAt: typeof raw.lastConfigImportAt === "number" ? raw.lastConfigImportAt : typeof raw.lastImportAt === "number" ? raw.lastImportAt : undefined,
		onlyFollowFirstParent: raw.onlyFollowFirstParent === 1 ? "enabled" : raw.onlyFollowFirstParent === 0 ? "disabled" : override(raw.onlyFollowFirstParent),
		pullRequest: null,
		showRemoteBranches: showRemoteOld,
		showStashes: showStashesOld,
		showTags: showTagsOld,
	};
}

// ---------- pruning ----------

function prunedRepos(value: unknown): Record<string, GitRepoState> {
	const kept: Record<string, GitRepoState> = {};
	for (const [repo, state] of Object.entries(plain(value))) {
		if (!repo || !existsSync(repo)) continue;
		kept[repo] = repoStateFrom(state);
	}
	return kept;
}

export type GitGraphViewStateFile = {
	repos: Record<string, GitRepoState>;
	lastActiveRepo: string | null;
	codeReviews: Record<string, Record<string, never>>;
	globalViewState: Record<string, never>;
	workspaceViewState: Record<string, never>;
};

function stateFrom(value: unknown): GitGraphViewStateFile {
	const raw = plain(value);
	const repos = prunedRepos(raw.repos);
	const lastActiveRepo = typeof raw.lastActiveRepo === "string" ? raw.lastActiveRepo : null;
	return {
		repos,
		codeReviews: {},
		globalViewState: {},
		workspaceViewState: {},
		lastActiveRepo: lastActiveRepo !== null && lastActiveRepo in repos ? lastActiveRepo : null,
	};
}

// ---------- cache ----------

type LoadedState = { state: GitGraphViewStateFile; timer: NodeJS.Timeout | null; workspace: { id: string; folder?: string } };
const loaded = new Map<string, LoadedState>();

export function stateFor(workspace: { id: string; folder?: string }): GitGraphViewStateFile {
	const hit = loaded.get(workspace.id);
	if (hit) return hit.state;
	importLegacyProjectState(workspace);
	const state = stateFrom(readJsonFile<unknown>(gitgraphStateFile(workspace), null));
	loaded.set(workspace.id, { state, timer: null, workspace });
	return state;
}

function refusedBecauseFolderGone(workspace: { id: string; folder?: string }): boolean {
	if (!projectFolderGone(workspace)) return false;
	console.error(`pi-studio: not saving the Git view state of ${workspace.folder}: the project folder is gone`);
	return true;
}

export function scheduleStateSave(workspace: { id: string; folder?: string }): void {
	const hit = loaded.get(workspace.id);
	if (!hit || hit.timer) return;
	hit.timer = setTimeout(() => {
		hit.timer = null;
		if (refusedBecauseFolderGone(hit.workspace)) return;
		writeJsonFile(gitgraphStateFile(hit.workspace), hit.state);
	}, 500);
	hit.timer.unref();
}

export function flushState(workspaceId: string): void {
	const hit = loaded.get(workspaceId);
	if (!hit) return;
	if (hit.timer) clearTimeout(hit.timer);
	hit.timer = null;
	if (refusedBecauseFolderGone(hit.workspace)) return;
	writeJsonFile(gitgraphStateFile(hit.workspace), hit.state);
}

export function resetStateCacheForTests(): void {
	for (const hit of loaded.values()) if (hit.timer) clearTimeout(hit.timer);
	loaded.clear();
}

// Kept for the older tests that imported these names.
export function globalViewStateFrom(value: unknown): Record<string, never> { return {}; }
export function workspaceViewStateFrom(value: unknown): Record<string, never> { return {}; }
