import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_TEXT_BYTES, diffText, openFile, untrackedDiff, viewDiff, viewDiffWithWorkingFile, viewFileAtRevision } from "../server/git/gitgraph/view.ts";
import { UNCOMMITTED } from "../server/git/gitgraph/protocol.ts";
import { git, scratchRepo } from "../test-support/git.ts";

/** A repository with two commits, an untracked file and two files that cannot be drawn. */
function repoForViews() {
	const repo = scratchRepo();
	writeFileSync(join(repo, "readme.md"), "hello\nand another line\n");
	git(repo, "add", "readme.md");
	git(repo, "commit", "-m", "second");
	writeFileSync(join(repo, "never-added.txt"), "never added\n");
	writeFileSync(join(repo, "picture.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
	writeFileSync(join(repo, "long.txt"), `${"x".repeat(1023)}\n`.repeat(2100));
	symlinkSync("/etc/hostname", join(repo, "outside-link"));
	return repo;
}

/** Every test cleans its own repository up. */
function withRepo(work: (repo: string) => Promise<void>) {
	return async () => {
		const repo = repoForViews();
		try {
			await work(repo);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	};
}

/** A diff's text, or the reason there is none, as one value a test can assert on. */
async function textOf(result: Awaited<ReturnType<typeof diffText>>): Promise<string> {
	assert.ok(result.ok, result.ok ? "" : result.error);
	return result.text;
}

test(
	"a diff between two commits is the change between them",
	withRepo(async (repo) => {
		const from = git(repo, "rev-parse", "HEAD~1");
		const to = git(repo, "rev-parse", "HEAD");
		const text = await textOf(await diffText(repo, from, to, ["readme.md"]));
		assert.match(text, /^\+and another line$/m);
		assert.doesNotMatch(text, /^\+hello$/m);
	}),
);

test(
	"the uncommitted marker on the right means the working tree",
	withRepo(async (repo) => {
		writeFileSync(join(repo, "readme.md"), "hello\nand another line\nand a third\n");
		const text = await textOf(await diffText(repo, "HEAD", UNCOMMITTED, ["readme.md"]));
		assert.match(text, /^\+and a third$/m);
	}),
);

test(
	"one revision against itself is the change that commit brought",
	withRepo(async (repo) => {
		const head = git(repo, "rev-parse", "HEAD");
		const text = await textOf(await diffText(repo, head, head, ["readme.md"]));
		assert.match(text, /^\+and another line$/m);
	}),
);

test(
	"a root commit compared with itself falls back to the tree it added",
	withRepo(async (repo) => {
		const root = git(repo, "rev-list", "--max-parents=0", "HEAD");
		const text = await textOf(await diffText(repo, root, root, []));
		assert.match(text, /^\+hello$/m, "a root commit has no parent, so git show draws the whole tree");
	}),
);

test(
	"an untracked file is drawn as the diff that adds it",
	withRepo(async (repo) => {
		const text = await textOf(await untrackedDiff(repo, "never-added.txt"));
		assert.match(text, /^diff --git a\/never-added\.txt b\/never-added\.txt$/m);
		assert.match(text, /^--- \/dev\/null$/m);
		assert.match(text, /^\+\+\+ b\/never-added\.txt$/m);
		assert.match(text, /^@@ -0,0 \+1,1 @@$/m);
		assert.match(text, /^\+never added$/m);
	}),
);

test(
	"a file with no newline at the end gets git's own marker rather than a line it does not have",
	withRepo(async (repo) => {
		writeFileSync(join(repo, "no-newline.txt"), "one line only");
		const text = await textOf(await untrackedDiff(repo, "no-newline.txt"));
		assert.match(text, /^\+one line only$/m);
		assert.match(text, /^\\ No newline at end of file$/m);
	}),
);

test(
	"the page's view diff answers text, and an untracked file goes through the untracked diff",
	withRepo(async (repo) => {
		const head = git(repo, "rev-parse", "HEAD");
		const tracked = await viewDiff(repo, head, head, "readme.md", "readme.md", "M");
		assert.ok("view" in tracked, "a diff is always text here");
		assert.equal(tracked.view.kind, "diff");
		assert.equal(tracked.view.filePath, "readme.md");
		assert.equal(tracked.view.binary, false);
		assert.equal(tracked.view.truncated, false);
		assert.match(tracked.view.content, /^\+and another line$/m);
		const untracked = await viewDiff(repo, UNCOMMITTED, UNCOMMITTED, "never-added.txt", "never-added.txt", "U");
		assert.ok("view" in untracked);
		assert.match(untracked.view.content, /^\+never added$/m);
	}),
);

test(
	"a file at a revision is read out of the object database",
	withRepo(async (repo) => {
		const first = git(repo, "rev-list", "--max-parents=0", "HEAD");
		const view = await viewFileAtRevision(repo, first, "readme.md");
		assert.ok("view" in view, "the first commit's readme is text");
		assert.equal(view.view.kind, "file");
		assert.equal(view.view.content, "hello\n");
		assert.match(view.view.title, /readme\.md at [0-9a-f]{7}/);
	}),
);

test(
	"open file with the uncommitted marker is the working file, read through the containment check",
	withRepo(async (repo) => {
		writeFileSync(join(repo, "readme.md"), "edited in the working tree\n");
		const view = await openFile(repo, UNCOMMITTED, "readme.md");
		assert.ok("view" in view);
		assert.equal(view.view.content, "edited in the working tree\n");
	}),
);

test(
	"a diff against the working file shows what the human has changed since",
	withRepo(async (repo) => {
		writeFileSync(join(repo, "readme.md"), "hello\nrewritten\n");
		const view = await viewDiffWithWorkingFile(repo, "HEAD", "readme.md");
		assert.ok("view" in view);
		assert.match(view.view.content, /^-and another line$/m);
		assert.match(view.view.content, /^\+rewritten$/m);
	}),
);

test(
	"a path that resolves outside the repository is refused with a sentence, and read nothing",
	withRepo(async (repo) => {
		const view = await openFile(repo, UNCOMMITTED, "outside-link");
		assert.ok("error" in view);
		assert.match(view.error, /outside the repository/);
		const diff = await untrackedDiff(repo, "outside-link");
		assert.equal(diff.ok, false);
	}),
);

test(
	"a binary file is said to be binary instead of being decoded",
	withRepo(async (repo) => {
		const view = await viewFileAtRevision(repo, UNCOMMITTED, "picture.bin");
		assert.ok("view" in view);
		assert.equal(view.view.binary, true);
		assert.equal(view.view.content, "");
	}),
);

test(
	"a file over the cap comes back truncated with its first two megabytes",
	withRepo(async (repo) => {
		const view = await viewFileAtRevision(repo, UNCOMMITTED, "long.txt");
		assert.ok("view" in view);
		assert.equal(view.view.binary, false);
		assert.equal(view.view.truncated, true);
		assert.ok(Buffer.byteLength(view.view.content) <= MAX_TEXT_BYTES, "the body is the cap and no more");
		assert.ok(Buffer.byteLength(view.view.content) > MAX_TEXT_BYTES - 4096, "and it is not much less than the cap");
	}),
);

test(
	"a path git cannot resolve is a sentence, not a throw",
	withRepo(async (repo) => {
		const view = await viewFileAtRevision(repo, "HEAD", "not-a-file.txt");
		assert.ok("error" in view);
		assert.ok(view.error.length > 0);
		const bad = await untrackedDiff(repo, "../outside.txt");
		assert.equal(bad.ok, false);
	}),
);
