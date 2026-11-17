import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The state folder is resolved once, when `server/paths.ts` is first imported, so this file sets it
 * before any view code is loaded and then loads that code dynamically — the same reason
 * `test/gitgraph-dispatch.test.ts` is a file of its own.
 */
const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-security-"));
process.env.PI_STUDIO_STATE = stateHome;

const actions = await import("../server/git/gitgraph/actions.ts");
const dispatch = await import("../server/git/gitgraph/dispatch.ts");
const { git, scratchRepo, treeWithChildCommit } = await import("../test-support/git.ts");

// ---------- a tree somebody is working in ----------

/** What a live tree and its board look like here, and what the tree looked like before a request. */
type Live = { folder: string; board: Parameters<typeof dispatch.respond>[0]; head: string; status: string };

/** A tree a thread is working in right now: it is on disk, its record says so, and a child is running. */
function liveTree(repo: string): Live {
	const { board, tree } = treeWithChildCommit(repo);
	const folder = realpathSync(tree.path);
	// A board knows the thread that owns each tree, and which of the trees has a child running in it now.
	board.threads.set("thread-child-1", { id: "thread-child-1", title: "a child change" });
	(board.children as Map<string, unknown>).set("thread-child-1", { id: "child" });
	return { folder, board: board as unknown as Parameters<typeof dispatch.respond>[0], head: git(folder, "rev-parse", "HEAD"), status: git(folder, "status", "--porcelain") };
}

/** The sentence a live tree answers with, as the guard words it: exported, so this is not a copy of it. */
const LIVE = actions.LIVE_REFUSAL;

/** What a reply says went wrong, from whichever of the page's two shapes this command answers in. */
function failure(reply: Record<string, unknown>): string {
	if (typeof reply.error === "string") return reply.error;
	const errors = reply.errors as Array<string | null> | undefined;
	return [...(errors ?? [])].find((error) => error !== null) ?? "";
}

/**
 * Every request that moves HEAD or the working tree, which is the whole set the guard is for. The values
 * are deliberately ones that would work if the guard were not there: a real selector, a real commit.
 */
function movingRequests(place: Live): Array<Record<string, unknown>> {
	const repo = place.folder;
	const parent = git(repo, "rev-parse", "HEAD~1");
	return [
		{ command: "checkoutBranch", repo, branchName: "dev", remoteBranch: null, pullAfterwards: null },
		{ command: "checkoutCommit", repo, commitHash: parent },
		{ command: "merge", repo, obj: "dev", actionOn: "Branch", createNewCommit: false, squash: false, noCommit: false },
		{ command: "rebase", repo, obj: parent, actionOn: "Commit", ignoreDate: true, interactive: false },
		{ command: "cherrypickCommit", repo, commitHash: parent, parentIndex: 0, recordOrigin: false, noCommit: false },
		{ command: "revertCommit", repo, commitHash: parent, parentIndex: 0 },
		{ command: "resetToCommit", repo, commit: parent, resetMode: "hard" },
		{ command: "dropCommit", repo, commitHash: parent },
		{ command: "pushStash", repo, message: "a stash", includeUntracked: true },
		{ command: "applyStash", repo, selector: "stash@{0}", reinstateIndex: true },
		{ command: "popStash", repo, selector: "stash@{0}", reinstateIndex: false },
		{ command: "dropStash", repo, selector: "stash@{0}" },
		{ command: "branchFromStash", repo, selector: "stash@{0}", branchName: "feat/from-stash" },
		{ command: "cleanUntrackedFiles", repo, directories: true },
		// A branch is a ref, but checking it out moves the tree, which is the part the guard is about.
		{ command: "createBranch", repo, branchName: "feat/checked-out", commitHash: parent, checkout: true, force: false },
	];
}

