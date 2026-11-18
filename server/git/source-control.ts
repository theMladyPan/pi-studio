/**
 * The source control drawer's backend: reading staged, changed and conflicted files, moving a file
 * between the two lists, committing the staged files, drafting a commit message with the cheapest
 * model the board already knows about, and concluding a merge once its conflicts are resolved.
 *
 * It is not the Git Graph page. That page keeps its own dispatch and its own verbs (branches, tags,
 * stashes, merges); this file owns only what a source control panel asks of git, and it asks through
 * the same `runGit` every other git surface uses, so a read cannot prompt, a write cannot hang
 * forever, and a command that would talk to a remote never runs here at all — publishing and pulling
 * stay where they already live.
 *
 * Paths a request names are folded by `cleanPaths` before git ever sees them: no absolute path, no
 * `..`, no `.git`, and the name exactly as given, because a file may end in a space. Every write
 * passes `--literal-pathspecs` and `--`, so a file named `*.txt` or `-x` is one file and not a
 * pattern or an option.
 *
 * A conflict is resolved by editing the working file and staging it, never by checking out a whole
 * side over the file, because a whole-side checkout would throw away the parts of the merge that
 * already agreed. Continue then commits the index as it stands, even when the resolved tree matches
 * HEAD, because a merge commit with two parents is the record that the merge happened.
 *
 * Writes in this file are serialised per repository by a small guard: one git change at a time, and
 * a second press while one is in flight is refused with a reason rather than queued behind it.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runGit } from "./exec.ts";
import { piCli } from "../child/argv.ts";
import { modelCatalog } from "../models.ts";

/** One file as the panel draws it: its path from the repository root and the letter on its right. */
export type ScFile = { path: string; kind: string };

/** One unmerged path, with the three index stages git holds for it (base, ours, theirs). */
export type ScConflict = { path: string; stages: { base: string | null; ours: string | null; theirs: string | null } };

/** What the panel is handed: the branch, the two lists, the conflicts, and any merge in flight. */
export type ScStatus = {
	branch: string;
	detached: boolean;
	staged: ScFile[];
	changes: ScFile[];
	conflicts: ScConflict[];
	operation: "merge" | "rebase" | "cherry-pick" | "revert" | "am" | null;
	merge: { id: string; message: string } | null;
};

/** A call that can fail in a sentence a human can act on. */
export type ScOutcome = { ok: true; status: ScStatus } | { ok: false; error: string };
export type ScCommitOutcome = { ok: true; message: string } | { ok: false; error: string };
export type ScConflictRead = { ok: true; path: string; mergeId: string; content: string; version: string } | { ok: false; error: string };

/** How much of a diff a draft may carry: enough to name the change, not enough to bill for the repo. */
const DRAFT_DIFF_CHARS = 4000;
/** How many files a draft may name before it starts naming folders instead. */
const DRAFT_FILE_NAMES = 40;
/** One request may move this many paths. Beyond it the request is a script, not a press. */
const MAX_BATCH = 500;
/** A draft that takes longer than this is not a draft, it is a wait. */
const DRAFT_TIMEOUT_MS = 60_000;
/** A draft's answer is one line; anything past this is not one line. */
const DRAFT_BYTES = 64 * 1024;
/** The editor ceiling a resolved file must fit under, the same one the files editor holds. */
const MAX_FILE_BYTES = 512 * 1024;
/** The empty tree, which un-staging from an unborn HEAD restores from: there is no HEAD to restore from. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Names that are never a message worth drafting, whatever their price tag says. */
const NOT_DRAFTABLE = ["preview", "research", "robotics", "computer-use", "embedding", "rerank"];

/** Repositories with a git change in flight in this process, keyed by their root. */
const inFlight = new Set<string>();

/** Take the repository's write lock, or name the press that holds it. Released by the caller. */
function holdWrite(root: string): { ok: true } | { ok: false; error: string } {
	if (inFlight.has(root)) return { ok: false, error: "another git change is already in flight in this repository" };
	inFlight.add(root);
	return { ok: true };
}

