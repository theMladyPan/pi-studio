/**
 * What replaces the editor: a diff, a file at a revision and a working file, answered as text.
 *
 * The page's own answer to "show me this diff" is to ask an editor to open a second document. There is
 * no editor here, so the daemon reads the text and the view draws it. Two rules keep that safe and
 * readable. Everything is read as bytes and capped, because a file is arbitrary input: over the cap it
 * comes back truncated with the first two megabytes, and anything holding a NUL is called binary and
 * sent with no body at all rather than decoded into replacement characters. And every read of a working
 * file goes through `containedReal`, because a checkout can hold a symlink pointing anywhere on this
 * machine, and a view that followed one would print a file the repository never had.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { runGit } from "../exec.ts";
import { UNCOMMITTED } from "./protocol.ts";
import type { GitTextView } from "./protocol.ts";
import { containedReal } from "./validate.ts";

// ---------- one answer ----------

/** What a view answers: the text to draw, or the sentence the page shows instead of it. */
export type ViewAnswer = { error: string } | { view: GitTextView };

/** How much of one file or one diff is worth handing to a browser tab. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * What is asked of git, which is more than the cap: a run cut off at exactly the cap would leave this
 * module unable to say whether the file ended there, and git reports a run it cut as a failed one.
 */
const READ_CEILING = MAX_TEXT_BYTES + 1;

// ---------- reading bounded text ----------

/** What one bounded read answered: the text, and whether there was more of it than the view draws. */
type Bounded = { ok: true; text: string; truncated: boolean; binary: boolean } | { ok: false; error: string };

/** Whether these bytes are text at all. A NUL in the first few thousand bytes is git's own answer too. */
function looksBinary(bytes: Buffer): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

/** The bytes of a run, cut to the cap and labelled for what cannot be drawn. */
function boundedText(bytes: Buffer): Bounded {
	const truncated = bytes.length > MAX_TEXT_BYTES;
	const kept = truncated ? bytes.subarray(0, MAX_TEXT_BYTES) : bytes;
	if (looksBinary(kept)) return { ok: true, text: "", truncated, binary: true };
	return { ok: true, text: kept.toString("utf8"), truncated, binary: false };
}

/** One git command that prints text, read up to the cap and no further. */
async function gitTextBounded(repo: string, args: readonly string[]): Promise<Bounded> {
	const result = await runGit(repo, args, { kind: "read", maxBytes: READ_CEILING });
	if (result.truncated) return boundedText(result.stdout);
	if (!result.ok) return { ok: false, error: result.timedOut ? "git did not answer in time" : result.stderr || "git could not read this" };
	return boundedText(result.stdout);
}

/**
 * One file out of the working tree, read through the check that proves it is inside the repository.
 *
 * The cap is enforced while reading rather than after: a file the human cannot open in a tab is not
 * worth a megabyte of resident memory first.
 */
function workingFileText(repo: string, filePath: string): Bounded {
	const contained = containedReal(repo, filePath);
	if (!contained.ok) return { ok: false, error: contained.error };
	let handle: number | null = null;
	try {
		const size = statSync(contained.fullPath).size;
		handle = openSync(contained.fullPath, "r");
		const room = Math.min(size + 1, READ_CEILING);
		const buffer = Buffer.alloc(room);
		const read = readSync(handle, buffer, 0, room, 0);
		return boundedText(buffer.subarray(0, read));
	} catch (error) {
		return { ok: false, error: `the file cannot be read: ${(error as Error).message}` };
	} finally {
		if (handle !== null) closeSync(handle);
	}
}

/** The right side of a diff against the working tree, which is a place and not a revision. */
const WORKING_TREE = "Working Tree";

/** A hash as the bar says it: seven characters, which is what a human recognises. */
function short(hash: string): string {
	if (hash === UNCOMMITTED) return "uncommitted changes";
	return hash.slice(0, 7);
}

// ---------- the diff ----------

/**
 * The text of one diff. `*` on the side being compared means the working tree, and one revision
 * compared with itself means the change it brought, which is what the page asks for when a human opens
 * a commit's own diff: `git diff <hash> <hash>` would answer nothing at all.
 */
