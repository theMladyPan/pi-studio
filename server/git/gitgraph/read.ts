/**
 * Everything the Git Graph page reads out of a repository, answered in the page's own words.
 *
 * The page is mhutchie's bundle, so nothing here may invent a field name or a shape: what leaves this
 * module is `protocol.ts` and nothing else. Every read goes through `gitText`, which is where a prompt,
 * a pager, a hang and a runaway print are already answered, and every read answers a value or a
 * sentence rather than throwing — the caller is a route whose reply has to be sent either way.
 *
 * Two decisions shape the parsing. Each command asks git for the whole answer in one run with a format
 * string carrying its own separators (`0x1f` between fields, `0x00` after a record), because a commit
 * subject, a branch name or a path may hold spaces and tabs, so splitting on whitespace loses data and
 * one call per commit costs a process per row. And the graph's pills are built from one `for-each-ref`
 * run joined to the commits by hash, because refs are what the page draws beside a commit and asking
 * git to decorate each row would repeat the same list on every line.
 */
import { gitText } from "../exec.ts";
import { DEFAULT_READ_FLAGS } from "./config.ts";
import { UNCOMMITTED } from "./protocol.ts";
import type {
	GitCommit,
	GitCommitDetails,
	GitFileChange,
	GitFileChangeType,
	GitRemoteBranch,
	GitRepoConfig,
	GitRepoInfo,
	GitSignature,
	GitStash,
	GitTag,
	GitTagDetails,
} from "./protocol.ts";

// ---------- one answer ----------

/** What a read answers: the data, or the sentence the page shows in place of it. */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The two bytes a commit subject, a branch name or a path cannot hold, as the format strings spell them.
 * The escapes never reach the kernel as bytes — a NUL in an argv entry is refused — so the format
 * carries plain text and only git's output carries the byte.
 *
 * The two families of git command spell them differently, which is not this module's idea:
 * `git log` and `git show` write `%x1f`, and `for-each-ref` writes `%1f`. Both are tried nowhere and
 * used where they belong, because a format string that prints its own escape is a record that never
 * splits and a graph with no pills.
 */
const LOG_FIELD = "%x1f";
const LOG_RECORD = "%x00";
const REF_FIELD = "%1f";
const REF_RECORD = "%00";

/** What those escapes spell in the output this module then reads. */
const FIELD = "\u001f";
const RECORD = "\u0000";

// ---------- reading what git printed ----------

/**
 * The records one `--format` run printed. The format ends every record with a NUL and git writes a
 * newline after it, so the newline is stripped here rather than in every reader below.
 */
function recordTexts(text: string): string[] {
	const kept: string[] = [];
	for (const chunk of text.split(RECORD)) {
		const record = chunk.startsWith("\n") ? chunk.slice(1) : chunk;
		if (record.length > 0) kept.push(record);
	}
	return kept;
}

/** One record, cut into its fields. A field the format left empty is an empty string, never a gap. */
function fieldsOf(record: string): string[] {
	return record.split(FIELD);
}

/** Why a read answered nothing, in the words git used, so the page can show them as they are. */
function reasonOf(result: { stderr: string; timedOut: boolean; truncated: boolean }): string {
	if (result.timedOut) return "git did not answer in time";
	if (result.truncated) return "git printed more than this view will read";
	return result.stderr || "git could not read this repository";
}

/** A number git printed, or `null` when it printed none: a binary file's counts are `-` and `-`. */
function countOf(text: string): number | null {
	return /^\d+$/.test(text) ? Number(text) : null;
}

/** Unix seconds git printed, which is what the page formats into the human's own date. */
function secondsOf(text: string): number {
	const value = Number(text);
	return Number.isFinite(value) ? value : 0;
}

// ---------- the refs, read once ----------

/** One ref as `for-each-ref` printed it: its full name, its object, the commit a tag names, its upstream. */
type RefEntry = { name: string; hash: string; target: string; upstream: string };

/** Every ref of a repository, grouped by what the page draws it as. */
type Refs = {
	/** Local branches, by the name the dropdown shows. */
	heads: Array<{ name: string; hash: string; upstream: string }>;
	/** Remote-tracking branches, by `origin/main` and the remote that first segment names. */
	remotes: Array<{ name: string; hash: string; remote: string }>;
	/** Tags, with the commit each one names and whether it carries a message of its own. */
	tags: Array<{ name: string; hash: string; annotated: boolean }>;
};

