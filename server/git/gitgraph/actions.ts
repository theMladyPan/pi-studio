/**
 * Every command the Git Graph page can run that writes to a repository, in one table:
 * branches, tags, checkouts, merges, rebases, cherry-picks, reverts, resets, stashes and a fetch.
 *
 * The page was written for an extension, and its answers are the strings the human then reads: git's
 * own stderr when a command failed, `null` when it worked. That shape is kept here, because a reply that
 * invents its own wording is one a human cannot search for in the terminal they already have open. Three
 * rules hold for every command in this module. It runs as an argument array, never a shell string, so no
 * name is ever split or quoted. Nothing the page supplied sits where git reads an option: the flags this
 * module chose come first, `--end-of-options` sits between them and the values the page sent, and a mode
 * is mapped to its flag rather than interpolated into one. And a run never throws — a git that failed, a
 * git that hung and a git that printed too much all answer a sentence, because the caller has to reply to
 * a page either way.
 *
 * Two guards stand in front of the table, and both are about work this daemon did not make. A repository
 * whose `RepoEntry.live` is true is being written to by a thread right now, so an action that moves HEAD
 * or the working tree is refused there: a checkout or a hard reset in that tree would throw away changes
 * nobody has committed. And one mutation at a time per repository, because the route that carries these
 * commands answers each request on its own, so two clicks in one tab are two git runs racing for the
 * same index lock.
 */
import { runGit } from "../exec.ts";
import type { GitExecKind } from "../exec.ts";
import type { GitGraphRequest } from "./protocol.ts";
import type { RepoEntry } from "./repos.ts";

// ---------- one answer ----------

/**
 * What one action answers: one slot per git command it ran, `null` where that command worked.
 *
 * Not a single error, because the page's own actions are not single: `deleteBranch` deletes the branch
 * and then one per remote it was asked to delete it from, and the page shows every failure it gets. The
 * replies that carry one `error` take the first sentence from here, so nothing git said is dropped.
 */
export type ActionAnswer = { errors: (string | null)[] };

/** The command a reset mode is spelled as, taken from the union the page's request was validated against. */
type ResetMode = Extract<GitGraphRequest, { command: "resetToCommit" }>["resetMode"];

/** One flag per mode, so a mode can never reach argv as a word git might read as an option. */
const RESET_FLAG: Record<ResetMode, string> = { soft: "--soft", mixed: "--mixed", hard: "--hard" };

// ---------- running one command ----------

/**
 * One git command, and the sentence git used if it failed.
 *
 * `kind` decides the timeout rather than the danger: a write to a checkout gets thirty seconds and a
 * command that talks to a remote gets two minutes, because a remote is the slow half and a killed push
 * is worse than a slow one.
 */
async function gitWrite(repo: string, args: readonly string[], kind: GitExecKind = "write"): Promise<string | null> {
	const result = await runGit(repo, args, { kind });
	if (result.ok) return null;
	if (result.timedOut) return "git did not answer in time";
	if (result.truncated) return "git printed more than this view will read";
	return result.stderr || `git could not run: git ${args[0] ?? ""}`;
}

/** How many parents a commit has, or the sentence explaining that git cannot tell us. */
async function parentCount(repo: string, commit: string): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
	const result = await runGit(repo, ["rev-list", "--parents", "-n", "1", "--end-of-options", commit], { kind: "read" });
	if (!result.ok) {
		return { ok: false, error: result.timedOut ? "git did not answer in time" : result.stderr || "git could not read that commit" };
	}
	const words = result.stdout.toString("utf8").trim().split(/\s+/).filter((word) => word.length > 0);
	// The first word is the commit itself; everything after it is a parent.
	return { ok: true, count: Math.max(words.length - 1, 0) };
}

// ---------- the guards ----------

/**
 * What an action that moves a live tree answers. Exported so the test that keeps this refusal honest
 * asserts the sentence itself rather than a copy of it.
 */
export const LIVE_REFUSAL = "a thread is working in this tree right now, so the graph will not move it";

/** What a second mutation of one repository answers while the first is still running. */
export const BUSY_REFUSAL = "another git action is still running in this repository";

/**
 * What an interactive rebase answers: git opens a text editor for the commit list, and this daemon has
 * no terminal to hand it, so the run would sit until the timeout killed it.
 */
const INTERACTIVE_REFUSAL = "an interactive rebase needs a terminal this tab does not have";

/** What dropping a merge commit answers: git cannot rebase a commit out of a history that joins two. */
const MERGE_DROP_REFUSAL = "a merge commit cannot be dropped: it is where two histories join";

/** The mutations running right now, one per repository, so a second click is refused rather than raced. */
const running = new Map<string, Promise<ActionAnswer>>();

/**
 * Whether this action moves HEAD or the working tree, which is the question the live guard asks.
 *
 * A branch made without a checkout is a ref and nothing else, so it is allowed in a tree a thread holds;
 * the same command with `checkout` moves that tree onto the new branch, and is not. Everything else in
 * this list writes to the checkout or to which commit it stands on: a checkout, a reset, a merge, a
 * rebase, a cherry-pick, a revert, a dropped commit, any stash operation (which stages and unstages the
 * files a thread may be holding) and a clean of its untracked files.
 */
