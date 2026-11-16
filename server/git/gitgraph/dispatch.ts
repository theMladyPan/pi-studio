/**
 * One message from the Git Graph page, and every answer it earns.
 *
 * The page is a bundle that was written for an extension: it posts one command per click and waits for
 * a reply carrying the same command name, sometimes with a `refreshId` it compares before it will draw
 * the answer at all. So this module is the extension's message switch, minus everything that needed an
 * editor or a child process, and it has three jobs. It re-reads which repositories this board may show
 * on every call, because a tree is cut and swept while a tab stays open, and a command naming a
 * repository it no longer has is answered with that sentence rather than run. It keeps the promise the
 * page depends on: one request in, an array of replies out, and a failure is a reply too, never a
 * rejected promise the route would turn into a dead tab. And it says plainly which commands it cannot
 * run yet, from one table, so the next stage that implements one has one list to edit.
 */
import { UNCOMMITTED, parseRequest } from "./protocol.ts";
import type { GitCodeReview, GitCommitDetails, GitGraphRequest, GitRepoState } from "./protocol.ts";
import { DEFAULT_REPO_STATE, scheduleStateSave, stateFor } from "./state.ts";
import { getCommitComparison, getCommitDetails, getCommits, getRepoConfig, getRepoInfo, getStashDetails, getTagDetails, getUncommittedDetails, readRepoRoot } from "./read.ts";
import type { ReadResult } from "./read.ts";
import { openFile, viewDiff, viewDiffWithWorkingFile, viewFileAtRevision } from "./view.ts";
import type { ViewAnswer } from "./view.ts";
import { reposFor } from "./repos.ts";
import type { RepoBoardLike, RepoEntry } from "./repos.ts";
import { runAction } from "./actions.ts";

// ---------- what a board is, to this module ----------

/**
 * The board as this module reads it: the repositories it may show, and the id its state is filed under.
 * It is `reposFor`'s own shape plus an identity, so a test can hand it a plain object.
 */
export type DispatchBoard = RepoBoardLike & { id: string; name?: string };

/** One thing the page is told, always carrying the command it answers. */
type Reply = Record<string, unknown> & { command: string };

// ---------- what this tab cannot do yet ----------

/** The one sentence every command this tab cannot run answers. */
const NOT_YET = "This tab cannot do that yet.";

/**
 * The commands that still need an editor, a terminal or a remote this tab does not have, and are
 * answered without a single git call. The local writes left this table when `actions.ts` gained their
 * handlers; what remains is refused by name, one sentence each, so a human who reaches one — a stale
 * page, a menu this tab has yet to earn — is told the same thing every other refused command says.
 */
const UNAVAILABLE_COMMANDS = [
	"addRemote",
	"createArchive",
	"createPullRequest",
	"deleteRemote",
	"deleteRemoteBranch",
	"deleteUserDetails",
	"editRemote",
	"editUserDetails",
	"exportRepoConfig",
	"fetchAvatar",
	"fetchIntoLocalBranch",
	"openExternalDirDiff",
	"openExtensionSettings",
	"openTerminal",
	"pullBranch",
	"pushBranch",
	"pushTag",
	"rescanForRepos",
	"showErrorMessage",
	"viewScm",
] as const;

/** The sentence each of those answers, by command, so a later stage can word one of them differently. */
export const UNAVAILABLE: Record<string, string> = Object.fromEntries(UNAVAILABLE_COMMANDS.map((command) => [command, NOT_YET]));

// ---------- small readers ----------

/** The code review a commit or a comparison is part of, if the human started one on it. */
function reviewFor(board: DispatchBoard, repo: string, id: string): GitCodeReview | null {
	return stateFor(board).codeReviews[repo]?.[id] ?? null;
}

/** A view's answer, which the page draws when it carries text and shows the reason for when it does not. */
function viewed(command: string, answer: ViewAnswer): Reply {
	return "view" in answer ? { command, error: null, view: answer.view } : { command, error: answer.error };
}

/**
 * The action's run, for the page's commands that show one failure: the first sentence git gave.
 *
 * A command that runs twice — a branch deleted on its remote too, a tag made and then pushed — still
 * answers a single `error` on this half of the page's commands, and a second sentence would be the same
 * cause said twice.
 */