/** What a name says about its price, cheapest first. A name with no cheap word in it is the dear end. */
function cheapness(model: string): number {
	// Words, not letters: `gemini` carries `mini` inside it, and a pro model is not a mini one.
	const words = model.toLowerCase().split(/[^a-z0-9]+/);
	if (words.some((word) => word === "lite" || word === "mini" || word === "nano")) return 0;
	if (words.includes("haiku")) return 1;
	if (words.some((word) => word === "flash" || word === "small")) return 2;
	return 3;
}

/**
 * The cheapest model in a list, by name — because the list carries no prices, and a guess written
 * down beats a guess spread across the caller. Deterministic on purpose: the same list always
 * picks the same model, and the tie-break is the shorter name, then the name itself.
 */
export function cheapestModel(models: readonly { provider: string; model: string }[]): { provider: string; model: string } | null {
	const usable = (models ?? []).filter(
		(one) => one && typeof one.provider === "string" && typeof one.model === "string" && one.provider && one.model && !NOT_DRAFTABLE.some((word) => one.model.toLowerCase().includes(word)),
	);
	if (!usable.length) return null;
	return [...usable].sort((a, b) => {
		const byPrice = cheapness(a.model) - cheapness(b.model);
		if (byPrice) return byPrice;
		if (a.model.length !== b.model.length) return a.model.length - b.model.length;
		const byModel = a.model.localeCompare(b.model);
		return byModel || a.provider.localeCompare(b.provider);
	})[0];
}

/** The repository root for a folder, or null when the folder is not in one. */
async function toplevel(folder: string): Promise<string | null> {
	const found = await runGit(folder, ["rev-parse", "--show-toplevel"], { kind: "read" });
	return found.ok && found.stdout.toString().trim() ? found.stdout.toString().trim() : null;
}

/**
 * A request's paths, folded into the only shape git is handed: repository-relative, no escapes, no
 * absolute names, no `.git`, and the name exactly as given. Anything else is an error naming the
 * path, so one bad name refuses the batch rather than quietly staging half of it.
 */
export function cleanPaths(input: unknown): { ok: true; paths: string[] } | { ok: false; error: string } {
	if (!Array.isArray(input)) return { ok: false, error: "a list of files is needed" };
	if (!input.length) return { ok: false, error: "no files were picked" };
	if (input.length > MAX_BATCH) return { ok: false, error: `too many files in one press: ${MAX_BATCH} at most` };
	const paths: string[] = [];
	for (const one of input) {
		if (typeof one !== "string" || !one.trim()) return { ok: false, error: "a file name is not a name" };
		const path = one;
		const segments = path.split("/");
		if (/[\0-\x1f\x7f]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path) || segments.some((part) => part === ".." || part === ".git" || part === "")) {
			return { ok: false, error: `that is not a file in this repository: ${path}` };
		}
		if (!paths.includes(path)) paths.push(path);
	}
	return { ok: true, paths };
}

/** The letter a porcelain row wears, with an untracked file named the way the panel names it. */
function kindOf(x: string, y: string): string {
	if (x === "?" || y === "?") return "U";
	return x !== " " && x !== "?" ? x : y;
}

