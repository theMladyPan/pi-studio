import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cheapestModel, cleanPaths, sourceControlCommit, sourceControlMessage, sourceControlStage, sourceControlStatus } from "../server/git/source-control.ts";
import { git, scratchRepo } from "../test-support/git.ts";

/**
 * The source control drawer's backend, against throwaway repositories.
 *
 * The draft is never called for real here: the pi run is handed in as a stub, so the test proves the
 * shape of the question and the reading of the answer without spending a model call on it.
 */

type Status = { branch: string; detached: boolean; staged: { path: string; kind: string }[]; changes: { path: string; kind: string }[] };

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
		const drafted = await sourceControlMessage(repo, async (_cli: unknown, _folder: string, _model: unknown, prompt: string) => {
			asked = prompt;
			return "```\ndocs(readme): refresh the hello line\nsecond thoughts\n```\n";
		});
		assert.equal(drafted.ok, true, drafted.ok ? "" : drafted.error);
		assert.equal(drafted.ok && drafted.message, "docs(readme): refresh the hello line");
		assert.match(asked, /readme\.md/);

		const silent = await sourceControlMessage(repo, async () => "   \n");
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
		const outcome = await sourceControlMessage(repo, async () => {
			called = true;
			return "feat: never asked";
		});
		assert.equal(outcome.ok, false);
		assert.match(!outcome.ok ? outcome.error : "", /nothing is staged/);
		assert.equal(called, false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
