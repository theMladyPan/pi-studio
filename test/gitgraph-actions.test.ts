import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The state folder is resolved once, when `server/paths.ts` is first imported, so this file sets it
 * before any view code is loaded and then loads that code dynamically — the same reason
 * `test/gitgraph-dispatch.test.ts` is a file of its own.
 */
const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-actions-"));
process.env.PI_STUDIO_STATE = stateHome;

const actions = await import("../server/git/gitgraph/actions.ts");
const dispatch = await import("../server/git/gitgraph/dispatch.ts");
const config = await import("../server/git/gitgraph/config.ts");
const { git, scratchRepo, treeWithChildCommit } = await import("../test-support/git.ts");

// ---------- one repository, one board ----------

/** A board that shows one repository, which is what a request has to name to be run. */
type Board = {
	id: string;
	folder: string;
	trees: Array<{ path: string; branch?: string; thread?: string }>;
	threads: Map<string, { id?: string; title?: string }>;
	children: Map<string, unknown>;
};

/** A scratch repository and the board that shows it, from a test's point of view. */
type Place = { folder: string; board: Board };

/** One repository of a test's own, and the board that shows it, cleaned up whatever the test does. */
async function withRepo(work: (place: Place) => Promise<void>): Promise<void> {
	const folder = realpathSync(scratchRepo());
	const board: Board = { id: "w-actions", folder, trees: [], threads: new Map(), children: new Map() };
	try {
		await work({ folder, board });
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

/** One request, and the single reply it earns. */
async function act(place: Place, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	const replies = await dispatch.respond(place.board, request);
	assert.equal(replies.length, 1, `expected one reply to ${String(request.command)}, got ${replies.length}`);
	return replies[0];
}

/** A commit of its own on `dev`, so what a test asserts is not the commit it started from. */
function commitFile(folder: string, file: string, subject: string): string {
	writeFileSync(join(folder, file), `${subject}\n`);
	git(folder, "add", ".");
	git(folder, "commit", "-m", subject);
	return git(folder, "rev-parse", "HEAD");
}

/** A bare repository beside the checkout, added as `origin`, so a push or a fetch has somewhere to go. */
function withRemote(folder: string): string {
	const bare = mkdtempSync(join(tmpdir(), "pi-studio-remote-"));
	git(bare, "init", "--bare", "-b", "dev");
	git(folder, "remote", "add", "origin", bare);
	git(folder, "push", "-u", "origin", "dev");
	// A `git clone` of a bare folder does not fetch anything by itself, and neither does a remote added
	// by hand: the tracking refs a test reads are the ones a fetch has written.
	git(folder, "fetch", "origin");
	return bare;
}

/** The branch names a repository has, without the stars and the spacing `git branch` prints. */
const branches = (folder: string): string[] => git(folder, "branch", "--list", "--format=%(refname:short)").split("\n").filter(Boolean);
const tags = (folder: string): string[] => git(folder, "tag", "--list").split("\n").filter(Boolean);
const head = (folder: string): string => git(folder, "rev-parse", "--abbrev-ref", "HEAD");
const subjects = (folder: string): string[] => git(folder, "log", "--oneline", "--format=%s").split("\n").filter(Boolean);

// ---------- branches ----------

test("a branch is made at a commit, checked out when asked, renamed and deleted", async () => {
	await withRepo(async (place) => {
		const first = git(place.folder, "rev-parse", "HEAD");

		const made = await act(place, { command: "createBranch", repo: place.folder, branchName: "feat/made", commitHash: first, checkout: false, force: false });
		assert.deepEqual(made.errors, [null]);
		assert.ok(branches(place.folder).includes("feat/made"), "the branch must exist");
		assert.equal(head(place.folder), "dev", "a branch made without a checkout leaves HEAD where it was");
		assert.equal(git(place.folder, "rev-parse", "feat/made"), first, "the branch must be at the commit that was named");

		const checked = await act(place, { command: "createBranch", repo: place.folder, branchName: "feat/checked", commitHash: first, checkout: true, force: false });
		assert.deepEqual(checked.errors, [null, null]);
		assert.equal(head(place.folder), "feat/checked", "the checkout the page asked for in the same breath");

		const renamed = await act(place, { command: "renameBranch", repo: place.folder, oldName: "feat/made", newName: "feat/renamed" });
		assert.equal(renamed.error, null);
		assert.deepEqual(branches(place.folder).filter((name) => name.startsWith("feat/")).sort(), ["feat/checked", "feat/renamed"]);

		const deleted = await act(place, { command: "deleteBranch", repo: place.folder, branchName: "feat/renamed", forceDelete: false, deleteOnRemotes: null });
		assert.deepEqual(deleted.errors, [null]);
		assert.equal(deleted.branchName, "feat/renamed");
		assert.deepEqual(deleted.deleteOnRemotes, []);
		assert.ok(!branches(place.folder).includes("feat/renamed"), "the branch must be gone");
	});
});

test("a branch git will not delete says so, and a forced delete is the page's next question", async () => {
	await withRepo(async (place) => {
		// Work that only this branch has: `git branch -d` refuses it, and the page asks the human whether
		// to force it when the sentence it gets back is git's own hint to run `git branch -D`.
		git(place.folder, "checkout", "-q", "-b", "feat/unmerged");
		commitFile(place.folder, "unmerged.txt", "unmerged work");
		git(place.folder, "checkout", "-q", "dev");

		const refused = await act(place, { command: "deleteBranch", repo: place.folder, branchName: "feat/unmerged", forceDelete: false, deleteOnRemotes: null });
		const [sentence] = refused.errors as Array<string | null>;
		assert.ok(sentence !== null && sentence.includes("git branch -D"), `the page looks for that hint: ${String(sentence)}`);
		assert.ok(branches(place.folder).includes("feat/unmerged"), "a refused delete must leave the branch alone");

		const forced = await act(place, { command: "deleteBranch", repo: place.folder, branchName: "feat/unmerged", forceDelete: true, deleteOnRemotes: null });
		assert.deepEqual(forced.errors, [null]);
		assert.ok(!branches(place.folder).includes("feat/unmerged"), "the forced delete must remove it");
	});
});

test("a branch deleted on its remotes too is deleted there as well", async () => {
	await withRepo(async (place) => {
		const bare = withRemote(place.folder);
		try {
			git(place.folder, "checkout", "-q", "-b", "feat/shared");
			commitFile(place.folder, "shared.txt", "shared work");
			git(place.folder, "push", "-q", "-u", "origin", "feat/shared");
			git(place.folder, "checkout", "-q", "dev");
			assert.ok(git(bare, "branch", "--list", "--format=%(refname:short)").split("\n").includes("feat/shared"));

			const deleted = await act(place, { command: "deleteBranch", repo: place.folder, branchName: "feat/shared", forceDelete: false, deleteOnRemotes: ["origin"] });
			assert.deepEqual(deleted.errors, [null, null], "one answer per git command: the branch, then the remote");
			assert.ok(!branches(place.folder).includes("feat/shared"));
			assert.ok(!git(bare, "branch", "--list", "--format=%(refname:short)").split("\n").includes("feat/shared"), "the remote branch must be gone");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});

// ---------- tags ----------

test("a lightweight tag is a ref, an annotated one is an object, and both land where they were asked", async () => {
	await withRepo(async (place) => {
		const first = git(place.folder, "rev-parse", "HEAD");
		const light = await act(place, { command: "addTag", repo: place.folder, tagName: "v1.0.0", commitHash: first, type: 1, message: "", pushToRemote: null, force: false });
		assert.deepEqual(light.errors, [null]);
		assert.deepEqual(tags(place.folder), ["v1.0.0"]);
		assert.equal(git(place.folder, "cat-file", "-t", "v1.0.0"), "commit", "a lightweight tag is the commit itself");

		const annotated = await act(place, { command: "addTag", repo: place.folder, tagName: "v2.0.0", commitHash: first, type: 0, message: "the second release", pushToRemote: null, force: false });
		assert.deepEqual(annotated.errors, [null]);
		assert.equal(git(place.folder, "cat-file", "-t", "v2.0.0"), "tag", "an annotated tag is an object of its own");
		assert.match(git(place.folder, "tag", "--list", "--format=%(contents:subject)", "v2.0.0"), /the second release/);

		const again = await act(place, { command: "addTag", repo: place.folder, tagName: "v2.0.0", commitHash: first, type: 1, message: "", pushToRemote: null, force: false });
		const [taken] = again.errors as Array<string | null>;
		assert.match(String(taken), /already exists/, "an existing tag is git's refusal, not ours");
		const forced = await act(place, { command: "addTag", repo: place.folder, tagName: "v2.0.0", commitHash: first, type: 1, message: "", pushToRemote: null, force: true });
		assert.deepEqual(forced.errors, [null]);
		assert.equal(git(place.folder, "cat-file", "-t", "v2.0.0"), "commit", "a forced lightweight tag replaces the annotated one");
	});
});

test("a tag pushed in the same breath is on the remote, and a delete takes it off both", async () => {
	await withRepo(async (place) => {
		const bare = withRemote(place.folder);
		try {
			const first = git(place.folder, "rev-parse", "HEAD");
			const pushed = await act(place, { command: "addTag", repo: place.folder, tagName: "v3.0.0", commitHash: first, type: 1, message: "", pushToRemote: "origin", force: false });
			assert.deepEqual(pushed.errors, [null, null]);
			assert.deepEqual(git(bare, "tag", "--list").split("\n").filter(Boolean), ["v3.0.0"]);

			const removed = await act(place, { command: "deleteTag", repo: place.folder, tagName: "v3.0.0", deleteOnRemote: "origin" });
			assert.equal(removed.error, null);
			assert.deepEqual(tags(place.folder), []);
			assert.deepEqual(git(bare, "tag", "--list").split("\n").filter(Boolean), [], "the remote tag must be gone too");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});

// ---------- checkouts ----------

test("a branch is checked out, a remote-tracking one gets a local branch that tracks it, and a commit is detached", async () => {
	await withRepo(async (place) => {
		const bare = withRemote(place.folder);
		try {
			git(place.folder, "checkout", "-q", "-b", "feat/remote");
			commitFile(place.folder, "remote.txt", "remote work");
			git(place.folder, "push", "-q", "-u", "origin", "feat/remote");
			git(place.folder, "checkout", "-q", "dev");
			git(place.folder, "branch", "-q", "-D", "feat/remote");
			git(place.folder, "fetch", "-q", "origin");

			const local = await act(place, { command: "checkoutBranch", repo: place.folder, branchName: "dev", remoteBranch: null, pullAfterwards: null });
			assert.deepEqual(local.errors, [null]);
			assert.deepEqual(local.pullAfterwards, null, "the page words its failure report from this field");
			assert.equal(head(place.folder), "dev");

			const tracking = await act(place, { command: "checkoutBranch", repo: place.folder, branchName: "feat/local", remoteBranch: "origin/feat/remote", pullAfterwards: null });
			assert.deepEqual(tracking.errors, [null]);
			assert.equal(head(place.folder), "feat/local");
			assert.equal(git(place.folder, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"), "origin/feat/remote", "the local branch must track the remote one");

			const detached = await act(place, { command: "checkoutCommit", repo: place.folder, commitHash: git(place.folder, "rev-parse", "dev") });
			assert.equal(detached.error, null);
			assert.equal(head(place.folder), "HEAD", "a commit is checked out detached");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});

test("a checkout that carries the page's pull brings the remote's work in", async () => {
	await withRepo(async (place) => {
		const bare = withRemote(place.folder);
		const elsewhere = mkdtempSync(join(tmpdir(), "pi-studio-clone-"));
		try {
			// Somebody else's clone, so the remote has a commit this checkout has not seen.
			git(elsewhere, "clone", "-q", bare, "theirs");
			const theirs = join(elsewhere, "theirs");
			git(theirs, "config", "user.email", "test@example.invalid");
			git(theirs, "config", "user.name", "test");
			commitFile(theirs, "theirs.txt", "work from elsewhere");
			git(theirs, "push", "-q", "origin", "dev");

			const pull = { branchName: "dev", remote: "origin", createNewCommit: false, squash: false };
			const checked = await act(place, { command: "checkoutBranch", repo: place.folder, branchName: "dev", remoteBranch: null, pullAfterwards: pull });
			assert.deepEqual(checked.errors, [null, null], "the checkout, then the pull it asked for");
			assert.deepEqual(checked.pullAfterwards, pull, "the page words its failure report from this field");
			assert.equal(subjects(place.folder)[0], "work from elsewhere", "the pull brought the commit in");
			assert.equal(head(place.folder), "dev");
		} finally {
			rmSync(bare, { recursive: true, force: true });
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

// ---------- push and pull ----------

test("a branch is pushed to the remote, and a pull brings the remote's work in", async () => {
	await withRepo(async (place) => {
		const bare = withRemote(place.folder);
		const elsewhere = mkdtempSync(join(tmpdir(), "pi-studio-clone-"));
		try {
			git(place.folder, "checkout", "-q", "-b", "feat/pushed");
			const pushed = commitFile(place.folder, "pushed.txt", "pushed work");
			git(place.folder, "checkout", "-q", "dev");

			const pushedReply = await act(place, { command: "pushBranch", repo: place.folder, branchName: "feat/pushed", remotes: ["origin"], setUpstream: true, mode: "", willUpdateBranchConfig: true });
			assert.deepEqual(pushedReply.errors, [null]);
			assert.equal(pushedReply.willUpdateBranchConfig, true, "the flag the bundle asked with is echoed back");
			assert.equal(git(bare, "rev-parse", "feat/pushed"), pushed, "the bare repository must hold the pushed branch");

			// Somebody else's clone, so the remote has a commit this checkout has not seen.
			git(elsewhere, "clone", "-q", bare, "theirs");
			const theirs = join(elsewhere, "theirs");
			git(theirs, "config", "user.email", "test@example.invalid");
			git(theirs, "config", "user.name", "test");
			commitFile(theirs, "theirs.txt", "work from elsewhere");
			git(theirs, "push", "-q", "origin", "dev");

			const pulled = await act(place, { command: "pullBranch", repo: place.folder, branchName: "dev", remote: "origin", createNewCommit: false, squash: false });
			assert.equal(pulled.error, null);
			assert.equal(subjects(place.folder)[0], "work from elsewhere", "the pull brought the commit in");
		} finally {
			rmSync(bare, { recursive: true, force: true });
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

// ---------- merging, cherry-picking, reverting ----------

test("a merge that is asked for a commit makes one, and a squash merge stages without committing", async () => {
	await withRepo(async (place) => {
		git(place.folder, "checkout", "-q", "-b", "feat/side");
		commitFile(place.folder, "side.txt", "side work");
		git(place.folder, "checkout", "-q", "dev");
		const before = git(place.folder, "rev-parse", "HEAD");

		const merged = await act(place, { command: "merge", repo: place.folder, obj: "feat/side", actionOn: "Branch", createNewCommit: true, squash: false, noCommit: false });
		assert.equal(merged.error, null);
		assert.equal(merged.actionOn, "Branch", "the page prints the thing that was merged into the sentence it shows");
		assert.match(subjects(place.folder)[0], /^Merge branch 'feat\/side'/, "the merge commit git writes for a --no-ff merge");
		assert.equal(git(place.folder, "rev-parse", "HEAD^2"), git(place.folder, "rev-parse", "feat/side"), "the merged commit must be the second parent");

		git(place.folder, "reset", "-q", "--hard", before);
		const squashed = await act(place, { command: "merge", repo: place.folder, obj: "feat/side", actionOn: "Branch", createNewCommit: false, squash: true, noCommit: false });
		assert.equal(squashed.error, null);
		assert.equal(git(place.folder, "rev-parse", "HEAD"), before, "a squash merge makes no commit of its own");
		assert.match(git(place.folder, "status", "--porcelain"), /^A\s+side\.txt$/m, "the squash's work is staged for the human to commit");
	});
});

test("a cherry-pick commits the change, or stages it when the page asks for no commit", async () => {
	await withRepo(async (place) => {
		git(place.folder, "checkout", "-q", "-b", "feat/pick");
		const picked = commitFile(place.folder, "picked.txt", "work to pick");
		git(place.folder, "checkout", "-q", "dev");
		const before = git(place.folder, "rev-parse", "HEAD");

		const committed = await act(place, { command: "cherrypickCommit", repo: place.folder, commitHash: picked, parentIndex: 0, recordOrigin: false, noCommit: false });
		assert.deepEqual(committed.errors, [null]);
		assert.notEqual(git(place.folder, "rev-parse", "HEAD"), before);
		assert.equal(subjects(place.folder)[0], "work to pick");
		assert.equal(git(place.folder, "cat-file", "-p", "HEAD").includes("cherry picked from"), false, "without -x nothing is recorded");

		git(place.folder, "reset", "-q", "--hard", before);
		const staged = await act(place, { command: "cherrypickCommit", repo: place.folder, commitHash: picked, parentIndex: 0, recordOrigin: false, noCommit: true });
		assert.deepEqual(staged.errors, [null]);
		assert.equal(git(place.folder, "rev-parse", "HEAD"), before, "no commit was made");
		assert.match(git(place.folder, "status", "--porcelain"), /^A\s+picked\.txt$/m);

		git(place.folder, "reset", "-q", "--hard", before);
		git(place.folder, "clean", "-qfd");
		const recorded = await act(place, { command: "cherrypickCommit", repo: place.folder, commitHash: picked, parentIndex: 0, recordOrigin: true, noCommit: false });
		assert.deepEqual(recorded.errors, [null]);
		assert.match(git(place.folder, "log", "-1", "--format=%B"), /\(cherry picked from commit [0-9a-f]+\)/, "-x appends the origin");
	});
});

test("a revert makes the commit that undoes one", async () => {
	await withRepo(async (place) => {
		const work = commitFile(place.folder, "undone.txt", "work to undo");
		const reverted = await act(place, { command: "revertCommit", repo: place.folder, commitHash: work, parentIndex: 0 });
		assert.equal(reverted.error, null);
		assert.match(subjects(place.folder)[0], /^Revert "work to undo"$/);
		assert.equal(git(place.folder, "status", "--porcelain"), "", "the revert leaves the tree clean");
	});
});

// ---------- resetting ----------

test("a soft reset moves the branch and keeps the changes, a hard one discards them", async () => {
	await withRepo(async (place) => {
		const first = git(place.folder, "rev-parse", "HEAD");
		commitFile(place.folder, "second.txt", "the second commit");

		const soft = await act(place, { command: "resetToCommit", repo: place.folder, commit: first, resetMode: "soft" });
		assert.equal(soft.error, null);
		assert.equal(git(place.folder, "rev-parse", "HEAD"), first, "the branch is back at the first commit");
		assert.match(git(place.folder, "status", "--porcelain"), /^A\s+second\.txt$/m, "soft keeps the change staged");

		commitFile(place.folder, "third.txt", "a third commit");
		const to = git(place.folder, "rev-parse", "HEAD");
		git(place.folder, "reset", "-q", "--hard", first);
		const hard = await act(place, { command: "resetToCommit", repo: place.folder, commit: to, resetMode: "hard" });
		assert.equal(hard.error, null);
		assert.equal(git(place.folder, "rev-parse", "HEAD"), to);
		assert.equal(git(place.folder, "status", "--porcelain"), "", "hard throws the work away");
	});
});

test("the uncommitted changes row resets to HEAD, which is the same command with a word for a commit", async () => {
	await withRepo(async (place) => {
		writeFileSync(join(place.folder, "modified.txt"), "modified\n");
		git(place.folder, "add", "modified.txt");
		git(place.folder, "commit", "-q", "-m", "to be reset");
		writeFileSync(join(place.folder, "modified.txt"), "changed again\n");

		const reset = await act(place, { command: "resetToCommit", repo: place.folder, commit: "HEAD", resetMode: "hard" });
		assert.equal(reset.error, null);
		assert.equal(git(place.folder, "status", "--porcelain"), "");
	});
});

test("a commit is dropped by replaying what is above it, and a merge commit is not droppable", async () => {
	await withRepo(async (place) => {
		const second = commitFile(place.folder, "second.txt", "the commit that goes");
		commitFile(place.folder, "third.txt", "the commit that stays");

		const dropped = await act(place, { command: "dropCommit", repo: place.folder, commitHash: second });
		assert.equal(dropped.error, null);
		assert.deepEqual(subjects(place.folder).sort(), ["first", "the commit that stays"], "the dropped commit is gone and the one above it kept");
		assert.equal(git(place.folder, "log", "--format=%s", "dev").split("\n").includes("the commit that goes"), false);
		assert.notEqual(git(place.folder, "rev-parse", "HEAD"), second);

		// A merge commit, which the bundle hides the Drop entry for: refused with one sentence and no git.
		git(place.folder, "checkout", "-q", "-b", "feat/joined");
		commitFile(place.folder, "joined.txt", "joined work");
		git(place.folder, "checkout", "-q", "dev");
		git(place.folder, "merge", "-q", "--no-ff", "-m", "a merge", "feat/joined");
		const merge = git(place.folder, "rev-parse", "HEAD");
		const refused = await act(place, { command: "dropCommit", repo: place.folder, commitHash: merge });
		assert.match(String(refused.error), /a merge commit cannot be dropped/);
		assert.equal(git(place.folder, "rev-parse", "HEAD"), merge, "the refused drop moved nothing");
	});
});

// ---------- stashes ----------

test("a stash is pushed, applied, popped and dropped, and one becomes a branch", async () => {
	await withRepo(async (place) => {
		writeFileSync(join(place.folder, "wip.txt"), "uncommitted\n");
		// Staged, because `--index` is about reinstating what was staged; the untracked file beside it is
		// what `-u` carries into the stash's third parent.
		git(place.folder, "add", "wip.txt");

		const pushed = await act(place, { command: "pushStash", repo: place.folder, message: "work in progress", includeUntracked: true });
		assert.equal(pushed.error, null);
		assert.equal(git(place.folder, "status", "--porcelain"), "", "the stash takes the changes off the tree");
		assert.match(git(place.folder, "stash", "list"), /work in progress/);

		const applied = await act(place, { command: "applyStash", repo: place.folder, selector: "stash@{0}", reinstateIndex: true });
		assert.equal(applied.error, null);
		assert.match(git(place.folder, "status", "--porcelain"), /^A\s+wip\.txt$/m, "--index reinstates what was staged");
		assert.equal(git(place.folder, "stash", "list").split("\n").filter(Boolean).length, 1, "apply keeps the stash");

		git(place.folder, "reset", "-q", "--hard", "HEAD");
		git(place.folder, "clean", "-qfd");
		const popped = await act(place, { command: "popStash", repo: place.folder, selector: "stash@{0}", reinstateIndex: false });
		assert.equal(popped.error, null);
		assert.equal(git(place.folder, "stash", "list"), "", "pop drops it once it is applied");
		assert.ok(git(place.folder, "status", "--porcelain") !== "", "the changes are back");

		git(place.folder, "reset", "-q", "--hard", "HEAD");
		git(place.folder, "clean", "-qfd");
		writeFileSync(join(place.folder, "branch-work.txt"), "work to branch\n");
		git(place.folder, "add", "branch-work.txt");
		git(place.folder, "stash", "push", "-q", "-u", "-m", "to be a branch");
		const branched = await act(place, { command: "branchFromStash", repo: place.folder, selector: "stash@{0}", branchName: "feat/from-stash" });
		assert.equal(branched.error, null);
		assert.equal(head(place.folder), "feat/from-stash");
		assert.equal(git(place.folder, "stash", "list"), "", "git drops the stash it turned into a branch");

		git(place.folder, "reset", "-q", "--hard", "HEAD");
		git(place.folder, "clean", "-qfd");
		git(place.folder, "checkout", "-q", "dev");
		writeFileSync(join(place.folder, "dropped-work.txt"), "work to drop\n");
		git(place.folder, "add", "dropped-work.txt");
		git(place.folder, "stash", "push", "-q", "-u", "-m", "to be dropped");
		const dropped = await act(place, { command: "dropStash", repo: place.folder, selector: "stash@{0}" });
		assert.equal(dropped.error, null);
		assert.equal(git(place.folder, "stash", "list"), "");
	});
});

// ---------- untracked files ----------

test("a clean takes untracked files and, when asked, the folders they are in", async () => {
	await withRepo(async (place) => {
		writeFileSync(join(place.folder, "loose.txt"), "loose\n");
		git(place.folder, "clean", "-q", "-f");

		writeFileSync(join(place.folder, "kept.txt"), "kept\n");
		mkdirSync(join(place.folder, "folder"));
		writeFileSync(join(place.folder, "folder", "inside.txt"), "inside\n");
		const filesOnly = await act(place, { command: "cleanUntrackedFiles", repo: place.folder, directories: false });
		assert.equal(filesOnly.error, null);
		assert.equal(git(place.folder, "status", "--porcelain", "--untracked-files=all"), "?? folder/inside.txt", "a file is gone and the folder is not");

		const withFolders = await act(place, { command: "cleanUntrackedFiles", repo: place.folder, directories: true });
		assert.equal(withFolders.error, null);
		assert.equal(git(place.folder, "status", "--porcelain", "--untracked-files=all"), "");
	});
});

// ---------- a remote, read and pruned ----------

test("a fetch brings a remote's branches in, and a prune removes the ones that are gone", async () => {
	await withRepo(async (place) => {
		const bare = withRemote(place.folder);
		try {
			git(place.folder, "checkout", "-q", "-b", "feat/gone");
			commitFile(place.folder, "gone.txt", "work on a branch that goes");
			git(place.folder, "push", "-q", "origin", "feat/gone");
			git(place.folder, "checkout", "-q", "dev");
			git(place.folder, "branch", "-q", "-D", "feat/gone");

			const fetched = await act(place, { command: "fetch", repo: place.folder, name: "origin", prune: false, pruneTags: false });
			assert.equal(fetched.error, null);
			assert.ok(git(place.folder, "branch", "--remotes", "--list", "--format=%(refname:short)").split("\n").includes("origin/feat/gone"));

			// Deleted on the remote itself: a `git push --delete` here would also drop this checkout's own
			// tracking ref, and a ref already gone is not the stale one a prune is for.
			git(bare, "branch", "-D", "feat/gone");
			const stale = await act(place, { command: "fetch", repo: place.folder, name: "origin", prune: false, pruneTags: false });
			assert.equal(stale.error, null);
			assert.ok(git(place.folder, "branch", "--remotes", "--list", "--format=%(refname:short)").split("\n").includes("origin/feat/gone"), "a plain fetch keeps the stale ref");

			const pruned = await act(place, { command: "pruneRemote", repo: place.folder, name: "origin" });
			assert.equal(pruned.error, null);
			assert.ok(!git(place.folder, "branch", "--remotes", "--list", "--format=%(refname:short)").split("\n").includes("origin/feat/gone"), "a prune takes the stale ref away");

			const all = await act(place, { command: "fetch", repo: place.folder, name: null, prune: true, pruneTags: false });
			assert.equal(all.error, null, "no remote named is every remote");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});

// ---------- the guards ----------

test("a tree a thread is working in is not moved, though a branch may still be named in it", async () => {
	const repo = realpathSync(scratchRepo());
	try {
		const { board, tree } = treeWithChildCommit(repo);
		const live = realpathSync(tree.path);
		// A board knows the thread that owns each tree, and which of them has a child running in it now.
		board.threads.set("thread-child-1", { id: "thread-child-1", title: "a child change" });
		(board.children as Map<string, unknown>).set("thread-child-1", { id: "child" });
		const place = { folder: live, board: board as unknown as Board };
		const before = git(live, "rev-parse", "HEAD");

		const refused = await act(place, { command: "resetToCommit", repo: live, commit: git(live, "rev-parse", "HEAD~1"), resetMode: "hard" });
		assert.ok(typeof refused.error === "string" && refused.error.startsWith("a thread is working in this tree right now, so the graph will not move it"), String(refused.error));
		assert.match(String(refused.error), /a child change/, "the sentence names the thread the dropdown names");
		assert.equal(git(live, "rev-parse", "HEAD"), before, "the tree must not have moved");

		// A ref is not the tree: naming a branch there is what the graph may still do.
		const named = await act(place, { command: "createBranch", repo: live, branchName: "feat/from-the-graph", commitHash: before, checkout: false, force: false });
		assert.deepEqual(named.errors, [null]);
		assert.equal(git(live, "rev-parse", "--abbrev-ref", "HEAD"), "feat/child", "and the tree still stands where it stood");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("an interactive rebase is refused for want of a terminal, and nothing is rewound", async () => {
	await withRepo(async (place) => {
		commitFile(place.folder, "second.txt", "the second commit");
		const before = git(place.folder, "rev-parse", "HEAD");
		const refused = await act(place, { command: "rebase", repo: place.folder, obj: git(place.folder, "rev-parse", "HEAD~1"), actionOn: "Commit", ignoreDate: true, interactive: true });
		assert.equal(refused.error, "an interactive rebase needs a terminal this tab does not have");
		assert.equal(refused.interactive, true, "the page keeps its running notice up until it reads this field");
		assert.equal(git(place.folder, "rev-parse", "HEAD"), before);
		assert.equal(git(place.folder, "status", "--porcelain"), "");
	});
});

test("a second action in one repository is refused while the first is still running", async () => {
	await withRepo(async (place) => {
		writeFileSync(join(place.folder, "wip.txt"), "in progress\n");
		// Started in one tick and without awaiting, which is what two clicks in one page make: the second
		// request arrives while the first is still the repository's. The route answers each POST on its own,
		// so this is the concurrent case rather than a hypothetical one.
		const first = actions.runAction(place.folder, { command: "pushStash", repo: place.folder, message: "running", includeUntracked: true });
		const second = await actions.runAction(place.folder, { command: "cleanUntrackedFiles", repo: place.folder, directories: true });
		assert.deepEqual(second.errors, ["another git action is still running in this repository"]);
		assert.deepEqual((await first).errors, [null], "the run that held the repository still worked");
		// And the repository is free again once it settles.
		const after = await actions.runAction(place.folder, { command: "cleanUntrackedFiles", repo: place.folder, directories: true });
		assert.deepEqual(after.errors, [null]);
	});
});

test("git's own sentence is what the page is told when a command fails", async () => {
	await withRepo(async (place) => {
		const missing = await act(place, { command: "deleteBranch", repo: place.folder, branchName: "feat/never-made", forceDelete: false, deleteOnRemotes: null });
		const [sentence] = missing.errors as Array<string | null>;
		assert.match(String(sentence), /branch 'feat\/never-made' not found/, "git's words, not ours");
		const tag = await act(place, { command: "deleteTag", repo: place.folder, tagName: "v0", deleteOnRemote: null });
		assert.match(String(tag.error), /tag 'v0' not found/);
	});
});

// ---------- the menu and the dispatch are one decision ----------

/**
 * Which command each of the page's menu entries sends, read from the bundle's own menu builders: a flag
 * that is true here draws an entry that posts this command. `null` is an entry the page answers without
 * asking the daemon at all — a copy, a dropdown selection, a line inserted into the description.
 */
const MENU_COMMANDS: Record<string, string | null> = {
	"branch.checkout": "checkoutBranch",
	"branch.rename": "renameBranch",
	"branch.delete": "deleteBranch",
	"branch.merge": "merge",
	"branch.rebase": "rebase",
	"branch.push": "pushBranch",
	"branch.createPullRequest": "createPullRequest",
	"branch.createArchive": "createArchive",
	"branch.selectInBranchesDropdown": null,
	"branch.unselectInBranchesDropdown": null,
	"branch.copyName": null,
	"commit.addTag": "addTag",
	"commit.createBranch": "createBranch",
	"commit.checkout": "checkoutCommit",
	"commit.cherrypick": "cherrypickCommit",
	"commit.revert": "revertCommit",
	"commit.drop": "dropCommit",
	"commit.merge": "merge",
	"commit.rebase": "rebase",
	"commit.reset": "resetToCommit",
	"commit.copyHash": null,
	"commit.copySubject": null,
	"remoteBranch.checkout": "checkoutBranch",
	"remoteBranch.delete": "deleteRemoteBranch",
	"remoteBranch.fetch": "fetchIntoLocalBranch",
	"remoteBranch.merge": "merge",
	"remoteBranch.pull": "pullBranch",
	"remoteBranch.createPullRequest": "createPullRequest",
	"remoteBranch.createArchive": "createArchive",
	"remoteBranch.selectInBranchesDropdown": null,
	"remoteBranch.unselectInBranchesDropdown": null,
	"remoteBranch.copyName": null,
	"stash.apply": "applyStash",
	"stash.createBranch": "branchFromStash",
	"stash.pop": "popStash",
	"stash.drop": "dropStash",
	"stash.copyName": null,
	"stash.copyHash": null,
	"tag.viewDetails": "tagDetails",
	"tag.delete": "deleteTag",
	"tag.push": "pushTag",
	"tag.createArchive": "createArchive",
	"tag.copyName": null,
	"uncommittedChanges.stash": "pushStash",
	"uncommittedChanges.reset": "resetToCommit",
	"uncommittedChanges.clean": "cleanUntrackedFiles",
	"uncommittedChanges.openSourceControlView": "viewScm",
	"fileView.viewIssue": "openExternalUrl",
	"fileView.viewDiff": "viewDiff",
	"fileView.viewFileAtThisRevision": "viewFileAtRevision",
	"fileView.viewDiffWithWorkingFile": "viewDiffWithWorkingFile",
	"fileView.openFile": "openFile",
	"fileView.markAsReviewed": null,
	"fileView.markAsNotReviewed": null,
	"fileView.copyAbsoluteFilePath": null,
	"fileView.copyRelativeFilePath": null,
};

test("every menu entry this tab offers has a handler, and every refused command is hidden", () => {
	const offered: Record<string, boolean> = {};
	for (const [group, menu] of Object.entries(config.ENABLED_CONTEXT_ACTIONS)) {
		for (const [action, visible] of Object.entries(menu as Record<string, boolean>)) offered[`${group}.${action}`] = visible;
	}
	// A menu entry added to the page's settings without a line here would be one this test never checks.
	assert.deepEqual(Object.keys(offered).sort(), Object.keys(MENU_COMMANDS).sort(), "every menu entry is mapped to the command it sends");

	// A flag that is true draws an entry that posts a command, so that command has to have a handler.
	for (const [entry, visible] of Object.entries(offered)) {
		const command = MENU_COMMANDS[entry];
		if (!visible || command === null) continue;
		const refused = dispatch.UNAVAILABLE[command];
		assert.equal(refused, undefined, `${entry} is offered but ${command} answers "${String(refused)}"`);
	}

	// And the other way round: a command the dispatch still refuses must not be reachable from a menu.
	for (const command of Object.keys(dispatch.UNAVAILABLE)) {
		for (const [entry, mapped] of Object.entries(MENU_COMMANDS)) {
			if (mapped === command) assert.equal(offered[entry], false, `${entry} sends ${command}, which is refused`);
		}
	}
});