/** Whether a porcelain row is an unmerged one: a `U` anywhere, or both sides added/deleted it. */
function unmergedOf(x: string, y: string): boolean {
	return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

/** The conflicts as the index holds them: one entry per unmerged path, stages 1 (base), 2, 3. */
async function conflictsOf(root: string): Promise<{ ok: true; conflicts: ScConflict[] } | { ok: false; error: string }> {
	const listed = await runGit(root, ["ls-files", "-u", "-z"], { kind: "read" });
	if (!listed.ok) return { ok: false, error: listed.stderr || "git could not read the conflicts" };
	const byPath = new Map<string, ScConflict>();
	for (const entry of listed.stdout.toString().split("\0")) {
		if (!entry) continue;
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const [mode, oid, stage] = entry.slice(0, tab).split(" ");
		const path = entry.slice(tab + 1);
		let conflict = byPath.get(path);
		if (!conflict) {
			conflict = { path, stages: { base: null, ours: null, theirs: null } };
			byPath.set(path, conflict);
		}
		if (stage === "1") conflict.stages.base = oid;
		else if (stage === "2") conflict.stages.ours = oid;
		else if (stage === "3") conflict.stages.theirs = oid;
		void mode;
	}
	return { ok: true, conflicts: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Which sequencer in progress owns this checkout, read from the administrative files git names. */
async function operationOf(root: string): Promise<{ operation: ScStatus["operation"]; merge: ScStatus["merge"] }> {
	const gitPath = async (name: string): Promise<string | null> => {
		const found = await runGit(root, ["rev-parse", "--path-format=absolute", "--git-path", name], { kind: "read" });
		return found.ok && found.stdout.toString().trim() ? found.stdout.toString().trim() : null;
	};
	const read = (path: string | null): string => {
		if (!path) return "";
		try {
			return readFileSync(path, "utf8").trim();
		} catch {
			return "";
		}
	};
	const [mergeHead, rebaseMerge, rebaseApply, cherryPick, revert] = await Promise.all([
		gitPath("MERGE_HEAD"),
		gitPath("rebase-merge"),
		gitPath("rebase-apply"),
		gitPath("CHERRY_PICK_HEAD"),
		gitPath("REVERT_HEAD"),
	]);
	if (mergeHead && read(mergeHead)) {
		const message = read(await gitPath("MERGE_MSG"));
		const head = read(mergeHead);
		return { operation: "merge", merge: { id: createHash("sha256").update(head).digest("hex").slice(0, 16), message } };
	}
	// `git rev-parse --git-path` prints the path whether or not the file exists, so existence is
	// the `existsSync` question, never the path's truthiness.
	if ((rebaseMerge && existsSync(rebaseMerge)) || (rebaseApply && existsSync(rebaseApply)))
		return { operation: rebaseApply && existsSync(join(rebaseApply, "applying")) ? "am" : "rebase", merge: null };
	if (cherryPick && existsSync(cherryPick)) return { operation: "cherry-pick", merge: null };
	if (revert && existsSync(revert)) return { operation: "revert", merge: null };
	return { operation: null, merge: null };
}

/** Read the two lists, the conflicts, the branch, and any merge in flight. */
export async function sourceControlStatus(folder: string): Promise<ScOutcome> {
	const root = await toplevel(folder);
	if (!root) return { ok: false, error: "this folder is not a git repository" };
	const [porcelain, branch, conflicts, operation] = await Promise.all([
		runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { kind: "read" }),
		runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], { kind: "read" }),
		conflictsOf(root),
		operationOf(root),
	]);
	if (!porcelain.ok) return { ok: false, error: porcelain.stderr || "git could not read this repository" };
	if (!conflicts.ok) return conflicts;
	const conflicted = new Set(conflicts.conflicts.map((one) => one.path));
	const staged: ScFile[] = [];
	const changes: ScFile[] = [];
	const rows = porcelain.stdout.toString().split("\0");
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (!row) continue;
		const x = row[0] ?? " ";
		const y = row[1] ?? " ";
		let path = row.slice(3);
		if ((x === "R" || x === "C" || y === "R" || y === "C") && rows[i + 1]) {
			// Porcelain -z names the destination first and the source second; the panel lists the
			// file by the name it has now, and the source is consumed so it is not listed twice.
			i += 1;
		}
		if (unmergedOf(x, y) || conflicted.has(path)) continue;
		if (x !== " " && x !== "?") staged.push({ path, kind: kindOf(x, y) });
		if (y !== " " || x === "?") changes.push({ path, kind: kindOf(x, y) });
	}
	const head = branch.ok ? branch.stdout.toString().trim() : "";
	return {
		ok: true,
		status: {
			branch: head,
			detached: head === "HEAD",
			staged,
			changes,
			conflicts: conflicts.conflicts,
			operation: operation.operation,
			merge: operation.merge,
		},
	};
}

