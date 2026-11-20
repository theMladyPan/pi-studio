/**
 * The native Git Graph page and the daemon that answers it, checked against each other.
 *
 * Two things are easy to break without noticing. The graph module turns a list of commits into lanes,
 * and a mistake there draws a line that runs off the bottom or a join that lands in the wrong column,
 * with no error anywhere: the rows are what the human sees. And the page sends 60-odd commands to
 * `/git/msg`, so a command the page offers and the message table has since refused or forgotten is a
 * menu entry that answers "This tab cannot do that yet." at the moment a human clicks it.
 *
 * So this file walks the graph module with hand-built histories (a merge, a root, a parent the walk
 * cannot return, an expanded row) and then walks the page's own command names past the real message
 * table. Nothing here fakes git: a scratch repository from `test-support/git.ts` is the only fixture.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-native-gitgraph-"));
process.env.PI_STUDIO_STATE = stateHome;

type Link = { from: number; to: number; tone: number; kind: "pass" | "in" | "out"; uncommitted: boolean };
type LayoutRow = { lane: number; tone: number; links: Link[]; root: boolean; exits: Array<{ column: number; tone: number }> };
type Commit = { hash: string; parentHashes: string[] };
type Layout = { rows: LayoutRow[]; width: number };

const graph = (await import(new URL("../public/client/gitgraph/graph.js", import.meta.url).href)) as {
	layoutGraph: (commits: Commit[], options?: { more?: boolean; firstParentOnly?: boolean }) => Layout;
	graphWidth: (lanes: number) => number;
};
const dispatch = await import("../server/git/gitgraph/dispatch.ts");
const { git, scratchRepo } = await import("../test-support/git.ts");

type Board = { id: string; folder: string; trees: Array<{ path: string; branch?: string; thread?: string }>; threads: Map<string, { id?: string; title?: string }>; children: Map<string, unknown> };

// ---------- fixtures ----------

async function withRepo(work: (board: Board, folder: string) => Promise<void>): Promise<void> {
	const folder = realpathSync(scratchRepo());
	const board: Board = { id: "w-native", folder, trees: [], threads: new Map(), children: new Map() };
	try {
		await work(board, folder);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

async function one(board: Board, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	const replies = await dispatch.respond(board, request);
	assert.equal(replies.length, 1, `expected one reply to ${String(request.command)}, got ${replies.length}`);
	return replies[0] as Record<string, unknown>;
}

const commitFile = (folder: string, file: string, subject: string): string => {
	writeFileSync(join(folder, file), `${subject}\n`);
	git(folder, "add", ".");
	git(folder, "commit", "-m", subject);
	return git(folder, "rev-parse", "HEAD");
};

/** A checkout and a bare remote it tracks, so a remote-tracking branch exists to hide. */
async function withRemote(folder: string, work: () => Promise<void>): Promise<void> {
	const bare = mkdtempSync(join(tmpdir(), "pi-studio-native-remote-"));
	try {
		git(bare, "init", "--bare", "-b", "dev");
		git(folder, "remote", "add", "origin", bare);
		git(folder, "push", "-u", "origin", "dev");
		git(folder, "fetch", "origin");
		await work();
	} finally {
		rmSync(bare, { recursive: true, force: true });
	}
}

// ---------- the graph's joins ----------

test("a commit both parents lead to is one join, not a lane of its own", () => {
	// A is a merge of B and C; both of them are built on D.
	const { rows, width } = graph.layoutGraph([
		{ hash: "A", parentHashes: ["B", "C"] },
		{ hash: "B", parentHashes: ["D"] },
		{ hash: "C", parentHashes: ["D"] },
		{ hash: "D", parentHashes: [] },
	]);
	assert.equal(width, 2, "a merge of two branches is two lanes");
	assert.equal(rows[0].lane, 0);
	// The merge leaves one line for each parent, the second in the lane beside it.
	assert.deepEqual(rows[0].links.map(({ to, kind }) => [to, kind]), [[0, "out"], [1, "out"]]);
	// C is drawn in the second lane and its line comes back to the first, where D is already due.
	assert.equal(rows[2].lane, 1);
	assert.deepEqual(rows[2].links.filter(({ kind }) => kind === "out").map(({ from, to }) => [from, to]), [[1, 0]]);
	// Once the join is drawn, only the lane D is waiting in is left.
	assert.deepEqual(rows[2].exits.map(({ column }) => column), [0]);
	assert.deepEqual(rows[3].exits, []);
});

