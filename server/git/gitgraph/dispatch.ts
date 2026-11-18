/**
 * One message from the Git Graph Libre page, and every answer it earns.
 *
 * The page is Libre's bundle: it posts one command per click and waits for a
 * reply carrying the same command name, sometimes with a `requestId` it
 * compares before it will draw the answer at all. This module is the
 * extension's message switch, minus everything that needed an editor or a
 * child process. Every answer is an array, and a failure is a reply too,
 * never a rejected promise, so the route always answers.
 */
import { parseLibreRequest, queryError, UNCOMMITTED } from "./libre.ts";
import type { LibreRequest } from "./libre.ts";
import { DEFAULT_REPO_STATE, scheduleStateSave, stateFor } from "./state.ts";
import { getCommitComparison, getRepoConfig, libreBranches, libreCommitDetails, libreCommits, librePushDefaults, libreRemoteTags, libreRepoInfo, libreResolveRef, libreSearch, libreTagDetails, libreUncommitted, libreWorktreeChanges, libreWorktreeStatus, readRepoRoot } from "./read.ts";
import { diffText, openFile, untrackedDiff, viewDiffWithWorkingFile, viewFileAtRevision } from "./view.ts";
import { reposFor } from "./repos.ts";
import type { RepoBoardLike, RepoEntry } from "./repos.ts";
import { runLibreAction } from "./actions.ts";
import { gitText } from "../exec.ts";

// ---------- board ----------

export type DispatchBoard = RepoBoardLike & { id: string; name?: string };
type Reply = Record<string, unknown> & { command: string };

const NOT_YET = "This tab cannot do that yet.";

/** Commands that need an editor, a terminal, a remote this tab does not have, or a picker this tab cannot open. */
export const UNAVAILABLE_COMMANDS = [
	"addWorktreeToWorkspace",
	"createArchive",
	"createPullRequest",
	"deleteUserDetails",
	"editUserDetails",
	"exportExtensionSettings",
	"exportRepoConfig",
	"importExtensionSettings",
	"importRepoConfig",
	"loadExtensionSettings",
	"openDiffTab",
	"openExternalDirDiff",
		"openSourceControl",
	"openTerminal",
	"openWorktree",
	"pickFolder",
	"revealWorktree",
	"showOutput",
	"startHistorySearch",
	"switchGraphToWorktree",
	"updateExtensionSetting",
] as const;

export const UNAVAILABLE: Record<string, string> = Object.fromEntries(UNAVAILABLE_COMMANDS.map((c) => [c, NOT_YET]));

/** Commands a browser answers for itself: clipboard, new tab. */
const LOCAL_COMMANDS = new Set(["copyToClipboard", "openExternalUrl", "openFile"]);

/** The repository states the dropdown is drawn from. */
function repoStates(board: DispatchBoard, entries: Map<string, RepoEntry>): Record<string, import("./libre.ts").GitRepoState> {
	const stored = stateFor(board).repos;
	const states: Record<string, import("./libre.ts").GitRepoState> = {};
	for (const [path, entry] of entries) {
		const held = stored[path];
		if (held) states[path] = { ...held, displayName: held.displayName ?? entry.label };
		else states[path] = { ...DEFAULT_REPO_STATE, displayName: entry.label };
	}
	return states;
}

function lastActiveRepo(board: DispatchBoard, paths: Iterable<string>): string | null {
	const known = [...paths];
	const stored = stateFor(board).lastActiveRepo;
	if (stored !== null && known.includes(stored)) return stored;
	return known[0] ?? null;
}

