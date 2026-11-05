import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

// The transcript a removal deletes is the one `sessionFile` names, and that folder is resolved once, when
// the modules below load. A throwaway state folder is set first, so the test never touches a real board.
process.env.PI_STUDIO_STATE = mkdtempSync(join(tmpdir(), "pi-studio-trash-state-"));

const { onFragmentRemove, onFragments, onRemove, onRemovePreview } = await import("../server/routes/board/lifecycle.ts");
const { PREVIEW_IGNORED_FILES } = await import("../server/worktrees/fragments.ts");
const { discardBranch } = await import("../server/worktrees/retire.ts");
const { ensureWorktree } = await import("../server/worktrees/make.ts");
const { sessionFile } = await import("../server/session.ts");

const git = (folder: string, ...args: string[]) =>
	execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A throwaway repository with one commit on `dev`. Never the human's. */
function scratchRepo() {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-trash-"));
	git(folder, "init", "-b", "dev");
	git(folder, "config", "user.email", "test@example.invalid");
	git(folder, "config", "user.name", "test");
	writeFileSync(join(folder, "readme.md"), "hello\n");
	git(folder, "add", ".");
	git(folder, "commit", "-m", "first");
	return folder;
}

/** A board no file backs, so nothing a route writes has a place to land. */
function scratchBoard(repo: string) {
	return {
		id: "scratch",
		folder: repo,
		name: "scratch",
		children: new Map(),
		threads: new Map(),
		cards: new Map(),
		activity: [] as any[],
		askers: new Map(),
		trees: [] as any[],
		trash: [] as any[],
		saveTimer: null as any,
		clients: new Set(),
	};
}

/** A response a route can answer on, holding what it said so a test can read the status back. */
function scratchRes() {
	const res: { status: number; body: string; writeHead: (status: number) => void; end: (body: string) => void } = {
		status: 0,
		body: "",
		writeHead(status) {
			res.status = status;
		},
		end(body) {
			res.body = body;
		},
	};
	return res;
}

const jsonRequest = (body: unknown) => Readable.from([Buffer.from(JSON.stringify(body))]);

const answered = (res: { body: string }) => JSON.parse(res.body);

/** The save a route schedules is dropped: this board is a literal, not a folder of JSON. */
function unschedule(board: { saveTimer: any }) {
	if (board.saveTimer) clearTimeout(board.saveTimer);
	board.saveTimer = null;
}

/**
 * A thread with a tree of its own, a branch it committed on, and the transcript pi would have written for
 * it. The branch carries the thread's own eight hex, which is what tells a thread's branch from a human's.
 */
function startThread(board: any, id: string, branch: string) {
	const thread: any = { id, title: `a thread ${id}`, folder: board.folder, at: Date.now(), turns: [], status: "idle", sessionId: `sess-${id}` };
	const tree = ensureWorktree(board, thread);
	assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
	git(tree.path, "checkout", "-b", branch);
	writeFileSync(join(tree.path, `${id}.md`), `${id}\n`);
	git(tree.path, "add", ".");
	git(tree.path, "commit", "-m", `${id} work`);
	tree.branch = branch;
	board.threads.set(thread.id, thread);
	const dir = join(process.env.PI_STUDIO_STATE as string, "sessions", board.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `1700000000000_${thread.sessionId}.jsonl`), `${JSON.stringify({ type: "message" })}\n`);
	unschedule(board);
	return { thread, tree };
}

/** Whether the repository still holds this branch, by full name rather than by what `git branch` draws. */
function hasBranch(repo: string, name: string) {
	return git(repo, "for-each-ref", "refs/heads", "--format=%(refname:short)")
		.split("\n")
		.includes(name);
}