/** Stage or unstage a list of files, and answer with the lists as they now stand. */
export async function sourceControlStage(folder: string, input: unknown, stage: boolean): Promise<ScOutcome> {
	const root = await toplevel(folder);
	if (!root) return { ok: false, error: "this folder is not a git repository" };
	const cleaned = cleanPaths(input);
	if (!cleaned.ok) return cleaned;
	const conflicts = await conflictsOf(root);
	if (!conflicts.ok) return conflicts;
	const blocked = cleaned.paths.find((path) => conflicts.conflicts.some((one) => one.path === path));
	if (blocked) return { ok: false, error: `a conflicted file is resolved in the merge editor, not staged: ${blocked}` };
	const held = holdWrite(root);
	if (!held.ok) return held;
	try {
		let args: string[];
		if (stage) {
			args = ["--literal-pathspecs", "add", "--", ...cleaned.paths];
		} else {
			const head = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { kind: "read" });
			// An unborn HEAD has nothing to restore from; the empty tree is the index as it began.
			args = head.ok
				? ["--literal-pathspecs", "restore", "--staged", "--", ...cleaned.paths]
				: ["--literal-pathspecs", "restore", "--staged", `--source=${EMPTY_TREE}`, "--", ...cleaned.paths];
		}
		const written = await runGit(root, args, { kind: "write" });
		if (!written.ok) return { ok: false, error: written.stderr || "git could not change the staged files" };
		return await sourceControlStatus(folder);
	} finally {
		inFlight.delete(root);
	}
}

/** Commit the staged files under a message. Nothing staged, or no message, is a refusal with a reason. */
export async function sourceControlCommit(folder: string, message: unknown): Promise<ScCommitOutcome> {
	const text = typeof message === "string" ? message.trim() : "";
	if (!text) return { ok: false, error: "a commit message is needed" };
	if (text.length > 1000) return { ok: false, error: "that message is too long for one commit" };
	const root = await toplevel(folder);
	if (!root) return { ok: false, error: "this folder is not a git repository" };
	const operation = await operationOf(root);
	if (operation.operation === "merge") return { ok: false, error: "a merge is in flight: resolve its conflicts and press Continue" };
	const staged = await runGit(root, ["diff", "--cached", "--name-only", "-z"], { kind: "read" });
	if (!staged.ok) return { ok: false, error: staged.stderr || "git could not read the staged files" };
	if (!staged.stdout.toString().split("\0").some(Boolean)) return { ok: false, error: "nothing is staged: stage a file first" };
	const held = holdWrite(root);
	if (!held.ok) return held;
	try {
		const committed = await runGit(root, ["commit", "-m", text], { kind: "write" });
		if (!committed.ok) return { ok: false, error: committed.stderr || "git could not make the commit" };
		return { ok: true, message: text };
	} finally {
		inFlight.delete(root);
	}
}

/** One single-answer pi run: no tools, no session, no extensions, and a hard ceiling on time. */
function runDraft(cli: { command: string; args: string[] }, folder: string, model: { provider: string; model: string }, prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			cli.command,
			[...cli.args, "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--provider", model.provider, "--model", model.model, "--thinking", "off", prompt],
			{ cwd: folder, stdio: ["ignore", "pipe", "pipe"] },
		);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let bytes = 0;
		const timer = setTimeout(() => child.kill("SIGKILL"), DRAFT_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes <= DRAFT_BYTES) out.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(Buffer.concat(err).toString().trim() || `pi stopped with ${code}`));
			resolve(Buffer.concat(out).toString());
		});
	});
}