/**
 * Every ref in one run, and the three kinds told apart by the full name rather than by three runs.
 * `%(*objectname)` is the commit an annotated tag names and is empty for a lightweight one, which is
 * exactly the difference the graph draws; `%(upstream:lstrip=2)` is the branch a local one tracks.
 */
async function readRefs(repo: string): Promise<ReadResult<Refs>> {
	const result = await gitText(repo, [
		"for-each-ref",
		`--format=%(refname)${REF_FIELD}%(objectname)${REF_FIELD}%(*objectname)${REF_FIELD}%(upstream:lstrip=2)${REF_RECORD}`,
		"refs/heads",
		"refs/remotes",
		"refs/tags",
	]);
	if (!result.ok) return { ok: false, error: reasonOf(result) };
	const refs: Refs = { heads: [], remotes: [], tags: [] };
	for (const record of recordTexts(result.text)) {
		const [full, hash, target, upstream] = fieldsOf(record);
		if (!full || !hash) continue;
		const entry: RefEntry = { name: full, hash, target: target ?? "", upstream: upstream ?? "" };
		if (entry.name.startsWith("refs/heads/")) {
			refs.heads.push({ name: entry.name.slice("refs/heads/".length), hash: entry.hash, upstream: entry.upstream });
		} else if (entry.name.startsWith("refs/remotes/")) {
			const name = entry.name.slice("refs/remotes/".length);
			// `origin/HEAD` is a pointer to whichever branch the remote calls its head, not a branch of its
			// own: offering it would put a name in the dropdown that git cannot check out.
			if (name.endsWith("/HEAD")) continue;
			refs.remotes.push({ name, hash: entry.hash, remote: name.split("/")[0] });
		} else if (entry.name.startsWith("refs/tags/")) {
			// An annotated tag's own object is the tag, and the commit it names is `*objectname`; the
			// graph hangs both pills on that commit.
			refs.tags.push({ name: entry.name.slice("refs/tags/".length), hash: entry.target || entry.hash, annotated: entry.target !== "" });
		}
	}
	return { ok: true, value: refs };
}

/**
 * The top level of the checkout a folder is, or `null` when it is not one any more.
 *
 * The page asks this only when something went wrong, and it is what tells the two kinds of failure
 * apart: a folder that is no longer a repository is one the page stops drawing for, while a repository
 * whose stash list could not be read is still a repository and its graph still loads.
 */
export async function readRepoRoot(repo: string): Promise<string | null> {
	const result = await gitText(repo, ["rev-parse", "--show-toplevel"]);
	const root = result.ok ? result.text.trim() : "";
	return root.length > 0 ? root : null;
}

