import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cheapestModel, cleanPaths, sourceControlCommit, sourceControlConflict, sourceControlContinue, sourceControlMessage, sourceControlResolve, sourceControlStage, sourceControlStatus } from "../server/git/source-control.ts";
import { git, scratchRepo } from "../test-support/git.ts";

/**
 * The source control drawer's backend, against throwaway repositories.
 *
 * The draft is never called for real here: the pi run is handed in as a stub, so the test proves the
 * shape of the question and the reading of the answer without spending a model call on it.
 */

type Status = { branch: string; detached: boolean; staged: { path: string; kind: string }[]; changes: { path: string; kind: string }[]; conflicts: { path: string; stages: { base: string | null; ours: string | null; theirs: string | null } }[]; operation: string | null; merge: { id: string; message: string } | null };

async function statusOf(folder: string): Promise<Status> {
	const outcome = await sourceControlStatus(folder);
	assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
	return (outcome as { ok: true; status: Status }).status;
}

test("a changed, a staged and a new file land in their own lists", async () => {
	const repo = scratchRepo();
	try {
		writeFileSync(join(repo, "readme.md"), "changed\n");
		writeFileSync(join(repo, "new.txt"), "new\n");
		const status = await statusOf(repo);
		assert.equal(status.branch, "dev");
		assert.equal(status.detached, false);
		assert.deepEqual(status.staged, []);
		assert.deepEqual(status.changes.map((f) => f.path).sort(), ["new.txt", "readme.md"]);
		assert.equal(status.changes.find((f) => f.path === "new.txt")?.kind, "U");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("staging moves a file across, unstaging moves it back, and the commit clears the lists", async () => {
	const repo = scratchRepo();
	try {
		writeFileSync(join(repo, "readme.md"), "changed\n");
		const staged = await sourceControlStage(repo, ["readme.md"], true);
		assert.equal(staged.ok, true);
		let status = await statusOf(repo);
		assert.deepEqual(status.staged.map((f) => f.path), ["readme.md"]);
		assert.deepEqual(status.changes, []);

		const unstaged = await sourceControlStage(repo, ["readme.md"], false);
		assert.equal(unstaged.ok, true);
		status = await statusOf(repo);
		assert.deepEqual(status.staged, []);
		assert.deepEqual(status.changes.map((f) => f.path), ["readme.md"]);

		await sourceControlStage(repo, ["readme.md"], true);
		const committed = await sourceControlCommit(repo, "docs: change the readme");
		assert.equal(committed.ok, true);
		assert.equal(git(repo, "log", "--format=%s", "-1"), "docs: change the readme");
		status = await statusOf(repo);
		assert.deepEqual(status.staged, []);
		assert.deepEqual(status.changes, []);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("an empty message, nothing staged, and a path outside the repository are refusals with reasons", async () => {
	const repo = scratchRepo();
	try {
		const empty = await sourceControlCommit(repo, "   ");
		assert.equal(empty.ok, false);
		assert.match(!empty.ok ? empty.error : "", /message/);

		const nothing = await sourceControlCommit(repo, "feat: nothing staged");
		assert.equal(nothing.ok, false);
		assert.match(!nothing.ok ? nothing.error : "", /nothing is staged/);

		const outside = await sourceControlStage(repo, ["../outside.txt"], true);
		assert.equal(outside.ok, false);
		assert.match(!outside.ok ? outside.error : "", /not a file/);

		const dash = cleanPaths(["-x"]);
		assert.equal(dash.ok, true, "a dashed name is still a file name");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a folder that is not a repository says so", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-notrepo-"));
	try {
		const outcome = await sourceControlStatus(folder);
		assert.equal(outcome.ok, false);
		assert.match(!outcome.ok ? outcome.error : "", /not a git repository/);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("the cheapest model is the lite one, whatever order the list arrives in", () => {
	const models = [
		{ provider: "google", model: "gemini-2.5-pro" },
		{ provider: "github-copilot", model: "gpt-6.1-sol" },
		{ provider: "deepseek", model: "deepseek-v4-pro" },
		{ provider: "google", model: "gemini-2.5-flash-lite" },
		{ provider: "huggingface", model: "MiniMaxAI/MiniMax-M3.1-Flash" },
	];
	assert.deepEqual(cheapestModel(models), { provider: "google", model: "gemini-2.5-flash-lite" });
	assert.deepEqual(cheapestModel([...models].reverse()), { provider: "google", model: "gemini-2.5-flash-lite" });
	assert.equal(cheapestModel([]), null);
	assert.equal(cheapestModel([{ provider: "google", model: "gemini-3-pro-preview" }]), null, "a preview is never the draft model");
});

test("a draft is one line, and a model that answers nothing is a refusal, not a message", async () => {
	const repo = scratchRepo();
	try {
		writeFileSync(join(repo, "readme.md"), "changed\n");
		await sourceControlStage(repo, ["readme.md"], true);

		let asked = "";
		const catalog = async () => ({ models: [{ provider: "google", model: "gemini-2.5-flash-lite" }] });
		const drafted = await sourceControlMessage(repo, {
			catalog,
			run: async (_cli: unknown, _folder: string, _model: unknown, prompt: string) => {
				asked = prompt;
				return "```\ndocs(readme): refresh the hello line\nsecond thoughts\n```\n";
			},
		});
		assert.equal(drafted.ok, true, drafted.ok ? "" : drafted.error);
		assert.equal(drafted.ok && drafted.message, "docs(readme): refresh the hello line");
		assert.match(asked, /readme\.md/);

		const silent = await sourceControlMessage(repo, { catalog, run: async () => "   \n" });
		assert.equal(silent.ok, false);
		assert.match(!silent.ok ? silent.error : "", /no message/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a draft with nothing staged asks nobody", async () => {
	const repo = scratchRepo();
	try {
		let called = false;
		const outcome = await sourceControlMessage(repo, {
			catalog: async () => ({ models: [{ provider: "google", model: "gemini-2.5-flash-lite" }] }),
			run: async () => {
				called = true;
				return "feat: never asked";
			},
		});
		assert.equal(outcome.ok, false);
		assert.match(!outcome.ok ? outcome.error : "", /nothing is staged/);
		assert.equal(called, false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a renamed file is listed by the name it has now, once", async () => {
	const repo = scratchRepo();
	try {
		git(repo, "mv", "readme.md", "renamed.md");
		const status = await statusOf(repo);
		assert.deepEqual(status.staged.map((f) => f.path), ["renamed.md"]);
		assert.deepEqual(status.changes, []);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("unstaging works before the first commit, and a glob-named file stages only itself", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-unborn-"));
	try {
		git(folder, "init", "-b", "main");
		git(folder, "config", "user.email", "test@example.invalid");
		git(folder, "config", "user.name", "test");
		writeFileSync(join(folder, "a.txt"), "a\n");
		writeFileSync(join(folder, "*.txt"), "literal\n");
		writeFileSync(join(folder, "b.txt"), "b\n");
		const staged = await sourceControlStage(folder, ["*.txt"], true);
		assert.equal(staged.ok, true);
		let status = await statusOf(folder);
		assert.deepEqual(status.staged.map((f) => f.path), ["*.txt"]);
		const unstaged = await sourceControlStage(folder, ["*.txt"], false);
		assert.equal(unstaged.ok, true, unstaged.ok ? "" : unstaged.error);
		status = await statusOf(folder);
		assert.deepEqual(status.staged, []);
		assert.equal(status.changes.length, 3);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

/** A repository mid-merge: both sides changed the same line, so git left a conflict. */
async function conflictedRepo(): Promise<{ repo: string; cleanup: () => void }> {
	const repo = scratchRepo();
	git(repo, "checkout", "-q", "-b", "side");
	writeFileSync(join(repo, "readme.md"), "side\n");
	git(repo, "commit", "-qam", "side change");
	git(repo, "checkout", "-q", "dev");
	writeFileSync(join(repo, "readme.md"), "main\n");
	git(repo, "commit", "-qam", "main change");
	try {
		git(repo, "merge", "side");
	} catch {
		// A conflicted merge exits non-zero; the conflict is what the test is about.
	}
	return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

test("a conflicted merge is listed once, out of both ordinary lists", async () => {
	const { repo, cleanup } = await conflictedRepo();
	try {
		const status = await statusOf(repo);
		assert.equal(status.operation, "merge");
		assert.ok(status.merge?.message.includes("Merge branch 'side'"), status.merge?.message ?? "no merge message");
		assert.deepEqual(status.conflicts.map((c) => c.path), ["readme.md"]);
		assert.ok(status.conflicts[0].stages.base && status.conflicts[0].stages.ours && status.conflicts[0].stages.theirs);
		assert.deepEqual(status.staged, []);
		assert.deepEqual(status.changes, []);
	} finally {
		cleanup();
	}
});

test("a conflicted file cannot be staged by the ordinary press, and a plain commit is refused", async () => {
	const { repo, cleanup } = await conflictedRepo();
	try {
		const staged = await sourceControlStage(repo, ["readme.md"], true);
		assert.equal(staged.ok, false);
		assert.match(!staged.ok ? staged.error : "", /merge editor/);
		const committed = await sourceControlCommit(repo, "feat: nope");
		assert.equal(committed.ok, false);
		assert.match(!committed.ok ? committed.error : "", /Continue/);
	} finally {
		cleanup();
	}
});

test("resolving a conflict stages exactly it, and Continue makes a two-parent commit", async () => {
	const { repo, cleanup } = await conflictedRepo();
	try {
		const read = await sourceControlConflict(repo, "readme.md");
		assert.equal(read.ok, true, read.ok ? "" : read.error);
		const text = read.ok ? read.content : "";
		assert.match(text, /<<<<<<< HEAD/);
		assert.match(text, />>>>>>> side/);

		const resolved = await sourceControlResolve(repo, { path: "readme.md", mergeId: read.ok ? read.mergeId : "", version: read.ok ? read.version : "", content: "main\nside\n" });
		assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
		let status = await statusOf(repo);
		assert.deepEqual(status.conflicts, []);
		assert.deepEqual(status.staged.map((f) => f.path), ["readme.md"]);

		const continued = await sourceControlContinue(repo, { message: "Merge branch 'side' into dev" });
		assert.equal(continued.ok, true, continued.ok ? "" : continued.error);
		assert.equal(git(repo, "log", "--format=%s", "-1"), "Merge branch 'side' into dev");
		const parents = git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length - 1;
		assert.equal(parents, 2, "the merge commit has two parents");
		status = await statusOf(repo);
		assert.equal(status.operation, null);
	} finally {
		cleanup();
	}
});

test("Continue refuses while a conflict remains, and a stale editor cannot overwrite", async () => {
	const { repo, cleanup } = await conflictedRepo();
	try {
		const early = await sourceControlContinue(repo, { message: "Merge branch 'side' into dev" });
		assert.equal(early.ok, false);
		assert.match(!early.ok ? early.error : "", /conflicts remain/);

		const read = await sourceControlConflict(repo, "readme.md");
		assert.equal(read.ok, true);
		writeFileSync(join(repo, "readme.md"), "changed elsewhere\n");
		const stale = await sourceControlResolve(repo, { path: "readme.md", mergeId: read.ok ? read.mergeId : "", version: read.ok ? read.version : "", content: "resolved\n" });
		assert.equal(stale.ok, false);
		assert.match(!stale.ok ? stale.error : "", /changed on disk/);
	} finally {
		cleanup();
	}
});
