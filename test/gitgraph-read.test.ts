import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rmSync } from "node:fs";
import {
	getCommitComparison,
	getCommitDetails,
	getCommits,
	getRepoConfig,
	getRepoInfo,
	getStashDetails,
	getTagDetails,
	getUncommittedDetails,
} from "../server/git/gitgraph/read.ts";
import { UNCOMMITTED } from "../server/git/gitgraph/protocol.ts";
import { git, scratchRepo } from "../test-support/git.ts";

/**
 * A repository with something of every kind in it: a rename, both sorts of tag, a remote-tracking ref
 * that no network made, a stash that kept an untracked file, and a working tree nobody has committed.
 */
function history() {
	const repo = scratchRepo();
	writeFileSync(join(repo, "b.txt"), "one\ntwo\n");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "second\n\nbody keeps going");
	git(repo, "mv", "readme.md", "renamed.md");
	git(repo, "commit", "-m", "rename");
	git(repo, "tag", "-a", "v1", "-m", "the first tag");
	git(repo, "tag", "plain");
	git(repo, "remote", "add", "origin", "https://example.invalid/repo.git");
	git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
	git(repo, "config", "branch.dev.remote", "origin");
	writeFileSync(join(repo, "stashed.txt"), "stash me\n");
	git(repo, "add", "stashed.txt");
	writeFileSync(join(repo, "kept-untracked.txt"), "untracked in the stash\n");
	git(repo, "stash", "push", "-u", "-m", "wip");
	writeFileSync(join(repo, "b.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(repo, "brand-new.txt"), "never added\n");
	return repo;
}

/** Every test cleans its own repository up, because a scratch repo in `/tmp` is never reused. */
function withHistory(work: (repo: string) => Promise<void>) {
	return async () => {
		const repo = history();
		try {
			await work(repo);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	};
}

test(
	"the repository info names the branches, the head, the remotes and the stashes",
	withHistory(async (repo) => {
		const info = await getRepoInfo(repo, { showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		assert.equal(info.error, null);
		assert.equal(info.head, "dev");
		assert.deepEqual(info.branches, ["dev", "origin/main"]);
		assert.deepEqual(info.remotes, ["origin"]);
		assert.equal(info.stashes.length, 1);
		assert.equal(info.stashes[0].selector, "stash@{0}");
		// The stash kept an untracked file, so its third parent is there to be read.
		assert.match(info.stashes[0].untrackedFilesHash ?? "", /\^3$/);
	}),
);

test(
	"a hidden remote is left out of the branches, and so is every remote when they are not shown",
	withHistory(async (repo) => {
		const hidden = await getRepoInfo(repo, { showRemoteBranches: true, showStashes: false, hideRemotes: ["origin"] });
		assert.deepEqual(hidden.branches, ["dev"]);
		assert.deepEqual(hidden.stashes, [], "a repository asked without stashes reads none");
		const local = await getRepoInfo(repo, { showRemoteBranches: false, showStashes: false, hideRemotes: [] });
		assert.deepEqual(local.branches, ["dev"]);
	}),
);

test(
	"a folder that is not a repository answers a reason instead of throwing",
	withHistory(async (repo) => {
		const info = await getRepoInfo(join(repo, "not-a-repo-at-all"), { showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		assert.equal(info.head, null);
		assert.deepEqual(info.branches, []);
		assert.ok(info.error && info.error.length > 0, "a folder git cannot read has to say why");
	}),
);

/** The options a graph is drawn with unless a test wants something else. */
const graphOptions = {
	maxCommits: 50,
	showTags: true,
	showRemoteBranches: true,
	includeCommitsMentionedByReflogs: false,
	onlyFollowFirstParent: false,
	commitOrdering: "date" as const,
	branches: null,
	remotes: ["origin"],
	hideRemotes: [],
	stashes: true,
};

test(
	"the graph is walked in one run, with parents, pills and the uncommitted row",
	withHistory(async (repo) => {
		const log = await getCommits(repo, graphOptions);
		assert.ok(log.ok, log.ok ? "" : log.error);
		const [uncommitted, ...commits] = log.value.commits;
		assert.equal(uncommitted.hash, UNCOMMITTED);
		assert.equal(uncommitted.message, "Uncommitted Changes");
		// The walk covers the branch, the tag and `refs/stash`, so the stash's own commits — the change,
		// its index and its untracked files — are rows beside the branch's three, newest first.
		const branch = commits.filter((commit) => ["rename", "second", "first"].includes(commit.message));
		assert.deepEqual(
			branch.map((commit) => commit.message),
			["rename", "second", "first"],
		);
		const tip = branch[0];
		assert.equal(tip.parents.length, 1);
		assert.deepEqual(tip.heads, ["dev"]);
		assert.deepEqual(tip.tags, [
			{ name: "plain", annotated: false },
			{ name: "v1", annotated: true },
		]);
		assert.deepEqual(tip.remotes, [{ name: "origin/main", remote: "origin" }]);
		// The stash is a commit reachable from `refs/stash`, and the row says which selector it is.
		const stashed = commits.find((commit) => commit.stash !== null);
		assert.equal(stashed?.stash?.selector, "stash@{0}");
		assert.equal(log.value.head, "dev");
		assert.deepEqual(log.value.tags, ["plain", "v1"]);
		assert.equal(log.value.moreCommitsAvailable, false);
	}),
);

test(
	"a repository with the stash row switched on and no stash still draws its commits",
	withHistory(async (repo) => {
		git(repo, "stash", "clear");
		const log = await getCommits(repo, { ...graphOptions, stashes: true });
		assert.ok(log.ok, log.ok ? "" : log.error);
		assert.deepEqual(
			log.value.commits.map((commit) => commit.message),
			["Uncommitted Changes", "rename", "second", "first"],
		);
	}),
);

test(
	"a ceiling that cuts the walk says so, and the rows are the ceiling",
	withHistory(async (repo) => {
		const log = await getCommits(repo, { ...graphOptions, maxCommits: 2 });
		assert.ok(log.ok);
		assert.equal(log.value.moreCommitsAvailable, true);
		assert.equal(log.value.commits.length, 3, "the uncommitted row plus the two asked for");
	}),
);

test(
	"a hidden remote contributes no pills, and no remote branches at all is the same as hiding them",
	withHistory(async (repo) => {
		const hidden = await getCommits(repo, { ...graphOptions, hideRemotes: ["origin"] });
		assert.ok(hidden.ok);
		assert.deepEqual(hidden.value.commits[1].remotes, []);
		const local = await getCommits(repo, { ...graphOptions, showRemoteBranches: false });
		assert.ok(local.ok);
		assert.deepEqual(local.value.commits[1].remotes, []);
	}),
);

test(
	"one commit's details carry its whole message and every file it touched",
	withHistory(async (repo) => {
		const hash = git(repo, "rev-parse", "HEAD");
		const details = await getCommitDetails(repo, hash, true);
		assert.ok(details.ok, details.ok ? "" : details.error);
		assert.equal(details.value.hash, hash);
		assert.equal(details.value.author, "test");
		assert.equal(details.value.authorEmail, "test@example.invalid");
		assert.equal(details.value.body.trim(), "rename");
		assert.equal(details.value.signature, null);
		const renamed = details.value.fileChanges.find((change) => change.type === "R");
		assert.equal(renamed?.oldFilePath, "readme.md");
		assert.equal(renamed?.newFilePath, "renamed.md");
		assert.equal(renamed?.additions, 0);
		assert.equal(renamed?.deletions, 0);
	}),
);

test(
	"a root commit is shown against nothing, and it has files",
	withHistory(async (repo) => {
		const root = git(repo, "rev-list", "--max-parents=0", "HEAD");
		const details = await getCommitDetails(repo, root, false);
		assert.ok(details.ok, details.ok ? "" : details.error);
		assert.deepEqual(details.value.parents, []);
		assert.deepEqual(
			details.value.fileChanges.map((change) => [change.type, change.newFilePath, change.additions]),
			[["A", "readme.md", 1]],
		);
	}),
);

test(
	"a stash's details hold its changes and the untracked file it kept",
	withHistory(async (repo) => {
		const info = await getRepoInfo(repo, { showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		const stash = info.stashes[0];
		const details = await getStashDetails(repo, stash.selector, stash.baseHash);
		assert.ok(details.ok, details.ok ? "" : details.error);
		assert.deepEqual(
			details.value.fileChanges.map((change) => [change.type, change.newFilePath]),
			[
				["A", "stashed.txt"],
				["U", "kept-untracked.txt"],
			],
			"the staged change it holds, then the file it kept as untracked",
		);
	}),
);

test(
	"the uncommitted details are what differs from HEAD plus every untracked file",
	withHistory(async (repo) => {
		const details = await getUncommittedDetails(repo);
		assert.ok(details.ok, details.ok ? "" : details.error);
		assert.equal(details.value.hash, UNCOMMITTED);
		assert.equal(details.value.body, "Uncommitted Changes");
		const files = details.value.fileChanges.map((change) => [change.type, change.newFilePath, change.additions]);
		assert.deepEqual(files, [
			["M", "b.txt", 1],
			["U", "brand-new.txt", null],
		]);
	}),
);

test(
	"a comparison between two commits is the files between them",
	withHistory(async (repo) => {
		const from = git(repo, "rev-parse", "HEAD~1");
		const to = git(repo, "rev-parse", "HEAD");
		const comparison = await getCommitComparison(repo, from, to);
		assert.ok(comparison.ok, comparison.ok ? "" : comparison.error);
		assert.deepEqual(
			comparison.value.map((change) => [change.type, change.oldFilePath, change.newFilePath]),
			[["R", "readme.md", "renamed.md"]],
		);
	}),
);

test(
	"an annotated tag is read from the tag, a lightweight one from its commit",
	withHistory(async (repo) => {
		const annotated = await getTagDetails(repo, "v1");
		assert.ok(annotated.ok, annotated.ok ? "" : annotated.error);
		assert.equal(annotated.value.name, "test");
		assert.equal(annotated.value.email, "test@example.invalid");
		assert.equal(annotated.value.message.trim(), "the first tag");
		assert.match(annotated.value.tagHash, /^[0-9a-f]{40}$/);
		// A lightweight tag has no tagger and no message, so the commit's own are what a human is shown.
		const plain = await getTagDetails(repo, "plain");
		assert.ok(plain.ok, plain.ok ? "" : plain.error);
		assert.equal(plain.value.name, "test");
		assert.equal(plain.value.message.trim(), "rename");
	}),
);

test(
	"the configuration says what a human's git would do, at both scopes",
	withHistory(async (repo) => {
		git(repo, "config", "diff.tool", "meld");
		const config = await getRepoConfig(repo, ["origin"]);
		assert.ok(config.ok, config.ok ? "" : config.error);
		assert.equal(config.value.user.name.local, "test");
		assert.equal(config.value.user.email.local, "test@example.invalid");
		assert.equal(config.value.diffTool, "meld");
		assert.equal(config.value.pushDefault, null);
		assert.equal(config.value.branches.dev?.remote, "origin");
		assert.deepEqual(config.value.remotes, [{ name: "origin", url: "https://example.invalid/repo.git", pushUrl: null }]);
	}),
);