export async function diffText(repo: string, fromHash: string, toHash: string, filePaths: readonly string[]): Promise<Bounded> {
	const paths = filePaths.length > 0 ? ["--", ...filePaths] : [];
	if (toHash === UNCOMMITTED) {
		return gitTextBounded(repo, ["diff", "--no-color", "--find-renames", fromHash === UNCOMMITTED ? "HEAD" : fromHash, ...paths]);
	}
	if (fromHash === UNCOMMITTED) return gitTextBounded(repo, ["diff", "--no-color", "--find-renames", toHash, ...paths]);
	if (fromHash === toHash) {
		// One revision against itself is the commit's own change, so it is compared with its parent; a
		// root commit has none, and `git show` is the only command that draws the whole tree it added.
		const parents = await runGit(repo, ["rev-list", "--parents", "-n", "1", toHash], { kind: "read" });
		const parent = parents.ok ? parents.stdout.toString("utf8").trim().split(" ")[1] : undefined;
		if (!parent) return gitTextBounded(repo, ["show", "--no-color", "--format=", toHash, ...paths]);
		return gitTextBounded(repo, ["diff", "--no-color", "--find-renames", parent, toHash, ...paths]);
	}
	return gitTextBounded(repo, ["diff", "--no-color", "--find-renames", fromHash, toHash, ...paths]);
}

/**
 * An untracked file drawn as the diff that adds it, because `git diff` will not show one.
 *
 * This is the one diff git cannot produce, so it is built here in git's own unified form: the header a
 * human's tools understand, the hunk that says the whole file is new, and every line prefixed with the
 * `+` that the viewer colours. A file with no newline at the end gets git's own marker line, so the
 * text never claims an ending the file does not have.
 */
export async function untrackedDiff(repo: string, filePath: string): Promise<Bounded> {
	const read = workingFileText(repo, filePath);
	if (!read.ok) return read;
	if (read.binary) return { ok: true, text: "", truncated: read.truncated, binary: true };
	const lines = read.text.split("\n");
	// A trailing newline ends the last line rather than starting an empty one.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const endsWithNewline = read.text.endsWith("\n");
	const header = [`diff --git a/${filePath} b/${filePath}`, "new file mode 100644", "--- /dev/null", `+++ b/${filePath}`];
	const hunk = `@@ -0,0 +1,${lines.length} @@`;
	const body = lines.map((line) => `+${line}`);
	const marker = endsWithNewline || lines.length === 0 ? [] : ["\\ No newline at end of file"];
	return { ok: true, text: [...header, hunk, ...body, ...marker].join("\n") + "\n", truncated: read.truncated, binary: false };
}

// ---------- the four things the page may ask to see ----------

/**
 * What the two sides of a diff are, in the words the extension's own title uses.
 *
 * One revision against itself is the change that commit brought, so its left side is its parent and is
 * written with the caret that names one: `<hash>^ ↔ <hash>`. The working tree is the right side of a
 * diff against it, and is named as a place rather than as a revision. An added or deleted file says
 * which revision brought it, because a side it never had is not worth naming.
 */
function sides(from: string, to: string, type: string): string {
	const left = from === UNCOMMITTED ? WORKING_TREE : short(from);
	const right = to === UNCOMMITTED ? WORKING_TREE : short(to);
	if (from === to) {
		if (from === UNCOMMITTED) return "Uncommitted";
		if (type === "A") return `Added in ${right}`;
		if (type === "D") return `Deleted in ${right}`;
		return `${left}^ ↔ ${right}`;
	}
	if (type === "A") return `Added between ${left} & ${right}`;
	if (type === "D") return `Deleted between ${left} & ${right}`;
	return `${left} ↔ ${right}`;
}

/** The view a diff is drawn in, with the title the bar shows: the file's own name, then both sides. */
function diffView(from: string, to: string, filePath: string, type: string, text: Bounded): ViewAnswer {
	if (!text.ok) return { error: text.error };
	return {
		view: {
			title: `${filePath.split("/").pop() ?? filePath} (${sides(from, to, type)})`,
			kind: "diff",
			content: text.binary ? "" : text.text,
			filePath,
			truncated: text.truncated,
			binary: text.binary,
		},
	};
}