/** The capped summary of the staged diff a draft is allowed to read. */
export async function draftSummary(folder: string): Promise<string> {
	const root = (await toplevel(folder)) ?? folder;
	const [names, stat, diff] = await Promise.all([
		runGit(root, ["diff", "--cached", "--name-only", "-z"], { kind: "read" }),
		runGit(root, ["diff", "--cached", "--stat"], { kind: "read", maxBytes: 4096 }),
		runGit(root, ["diff", "--cached"], { kind: "read", maxBytes: DRAFT_DIFF_CHARS * 4 }),
	]);
	const files = names.ok ? names.stdout.toString().split("\0").filter(Boolean) : [];
	const shown = files.slice(0, DRAFT_FILE_NAMES);
	const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more files` : "";
	// A truncated diff still carries its beginning: dropping it entirely would leave the draft
	// with names and no change at all, which is worse than a capped excerpt that says it is capped.
	const diffText = diff.stdout.toString().slice(0, DRAFT_DIFF_CHARS);
	const diffNote = diff.truncated ? "\n(diff excerpt is capped)" : "";
	return [
		`Staged files (${files.length}):`,
		shown.join("\n"),
		more,
		stat.stdout.toString().trim().slice(0, 1024),
		"Diff (capped):",
		diffText + diffNote,
	]
		.filter(Boolean)
		.join("\n");
}

export type ScDraftDeps = {
	run?: typeof runDraft;
	catalog?: () => Promise<{ models: { provider: string; model: string }[] } | null>;
};

/** Draft one commit message for the staged files. Never commits, and never invents one on failure. */
export async function sourceControlMessage(folder: string, deps: ScDraftDeps = {}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
	const status = await sourceControlStatus(folder);
	if (!status.ok) return status;
	if (status.status.operation === "merge") return { ok: false, error: "a merge is in flight: its message is already written" };
	if (!status.status.staged.length) return { ok: false, error: "nothing is staged: stage a file first" };
	const readCatalog = deps.catalog ?? (async () => (await modelCatalog()) as { models: { provider: string; model: string }[] } | null);
	const catalog = await readCatalog();
	const model = cheapestModel(catalog?.models ?? []);
	if (!model) return { ok: false, error: "no model is available to draft a message" };
	const summary = await draftSummary(folder);
	const prompt = [
		"Write exactly one line of a git commit message in conventional style: type(scope): summary.",
		"Use a type from feat, fix, docs, refactor, test, chore. Keep it under 80 characters.",
		"Reply with the message only: no quotes, no code fence, no explanation.",
		"",
		summary,
	].join("\n");
	let answer: string;
	try {
		answer = await (deps.run ?? runDraft)(piCli(), folder, model, prompt);
	} catch (error) {
		return { ok: false, error: `the model could not draft a message: ${(error as Error).message}` };
	}
	const message = answer
		.split("\n")
		.map((line) => line.trim().replace(/^[`"'*>\s]+|[`"'*\s]+$/g, ""))
		.find(Boolean);
	if (!message) return { ok: false, error: "the model answered with no message" };
	return { ok: true, message: message.slice(0, 200) };
}

// ---------- conflicts ----------

/** Whether text still carries an unresolved conflict marker, in any of the shapes git writes. */
export function hasConflictMarkers(text: string): boolean {
	return /^<{7}( |$)|^\|{7}( |$)|^={7}$|^>{7}( |$)/m.test(text);
}

/** The merge identity a resolve or continue must still match, so a stale editor cannot win a race. */
async function mergeIdOf(root: string): Promise<string | null> {
	const operation = await operationOf(root);
	return operation.merge ? operation.merge.id : null;
}