/** The branch `HEAD` points at, or `null` when it is detached and no branch names the commit. */
async function readHead(repo: string): Promise<string | null> {
	const result = await gitText(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
	if (!result.ok) return null;
	const name = result.text.trim();
	return name.length > 0 ? name : null;
}

/**
 * The stashes a repository holds, newest first, each with the hash of its untracked files when it kept
 * them. A stash commit has a third parent exactly when git stashed untracked files beside the changes,
 * and `stash list` cannot print that, so the parents are read in the same breath and joined by hash.
 */
async function readStashes(repo: string): Promise<ReadResult<GitStash[]>> {
	const listed = await gitText(repo, ["stash", "list", `--format=%gd${LOG_FIELD}%H${LOG_FIELD}%s${LOG_RECORD}`]);
	if (!listed.ok) return { ok: false, error: reasonOf(listed) };
	const rows = recordTexts(listed.text)
		.map(fieldsOf)
		.filter((fields) => fields.length >= 2 && fields[0] && fields[1])
		.map((fields) => ({ selector: fields[0], hash: fields[1] }));
	if (rows.length === 0) return { ok: true, value: [] };
	const parents = await gitText(repo, ["log", "--no-walk", `--format=%H${LOG_FIELD}%P${LOG_RECORD}`, ...rows.map((row) => row.hash)]);
	if (!parents.ok) return { ok: false, error: reasonOf(parents) };
	const parentCounts = new Map<string, number>();
	for (const record of recordTexts(parents.text)) {
		const [hash, list] = fieldsOf(record);
		parentCounts.set(hash, list ? list.split(" ").filter(Boolean).length : 0);
	}
	const stashes = rows.map((row) => ({
		selector: row.selector,
		baseHash: row.hash,
		// The third parent is the tree of untracked files `git stash --include-untracked` made.
		untrackedFilesHash: (parentCounts.get(row.hash) ?? 0) >= 3 ? `${row.hash}^3` : null,
	}));
	return { ok: true, value: stashes };
}

// ---------- the repository's own shape ----------

/** What `getRepoInfo` is asked for, which is what the page's checkboxes and settings say. */
export type RepoInfoOptions = {
	showRemoteBranches: boolean;
	showStashes: boolean;
	hideRemotes: readonly string[];
};

/**
 * The branches the dropdown offers, the branch checked out, the remotes and the stashes.
 *
 * A remote branch is offered when the human asked to see remote branches, and the current branch's
 * upstream is offered even when they did not: it is the branch the fetch and pull buttons act on, and
 * hiding it would make those buttons silently act on a branch the dropdown does not name. A remote the
 * human hid contributes no branches, which is what hiding it means.
 */
export async function getRepoInfo(repo: string, options: RepoInfoOptions): Promise<GitRepoInfo> {
	const refs = await readRefs(repo);
	if (!refs.ok) {
		return { branches: [], head: null, remotes: [], stashes: [], error: refs.error };
	}
	const head = await readHead(repo);
	const remotesResult = await gitText(repo, ["remote"]);
	const remotes = remotesResult.ok ? remotesResult.text.split("\n").map((name) => name.trim()).filter(Boolean) : [];
	const branches = refs.value.heads.map((entry) => entry.name);
	const upstream = head ? refs.value.heads.find((entry) => entry.name === head)?.upstream ?? "" : "";
	for (const remoteBranch of refs.value.remotes) {
		if (options.hideRemotes.includes(remoteBranch.remote)) continue;
		if (options.showRemoteBranches || remoteBranch.name === upstream) branches.push(remoteBranch.name);
	}
	const stashes = options.showStashes ? await readStashes(repo) : { ok: true as const, value: [] as GitStash[] };
	return {
		branches,
		head,
		remotes,
		stashes: stashes.ok ? stashes.value : [],
		// A stash list or a remote list that could not be read is not a repository that could not be
		// read: the branches above are still true, so the reason rides along and the page says it beside
		// a graph it can still draw.
		error: !stashes.ok ? stashes.error : remotesResult.ok ? null : reasonOf(remotesResult),
	};
}

// ---------- the graph itself ----------

/** Everything `loadCommits` is asked for, as the page sent it. */
export type CommitOptions = {
	maxCommits: number;
	showTags: boolean;
	showRemoteBranches: boolean;
	includeCommitsMentionedByReflogs: boolean;
	onlyFollowFirstParent: boolean;
	commitOrdering: "default" | "date" | "author-date" | "topo";
	/** The branches the dropdown has selected, or `null` for all of them. */
	branches: readonly string[] | null;
	remotes: readonly string[];
	hideRemotes: readonly string[];
	/**
	 * The stashes the page already holds, so the commits that belong to one are marked with the selector
	 * it knows, or `null` for a page that knows nothing about them yet: the list is then read here.
	 */
	stashes: readonly GitStash[] | null;
};

/**
 * What one `loadCommits` answered. It carries more than the rows because the page draws the graph from
 * all of it: `head` is the row the graph scrolls to, `tags` is the list the dropdown offers, and
 * `moreCommitsAvailable` is whether the ceiling cut the walk short — all of which the same run has
 * already read, so asking again would be a second process for an answer already in hand.
 */
export type CommitLog = {
	commits: GitCommit[];
	head: string | null;
	tags: string[];
	moreCommitsAvailable: boolean;
};

/** The commit order as the argv word git knows it by; `default` is git's own order, so no word at all. */
function orderArgs(ordering: CommitOptions["commitOrdering"]): string[] {
	if (ordering === "date") return ["--date-order"];
	if (ordering === "author-date") return ["--author-date-order"];
	if (ordering === "topo") return ["--topo-order"];
	return [];
}

/**
 * The revisions one walk may start from, given what the page asked to see.
 *
 * The stashes are named one commit at a time rather than as `refs/stash`: a repository with the stash
 * row switched on and no stash at all is the common case, and `refs/stash` is then a revision that does
 * not exist, which fails the whole walk. Every stash's own commit is walked instead, the older ones
 * from the reflog included, so the rows the page draws are exactly the selectors it lists.
 */
function revisionArgs(options: CommitOptions, stashCommits: readonly string[]): string[] {
	const args: string[] = [];
	if (options.branches !== null && options.branches.length > 0) args.push(...options.branches);
	else args.push("--branches");
	if (options.showRemoteBranches) {
		const visible = options.remotes.filter((remote) => !options.hideRemotes.includes(remote));
		// One `--remotes=<pattern>` per remote that is still shown, so a hidden remote contributes no
		// commits at all rather than rows whose pills were then erased. Every remote hidden walks none.
		if (visible.length === options.remotes.length) args.push("--remotes");
		else for (const remote of visible) args.push(`--remotes=${remote}`);
	}
	// A commit only a tag names is still a commit in this repository, which is what the page draws it
	// for; the flag that would hide them is a setting this view does not offer.
	if (options.showTags) args.push("--tags");
	// A detached checkout has commits no branch names, and the graph is about the commits this checkout
	// can reach, so HEAD is walked whatever the branches say.
	args.push("HEAD");
	args.push(...stashCommits);
	return args;
}

/** The row the graph draws above the checked out commit; it is not a commit and has no id. */
function uncommittedRow(headHash: string | null): GitCommit {
	return {
		hash: UNCOMMITTED,
		parents: headHash ? [headHash] : [],
		author: "",
		email: "",
		date: Math.floor(Date.now() / 1000),
		message: "Uncommitted Changes",
		heads: [],
		tags: [],
		remotes: [],
		stash: null,
		signature: null,
	};
}

/**
 * The graph: one walk over every revision the page asked for, with the refs joined on afterwards.
 *
 * The walk is asked for one commit more than the ceiling. That extra row is how `moreCommitsAvailable`
 * is known without a second count: if it came back, the walk was cut and the page offers its load-more
 * button, and the row itself is dropped before the answer goes out.
 */
export async function getCommits(repo: string, options: CommitOptions): Promise<ReadResult<CommitLog>> {
	const refs = await readRefs(repo);
	if (!refs.ok) return { ok: false, error: refs.error };
	const head = await readHead(repo);
	const tagsWanted = options.showTags;
	const tags = tagsWanted ? refs.value.tags.map((tag) => tag.name).sort() : [];

	const signatureFields = DEFAULT_READ_FLAGS.showSignatureStatus ? `${LOG_FIELD}%G?${LOG_FIELD}%GS${LOG_FIELD}%GK` : "";
	const format = `--format=%H${LOG_FIELD}%P${LOG_FIELD}%an${LOG_FIELD}%ae${LOG_FIELD}%at${LOG_FIELD}%s${signatureFields}${LOG_RECORD}`;
	const stashes: ReadResult<GitStash[]> =
		options.stashes !== null ? { ok: true, value: [...options.stashes] } : await readStashes(repo);
	const stashCommits = stashes.ok ? stashes.value.map((stash) => stash.baseHash) : [];
	const result = await gitText(repo, [
		"log",
		`--max-count=${options.maxCommits + 1}`,
		// A branch the dropdown still lists can be deleted while the tab stays open, and a walk that
		// fails over it would blank the graph the human is reading. The revision is skipped instead.
		"--ignore-missing",
		"--no-color",
		format,
		...orderArgs(options.commitOrdering),
		...(options.onlyFollowFirstParent ? ["--first-parent"] : []),
		...(options.includeCommitsMentionedByReflogs ? ["--reflog"] : []),
		...revisionArgs(options, stashCommits),
	]);
	if (!result.ok) {
		// An empty repository has no revision to walk, and git says so in the words the page already
		// translates into "There are no commits in this repository": it is not a failure to report. The
		// uncommitted row is still drawn, because that is where a human with files and no commit yet can
		// see them and where the page offers to do something about it.
		if (/bad revision 'HEAD'|does not have any commits yet|unknown revision/.test(result.stderr)) {
			const rows = DEFAULT_READ_FLAGS.showUncommittedChanges ? [uncommittedRow(null)] : [];
			return { ok: true, value: { commits: rows, head, tags, moreCommitsAvailable: false } };
		}
		return { ok: false, error: reasonOf(result) };
	}

	const headsByHash = byHash(refs.value.heads);
	const remotesByHash = byHash(refs.value.remotes.filter((entry) => options.showRemoteBranches && !options.hideRemotes.includes(entry.remote)));
	const tagsByHash = byHash(tagsWanted ? refs.value.tags : []);
	const stashByHash = new Map((stashes.ok ? stashes.value : []).map((stash) => [stash.baseHash, stash]));

	const commits: GitCommit[] = [];
	for (const record of recordTexts(result.text)) {
		const fields = fieldsOf(record);
		const [hash, parentList, author, email, date, subject] = fields;
		if (!hash) continue;
		const signature: GitSignature | null =
			DEFAULT_READ_FLAGS.showSignatureStatus && fields.length >= 9
				? { status: fields[6] ?? "", signer: fields[7] ?? "", key: fields[8] ?? "" }
				: null;
		commits.push({
			hash,
			parents: parentList ? parentList.split(" ").filter(Boolean) : [],
			author: author ?? "",
			email: email ?? "",
			date: secondsOf(date ?? ""),
			message: subject ?? "",
			heads: pillNames(headsByHash.get(hash)),
			tags: pillsOf(tagsByHash.get(hash)),
			remotes: remotePillsOf(remotesByHash.get(hash)),
			stash: stashByHash.get(hash) ?? null,
			signature,
		});
	}

	const moreCommitsAvailable = commits.length > options.maxCommits;
	const kept = moreCommitsAvailable ? commits.slice(0, options.maxCommits) : commits;
	const headHash = head ? refs.value.heads.find((entry) => entry.name === head)?.hash ?? null : null;
	// The uncommitted row is drawn whether or not anything actually changed, because it is where the
	// page offers to stash or reset what is there: a row that appeared and vanished by itself would be a
	// target the human cannot aim at.
	const rows = DEFAULT_READ_FLAGS.showUncommittedChanges ? [uncommittedRow(headHash), ...kept] : kept;
	return { ok: true, value: { commits: rows, head, tags, moreCommitsAvailable } };
}

/** Rows grouped by the commit they point at, in the order `for-each-ref` printed them. */
function byHash<T extends { hash: string }>(entries: readonly T[]): Map<string, T[]> {
	const grouped = new Map<string, T[]>();
	for (const entry of entries) {
		const held = grouped.get(entry.hash);
		if (held) held.push(entry);
		else grouped.set(entry.hash, [entry]);
	}
	return grouped;
}

/** The branch pills one commit carries. */
function pillNames(entries: Array<{ name: string }> | undefined): string[] {
	return entries ? entries.map((entry) => entry.name) : [];
}

/** The tag pills one commit carries, each saying whether it is annotated. */
function pillsOf(entries: Array<{ name: string; annotated: boolean }> | undefined): GitTag[] {
	return entries ? entries.map((entry) => ({ name: entry.name, annotated: entry.annotated })) : [];
}

/** The remote-tracking pills one commit carries. */
function remotePillsOf(entries: Array<{ name: string; remote: string }> | undefined): GitRemoteBranch[] {
	return entries ? entries.map((entry) => ({ name: entry.name, remote: entry.remote })) : [];
}

// ---------- one commit's details ----------

/** The `--raw --numstat -z` pair, which is the one run that prints a change's letter and its counts. */
const CHANGE_ARGS = ["--raw", "--numstat", "-M", "-z"];

/**
 * The files one diff touched, with each change's letter and its two line counts.
 *
 * `--raw` and `--numstat` together print both halves of the answer in one run, `-z` keeps a path whole
 * when it holds a space or a newline, and `-M` makes a rename one entry with two paths instead of a
 * deletion and an addition the human cannot pair up.
 */
async function readFileChanges(args: readonly string[], repo: string): Promise<ReadResult<GitFileChange[]>> {
	const result = await gitText(repo, args);
	if (!result.ok) return { ok: false, error: reasonOf(result) };
	const tokens = result.text.split(RECORD);
	const changes: GitFileChange[] = [];
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		if (!token.startsWith(":")) {
			index += 1;
			continue;
		}
		const raw = token.trimEnd().split(" ");
		const status = raw[raw.length - 1] ?? "";
		const type = changeTypeOf(status);
		index += 1;
		const paths: string[] = [];
		const wanted = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
		while (paths.length < wanted && index < tokens.length) {
			const path = tokens[index].startsWith("\n") ? tokens[index].slice(1) : tokens[index];
			paths.push(path);
			index += 1;
		}
		changes.push({
			oldFilePath: paths[0] ?? "",
			newFilePath: paths[wanted - 1] ?? paths[0] ?? "",
			type,
			additions: null,
			deletions: null,
		});
	}
	// The counts follow the raw lines in the same run, one record per file, in the order `--raw` named
	// them, so they are matched by that order rather than by a path that a rename spells twice.
	const counts = tokens
		.map((token) => token.replace(/^\n+/, ""))
		.filter((token) => /^(\d+|-)\t(\d+|-)\t/.test(token))
		.map((token) => {
			const parts = token.split("\t");
			return { additions: countOf(parts[0] ?? ""), deletions: countOf(parts[1] ?? "") };
		});
	if (counts.length === changes.length) {
		for (let at = 0; at < changes.length; at += 1) {
			changes[at].additions = counts[at].additions;
			changes[at].deletions = counts[at].deletions;
		}
	}
	return { ok: true, value: changes };
}