function str(f: Record<string, unknown>, key: string, fallback = ""): string {
	const v = f[key];
	return typeof v === "string" ? v : fallback;
}
function bool(f: Record<string, unknown>, key: string, fallback = false): boolean {
	return typeof f[key] === "boolean" ? f[key] as boolean : fallback;
}
function num(f: Record<string, unknown>, key: string, fallback = 0): number {
	const v = f[key];
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function arr(f: Record<string, unknown>, key: string): string[] {
	const v = f[key];
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function optArr(f: Record<string, unknown>, key: string): string[] | null {
	const v = f[key];
	if (v === null || v === undefined) return null;
	if (!Array.isArray(v)) return null;
	return v.filter((x): x is string => typeof x === "string");
}

/** The one-line reason a view command gives the browser when git fails. */
function viewStatus(answer: { ok: true; text: string; truncated: boolean; binary: boolean } | { ok: false; error: string }): { success: boolean } {
	return { success: answer.ok };
}

/** Run one Libre request. Always an array; never throws. */
export async function respond(board: DispatchBoard, raw: unknown): Promise<Reply[]> {
	const parsed = parseLibreRequest(raw);
	if (!parsed.ok) {
		const command = parsed.command || "repositoryStatus";
		// Query commands need a typed error, action commands a status string.
		const QUERY = new Set(["loadBranches", "loadCommits", "loadRepoInfo", "commitDetails", "commitComparison", "tagDetails", "uncommittedDetails", "searchCommits", "commitSignatures", "remoteTags", "branchPushDefaults", "worktreeStatus", "worktreeChanges", "resolveRef"]);
		if (QUERY.has(command)) {
			const fid = (raw as Record<string, unknown>)?.requestId ?? 0;
			const frepo = (raw as Record<string, unknown>)?.repo ?? "";
			const extra: Record<string, unknown> =
				command === "commitDetails" || command === "commitComparison" ? { commitDetails: null }
				: command === "tagDetails" ? { tagDetails: null }
				: command === "uncommittedDetails" ? { changes: null }
				: command === "searchCommits" ? { results: [] }
				: command === "commitSignatures" ? { signatures: {} }
				: command === "remoteTags" ? { tags: {}, unavailableRemotes: [] }
				: command === "worktreeStatus" ? { statuses: {} }
				: command === "worktreeChanges" ? { path: "", files: [], truncated: false }
				: command === "loadBranches" ? { branches: [], head: null, hard: false, isRepo: false, worktrees: [], upstreams: {} }
				: command === "loadCommits" ? { commits: [], head: null, moreCommitsAvailable: false, hard: false }
				: command === "loadRepoInfo" ? { repoInfo: null }
				: command === "resolveRef" ? { hash: null }
				: command === "branchPushDefaults" ? { upstreamRemote: null, pushRemote: null }
				: {};
			return [{ command, requestId: fid, repo: frepo, ...extra, error: queryError(parsed.error) } as Reply];
		}
		return [{ command, status: parsed.error }];
	}
	const request = parsed.request;
	try {
		const repos = await reposFor(board);
		const paths = [...repos.keys()];
		const named = request.repo;
		const entry = named !== undefined ? repos.get(named) : undefined;
		if (named !== undefined && !repos.has(named)) {
			const QUERY = new Set(["loadCommits", "loadRepoInfo", "commitDetails", "commitComparison", "tagDetails", "uncommittedDetails", "searchCommits", "commitSignatures", "remoteTags", "branchPushDefaults", "worktreeStatus", "worktreeChanges", "resolveRef"]);
			if (QUERY.has(request.command)) return [{ command: request.command, requestId: request.requestId ?? 0, repo: named, error: queryError("That repository is no longer open in this tab.") }];
			return [{ command: request.command, status: "That repository is no longer open in this tab." }];
		}
		return await answer(board, request, paths, repos, entry);
	} catch (error) {
		const message = (error as Error).message;
		const QUERY = new Set(["loadBranches", "loadCommits", "loadRepoInfo", "commitDetails", "commitComparison", "tagDetails", "uncommittedDetails", "searchCommits", "commitSignatures", "remoteTags", "branchPushDefaults", "worktreeStatus", "worktreeChanges", "resolveRef"]);
		if (QUERY.has(request.command)) return [{ command: request.command, requestId: request.requestId ?? 0, repo: request.repo ?? "", error: queryError(message) }];
		return [{ command: request.command, status: message }];
	}
}

async function answer(board: DispatchBoard, request: LibreRequest, paths: string[], repos: Map<string, RepoEntry>, entry?: RepoEntry): Promise<Reply[]> {
	const f = request as Record<string, unknown>;
	const command = request.command;
	const unavailable = UNAVAILABLE[command];
	if (unavailable !== undefined) {
		// Queries still owe a typed shape so the view drops the answer; actions owe a status string.
		const QUERY = new Set(["loadExtensionSettings"]);
		if (QUERY.has(command)) return [{ command, requestId: request.requestId ?? 0, settings: [], status: unavailable }];
		return [{ command, status: unavailable }];
	}
	switch (command) {
		case "selectRepo": {
			const repo = str(f, "repo");
			if (repos.has(repo)) { stateFor(board).lastActiveRepo = repo; scheduleStateSave(board); }
			return [];
		}
		case "loadRepos": {
			return [{ command: "loadRepos", repos: repoStates(board, repos), lastActiveRepo: lastActiveRepo(board, paths), layout: { worktrees: {}, outside: [] } }];
		}
		case "saveRepoState": {
			const repo = str(f, "repo");
			const state = f.state;
			if (repos.has(repo) && state && typeof state === "object" && !Array.isArray(state)) {
				stateFor(board).repos[repo] = state as import("./libre.ts").GitRepoState;
				stateFor(board).lastActiveRepo = repo;
				scheduleStateSave(board);
			}
			return [];
		}
		case "loadRepoInfo": {
			const repo = str(f, "repo");
			const showStashes = bool(f, "showStashes", true);
			const info = await libreRepoInfo(repo, showStashes);
			return [{ command: "loadRepoInfo", requestId: request.requestId ?? 0, repoInfo: info, error: null }];
		}
		case "loadBranches": {
			const repo = lastActiveRepo(board, paths) ?? "";
			// Libre's loadBranches names no repo: it asks about the selected one. Use last active, falling back to first.
			const active = stateFor(board).lastActiveRepo && repos.has(stateFor(board).lastActiveRepo as string) ? stateFor(board).lastActiveRepo as string : repo;
			if (!active) return [{ command: "loadBranches", requestId: request.requestId ?? 0, branches: [], head: null, hard: bool(f, "hard"), isRepo: false, error: queryError("no repository"), worktrees: [], upstreams: {} }];
			const showRemote = bool(f, "showRemoteBranches", true);
			const hidden = arr(f, "hiddenRemotes");
			const out = await libreBranches(active, showRemote, hidden);
			return [{ command: "loadBranches", requestId: request.requestId ?? 0, branches: out.branches, head: out.head, hard: bool(f, "hard"), isRepo: out.isRepo, error: out.isRepo ? null : queryError("not a repository"), worktrees: out.worktrees, upstreams: out.upstreams }];
		}
		case "loadCommits": {
			const repo = str(f, "repo");
			const branchName = str(f, "branchName");
			const maxCommits = num(f, "maxCommits", 250);
			const showRemote = bool(f, "showRemoteBranches", true);
			const hidden = arr(f, "hiddenRemotes");
			const showTags = bool(f, "showTags", true);
			const includeReflog = bool(f, "includeReflog", false);
			const includeUnreachable = bool(f, "includeUnreachableCommits", false);
			const onlyFirst = bool(f, "onlyFollowFirstParent", false);
			const ordering = (f.commitOrdering === "date" || f.commitOrdering === "author-date" || f.commitOrdering === "topo") ? f.commitOrdering : "date";
			const showStashes = typeof f.showStashes === "boolean" ? f.showStashes as boolean : true;
			const branches = optArr(f, "branches");
			const authors = optArr(f, "authors");
			const tags = optArr(f, "tags");
			const out = await libreCommits(repo, { maxCommits, branches, branchName, authors, tags, showRemoteBranches: showRemote, hiddenRemotes: hidden, showTags, includeReflog, includeUnreachable, onlyFollowFirstParent: onlyFirst, commitOrdering: ordering, showStashes });
			if (out.error !== null) return [{ command: "loadCommits", requestId: request.requestId ?? 0, commits: [], head: null, moreCommitsAvailable: false, hard: bool(f, "hard"), error: queryError(out.error) }];
			return [{ command: "loadCommits", requestId: request.requestId ?? 0, commits: out.commits, head: out.head, moreCommitsAvailable: out.more, hard: bool(f, "hard"), error: null }];
		}
		case "commitDetails": {
			const repo = str(f, "repo");
			const hash = str(f, "commitHash");
			const out = await libreCommitDetails(repo, hash);
			return [{ command: "commitDetails", commitDetails: out.details, error: out.error }];
		}
		case "commitComparison": {
			const repo = str(f, "repo");
			const baseRef = str(f, "baseRef", "HEAD");
			const compareRef = str(f, "compareRef", "HEAD");
			const from = baseRef === "*" ? UNCOMMITTED : baseRef;
			const to = compareRef === "*" ? UNCOMMITTED : compareRef;
			const files = await getCommitComparison(repo, from, to);
			if (!files.ok) return [{ command: "commitComparison", commitDetails: null, error: queryError(files.error) }];
			// Build a details object like commitDetails but for the comparison diff.
			const meta = await libreCommitDetails(repo, str(f, "commitHash"));
			const fileChanges = files.value.map((c) => c.type === "U" ? { oldFilePath: c.oldFilePath, newFilePath: c.newFilePath, type: "A" as const, additions: c.additions, deletions: c.deletions, untracked: true as const } : { oldFilePath: c.oldFilePath, newFilePath: c.newFilePath, type: (c.type === "C" ? "T" : c.type) as "A" | "M" | "D" | "R" | "T", additions: c.additions, deletions: c.deletions });
			const base = meta.details ?? { hash: to, parents: [], author: "", email: "", authorDate: 0, committer: "", committerEmail: "", committerDate: 0, body: "", fileChanges: [] };
			return [{ command: "commitComparison", commitDetails: { ...base, fileChanges }, error: null }];
		}
		case "tagDetails": {
			const repo = str(f, "repo");
			const out = await libreTagDetails(repo, str(f, "tagName"));
			return [{ command: "tagDetails", tagName: str(f, "tagName"), tagDetails: out.details, error: out.error }];
		}
		case "uncommittedDetails": {
			const repo = str(f, "repo");
			const out = await libreUncommitted(repo);
			return [{ command: "uncommittedDetails", changes: out.changes, error: out.error }];
		}
		case "searchCommits": {
			const repo = str(f, "repo");
			const out = await libreSearch(repo, str(f, "query"), num(f, "maxResults", 50), {
				showRemoteBranches: bool(f, "showRemoteBranches", true),
				hiddenRemotes: arr(f, "hiddenRemotes"),
				showTags: bool(f, "showTags", true),
				branches: optArr(f, "branches"),
				authors: optArr(f, "authors"),
				tags: optArr(f, "tags"),
			});
			return [{ command: "searchCommits", requestId: request.requestId ?? 0, results: out.results, error: out.error }];
		}
		case "commitSignatures": {
			const hashes = arr(f, "hashes");
			const signatures: Record<string, null> = {};
			for (const h of hashes) signatures[h] = null;
			return [{ command: "commitSignatures", requestId: request.requestId ?? 0, repo: str(f, "repo"), signatures, error: null }];
		}
		case "remoteTags": {
			const out = await libreRemoteTags(str(f, "repo"));
			return [{ command: "remoteTags", requestId: request.requestId ?? 0, repo: str(f, "repo"), tags: out.tags, unavailableRemotes: out.unavailable, error: out.error }];
		}
		case "branchPushDefaults": {
			const out = await librePushDefaults(str(f, "repo"), str(f, "branch"));
			return [{ command: "branchPushDefaults", requestId: request.requestId ?? 0, upstreamRemote: out.upstreamRemote, pushRemote: out.pushRemote, error: out.error }];
		}
		case "worktreeStatus": {
			const out = await libreWorktreeStatus(str(f, "repo"), arr(f, "paths"));
			return [{ command: "worktreeStatus", requestId: request.requestId ?? 0, repo: str(f, "repo"), statuses: out }];
		}
		case "worktreeChanges": {
			const out = await libreWorktreeChanges(str(f, "repo"), str(f, "path"));
			return [{ command: "worktreeChanges", requestId: request.requestId ?? 0, path: out.path, files: out.files, truncated: out.truncated, error: out.error }];
		}
		case "resolveRef": {
			const out = await libreResolveRef(str(f, "repo"), str(f, "ref"));
			return [{ command: "resolveRef", requestId: request.requestId ?? 0, hash: out.hash, error: out.error }];
		}
		case "repositoryStatus": {
			const roots = paths;
			return [{ command: "repositoryStatus", startup: { searchDepth: 0, roots, repositories: roots.map((p) => ({ path: p, state: "ready" as const, repository: true, detectedBy: "git" as const, detail: null })), components: { git: { state: "ok" as const, path: "git", version: "git" }, engine: { state: "off" as const }, graphLoad: null }, error: null } }];
		}
		case "componentStatus": {
			return [{ command: "componentStatus", components: { git: { state: "ok" as const, path: "git", version: "git" }, engine: { state: "off" as const }, graphLoad: null } }];
		}
		case "copyToClipboard":
		case "openExternalUrl": {
			return [{ command, success: true }];
		}
		case "viewDiff":
		case "openDiffTab":
		case "viewFileAtRevision":
		case "compareFileWithWorkingTree":
		case "openFile": {
			// This tab has no second editor: answer success and draw the text via the view reply the host intercepts.
			// For openDiffTab we draw the same diff as viewDiff.
			const repo = str(f, "repo");
			const commitHash = str(f, "commitHash");
			const filePath = str(f, "filePath", str(f, "newFilePath"));
			const oldRef = str(f, "oldRef", commitHash);
			const newRef = str(f, "newRef", commitHash);
			const type = str(f, "type", "M");
			let answerView;
			if (command === "viewFileAtRevision") {
				answerView = await viewFileAtRevision(repo, commitHash || UNCOMMITTED, filePath);
			} else if (command === "compareFileWithWorkingTree") {
				answerView = await viewDiffWithWorkingFile(repo, commitHash || UNCOMMITTED, filePath);
			} else if (command === "openFile") {
				answerView = await openFile(repo, UNCOMMITTED, filePath);
			} else {
				// viewDiff / openDiffTab
				const oldPath = str(f, "oldFilePath", filePath);
				const newPath = str(f, "newFilePath", filePath);
				// Libre sends oldRef/newRef or falls back to commitHash
				const from = oldRef === "*" ? UNCOMMITTED : oldRef;
				const to = newRef === "*" ? UNCOMMITTED : newRef;
				const { viewDiff } = await import("./view.ts");
				answerView = await viewDiff(repo, from === to ? commitHash : from, to, oldPath, newPath, type as "A" | "C" | "D" | "M" | "R" | "U");
			}
			if ("view" in answerView) {
				return [{ command, success: true, view: answerView.view } as Reply];
			}
			return [{ command, success: false } as Reply];
		}
		case "setTemporaryLanguage":
			return [];
		case "showTelemetryConsent":
			return [];
		case "trustRepository":
		case "openGitSettings":
		case "showOutput":
		case "openLogFile":
		case "copyDiagnostics":
		case "copyRecentLog":
		case "setRepoSearchDepth":
		case "failureScreenShown":
			return [];
		case "exportRepoConfig": {
			const repo = str(f, "repo");
			const cfg = await getRepoConfig(repo, []);
			return [{ command: "exportRepoConfig", status: cfg.ok ? null : cfg.error }];
		}
		default: {
			// Action commands: answer a single status string.
			const ACTION = new Set([
				"addRemote", "addTag", "applyStash", "branchFromStash", "checkoutBranch", "checkoutAndFastForward", "checkoutCommit",
				"cherrypickCommit", "cleanUntrackedFiles", "createBranch", "deleteBranch", "deleteRemote", "deleteRemoteBranch",
				"deleteTag", "dropCommit", "dropCommitSelection", "dropStash", "editHeadCommitMessage", "editRemote", "fetchIntoLocalBranch",
				"fetchRemotes", "fetchTags", "mergeBranch", "mergeCommit", "popStash", "pruneRemote", "pullBranch", "pushAllTags", "pushBranch",
				"pushStash", "pushTag", "renameBranch", "resetFileToRevision", "resetToCommit", "resetUncommittedChanges", "rebaseCurrentBranch",
				"squashCommitSelection", "stageFiles", "undoLastCommit", "unstageFiles", "updateBranchFromUpstream", "revertCommit",
				"addWorktree", "lockWorktree", "moveWorktree", "pruneWorktrees", "removeWorktree", "repairWorktree", "unlockWorktree",
				"createArchive", "createPullRequest",
			]);
			if (ACTION.has(command)) {
				const repo = str(f, "repo");
				const status = await runLibreAction(repo, request, entry);
				return [{ command, status }];
			}
			return [{ command, status: NOT_YET }];
		}
	}
}