function movesTheTree(request: GitGraphRequest): boolean {
	switch (request.command) {
		case "checkoutBranch":
		case "checkoutCommit":
		case "cherrypickCommit":
		case "cleanUntrackedFiles":
		case "merge":
		case "rebase":
		case "resetToCommit":
		case "dropCommit":
		case "revertCommit":
		case "pushStash":
		case "applyStash":
		case "popStash":
		case "dropStash":
		case "branchFromStash":
			return true;
		case "createBranch":
			return request.checkout;
		default:
			return false;
	}
}

/** Why a live tree refuses this action, naming the thread the human sees in the dropdown, or `null`. */
function liveRefusal(request: GitGraphRequest, entry: RepoEntry | undefined): string | null {
	if (!entry?.live || !movesTheTree(request)) return null;
	return entry.label ? `${LIVE_REFUSAL}: ${entry.label}` : LIVE_REFUSAL;
}

// ---------- the table ----------

/**
 * What one command does to the repository, as the sentences git gave for each part that failed.
 *
 * Nothing here checks that the command may run: `runAction` has already answered the two guards, and
 * `parseRequest` has already refused every value git would read as an option.
 */
async function perform(repo: string, request: GitGraphRequest): Promise<ActionAnswer> {
	switch (request.command) {
		case "createBranch": {
			const made = await gitWrite(repo, ["branch", ...(request.force ? ["-f"] : []), "--end-of-options", request.branchName, request.commitHash]);
			const errors: (string | null)[] = [made];
			// A branch that was not made has nothing to check out, and the page would report the second
			// failure as if it were a separate thing that went wrong.
			if (made === null && request.checkout) errors.push(await gitWrite(repo, ["checkout", "--end-of-options", request.branchName]));
			return { errors };
		}
		case "branchFromStash":
			return { errors: [await gitWrite(repo, ["stash", "branch", "--end-of-options", request.branchName, request.selector])] };
		case "renameBranch":
			return { errors: [await gitWrite(repo, ["branch", "-m", "--end-of-options", request.oldName, request.newName])] };
		case "deleteBranch": {
			const deleted = await gitWrite(repo, ["branch", request.forceDelete ? "-D" : "-d", "--end-of-options", request.branchName]);
			const errors: (string | null)[] = [deleted];
			// The remotes are only asked once the branch is gone, because a delete that git refused is a
			// branch the human still has, and taking it off a remote would leave them nothing to restore.
			if (deleted === null) {
				for (const remote of request.deleteOnRemotes ?? []) {
					errors.push(await gitWrite(repo, ["push", "--delete", "--end-of-options", remote, request.branchName], "network"));
				}
			}
			return { errors };
		}
		case "addTag": {
			// Type 1 is a lightweight tag: a ref and nothing else. Type 0 is annotated, which git will not
			// make without a message, so the message is passed even when the human left it empty.
			const args = request.type === 1
				? ["tag", ...(request.force ? ["-f"] : []), "--end-of-options", request.tagName, request.commitHash]
				: ["tag", ...(request.force ? ["-f"] : []), "-a", "-m", request.message, "--end-of-options", request.tagName, request.commitHash];
			const made = await gitWrite(repo, args);
			const errors: (string | null)[] = [made];
			if (made === null && request.pushToRemote !== null) {
				errors.push(await gitWrite(repo, ["push", "--end-of-options", request.pushToRemote, request.tagName], "network"));
			}
			return { errors };
		}
		case "deleteTag": {
			const deleted = await gitWrite(repo, ["tag", "-d", "--end-of-options", request.tagName]);
			// The local tag goes first, so a remote that cannot be reached still leaves the human with the
			// delete they asked for; the remote's half is the part that can be tried again.
			if (deleted !== null || request.deleteOnRemote === null) return { errors: [deleted] };
			return { errors: [await gitWrite(repo, ["push", "--end-of-options", request.deleteOnRemote, `:refs/tags/${request.tagName}`], "network")] };
		}
		case "checkoutBranch": {
			const checked = request.remoteBranch === null
				? await gitWrite(repo, ["checkout", "--end-of-options", request.branchName])
				: await gitWrite(repo, ["checkout", "-b", request.branchName, "--track", "--end-of-options", request.remoteBranch]);
			const errors: (string | null)[] = [checked];
			const pull = request.pullAfterwards;
			if (checked === null && pull !== null) {
				// The pull is what the human asked for in the same dialog, so it runs on the branch they just
				// checked out: `--squash` and `--no-ff` are the two answers the page's form allows.
				const args = ["pull", ...(pull.squash ? ["--squash"] : pull.createNewCommit ? ["--no-ff"] : []), "--end-of-options", pull.remote, pull.branchName];
				errors.push(await gitWrite(repo, args, "network"));
			}
			return { errors };
		}
		case "checkoutCommit":
			return { errors: [await gitWrite(repo, ["checkout", "--end-of-options", request.commitHash])] };
		case "merge": {
			const args = ["merge"];
			// The page's form can ask for one of the three, and squash wins: a squash merge has no commit of
			// its own, so there is nothing for `--no-ff` to describe and nothing for `--no-commit` to hold.
			if (request.squash) args.push("--squash");
			else if (request.createNewCommit) args.push("--no-ff");
			if (request.noCommit) args.push("--no-commit");
			args.push("--end-of-options", request.obj);
			return { errors: [await gitWrite(repo, args)] };
		}
		case "rebase": {
			// `git rebase --interactive` opens an editor on a todo list, which this daemon has no terminal
			// for: refusing it is the honest answer rather than a run that hangs until it is killed.
			if (request.interactive) return { errors: [INTERACTIVE_REFUSAL] };
			const args = ["rebase", ...(request.ignoreDate ? ["--ignore-date"] : []), "--end-of-options", request.obj];
			return { errors: [await gitWrite(repo, args)] };
		}
		case "cherrypickCommit": {
			const args = ["cherry-pick"];
			if (request.noCommit) args.push("--no-commit");
			if (request.recordOrigin) args.push("-x");
			// Parent 0 is the page's word for "not a merge": a `-m 0` there would make git refuse the commit.
			if (request.parentIndex > 0) args.push("-m", String(request.parentIndex));
			args.push("--end-of-options", request.commitHash);
			return { errors: [await gitWrite(repo, args)] };
		}
		case "revertCommit": {
			// `--no-edit` keeps git's own message: without it `git revert` opens an editor, and a daemon has
			// no terminal to give it.
			const args = ["revert", "--no-edit"];
			if (request.parentIndex > 0) args.push("-m", String(request.parentIndex));
			args.push("--end-of-options", request.commitHash);
			return { errors: [await gitWrite(repo, args)] };
		}
		case "resetToCommit":
			return { errors: [await gitWrite(repo, ["reset", RESET_FLAG[request.resetMode], "--end-of-options", request.commit])] };
		case "dropCommit": {
			const parents = await parentCount(repo, request.commitHash);
			if (!parents.ok) return { errors: [parents.error] };
			if (parents.count > 1) return { errors: [MERGE_DROP_REFUSAL] };
			// A single commit is dropped by replaying everything above it onto its own parent, which is what
			// `git rebase --onto <commit>^ <commit>` does.
			return { errors: [await gitWrite(repo, ["rebase", "--onto", `${request.commitHash}^`, "--end-of-options", request.commitHash])] };
		}
		case "pushStash": {
			// The message is the page's, but it is an argument to `-m` rather than a positional, so it cannot
			// be read as an option. Nothing else here is positional, so no `--end-of-options` is needed.
			const args = ["stash", "push", ...(request.includeUntracked ? ["-u"] : []), ...(request.message === "" ? [] : ["-m", request.message])];
			return { errors: [await gitWrite(repo, args)] };
		}
		case "applyStash":
			return { errors: [await gitWrite(repo, ["stash", "apply", ...(request.reinstateIndex ? ["--index"] : []), "--end-of-options", request.selector])] };
		case "popStash":
			return { errors: [await gitWrite(repo, ["stash", "pop", ...(request.reinstateIndex ? ["--index"] : []), "--end-of-options", request.selector])] };
		case "dropStash":
			return { errors: [await gitWrite(repo, ["stash", "drop", "--end-of-options", request.selector])] };
		case "cleanUntrackedFiles":
			// The page's one checkbox is whether the clean descends into untracked folders.
			return { errors: [await gitWrite(repo, ["clean", request.directories ? "-fd" : "-f"])] };
		case "fetch": {
			// No remote named is the page's "every remote", which is what the toolbar's fetch button asks for.
			const args = ["fetch", ...(request.name === null ? ["--all"] : []), ...(request.prune ? ["--prune"] : []), ...(request.pruneTags ? ["--prune-tags"] : [])];
			if (request.name !== null) args.push("--end-of-options", request.name);
			return { errors: [await gitWrite(repo, args, "network")] };
		}
		case "pruneRemote":
			return { errors: [await gitWrite(repo, ["remote", "prune", "--end-of-options", request.name], "network")] };
		default:
			// A command this table does not write is one the dispatch never sends here.
			return { errors: [null] };
	}
}

/**
 * One command from the page, run against one repository, as the sentences git gave for whatever failed.
 *
 * The guards are answered here rather than inside `perform` so that a refusal costs no git call at all:
 * a second mutation and a live tree are both decided from the request and the repository entry. This is
 * deliberately not `async` — the busy check and the registration of the run have to happen with nothing
 * in between, or two requests arriving in the same tick would both find the repository free.
 */
export function runAction(repo: string, request: GitGraphRequest, entry?: RepoEntry): Promise<ActionAnswer> {
	const refusal = liveRefusal(request, entry);
	if (refusal !== null) return Promise.resolve({ errors: [refusal] });
	if (running.has(repo)) return Promise.resolve({ errors: [BUSY_REFUSAL] });
	const job = perform(repo, request).finally(() => {
		running.delete(repo);
	});
	running.set(repo, job);
	return job;
}