/** What git's two-letter change code means as the one letter the page draws. */
function changeTypeOf(status: string): GitFileChangeType {
	const first = status.charAt(0);
	if (first === "A" || first === "C" || first === "D" || first === "M" || first === "R") return first;
	return "U";
}

/** The metadata fields a commit or a stash's own commit carries, in the order `readMetadata` reads them. */
const METADATA_FORMAT = `--format=%H${LOG_FIELD}%P${LOG_FIELD}%an${LOG_FIELD}%ae${LOG_FIELD}%at${LOG_FIELD}%cn${LOG_FIELD}%ce${LOG_FIELD}%ct${LOG_FIELD}%G?${LOG_FIELD}%GS${LOG_FIELD}%GK${LOG_FIELD}%B`;

/** One commit's own words: who wrote it, who committed it, when, and the whole message body. */
type Metadata = Omit<GitCommitDetails, "fileChanges">;

/** One commit as git holds it, body and signature included, which is what the details pane shows. */
async function readMetadata(repo: string, revision: string): Promise<ReadResult<Metadata>> {
	const result = await gitText(repo, ["show", "-s", "--no-color", METADATA_FORMAT, revision]);
	if (!result.ok) return { ok: false, error: reasonOf(result) };
	const record = recordTexts(result.text)[0] ?? "";
	const fields = fieldsOf(record);
	const status = fields[8] ?? "";
	return {
		ok: true,
		value: {
			hash: fields[0] ?? revision,
			parents: (fields[1] ?? "").split(" ").filter(Boolean),
			author: fields[2] ?? "",
			authorEmail: fields[3] ?? "",
			authorDate: secondsOf(fields[4] ?? ""),
			committer: fields[5] ?? "",
			committerEmail: fields[6] ?? "",
			committerDate: secondsOf(fields[7] ?? ""),
			// `N` is git's way of saying there is no signature to check, which is not a signature.
			signature: status && status !== "N" ? { status, signer: fields[9] ?? "", key: fields[10] ?? "" } : null,
			body: fields.slice(11).join(FIELD),
		},
	};
}

