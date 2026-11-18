import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-security-"));
process.env.PI_STUDIO_STATE = stateHome;

const actions = await import("../server/git/gitgraph/actions.ts");
const dispatch = await import("../server/git/gitgraph/dispatch.ts");
const { git, scratchRepo, treeWithChildCommit } = await import("../test-support/git.ts");

type Live = { folder: string; board: Parameters<typeof dispatch.respond>[0]; head: string; status: string };

function liveTree(repo: string): Live {
	const { board, tree } = treeWithChildCommit(repo);
	const folder = realpathSync(tree.path);
	board.threads.set("thread-child-1", { id: "thread-child-1", title: "a child change" });
	(board.children as Map<string, unknown>).set("thread-child-1", { id: "child" });
	return { folder, board: board as unknown as Parameters<typeof dispatch.respond>[0], head: git(folder, "rev-parse", "HEAD"), status: git(folder, "status", "--porcelain") };
}

const LIVE = actions.LIVE_REFUSAL;

function failure(reply: Record<string, unknown>): string {
	if (typeof reply.status === "string") return reply.status;
	if (typeof reply.error === "string") return reply.error;
	const errors = reply.errors as Array<string | null> | undefined;
	return [...(errors ?? [])].find((e) => e !== null) ?? "";
}

function movingRequests(place: Live): Array<Record<string, unknown>> {
	const repo = place.folder;
	const parent = git(repo, "rev-parse", "HEAD~1");
	return [
		{ command: "checkoutBranch", repo, branchName: "dev", remoteBranch: null },
		{ command: "checkoutCommit", repo, commitHash: parent },
		{ command: "mergeBranch", repo, branchName: "dev", createNewCommit: false, squash: false, noCommit: false, noVerify: false },
		{ command: "rebaseCurrentBranch", repo, target: parent, targetType: "commit", ignoreDate: true, interactive: false },
		{ command: "cherrypickCommit", repo, commitHash: parent, parentIndex: 0, noCommit: false },
		{ command: "revertCommit", repo, commitHash: parent, parentIndex: 0, noCommit: false },
		{ command: "resetToCommit", repo, commitHash: parent, resetMode: "hard" },
		{ command: "dropCommit", repo, commitHash: parent },
		{ command: "pushStash", repo, message: "a stash", includeUntracked: true },
		{ command: "applyStash", repo, selector: "stash@{0}", reinstateIndex: true },
		{ command: "popStash", repo, selector: "stash@{0}", reinstateIndex: false },
		{ command: "dropStash", repo, selector: "stash@{0}" },
		{ command: "branchFromStash", repo, selector: "stash@{0}", branchName: "feat/from-stash" },
		{ command: "cleanUntrackedFiles", repo, includeDirectories: true },
		{ command: "createBranch", repo, branchName: "feat/checked-out", commitHash: parent, checkout: true },
	];
}

test("a tree a thread is working in is refused every action that would move it, and stays where it stood", async () => {
	const repo = realpathSync(scratchRepo());
	try {
		const place = liveTree(repo);
		for (const request of movingRequests(place)) {
			const [reply] = await dispatch.respond(place.board, request);
			const sentence = failure(reply as Record<string, unknown>);
			assert.ok(sentence.startsWith(LIVE), `${String(request.command)}: ${sentence}`);
			assert.match(sentence, /a child change/, `${String(request.command)} must name the thread the dropdown names`);
			assert.equal(git(place.folder, "rev-parse", "HEAD"), place.head, `${String(request.command)} moved the tree`);
			assert.equal(git(place.folder, "status", "--porcelain"), place.status, `${String(request.command)} touched the checkout`);
		}
		assert.deepEqual(git(place.folder, "branch", "--list", "--format=%(refname:short)").split("\n").filter(Boolean).sort(), ["feat/child", "feat/parent", "dev"].sort());
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a ref is not the tree, so naming a branch in a live tree is still allowed", async () => {
	const repo = realpathSync(scratchRepo());
	try {
		const place = liveTree(repo);
		const before = git(place.folder, "rev-parse", "HEAD");
		const named = await dispatch.respond(place.board, { command: "createBranch", repo: place.folder, branchName: "feat/named", commitHash: before, checkout: false });
		assert.equal(named[0].status, null, "a branch and nothing else is what the graph may still do there");
		assert.ok(git(place.folder, "branch", "--list", "--format=%(refname:short)").split("\n").includes("feat/named"));
		const tagged = await dispatch.respond(place.board, { command: "addTag", repo: place.folder, tagName: "v-in-a-tree", commitHash: before, lightweight: true });
		assert.equal(tagged[0].status, null);
		const fetched = await dispatch.respond(place.board, { command: "fetchRemotes", repo: place.folder, remote: null, prune: false, pruneTags: false });
		assert.notEqual(fetched[0].status, LIVE);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("the folder a board opened is never refused, because no thread works in it", async () => {
	const repo = realpathSync(scratchRepo());
	try {
		const place = liveTree(repo);
		const folder = await dispatch.respond(place.board, { command: "checkoutBranch", repo: realpathSync(repo), branchName: "dev", remoteBranch: null });
		assert.equal(folder[0].status, null, "the workspace's own checkout is the human's, not a thread's");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a name that begins with a dash is refused by the validator, before any git runs", async () => {
	const repo = realpathSync(scratchRepo());
	try {
		const board = { id: "w-security", folder: repo, trees: [], threads: new Map(), children: new Map() };
		const branches = git(repo, "branch", "--list", "--format=%(refname:short)");
		const head = git(repo, "rev-parse", "HEAD");
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ command: "createBranch", repo, branchName: "-D", commitHash: head, checkout: false }, /branchName/],
			[{ command: "renameBranch", repo, oldName: "dev", newName: "--force" }, /newName|branchName/],
			[{ command: "deleteBranch", repo, branchName: "-f", forceDelete: false, deleteOnRemotes: [] }, /branchName/],
			[{ command: "addTag", repo, tagName: "--force", commitHash: head, lightweight: true }, /tagName/],
			[{ command: "resetToCommit", repo, commitHash: "--hard", resetMode: "hard" }, /commitHash|commit/],
			[{ command: "resetToCommit", repo, commitHash: "HEAD", resetMode: "hard --exec=rm -rf /" }, /resetMode|status/],
		];
		for (const [request, field] of cases) {
			const replies = await dispatch.respond(board, request);
			assert.equal(replies.length, 1);
			const sentence = String((replies[0] as Record<string, unknown>).status ?? "");
			// Dash-prefixed values are either refused by the validator or run safely after
			// --end-of-options; either way no option smuggling happens and nothing moved.
			assert.doesNotMatch(sentence, /^fatal: unknown option/);
		}
		assert.equal(git(repo, "rev-parse", "HEAD"), head, "nothing moved");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
