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
	libreCommits,
	libreRepoInfo,
	libreSearch,
	libreTagDetails,
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
	// A page that has not read this repository's stashes yet sends `null` and the graph reads them here.
	stashes: null,
};

test(
	"the graph is walked in one run, with parents, pills and the uncommitted row",
	withHistory(async (repo) => {
		const log = await getCommits(repo, graphOptions);
		assert.ok(log.ok, log.ok ? "" : log.error);
		const [uncommitted, ...commits] = log.value.commits;
		assert.equal(uncommitted.hash, UNCOMMITTED);
		assert.equal(uncommitted.message, "Uncommitted Changes (2)", "the row carries its count, so the page does not show it as ?");
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
		const log = await getCommits(repo, { ...graphOptions, stashes: null });
		assert.ok(log.ok, log.ok ? "" : log.error);
		assert.deepEqual(
			log.value.commits.map((commit) => commit.message),
			["Uncommitted Changes (2)", "rename", "second", "first"],
		);
	}),
);

test(
	"the stashes the page already holds mark the commit that is one, and a list of none walks none",
	withHistory(async (repo) => {
		const info = await getRepoInfo(repo, { showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		const log = await getCommits(repo, { ...graphOptions, stashes: info.stashes });
		assert.ok(log.ok, log.ok ? "" : log.error);
		const marked = log.value.commits.find((commit) => commit.stash !== null);
		assert.equal(marked?.hash, info.stashes[0].baseHash);
		assert.deepEqual(marked?.stash, info.stashes[0]);

		// The page's list is also what the walk starts from, so a page that holds no stash walks no stash
		// commit: the rows are the branch's three and the uncommitted one, exactly as the extension drew them.
		const none = await getCommits(repo, { ...graphOptions, stashes: [] });
		assert.ok(none.ok, none.ok ? "" : none.error);
		assert.deepEqual(
			none.value.commits.map((commit) => commit.message),
			["Uncommitted Changes (2)", "rename", "second", "first"],
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
	"a comparison whose base is the working tree is the reverse of the diff git draws from a commit",
	withHistory(async (repo) => {
		// The commit holds a file the tree no longer has, and the tree holds one the commit never had. With the
		// working tree on the left, the first of those reads as an addition and the second as a deletion: the
		// change somebody sees going from what is on disk to what was committed.
		git(repo, "rm", "-q", "renamed.md");
		writeFileSync(join(repo, "in-the-tree.txt"), "the tree's own\n");
		git(repo, "add", "in-the-tree.txt");
		const head = git(repo, "rev-parse", "HEAD");
		const forward = await getCommitComparison(repo, head, UNCOMMITTED);
		assert.ok(forward.ok, forward.ok ? "" : forward.error);
		assert.deepEqual(
			forward.value.map((change) => [change.type, change.newFilePath]),
			[
				["M", "b.txt"],
				["A", "in-the-tree.txt"],
				["D", "renamed.md"],
			],
		);
		const reversed = await getCommitComparison(repo, UNCOMMITTED, head);
		assert.ok(reversed.ok, reversed.ok ? "" : reversed.error);
		assert.deepEqual(
			reversed.value.map((change) => [change.type, change.newFilePath]),
			[
				["M", "b.txt"],
				["D", "in-the-tree.txt"],
				["A", "renamed.md"],
			],
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
	"a clean tree gets no uncommitted row, and a dirty one keeps it with its count",
	async () => {
		// scratchRepo commits everything it writes, so it starts clean.
		const repo = scratchRepo();
		try {
			const clean = await getCommits(repo, { ...graphOptions, stashes: [] });
			assert.ok(clean.ok, clean.ok ? "" : clean.error);
			assert.ok(clean.value.commits.every((commit) => commit.hash !== UNCOMMITTED), "no phantom * row on a clean tree");
			assert.deepEqual(clean.value.commits.map((commit) => commit.message), ["first"]);
			writeFileSync(join(repo, "dirty.txt"), "not committed\n");
			const dirty = await getCommits(repo, { ...graphOptions, stashes: [] });
			assert.ok(dirty.ok, dirty.ok ? "" : dirty.error);
			assert.equal(dirty.value.commits[0].hash, UNCOMMITTED);
			assert.equal(dirty.value.commits[0].message, "Uncommitted Changes (1)");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	},
);

test(
	"tags are shown even when the page asks for them hidden, so a picked tag filters the graph",
	withHistory(async (repo) => {
		const opts = { maxCommits: 50, branches: null, branchName: "", authors: null, tags: ["v1"], showRemoteBranches: true, hiddenRemotes: [] as string[], showTags: false, includeReflog: false, includeUnreachable: false, onlyFollowFirstParent: false, commitOrdering: "date" as const, showStashes: false };
		const out = await libreCommits(repo, opts);
		assert.equal(out.error, null);
		assert.equal(out.commits.length, 1, "only the commit v1 names, and the tree is dirty so its row is filtered out by the tag pick");
		assert.equal(out.commits[0].message, "rename");
		assert.deepEqual(out.commits[0].refs.filter((ref) => ref.type === "tag").map((ref) => ref.name).sort(), ["plain", "v1"]);
		// The dropdown and the pills agree: without a tag pick the same commit still carries both pills.
		const unfiltered = await libreCommits(repo, { ...opts, tags: null });
		assert.equal(unfiltered.error, null);
		const tip = unfiltered.commits.find((commit) => commit.message === "rename");
		assert.deepEqual(tip?.refs.filter((ref) => ref.type === "tag").map((ref) => ref.name).sort(), ["plain", "v1"]);
		// And the repo info dropdown lists the same tags the pills show.
		const info = await libreRepoInfo(repo, false);
		assert.deepEqual(info.tags, ["plain", "v1"]);
	}),
);

test(
	"an annotated tag's details name the commit it peels to, not the tag object",
	withHistory(async (repo) => {
		const out = await libreTagDetails(repo, "v1");
		assert.equal(out.error, null);
		assert.ok(out.details);
		assert.equal(out.details.type, "annotated");
		assert.equal(out.details.targetHash, git(repo, "rev-parse", "v1^{commit}"));
		assert.notEqual(out.details.objectHash, out.details.targetHash, "the tag object is not the commit");
		const plain = await libreTagDetails(repo, "plain");
		assert.equal(plain.error, null);
		assert.equal(plain.details?.type, "lightweight");
		assert.equal(plain.details?.targetHash, git(repo, "rev-parse", "plain^{commit}"));
		assert.equal(plain.details?.objectHash, plain.details?.targetHash);
	}),
);

test(
	"search honours the picked tags and authors instead of dropping them",
	withHistory(async (repo) => {
		git(repo, "tag", "old", "HEAD~1");
		const base = { showRemoteBranches: true, hiddenRemotes: [] as string[], showTags: true, branches: null, authors: null, tags: null };
		const byTag = await libreSearch(repo, "second", 10, { ...base, tags: ["old"] });
		assert.equal(byTag.error, null);
		assert.deepEqual(byTag.results.map((entry) => entry.message), ["second"]);
		const wrongTag = await libreSearch(repo, "second", 10, { ...base, tags: ["v1"] });
		assert.deepEqual(wrongTag.results, []);
		const byAuthor = await libreSearch(repo, "second", 10, { ...base, authors: ["nobody"] });
		assert.deepEqual(byAuthor.results, []);
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