function firstError(errors: (string | null)[]): string | null {
	return errors.find((error) => error !== null) ?? null;
}

/** What the page's commit details pane is handed, including the review and the refresh flag it sent. */
function detailsReply(
	board: DispatchBoard,
	command: string,
	repo: string,
	id: string,
	refresh: boolean,
	result: ReadResult<GitCommitDetails>,
): Reply {
	if (!result.ok) return { command, error: result.error, commitDetails: null, avatar: null, codeReview: null, refresh };
	return {
		command,
		error: null,
		commitDetails: result.value,
		// Never an avatar: this daemon makes no request to a third party on a human's behalf.
		avatar: null,
		codeReview: reviewFor(board, repo, id),
		refresh,
	};
}

/** The repository states the repository dropdown is drawn from, filled out for one it has never seen. */
function repoStates(board: DispatchBoard, paths: Iterable<string>): Record<string, GitRepoState> {
	const state = stateFor(board);
	const states: Record<string, GitRepoState> = {};
	for (const path of paths) states[path] = state.repos[path] ?? { ...DEFAULT_REPO_STATE };
	return states;
}

/** The repository the dropdown opens on: the last one the human had open, or the board's own folder. */
function lastActiveRepo(board: DispatchBoard, paths: Iterable<string>): string | null {
	const known = [...paths];
	const stored = stateFor(board).lastActiveRepo;
	if (stored !== null && known.includes(stored)) return stored;
	return known[0] ?? null;
}

// ---------- the request ----------

/**
 * Everything one request earns. Always an array, because the page's protocol allows one command to
 * answer twice — a tag that was made and pushed answers for both — and a single-reply shape would have
 * to be widened the moment that arrives.
 */
export async function respond(board: DispatchBoard, raw: unknown): Promise<Reply[]> {
	const parsed = parseRequest(raw);
	if (!parsed.ok) return [{ command: parsed.command, error: parsed.error }];
	const request = parsed.request;
	try {
		const repos = await reposFor(board);
		const paths = [...repos.keys()];
		const named = "repo" in request ? request.repo : null;
		if (named !== null && !repos.has(named)) return [{ command: request.command, error: "That repository is no longer open in this tab." }];
		// What the entry knows about the repository's tree decides whether an action may move it: `live` is the
		// board's own answer to "is a thread working in there right now".
		return await answer(board, request, paths, named === null ? undefined : repos.get(named));
	} catch (error) {
		// A read that escaped its own handling is still a page waiting for a reply, so it is answered
		// with what went wrong rather than left to the route's catch, which would answer a 500.
		return [{ command: request.command, error: (error as Error).message }];
	}
}