test("a tree a thread is working in is refused every action that would move it, and stays where it stood", async () => {
	const repo = realpathSync(scratchRepo());
	try {
		const place = liveTree(repo);
		for (const request of movingRequests(place)) {
			const [reply] = await dispatch.respond(place.board, request);
			const sentence = failure(reply);
			assert.ok(sentence.startsWith(LIVE), `${String(request.command)}: ${sentence}`);
			assert.match(sentence, /a child change/, `${String(request.command)} must name the thread the dropdown names`);
			assert.equal(git(place.folder, "rev-parse", "HEAD"), place.head, `${String(request.command)} moved the tree`);
			assert.equal(git(place.folder, "status", "--porcelain"), place.status, `${String(request.command)} touched the checkout`);
			assert.equal(git(place.folder, "stash", "list"), "", `${String(request.command)} stashed work`);
		}
		assert.deepEqual(git(place.folder, "branch", "--list", "--format=%(refname:short)").split("\n").filter(Boolean).sort(), ["feat/child", "feat/parent", "dev"].sort(), "not even the branch the checkout would have made");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a ref is not the tree, so naming a branch in a live tree is still allowed", async () => {
	const repo = realpathSync(scratchRepo());
	try {
		const place = liveTree(repo);
		const before = git(place.folder, "rev-parse", "HEAD");
		const named = await dispatch.respond(place.board, { command: "createBranch", repo: place.folder, branchName: "feat/named", commitHash: before, checkout: false, force: false });
		assert.deepEqual(named[0].errors, [null], "a branch and nothing else is what the graph may still do there");
		assert.ok(git(place.folder, "branch", "--list", "--format=%(refname:short)").split("\n").includes("feat/named"));
		assert.equal(git(place.folder, "rev-parse", "--abbrev-ref", "HEAD"), "feat/child", "and the tree still stands where it stood");

		const tagged = await dispatch.respond(place.board, { command: "addTag", repo: place.folder, tagName: "v-in-a-tree", commitHash: before, type: 1, message: "", pushToRemote: null, force: false });
		assert.deepEqual(tagged[0].errors, [null]);
		assert.deepEqual(git(place.folder, "tag", "--list").split("\n").filter(Boolean), ["v-in-a-tree"]);

		// A fetch and a prune name a remote and touch no checkout, so they are not the guard's business.
		const fetched = await dispatch.respond(place.board, { command: "fetch", repo: place.folder, name: null, prune: false, pruneTags: false });
		assert.notEqual(fetched[0].error, LIVE);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("the folder a board opened is never refused, because no thread works in it", async () => {
	const repo = realpathSync(scratchRepo());
	try {
		const place = liveTree(repo);
		const folder = await dispatch.respond(place.board, { command: "checkoutBranch", repo: realpathSync(repo), branchName: "dev", remoteBranch: null, pullAfterwards: null });
		assert.deepEqual(folder[0].errors, [null], "the workspace's own checkout is the human's, not a thread's");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

// ---------- a value dressed as an option ----------

test("a name that begins with a dash is refused by the validator, before any git runs", async () => {
	const repo = realpathSync(scratchRepo());
	try {
		const board = { id: "w-security", folder: repo, trees: [], threads: new Map(), children: new Map() };
		const branches = git(repo, "branch", "--list", "--format=%(refname:short)");
		const head = git(repo, "rev-parse", "HEAD");
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ command: "createBranch", repo, branchName: "-D", commitHash: head, checkout: false, force: false }, /branchName/],
			[{ command: "renameBranch", repo, oldName: "dev", newName: "--force" }, /newName/],
			[{ command: "deleteBranch", repo, branchName: "-f", forceDelete: false, deleteOnRemotes: null }, /branchName/],
			[{ command: "addTag", repo, tagName: "--force", commitHash: head, type: 1, message: "", pushToRemote: null, force: false }, /tagName/],
			[{ command: "resetToCommit", repo, commit: "--hard", resetMode: "hard" }, /commit/],
			// The mode is one of three words, never a string interpolated into a flag.
			[{ command: "resetToCommit", repo, commit: "HEAD", resetMode: "hard --exec=rm -rf /" }, /resetMode/],
			// A remote is a name, not a place to put a command line.
			[{ command: "fetch", repo, name: "--upload-pack=touch /tmp/pwned", prune: false, pruneTags: false }, /name/],
		];
		for (const [request, field] of cases) {
			const replies = await dispatch.respond(board, request);
			assert.equal(replies.length, 1, `${String(request.command)} answered ${replies.length} times`);
			const sentence = String(replies[0].error ?? "");
			assert.match(sentence, field, `${String(request.command)}: ${sentence}`);
			// The validator's own sentence, not one git would have produced for a command it ran.
			assert.doesNotMatch(sentence, /^(fatal|error|usage):/);
		}
		assert.equal(git(repo, "branch", "--list", "--format=%(refname:short)"), branches, "no branch was made, renamed or deleted");
		assert.equal(git(repo, "tag", "--list"), "");
		assert.equal(git(repo, "rev-parse", "HEAD"), head, "nothing moved");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