test("a root ends its lane, and a second root starts a fresh one", () => {
	const { rows, width } = graph.layoutGraph([
		{ hash: "A", parentHashes: ["B"] },
		{ hash: "B", parentHashes: [] },
		// A history that shares nothing with the one above, as an unfetched branch does.
		{ hash: "X", parentHashes: [] },
	]);
	assert.equal(rows[1].root, true, "a commit with no parent is the root the module draws as a square");
	assert.equal(rows[2].root, true);
	assert.deepEqual(rows[1].links.map(({ kind }) => kind), ["in"], "the root has nothing to continue");
	assert.deepEqual(rows[1].exits, [], "no lane runs past a root");
	assert.deepEqual(rows[2].links, [], "a second root is drawn on its own, with no line joining it");
	assert.equal(width, 1);
});

test("a parent the walk cannot return is drawn only when the walk is cut short", () => {
	const cut = [{ hash: "A", parentHashes: ["B"] }, { hash: "B", parentHashes: ["C"] }];
	// A filter dropped C: B's parent is not in these rows and never will be, so no line may run to the
	// bottom of the table looking for it.
	const filtered = graph.layoutGraph(cut, { more: false });
	assert.deepEqual(filtered.rows[1].links.map(({ kind }) => kind), ["in"]);
	assert.deepEqual(filtered.rows[1].exits, [], "a filtered-out parent leaves no dangling lane");
	// The same two rows with more history behind them: the lane has to reach the row that follows.
	const more = graph.layoutGraph(cut, { more: true });
	assert.deepEqual(more.rows[1].links.map(({ kind }) => kind), ["in", "out"]);
	assert.deepEqual(more.rows[1].exits.map(({ column }) => column), [0], "a cut window keeps its continuation");
});

test("an expanded row leaves the lanes the row after it already had", () => {
	const commits: Commit[] = [
		{ hash: "A", parentHashes: ["B", "C"] },
		{ hash: "B", parentHashes: ["D"] },
		{ hash: "C", parentHashes: ["D"] },
		{ hash: "D", parentHashes: [] },
	];
	const { rows } = graph.layoutGraph(commits);
	// The detail panel is drawn under one row and hands its lanes down through the gap. Every lane still
	// pending there must be in the next row, either as that row's own commit or as a line passing it.
	for (const [index, row] of rows.slice(0, -1).entries()) {
		const next = rows[index + 1];
		const covered = new Set([next.lane, ...next.links.filter(({ kind }) => kind === "pass").map(({ from }) => from)]);
		for (const { column } of row.exits) assert.ok(covered.has(column), `row ${index} leaves lane ${column}, which row ${index + 1} does not draw`);
	}
});

test("a stash row hangs off the commit it was made on and is a lane of its own", () => {
	const { rows, width } = graph.layoutGraph([
		{ hash: "S", parentHashes: ["B"] },
		{ hash: "B", parentHashes: ["D"] },
		{ hash: "D", parentHashes: [] },
	]);
	assert.equal(rows[0].lane, 0);
	assert.deepEqual(rows[0].links.map(({ to, kind }) => [to, kind]), [[0, "out"]]);
	assert.equal(width, 1, "a stash above the commit it holds needs no second lane");
});