test("a thread goes in one order: the child, the card, the session, the tree, the branch", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "aaaa1111", "feat/aaaa-work-aaaa1111");
		const file = sessionFile({ id: board.id }, thread.sessionId);
		assert.ok(file && existsSync(file), "the transcript was never written");
		const res = scratchRes();
		await onRemove(jsonRequest({ card: thread.id }), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(
			said.steps.map((step: any) => step.what),
			["child", "card", "session", "tree", "branch"],
		);
		assert.ok(
			said.steps.every((step: any) => step.ok),
			said.steps.map((step: any) => `${step.what}: ${step.note}`).join("; "),
		);
		assert.equal(said.note, null);
		assert.equal(board.threads.has(thread.id), false, "the thread is still on the board");
		assert.equal(board.trees.length, 0, "the board kept the record of a tree it removed");
		assert.equal(board.trash.length, 0, "the removal is undoable");
		assert.equal(existsSync(tree.path), false, "the folder is still on disk");
		assert.equal(existsSync(file), false, "the transcript outlived the thread");
		assert.equal(sessionFile({ id: board.id }, thread.sessionId), "");
		assert.equal(hasBranch(repo, "feat/aaaa-work-aaaa1111"), false, "the branch outlived the folder");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a dirty room and an unmerged branch are both deleted, because the human asked", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "bbbb2222", "feat/bbbb-work-bbbb2222");
		// Untracked work keeps a sweep away from this tree; a removal takes it anyway.
		writeFileSync(join(tree.path, "uncommitted.md"), "not staged\n");
		const res = scratchRes();
		await onRemove(jsonRequest({ card: thread.id }), res, board);
		assert.equal(res.status, 200, res.body);
		assert.equal(answered(res).branch, "feat/bbbb-work-bbbb2222");
		assert.equal(existsSync(tree.path), false, "the dirty folder is still on disk");
		assert.equal(hasBranch(repo, "feat/bbbb-work-bbbb2222"), false, "the unmerged branch outlived the folder");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("the preview shows the branch, the folder and the work, and the diff of what is uncommitted", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "cccc3333", "feat/cccc-work-cccc3333");
		writeFileSync(join(tree.path, "readme.md"), "changed\n");
		const res = scratchRes();
		await onRemovePreview(jsonRequest({ card: thread.id }), res, board);
		assert.equal(res.status, 200, res.body);
		const seen = answered(res);
		assert.equal(seen.thread.id, thread.id);
		assert.equal(seen.branch, "feat/cccc-work-cccc3333");
		assert.equal(seen.base, tree.base);
		assert.equal(seen.path, tree.path);
		assert.equal(seen.dirty, 1);
		assert.equal(seen.commits, 1);
		assert.match(seen.diff, /readme\.md/);
		assert.equal(seen.trunc, false);
		assert.equal(seen.note, null);
		// Nothing was touched by asking.
		assert.ok(existsSync(tree.path), "the preview removed the folder it was asked about");
		assert.equal(board.threads.has(thread.id), true);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a folder holding one new file names it, because git has no diff to draw for it", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "1111aaaa", "feat/1111-work-1111aaaa");
		// One file git has never seen: `status` counts it, `git diff HEAD` cannot show it.
		writeFileSync(join(tree.path, "fresh.md"), "never added\n");
		const res = scratchRes();
		await onRemovePreview(jsonRequest({ card: thread.id }), res, board);
		assert.equal(res.status, 200, res.body);
		const seen = answered(res);
		assert.equal(seen.dirty, 1);
		assert.equal(seen.diff, "", "git drew a diff for a file it has never seen");
		assert.equal(seen.note, null);
		assert.deepEqual(seen.new, ["fresh.md"], "the sheet is left with a count and nothing to draw");
		assert.equal(seen.ignored, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a new file whose name holds a space or a letter outside ascii arrives as it is on disk", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "9999cccc", "fix/9999-work-9999cccc");
		// `git status` quotes a name with a space in it and escapes one outside ascii, and the sheet draws
		// what it is given: a quoted name is a file the human cannot find.
		writeFileSync(join(tree.path, "my file.md"), "a space in the name\n");
		writeFileSync(join(tree.path, "naïve.md"), "a letter outside ascii\n");
		const res = scratchRes();
		await onRemovePreview(jsonRequest({ card: thread.id }), res, board);
		assert.equal(res.status, 200, res.body);
		const seen = answered(res);
		assert.deepEqual([...seen.new].sort(), ["my file.md", "naïve.md"].sort(), "git handed the sheet its own quoting");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a preview counts the ignored files the forced removal takes with the folder", async () => {
	const repo = scratchRepo();
	try {
		// The rule lives in the repository's own exclude file, so the ignore is nobody's uncommitted change.
		writeFileSync(join(repo, ".git", "info", "exclude"), "*.log\n");
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "2222aaaa", "feat/2222-work-2222aaaa");
		writeFileSync(join(tree.path, "installed.log"), "a dependency nobody wants to see\n");
		// A name git would quote in its line form, because the sheet draws what it is handed.
		writeFileSync(join(tree.path, "my cache.log"), "a space in the name\n");
		const res = scratchRes();
		await onRemovePreview(jsonRequest({ card: thread.id }), res, board);
		assert.equal(res.status, 200, res.body);
		const seen = answered(res);
		assert.equal(seen.dirty, 0, "an ignored file is not an uncommitted change");
		assert.deepEqual(seen.new, []);
		assert.equal(seen.ignored, 2, "the folder says it holds nothing while git is about to drop a file");
		assert.deepEqual([...seen.ignoredNames].sort(), ["installed.log", "my cache.log"], "the sheet cannot name what it drops");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a folder holding more ignored files than the sheet names arrives as a count alone", async () => {
	const repo = scratchRepo();
	try {
		writeFileSync(join(repo, ".git", "info", "exclude"), "*.log\n");
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "3333bbbb", "feat/3333-work-3333bbbb");
		for (let at = 0; at <= PREVIEW_IGNORED_FILES; at += 1) writeFileSync(join(tree.path, `dep-${at}.log`), "x\n");
		const res = scratchRes();
		await onRemovePreview(jsonRequest({ card: thread.id }), res, board);
		assert.equal(res.status, 200, res.body);
		const seen = answered(res);
		assert.equal(seen.ignored, PREVIEW_IGNORED_FILES + 1);
		assert.deepEqual(seen.ignoredNames, [], "a list past the page is a list the sheet cannot draw");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a card the board never had is refused, and so is one with no thread behind it", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		for (const ask of [onRemove, onRemovePreview]) {
			const res = scratchRes();
			await ask(jsonRequest({ card: "no-such-card" }), res, board);
			assert.equal(res.status, 404);
			assert.equal(res.body, "no such card");
		}
		board.cards.set("note-1", { id: "note-1", type: "note", title: "a note", at: Date.now() });
		const res = scratchRes();
		await onRemove(jsonRequest({ card: "note-1" }), res, board);
		assert.equal(res.status, 404);
		assert.equal(res.body, "no thread answers this card");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("the fragments are a remembered room, a forgotten folder and a stranded branch", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		// A record the board kept for a thread it no longer has, with a commit nobody merged.
		const { thread, tree } = startThread(board, "dddd4444", "feat/dddd-work-dddd4444");
		board.threads.delete(thread.id);
		// A folder git has as a worktree and the board never recorded.
		const orphan = join(repo, ".agents", "eeee5555");
		git(repo, "worktree", "add", "--detach", orphan, "dev");
		git(orphan, "checkout", "-b", "fix/eeee-work-eeee5555");
		// Work in it nobody has committed, which the row has to say before it offers to clear the folder.
		writeFileSync(join(orphan, "forgotten.md"), "nobody merged this\n");
		// A branch with no thread left to hold it, and no folder either.
		git(repo, "branch", "test/ffff-work-ffff6666", "dev");

		const res = scratchRes();
		await onFragments(jsonRequest({}), res, board);
		assert.equal(res.status, 200, res.body);
		const items = answered(res).items;
		const kept = items.find((item: any) => item.kind === "tree");
		assert.equal(kept.path, tree.path);
		assert.equal(kept.label, "feat/dddd-work-dddd4444");
		assert.match(kept.note, /1 commit that is not in/);
		const lost = items.find((item: any) => item.kind === "orphan");
		assert.equal(lost.path, orphan);
		assert.equal(lost.branch, "fix/eeee-work-eeee5555");
		assert.match(lost.note, /1 uncommitted change/, "a folder holding work is offered with no warning");
		assert.equal(lost.work, true);
		const stranded = items.find((item: any) => item.kind === "branch");
		assert.equal(stranded.label, "test/ffff-work-ffff6666");
		assert.equal(stranded.path, null);
		// A branch still on its base holds nothing, so the sheet files it under what holds nothing.
		assert.equal(stranded.work, false);
		// A folder on the list carries its branch, so the name is never offered twice.
		assert.equal(items.filter((item: any) => item.branch === "fix/eeee-work-eeee5555").length, 1);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a forgotten folder holding one unmerged commit says it holds that commit", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const orphan = join(repo, ".agents", "abcd7777");
		git(repo, "worktree", "add", "--detach", orphan, "dev");
		writeFileSync(join(orphan, "forgotten.md"), "one commit nobody merged\n");
		git(orphan, "add", ".");
		git(orphan, "commit", "-m", "nobody merged this");
		const res = scratchRes();
		await onFragments(jsonRequest({}), res, board);
		const lost = answered(res).items.find((item: any) => item.path === orphan);
		assert.ok(lost, "the forgotten folder is not on the list at all");
		assert.equal(lost.work, true, "a folder holding an unmerged commit is filed under what holds nothing");
		assert.match(lost.note, /1 commit that is not in dev/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a remembered room goes with its record, its folder and its branch", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "77778888", "fix/7777-work-77778888");
		board.threads.delete(thread.id);
		const res = scratchRes();
		await onFragmentRemove(jsonRequest({ kind: "tree", path: tree.path, branch: tree.branch }), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(
			said.steps.map((step: any) => step.what),
			["tree", "branch"],
		);
		assert.ok(said.steps.every((step: any) => step.ok), JSON.stringify(said.steps));
		assert.equal(existsSync(tree.path), false, "the folder is still on disk");
		assert.equal(hasBranch(repo, "fix/7777-work-77778888"), false, "the branch outlived the folder");
		assert.equal(board.trees.length, 0, "the board kept the record of the tree it removed");
		const left = scratchRes();
		await onFragments(jsonRequest({}), left, board);
		assert.deepEqual(answered(left).items, []);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
test("a branch of the type a title with no keyword is given is a leftover like any other", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		// `feat` is what `workType` answers for a title with no keyword of its own, so it is a type a
		// thread's branches really carry and one the list has to know.
		git(repo, "branch", "feat/aaaa-aaaa1111", "dev");
		const listed = scratchRes();
		await onFragments(jsonRequest({}), listed, board);
		const items = answered(listed).items;
		const stranded = items.find((item: any) => item.label === "feat/aaaa-aaaa1111");
		assert.ok(stranded, `the list does not see it: ${items.map((item: any) => item.label).join(", ")}`);
		assert.equal(stranded.kind, "branch");
		const res = scratchRes();
		await onFragmentRemove(jsonRequest({ kind: "branch", branch: "feat/aaaa-aaaa1111", path: null }), res, board);
		assert.equal(res.status, 200, res.body);
		assert.ok(answered(res).steps.every((step: any) => step.ok), JSON.stringify(answered(res).steps));
		assert.equal(hasBranch(repo, "feat/aaaa-aaaa1111"), false, "the branch outlived the press that cleared it");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a thread `ctrl+z` still restores is not offered as a leftover", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "3333aaaa", "feat/3333-work-3333aaaa");
		// A close takes the thread off the board and keeps it whole for `ctrl+z`, folder and branch with it.
		board.threads.delete(thread.id);
		board.trash.push({ at: Date.now(), kind: "thread", thread });
		const res = scratchRes();
		await onFragments(jsonRequest({}), res, board);
		assert.deepEqual(answered(res).items, [], "the list offers to destroy what the undo has promised back");
		assert.ok(existsSync(tree.path), "the preview touched a folder the trash still holds");
		assert.equal(hasBranch(repo, "feat/3333-work-3333aaaa"), true);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});


test("a thread `ctrl+z` still restores keeps its branch when its folder and registration are gone", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "4444bbbb", "feat/4444-work-4444bbbb");
		// The folder and its registration go, and the record never learned the branch: the shape a child
		// that cut its own branch leaves behind when its folder is taken away under it.
		git(repo, "worktree", "remove", "--force", tree.path);
		delete tree.branch;
		// The close keeps the thread whole for `ctrl+z`, and its branch is the one thing still on disk.
		board.threads.delete(thread.id);
		board.trash.push({ at: Date.now(), kind: "thread", thread });
		const res = scratchRes();
		await onFragments(jsonRequest({}), res, board);
		assert.equal(
			answered(res).items.some((item: any) => item.branch === "feat/4444-work-4444bbbb"),
			false,
			"the list offers to break the undo it has promised",
		);
		assert.equal(hasBranch(repo, "feat/4444-work-4444bbbb"), true);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});


test("a trunk is never on the list and is never deleted", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const res = scratchRes();
		await onFragments(jsonRequest({}), res, board);
		assert.deepEqual(answered(res).items, [], "a repository with nothing left behind listed a fragment");
		const refused = discardBranch(repo, "dev");
		assert.equal(refused.ok, false);
		assert.match(refused.note, /standing on dev/);
		assert.equal(hasBranch(repo, "dev"), true, "the trunk was deleted");
		// Nor is the name reachable over the wire: it is not an item, so the route refuses it.
		const gone = scratchRes();
		await onFragmentRemove(jsonRequest({ kind: "branch", branch: "dev" }), gone, board);
		assert.equal(gone.status, 404);
		assert.equal(hasBranch(repo, "dev"), true, "the trunk was deleted through the route");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a folder git will not remove keeps its branch, on the trash and on the leftovers press", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const { thread, tree } = startThread(board, "5555aaaa", "feat/5555-work-5555aaaa");
		// Forced honestly: a locked worktree is one git refuses to remove with the single `--force` that
		// `discardTree` runs (it wants `-f -f`), so the folder step fails without pretending anything
		// about permissions or about the disk.
		git(repo, "worktree", "lock", "--reason", "held by the test", tree.path);
		const res = scratchRes();
		await onRemove(jsonRequest({ card: thread.id }), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.equal(said.steps.find((step: any) => step.what === "tree").ok, false, JSON.stringify(said.steps));
		assert.equal(
			said.steps.some((step: any) => step.what === "branch"),
			false,
			"the branch was asked for after its folder would not go",
		);
		assert.equal(hasBranch(repo, "feat/5555-work-5555aaaa"), true, "the branch went under a folder that stayed");
		assert.ok(existsSync(tree.path), "the folder went after all");
		assert.match(said.note, /locked/);

		// The leftovers press takes the same route, and the folder that would not go is still on its list.
		const listed = scratchRes();
		await onFragments(jsonRequest({}), listed, board);
		const item = answered(listed).items.find((candidate: any) => candidate.kind === "tree");
		assert.ok(item, "the folder that would not go is not on the leftovers list");
		const again = scratchRes();
		await onFragmentRemove(jsonRequest({ kind: "tree", path: item.path, branch: item.branch }), again, board);
		const cleared = answered(again);
		assert.equal(cleared.steps.find((step: any) => step.what === "tree").ok, false, JSON.stringify(cleared.steps));
		assert.equal(
			cleared.steps.some((step: any) => step.what === "branch"),
			false,
			"the leftovers press asked for the branch after its folder would not go",
		);
		assert.equal(hasBranch(repo, "feat/5555-work-5555aaaa"), true, "the leftovers press deleted the branch anyway");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});


test("removing one fragment clears that one and leaves the rest", async () => {
	const repo = scratchRepo();
	try {
		const board = scratchBoard(repo);
		const orphan = join(repo, ".agents", "12345678");
		git(repo, "worktree", "add", "--detach", orphan, "dev");
		git(orphan, "checkout", "-b", "chore/1234-work-12345678");
		git(repo, "branch", "docs/9999-work-99999999", "dev");
		const listed = scratchRes();
		await onFragments(jsonRequest({}), listed, board);
		assert.equal(answered(listed).items.length, 2, answered(listed).items.map((item: any) => item.label).join(", "));

		const res = scratchRes();
		await onFragmentRemove(jsonRequest({ kind: "orphan", path: orphan, branch: "chore/1234-work-12345678" }), res, board);
		assert.equal(res.status, 200, res.body);
		const said = answered(res);
		assert.deepEqual(
			said.steps.map((step: any) => step.what),
			["tree", "branch"],
		);
		assert.ok(said.steps.every((step: any) => step.ok), JSON.stringify(said.steps));
		assert.equal(said.note, null);
		assert.equal(existsSync(orphan), false, "the folder is still on disk");
		assert.equal(hasBranch(repo, "chore/1234-work-12345678"), false, "the folder's branch outlived it");

		const left = scratchRes();
		await onFragments(jsonRequest({}), left, board);
		assert.deepEqual(
			answered(left).items.map((item: any) => item.branch),
			["docs/9999-work-99999999"],
		);
		// The item is gone from the list, so asking for it again is refused rather than guessed at.
		const stale = scratchRes();
		await onFragmentRemove(jsonRequest({ kind: "orphan", path: orphan }), stale, board);
		assert.equal(stale.status, 404);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