/** The command itself, once it is known to name a repository this board still has, and that entry. */
async function answer(board: DispatchBoard, request: GitGraphRequest, paths: string[], entry?: RepoEntry): Promise<Reply[]> {
	const unavailable = UNAVAILABLE[request.command];
	if (unavailable !== undefined) return [{ command: request.command, error: unavailable }];
	switch (request.command) {
		case "loadRepos":
			return [
				{
					command: "loadRepos",
					repos: repoStates(board, paths),
					lastActiveRepo: lastActiveRepo(board, paths),
					loadViewTo: null,
				},
			];
		case "loadRepoInfo": {
			const info = await getRepoInfo(request.repo, {
				showRemoteBranches: request.showRemoteBranches,
				showStashes: request.showStashes,
				hideRemotes: request.hideRemotes,
			});
			// The page stops asking for commits as soon as this says the folder is not a repository, so a
			// failed read is checked against the one thing that makes it true: a repository whose stash
			// list could not be read is still one, and its graph must load with the reason beside it.
			let error = info.error;
			let isRepo = true;
			if (error !== null && (await readRepoRoot(request.repo)) === null) {
				isRepo = false;
				error = null;
			}
			// The page drops an answer whose refreshId is not the one it is waiting for, so the id it sent
			// is echoed on every reply, failures included: a cached answer would draw an old graph.
			return [{ command: "loadRepoInfo", refreshId: request.refreshId, ...info, error, isRepo }];
		}
		case "loadCommits": {
			const log = await getCommits(request.repo, {
				maxCommits: request.maxCommits,
				showTags: request.showTags,
				showRemoteBranches: request.showRemoteBranches,
				includeCommitsMentionedByReflogs: request.includeCommitsMentionedByReflogs,
				onlyFollowFirstParent: request.onlyFollowFirstParent,
				commitOrdering: request.commitOrdering,
				branches: request.branches,
				remotes: request.remotes,
				hideRemotes: request.hideRemotes,
				stashes: request.stashes,
			});
			if (!log.ok) {
				return [{ command: "loadCommits", refreshId: request.refreshId, onlyFollowFirstParent: request.onlyFollowFirstParent, commits: [], head: null, tags: [], moreCommitsAvailable: false, error: log.error }];
			}
			return [
				{
					command: "loadCommits",
					refreshId: request.refreshId,
					onlyFollowFirstParent: request.onlyFollowFirstParent,
					commits: log.value.commits,
					head: log.value.head,
					tags: log.value.tags,
					moreCommitsAvailable: log.value.moreCommitsAvailable,
					error: null,
				},
			];
		}
		case "loadConfig": {
			const config = await getRepoConfig(request.repo, request.remotes);
			return [{ command: "loadConfig", repo: request.repo, config: config.ok ? config.value : null, error: config.ok ? null : config.error }];
		}
		case "commitDetails": {
			const result = request.stash !== null
				? await getStashDetails(request.repo, request.stash.selector, request.stash.baseHash)
				: request.commitHash === UNCOMMITTED
					? await getUncommittedDetails(request.repo)
					: await getCommitDetails(request.repo, request.commitHash, request.hasParents);
			return [detailsReply(board, "commitDetails", request.repo, request.commitHash, request.refresh, result)];
		}
		case "compareCommits": {
			const comparison = await getCommitComparison(request.repo, request.fromHash, request.toHash);
			const id = `${request.commitHash}-${request.compareWithHash}`;
			if (!comparison.ok) return [{ command: "compareCommits", error: comparison.error, commitHash: request.commitHash, compareWithHash: request.compareWithHash, fileChanges: [], codeReview: null, refresh: request.refresh }];
			return [
				{
					command: "compareCommits",
					error: null,
					commitHash: request.commitHash,
					compareWithHash: request.compareWithHash,
					fileChanges: comparison.value,
					codeReview: reviewFor(board, request.repo, id),
					refresh: request.refresh,
				},
			];
		}
		case "tagDetails": {
			const tag = await getTagDetails(request.repo, request.tagName);
			if (!tag.ok) return [{ command: "tagDetails", error: tag.error }];
			return [
				{
					command: "tagDetails",
					error: null,
					tagName: request.tagName,
					tagHash: tag.value.tagHash,
					commitHash: request.commitHash,
					name: tag.value.name,
					email: tag.value.email,
					date: tag.value.date,
					message: tag.value.message,
				},
			];
		}
		case "viewDiff":
			return [
				viewed(
					"viewDiff",
					await viewDiff(request.repo, request.fromHash, request.toHash, request.oldFilePath, request.newFilePath, request.type),
				),
			];
		case "viewDiffWithWorkingFile":
			return [viewed("viewDiffWithWorkingFile", await viewDiffWithWorkingFile(request.repo, request.hash, request.filePath))];
		case "viewFileAtRevision":
			return [viewed("viewFileAtRevision", await viewFileAtRevision(request.repo, request.hash, request.filePath))];
		case "openFile":
			return [viewed("openFile", await openFile(request.repo, request.hash, request.filePath))];
		case "copyToClipboard":
		case "copyFilePath":
		case "openExternalUrl":
			// The page does these itself: the clipboard and a new tab belong to the browser that is
			// already showing the text, and a daemon has no clipboard to put it on.
			return [{ command: request.command, error: null }];
		case "addTag":
		case "cherrypickCommit":
		case "createBranch":
			// The page's commands that report every step they ran, because they run more than one.
			return [{ command: request.command, errors: (await runAction(request.repo, request, entry)).errors }];
		case "checkoutBranch": {
			// The page words its own failure report from this field ("… & Pull Changes"), so the pull it asked
			// for is echoed whether or not the checkout worked.
			const errors = (await runAction(request.repo, request, entry)).errors;
			return [{ command: "checkoutBranch", pullAfterwards: request.pullAfterwards, errors }];
		}
		case "deleteBranch": {
			const errors = (await runAction(request.repo, request, entry)).errors;
			// The bundle asks again with `forceDelete` when it sees git's own "run 'git branch -D'" hint, and
			// it sends these three fields back with that question, so they are answered exactly as asked.
			return [{ command: "deleteBranch", repo: request.repo, branchName: request.branchName, deleteOnRemotes: request.deleteOnRemotes ?? [], errors }];
		}
		case "merge":
			return [{ command: "merge", actionOn: request.actionOn, error: firstError((await runAction(request.repo, request, entry)).errors) }];
		case "rebase":
			// `interactive` is echoed because the page keeps its "action running" notice up until it reads it.
			return [{ command: "rebase", actionOn: request.actionOn, interactive: request.interactive, error: firstError((await runAction(request.repo, request, entry)).errors) }];
		case "applyStash":
		case "branchFromStash":
		case "checkoutCommit":
		case "cleanUntrackedFiles":
		case "deleteTag":
		case "dropCommit":
		case "dropStash":
		case "fetch":
		case "popStash":
		case "pruneRemote":
		case "pushStash":
		case "renameBranch":
		case "resetToCommit":
		case "revertCommit":
			// The page's commands that report one failure, in one sentence.
			return [{ command: request.command, error: firstError((await runAction(request.repo, request, entry)).errors) }];
		case "setRepoState": {
			const state = stateFor(board);
			state.repos[request.repo] = request.state;
			// The page saves a repository's arrangement when it switches away from it, so the repository
			// it just saved is the one it was looking at.
			state.lastActiveRepo = request.repo;
			scheduleStateSave(board);
			return [{ command: "setRepoState", error: null }];
		}
		case "setGlobalViewState": {
			stateFor(board).globalViewState = request.state;
			scheduleStateSave(board);
			return [{ command: "setGlobalViewState", error: null }];
		}
		case "setWorkspaceViewState": {
			stateFor(board).workspaceViewState = request.state;
			scheduleStateSave(board);
			return [{ command: "setWorkspaceViewState", error: null }];
		}
		case "startCodeReview": {
			const review: GitCodeReview = {
				id: request.id,
				lastActive: Date.now(),
				lastViewedFile: request.lastViewedFile,
				remainingFiles: request.files,
			};
			const state = stateFor(board);
			state.codeReviews[request.repo] = { ...state.codeReviews[request.repo], [request.id]: review };
			scheduleStateSave(board);
			return [{ command: "startCodeReview", error: null, commitHash: request.commitHash, compareWithHash: request.compareWithHash, codeReview: review }];
		}
		case "updateCodeReview": {
			const held = reviewFor(board, request.repo, request.id);
			// A review the state file has pruned is one the human is not coming back to: answering that it
			// is gone is better than writing half of one back.
			if (held === null) return [{ command: "updateCodeReview", error: "that code review is no longer kept" }];
			held.remainingFiles = request.remainingFiles;
			held.lastViewedFile = request.lastViewedFile;
			held.lastActive = Date.now();
			scheduleStateSave(board);
			return [{ command: "updateCodeReview", error: null }];
		}
		case "endCodeReview": {
			const reviews = stateFor(board).codeReviews[request.repo];
			if (reviews && request.id in reviews) {
				delete reviews[request.id];
				// A repository whose last review just ended has nothing left to remember about reviews, and
				// an empty record in the state file is a file that grows a line per repository ever seen.
				if (Object.keys(reviews).length === 0) delete stateFor(board).codeReviews[request.repo];
				scheduleStateSave(board);
			}
			return [{ command: "endCodeReview", error: null }];
		}
		default:
			// A command `parseRequest` knows and this switch does not is a wiring mistake, and the page is
			// told so in the same words as a command this tab has no way to run.
			return [{ command: (request as { command: string }).command, error: NOT_YET }];
	}
}