/** One file as it is at one revision, which is what `viewFileAtRevision` and `openFile` both show. */
async function fileView(repo: string, hash: string, filePath: string): Promise<ViewAnswer> {
	const read = hash === UNCOMMITTED ? workingFileText(repo, filePath) : await gitTextBounded(repo, ["show", `--format=`, `${hash}:${filePath}`]);
	if (!read.ok) return { error: read.error };
	return {
		view: {
			title: `${filePath} at ${short(hash)}`,
			kind: "file",
			content: read.binary ? "" : read.text,
			filePath,
			truncated: read.truncated,
			binary: read.binary,
		},
	};
}

/** The staged diff for one file: what the index holds against HEAD, which is what a commit would carry. */
export async function cachedDiff(repo: string, filePaths: readonly string[]): Promise<{ ok: true; text: string; truncated: boolean; binary: boolean } | { ok: false; error: string }> {
	return gitTextBounded(repo, ["--literal-pathspecs", "diff", "--cached", "--no-color", "--find-renames", "--", ...filePaths]);
}

/** The working-tree diff for one tracked file: what the disk holds against the index. */
export async function workingDiff(repo: string, filePaths: readonly string[]): Promise<{ ok: true; text: string; truncated: boolean; binary: boolean } | { ok: false; error: string }> {
	return gitTextBounded(repo, ["--literal-pathspecs", "diff", "--no-color", "--find-renames", "--", ...filePaths]);
}

/**
 * What the source control drawer shows for one file: the staged diff, the working diff, or an
 * untracked file drawn as the diff that would add it. Bounded and binary-checked like every view.
 */
export async function sourceDiff(repo: string, scope: "staged" | "changes", filePaths: readonly string[], untracked: boolean): Promise<{ ok: true; text: string; truncated: boolean; binary: boolean } | { ok: false; error: string }> {
	if (scope === "staged") return cachedDiff(repo, filePaths);
	if (untracked) return untrackedDiff(repo, filePaths[0]);
	return workingDiff(repo, filePaths);
}


/**
 * The diff behind the page's "view diff" menu entry, for one changed file.
 *
 * The page sends the change's letter along with the two paths, and it is what decides which of them is
 * real: an added file has no old path, a deleted one has no new path, a copied or renamed one has both,
 * which git needs as two pathspecs to draw the rename rather than two unrelated files, and an untracked
 * one has no revision on either side at all — git will not diff a file it was never told about, so that
 * diff is built from the file's own bytes.
 */
export async function viewDiff(
	repo: string,
	fromHash: string,
	toHash: string,
	oldFilePath: string,
	newFilePath: string,
	type: string,
): Promise<ViewAnswer> {
	const filePath = newFilePath || oldFilePath;
	if (type === "U") return diffView(UNCOMMITTED, UNCOMMITTED, filePath, type, await untrackedDiff(repo, filePath));
	const paths = type === "A" ? [newFilePath] : type === "D" ? [oldFilePath] : oldFilePath === newFilePath ? [newFilePath] : [oldFilePath, newFilePath];
	const text = await diffText(repo, fromHash, toHash, paths);
	return diffView(fromHash, toHash, filePath, type, text);
}

/** The diff between one revision and the working file, which is how a human checks what they changed. */
export async function viewDiffWithWorkingFile(repo: string, hash: string, filePath: string): Promise<ViewAnswer> {
	const text = await diffText(repo, hash, UNCOMMITTED, [filePath]);
	// The working file of a tracked change: a modification, which is the one letter the title does not
	// have to mention.
	return diffView(hash, UNCOMMITTED, filePath, "M", text);
}

/**
 * One file as one revision held it, read out of the object database with `git show`.
 *
 * Nothing is ever checked out to answer this: a view is a read, and a read that moved the human's
 * working tree would be a command they did not ask for.
 */
export async function viewFileAtRevision(repo: string, hash: string, filePath: string): Promise<ViewAnswer> {
	return fileView(repo, hash, filePath);
}

/** The page's "open file": the file as it is now, or as that revision held it, drawn in this view. */
export async function openFile(repo: string, hash: string, filePath: string): Promise<ViewAnswer> {
	return fileView(repo, hash, filePath);
}