/**
 * What a root commit is diffed against: git's empty tree, whose id every repository agrees on. A root
 * commit has no parent to compare with, and `git diff <empty> <commit>` is the whole tree it added.
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * One commit's details: its own words, and the files it touched against its first parent.
 *
 * A merge commit is shown against its first parent, which is the change that landed on the branch the
 * human is looking at; a root commit is shown against the empty tree, because it has nothing else. A
 * stash is asked for by the same code with its base as the revision it is compared to.
 */
export async function getCommitDetails(repo: string, hash: string, hasParents: boolean): Promise<ReadResult<GitCommitDetails>> {
	const metadata = await readMetadata(repo, hash);
	if (!metadata.ok) return metadata;
	const base = hasParents ? `${hash}^` : EMPTY_TREE;
	const changes = await readFileChanges(["diff", ...CHANGE_ARGS, base, hash], repo);
	if (!changes.ok) return changes;
	return { ok: true, value: { ...metadata.value, fileChanges: changes.value } };
}

/**
 * One stash's details: the changes it holds, and the files it kept as untracked ones beside them.
 *
 * The untracked files live in the stash's third parent as a tree of their own, so they are listed from
 * there and drawn as `U` with no line counts: the page asks for their text only when a human opens one.
 * The selector is how the page names the stash and is not read here — the hash is the stash's commit,
 * and two selectors can name one commit once a human has dropped another.
 */