/** A conflicted file's text, if it is a plain text file small enough to edit. */
export async function sourceControlConflict(folder: string, path: unknown): Promise<ScConflictRead> {
	if (typeof path !== "string" || !path.trim()) return { ok: false, error: "a file is needed" };
	const cleaned = cleanPaths([path]);
	if (!cleaned.ok) return cleaned;
	const root = await toplevel(folder);
	if (!root) return { ok: false, error: "this folder is not a git repository" };
	const mergeId = await mergeIdOf(root);
	if (!mergeId) return { ok: false, error: "no merge is in flight in this repository" };
	const conflicts = await conflictsOf(root);
	if (!conflicts.ok) return conflicts;
	if (!conflicts.conflicts.some((one) => one.path === path)) return { ok: false, error: `that file has no conflict: ${path}` };
	let bytes: Buffer;
	try {
		bytes = readFileSync(join(root, path));
	} catch {
		return { ok: false, error: `that file could not be read: ${path}` };
	}
	if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: "that file is too large for the merge editor" };
	if (bytes.includes(0)) return { ok: false, error: "that file is not text, so resolve it outside the editor" };
	return { ok: true, path, mergeId, content: bytes.toString("utf8"), version: createHash("sha256").update(bytes).digest("hex") };
}

/** Save a resolved file and stage exactly it. The text must carry no markers and must be current. */
export async function sourceControlResolve(folder: string, input: { path?: unknown; mergeId?: unknown; version?: unknown; content?: unknown }): Promise<ScOutcome> {
	const cleaned = cleanPaths([input?.path]);
	if (!cleaned.ok) return cleaned;
	const path = cleaned.paths[0];
	if (typeof input?.content !== "string") return { ok: false, error: "the resolved text is needed" };
	if (typeof input?.version !== "string" || typeof input?.mergeId !== "string") return { ok: false, error: "the editor's version is needed" };
	if (hasConflictMarkers(input.content)) return { ok: false, error: "conflict markers remain: accept or remove every hunk first" };
	const root = await toplevel(folder);
	if (!root) return { ok: false, error: "this folder is not a git repository" };
	const held = holdWrite(root);
	if (!held.ok) return held;
	try {
		const mergeId = await mergeIdOf(root);
		if (!mergeId || mergeId !== input.mergeId) return { ok: false, error: "the merge changed while the editor was open: reopen the file" };
		const current = await sourceControlConflict(folder, path);
		if (!current.ok) return current;
		if (current.version !== input.version) return { ok: false, error: "the file changed on disk since it was opened: reopen it" };
		const target = join(root, path);
		const temp = join(root, `.pi-studio-resolve-${randomUUID()}`);
		await writeFile(temp, input.content, "utf8");
		await rename(temp, target);
		const staged = await runGit(root, ["--literal-pathspecs", "add", "--", path], { kind: "write" });
		if (!staged.ok) return { ok: false, error: `the text was saved but not staged: ${staged.stderr || "git could not stage it"}` };
		return await sourceControlStatus(folder);
	} finally {
		inFlight.delete(root);
	}
}

/** Conclude the merge: commit the index as it stands, with the message the field holds. */
export async function sourceControlContinue(folder: string, input: { message?: unknown }): Promise<ScOutcome> {
	const text = typeof input?.message === "string" ? input.message.trim() : "";
	if (!text) return { ok: false, error: "a merge message is needed" };
	if (text.length > 4096) return { ok: false, error: "that message is too long for one commit" };
	const root = await toplevel(folder);
	if (!root) return { ok: false, error: "this folder is not a git repository" };
	const held = holdWrite(root);
	if (!held.ok) return held;
	try {
		const operation = await operationOf(root);
		if (operation.operation !== "merge") return { ok: false, error: "no merge is in flight in this repository" };
		const conflicts = await conflictsOf(root);
		if (!conflicts.ok) return conflicts;
		if (conflicts.conflicts.length) return { ok: false, error: `conflicts remain: ${conflicts.conflicts.map((one) => one.path).join(", ")}` };
		const committed = await runGit(root, ["commit", "--cleanup=strip", "-m", text], { kind: "write" });
		if (!committed.ok) return { ok: false, error: committed.stderr || "git could not conclude the merge" };
		return await sourceControlStatus(folder);
	} finally {
		inFlight.delete(root);
	}
}