test("first parents only takes a merge's second line away", () => {
	const commits: Commit[] = [
		{ hash: "A", parentHashes: ["B", "C"] },
		{ hash: "B", parentHashes: ["D"] },
		{ hash: "C", parentHashes: ["D"] },
		{ hash: "D", parentHashes: [] },
	];
	const { rows, width } = graph.layoutGraph(commits, { firstParentOnly: true });
	assert.equal(width, 2, "C is still a row of its own, beside the lane that runs past it");
	assert.deepEqual(rows[0].links.map(({ to, kind }) => [to, kind]), [[0, "out"]], "the second parent of the merge is not drawn");
	assert.deepEqual(rows[1].exits.map(({ column }) => column), [0]);
});

// ---------- what the page asks for ----------

// The read and the writes the page leans on hardest, checked as the page sends them instead of by
// reading its source for command names: a branch list is answered about the repository named in the
// request, a rename is the name the next read lists, and a repository this tab no longer has is refused
// rather than answered with another one. Which commands the menus offer is checked in
// `gitgraph-actions.test.ts`, against the list those menus are drawn from.

test("loadBranches is answered about the repository it names, so a selection moving under it cannot change the answer", async () => {
	const { treeWithChildCommit, childBranch } = await import("../test-support/git.ts");
	const repo = realpathSync(scratchRepo());
	const made = treeWithChildCommit(repo);
	const board = made.board as unknown as Board;
	const treePath = realpathSync(made.tree.path);
	try {
		// The page selects the folder the workspace opened, and then reads the tree it drew.
		assert.deepEqual(await dispatch.respond(board, { command: "selectRepo", repo }), []);
		const named = await one(board, { command: "loadBranches", repo: treePath, showRemoteBranches: true, hiddenRemotes: [] });
		assert.equal(named.isRepo, true);
		assert.equal(named.head, childBranch, "the answer belongs to the repository the request names");
		// The same read with no repository is Libre's own shape: the selected one answers.
		const selected = await one(board, { command: "loadBranches", showRemoteBranches: true, hiddenRemotes: [] });
		assert.equal(selected.head, "dev", "a request naming no repository gets the selected one");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a branch the page renamed is the name the next read lists", async () => {
	await withRepo(async (board, folder) => {
		const head = git(folder, "rev-parse", "HEAD");
		assert.equal((await one(board, { command: "createBranch", repo: folder, branchName: "feat/before", commitHash: head, checkout: false })).status, null);
		assert.equal((await one(board, { command: "renameBranch", repo: folder, oldName: "feat/before", newName: "feat/after" })).status, null);
		const listed = await one(board, { command: "loadBranches", repo: folder, showRemoteBranches: true, hiddenRemotes: [] });
		const names = listed.branches as string[];
		assert.ok(names.includes("feat/after"), `the renamed branch is listed: ${names.join(", ")}`);
		assert.ok(!names.includes("feat/before"), "the old name is gone from the list");
	});
});

test("loadBranches naming a repository this tab does not have is refused, not answered with another one", async () => {
	await withRepo(async (board, folder) => {
		assert.deepEqual(await dispatch.respond(board, { command: "selectRepo", repo: folder }), []);
		const answer = await one(board, { command: "loadBranches", repo: join(folder, "not-a-checkout"), showRemoteBranches: true, hiddenRemotes: [] });
		const error = answer.error as { message?: string } | null;
		assert.match(String(error?.message), /no longer open in this tab/, "the refusal says which state the tab is in");
		assert.equal(answer.branches, undefined, "and hands over no branch list from the selected repository");
	});
});

test("the load the page makes is answered with the fields it reads", async () => {
	await withRepo(async (board, folder) => {
		commitFile(folder, "second.txt", "second");
		const head = git(folder, "rev-parse", "HEAD");

		const listed = await one(board, { command: "loadRepos", check: true });
		assert.deepEqual(Object.keys(listed.repos as Record<string, unknown>), [folder]);
		assert.equal(listed.lastActiveRepo, folder);

		// `refresh()` selects the repository, then asks for branches and the repository in one go.
		assert.deepEqual(await dispatch.respond(board, { command: "selectRepo", repo: folder }), []);
		const filters = { branches: [] as string[], authors: [] as string[], tags: [] as string[], showRemoteBranches: true, hiddenRemotes: [] as string[], showTags: true };
		const branches = await one(board, { command: "loadBranches", repo: folder, hard: true, ...filters });
		assert.equal(branches.isRepo, true);
		assert.deepEqual(branches.branches, ["dev"], "the checked out branch comes first");
		assert.equal(branches.head, "dev");
		assert.ok(Array.isArray(branches.worktrees) && branches.worktrees.length > 0, "the dropdown marks the worktrees by name");
		assert.equal(typeof branches.upstreams, "object");

		const info = await one(board, { command: "loadRepoInfo", repo: folder, showStashes: true });
		const repoInfo = info.repoInfo as Record<string, unknown>;
		assert.equal(repoInfo.isRepo, true);
		for (const key of ["authors", "tags", "remotes", "stashes"]) assert.ok(Array.isArray(repoInfo[key]), `repoInfo.${key} is a list the toolbar reads`);
		assert.equal(typeof (repoInfo.config as Record<string, unknown>).userName, "object", "the settings panel reads the git identity");

		const loaded = await one(board, {
			command: "loadCommits", repo: folder, ...filters, branchName: "", maxCommits: 250, showStashes: true,
			includeReflog: false, includeUnreachableCommits: false, onlyFollowFirstParent: false, commitOrdering: "date",
		});
		assert.equal(loaded.head, head, "the page marks its HEAD row by comparing these hashes");
		assert.equal(typeof loaded.moreCommitsAvailable, "boolean");
		const rows = loaded.commits as Array<{ hash: string; parentHashes: string[]; message: string; author: string; email: string; date: number; refs: Array<{ name: string; type: string }> }>;
		assert.deepEqual(rows.map(({ message }) => message), ["second", "first"]);
		for (const row of rows) {
			assert.match(row.hash, /^[0-9a-f]{40}$/);
			assert.ok(Array.isArray(row.parentHashes), "the graph draws its lanes from this field");
			assert.equal(typeof row.message, "string");
			assert.ok(Array.isArray(row.refs), "the pills are drawn from this field");
		}

		// What the daemon answers is what the graph module is handed.
		const layout = graph.layoutGraph(rows);
		assert.equal(layout.rows.length, rows.length);
		assert.ok(layout.width >= 1);
		for (const row of layout.rows) for (const { to } of row.links) assert.ok(to < layout.width, "a lane outside the drawn width is a line nobody sees");
	});
});

test("the settings the page saves are the settings its next load uses", async () => {
	await withRepo(async (board, folder) => {
		await withRemote(folder, async () => {
			const before = await one(board, { command: "loadBranches", repo: folder, showRemoteBranches: true, hiddenRemotes: [] });
			assert.ok((before.branches as string[]).includes("origin/dev"), "the remote branch is listed while no remote is hidden");

			// `changeSettings()` sends the whole repository state back, with the one field it changed.
			const listed = await one(board, { command: "loadRepos", check: true });
			const state = { ...(listed.repos as Record<string, Record<string, unknown>>)[folder], hiddenRemotes: ["origin"], columnWidths: [96, 145, 128, 84, 82] };
			assert.deepEqual(await dispatch.respond(board, { command: "saveRepoState", repo: folder, state }), []);

			const saved = await one(board, { command: "loadRepos", check: true });
			const kept = (saved.repos as Record<string, Record<string, unknown>>)[folder];
			assert.deepEqual(kept.hiddenRemotes, ["origin"]);
			assert.deepEqual(kept.columnWidths, [96, 145, 128, 84, 82], "the column widths the page saved come back");
			assert.equal(kept.displayName, folder.split("/").at(-1), "the dropdown still has a name to show");

			const after = await one(board, { command: "loadBranches", repo: folder, showRemoteBranches: true, hiddenRemotes: kept.hiddenRemotes });
			assert.ok(!(after.branches as string[]).includes("origin/dev"), "a hidden remote is hidden from the branch list too");
			const commits = await one(board, { command: "loadCommits", repo: folder, showRemoteBranches: true, hiddenRemotes: kept.hiddenRemotes, showTags: true, branchName: "", maxCommits: 50 });
			const names = (commits.commits as Array<{ refs: Array<{ name: string }> }>).flatMap(({ refs }) => refs.map(({ name }) => name));
			assert.ok(!names.includes("origin/dev"), "and from the pills beside the commits");
		});
	});
});

test("a change the daemon marks untracked is drawn as the file it adds", async () => {
	// The details panel decides from `untracked` whether a change has a diff at all, and the view diff
	// command draws an untracked file only when it is told the change is untracked (type `U`). Sending
	// the letter `A` with a revision of `*^`/`*^3` names nothing git can read on the uncommitted row.
	await withRepo(async (board, folder) => {
		writeFileSync(join(folder, "brand-new.txt"), "untracked body\n");
		const details = await one(board, { command: "commitDetails", repo: folder, commitHash: "*" });
		const changes = (details.commitDetails as { fileChanges: Array<{ newFilePath: string; type: string; untracked?: true }> }).fileChanges;
		const added = changes.find(({ newFilePath }) => newFilePath === "brand-new.txt");
		assert.ok(added, "the uncommitted row lists the untracked file");
		assert.equal(added.type, "A");
		assert.equal(added.untracked, true);

		const drawn = await one(board, { command: "viewDiff", repo: folder, commitHash: "*", oldFilePath: "", newFilePath: "brand-new.txt", type: "U" });
		assert.equal(drawn.success, true);
		const view = drawn.view as { kind: string; content: string; binary: boolean };
		assert.equal(view.kind, "diff");
		assert.match(view.content, /^diff --git a\/brand-new\.txt b\/brand-new\.txt/m);
		assert.match(view.content, /^\+untracked body$/m);
	});
});

test("a remote branch the local one already has is fast-forwarded by the menu's own request", async () => {
	// `checkoutRef` sends these two fields when the human picks "Switch and fast-forward".
	await withRepo(async (board, folder) => {
		await withRemote(folder, async () => {
			git(folder, "checkout", "-q", "-b", "feat/side");
			commitFile(folder, "side.txt", "side work");
			git(folder, "push", "-q", "-u", "origin", "feat/side");
			git(folder, "checkout", "-q", "dev");
			git(folder, "branch", "-f", "feat/side", "dev");
			git(folder, "fetch", "-q", "origin");
			const behind = git(folder, "rev-parse", "feat/side");
			const answer = await one(board, { command: "checkoutAndFastForward", repo: folder, branchName: "feat/side", target: "origin/feat/side" });
			assert.equal(answer.status, null);
			assert.equal(git(folder, "rev-parse", "--abbrev-ref", "HEAD"), "feat/side");
			assert.notEqual(git(folder, "rev-parse", "HEAD"), behind, "the branch was carried onto the remote's commit");
		});
	});
});

test("a staged file is unstaged and staged again by the path the details panel sends", async () => {
	await withRepo(async (board, folder) => {
		writeFileSync(join(folder, "readme.md"), "changed\n");
		const staged = await one(board, { command: "stageFiles", repo: folder, filePaths: ["readme.md"] });
		assert.equal(staged.status, null);
		assert.deepEqual((await one(board, { command: "uncommittedDetails", repo: folder })).changes instanceof Object, true);
		assert.equal(git(folder, "diff", "--cached", "--name-only"), "readme.md");
		const unstaged = await one(board, { command: "unstageFiles", repo: folder, filePaths: ["readme.md"] });
		assert.equal(unstaged.status, null);
		assert.equal(git(folder, "diff", "--cached", "--name-only"), "");
		assert.equal(git(folder, "diff", "--name-only"), "readme.md", "unstaging leaves the change in the working tree");
	});
});