export async function getStashDetails(repo: string, selector: string, hash: string): Promise<ReadResult<GitCommitDetails>> {
	const metadata = await readMetadata(repo, hash);
	if (!metadata.ok) return metadata;
	const changes = await readFileChanges(["diff", ...CHANGE_ARGS, `${hash}^`, hash], repo);
	if (!changes.ok) return changes;
	const untracked = await gitText(repo, ["ls-tree", "-r", "--name-only", "-z", `${hash}^3`]);
	if (untracked.ok) {
		for (const path of untracked.text.split(RECORD)) {
			if (!path) continue;
			changes.value.push({ oldFilePath: path, newFilePath: path, type: "U", additions: null, deletions: null });
		}
	}
	return { ok: true, value: { ...metadata.value, fileChanges: changes.value } };
}

/**
 * The working tree as one change: what differs from `HEAD`, and every file git is not tracking yet.
 *
 * Untracked files are the reason this is not one `git diff`: git does not diff a file it has never
 * been told about, so they are listed separately and drawn as `U`, which is what the page offers to
 * view, add or clean.
 */
export async function getUncommittedDetails(repo: string): Promise<ReadResult<GitCommitDetails>> {
	const tracked = await readFileChanges(["diff", ...CHANGE_ARGS, "HEAD"], repo);
	// A repository with no commit yet has no `HEAD` to diff against, and that is not a failure: the
	// working tree is then entirely untracked files, which are read below.
	const changes: GitFileChange[] = tracked.ok ? tracked.value : [];
	const untracked = await gitText(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (!untracked.ok && !tracked.ok) return tracked;
	if (untracked.ok) {
		for (const path of untracked.text.split(RECORD)) {
			if (!path) continue;
			changes.push({ oldFilePath: path, newFilePath: path, type: "U", additions: null, deletions: null });
		}
	}
	const head = await readMetadata(repo, "HEAD");
	return {
		ok: true,
		value: {
			hash: UNCOMMITTED,
			parents: head.ok ? [head.value.hash] : [],
			author: "",
			authorEmail: "",
			authorDate: Math.floor(Date.now() / 1000),
			committer: "",
			committerEmail: "",
			committerDate: Math.floor(Date.now() / 1000),
			signature: null,
			body: "Uncommitted Changes",
			fileChanges: changes,
		},
	};
}

/**
 * The files between two revisions, which is what a code review is a checklist of.
 *
 * `*` on either side means the working tree, because that is the row the page draws for changes nobody
 * has committed and the review may be started from it.
 */
export async function getCommitComparison(repo: string, fromHash: string, toHash: string): Promise<ReadResult<GitFileChange[]>> {
	const from = fromHash === UNCOMMITTED ? "HEAD" : fromHash;
	const to = toHash === UNCOMMITTED ? null : toHash;
	const args = ["diff", ...CHANGE_ARGS, from, ...(to === null ? [] : [to])];
	return readFileChanges(args, repo);
}

// ---------- one tag ----------

/** The words `%(contents)` prints for a tag, which are its message and, for an annotated one, nothing else. */
const TAG_FORMAT = `--format=%(objectname)${REF_FIELD}%(*objectname)${REF_FIELD}%(objecttype)${REF_FIELD}%(taggername)${REF_FIELD}%(taggeremail)${REF_FIELD}%(taggerdate:iso-strict)${REF_FIELD}%(contents)${REF_RECORD}`;

/**
 * One tag, annotated or lightweight, as the details dialog shows it.
 *
 * A lightweight tag has no tagger and no message of its own, so its details are the commit's: the
 * dialog is opened by a human who asked what is behind the name, and an empty box would answer less
 * than the commit does.
 */
export async function getTagDetails(repo: string, tagName: string): Promise<ReadResult<GitTagDetails>> {
	const result = await gitText(repo, ["for-each-ref", TAG_FORMAT, `refs/tags/${tagName}`]);
	if (!result.ok) return { ok: false, error: reasonOf(result) };
	const fields = fieldsOf(recordTexts(result.text)[0] ?? "");
	const [objectHash, targetHash, objectType, taggerName, taggerEmail, taggerDate] = fields;
	if (!objectHash) return { ok: false, error: `there is no tag named ${tagName}` };
	const message = fields.slice(6).join(FIELD).replace(/\n+$/, "");
	if (objectType === "tag") {
		return {
			ok: true,
			value: {
				tagHash: objectHash,
				// git prints an email as `<a@b>`, which is not what a human wants in a dialog.
				name: taggerName ?? "",
				email: (taggerEmail ?? "").replace(/^<|>$/g, ""),
				date: taggerDate ?? "",
				message,
			},
		};
	}
	const commit = await readMetadata(repo, targetHash || objectHash);
	if (!commit.ok) return commit;
	return {
		ok: true,
		value: {
			tagHash: objectHash,
			name: commit.value.author,
			email: commit.value.authorEmail,
			date: new Date(commit.value.authorDate * 1000).toISOString(),
			message: commit.value.body,
		},
	};
}

// ---------- the repository's configuration ----------

/**
 * The records of `git config -z --list`: `key`, a newline, the value, a NUL. The newline is the
 * separator because a value may be empty and a key may not, so the first one is the boundary.
 */
function configPairs(text: string): Map<string, string> {
	const pairs = new Map<string, string>();
	for (const record of text.split(RECORD)) {
		if (!record) continue;
		const cut = record.indexOf("\n");
		if (cut < 0) continue;
		pairs.set(record.slice(0, cut), record.slice(cut + 1));
	}
	return pairs;
}

/**
 * The repository's own configuration, read so the settings panel can show what the human's git would
 * do: the two diff tools, what a bare push does, every branch's upstream, and the user details at both
 * scopes.
 *
 * Everything but the local user details is read from the merged configuration, because `diff.tool` and
 * `push.default` are usually set once globally and a panel that showed them empty would be wrong about
 * the human's own machine. The user details are read from each scope on its own, because the panel
 * edits one scope at a time and has to show what that scope holds.
 */
export async function getRepoConfig(repo: string, remotes: readonly string[]): Promise<ReadResult<GitRepoConfig>> {
	const merged = await gitText(repo, ["config", "-z", "--list"]);
	if (!merged.ok) return { ok: false, error: reasonOf(merged) };
	const all = configPairs(merged.text);
	const localResult = await gitText(repo, ["config", "-z", "--local", "--list"]);
	const local = localResult.ok ? configPairs(localResult.text) : new Map<string, string>();
	const globalResult = await gitText(repo, ["config", "-z", "--global", "--list"]);
	const global = globalResult.ok ? configPairs(globalResult.text) : new Map<string, string>();

	const branches: Record<string, { remote: string | null; pushRemote: string | null }> = {};
	for (const [key, value] of all) {
		const match = /^branch\.(.+)\.(remote|pushRemote)$/.exec(key);
		if (!match) continue;
		const held = branches[match[1]] ?? { remote: null, pushRemote: null };
		if (match[2] === "remote") held.remote = value;
		else held.pushRemote = value;
		branches[match[1]] = held;
	}

	const urls = new Map<string, { url: string | null; pushUrl: string | null }>();
	for (const [key, value] of all) {
		const match = /^remote\.(.+)\.(url|pushurl)$/.exec(key);
		if (!match) continue;
		const held = urls.get(match[1]) ?? { url: null, pushUrl: null };
		if (match[2] === "url") held.url = value;
		else held.pushUrl = value;
		urls.set(match[1], held);
	}
	// The page's own list decides the order in which its settings panel names the remotes; a remote it
	// has not heard of yet is still shown, because the panel is where it is configured.
	const ordered = remotes.length > 0 ? [...remotes, ...[...urls.keys()].filter((name) => !remotes.includes(name))] : [...urls.keys()];

	return {
		ok: true,
		value: {
			branches,
			diffTool: all.get("diff.tool") ?? null,
			guiDiffTool: all.get("diff.guitool") ?? null,
			pushDefault: all.get("push.default") ?? null,
			remotes: ordered
				.filter((name) => urls.has(name))
				.map((name) => ({ name, url: urls.get(name)?.url ?? null, pushUrl: urls.get(name)?.pushUrl ?? null })),
			user: {
				name: { local: local.get("user.name") ?? null, global: global.get("user.name") ?? null },
				email: { local: local.get("user.email") ?? null, global: global.get("user.email") ?? null },
			},
		},
	};
}

