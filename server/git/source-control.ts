/**
 * The source control drawer's backend: reading staged and changed files, moving a file between the
 * two lists, committing the staged files, and drafting a commit message with the cheapest model the
 * board already knows about.
 *
 * It is not the Git Graph page. That page keeps its own dispatch and its own verbs (branches, tags,
 * stashes, merges); this file owns only the four things a source control panel asks of git, and it
 * asks them through the same `runGit` every other git surface uses, so a read cannot prompt, a write
 * cannot hang forever, and a command that would talk to a remote never runs here at all — publishing
 * and pulling stay where they already live.
 *
 *Paths a request names are folded by `cleanPaths` before git ever sees them: no absolute path, no
 * `..`, no `.git`, nothing starting with a dash. The write commands still pass `--` and
 * `--end-of-options`, so a file named `-x` is a file and not an option.
 *
 * The draft never commits. It sends a capped summary of the staged diff — file names, counts and a
 * bounded slice of the diff itself — to one single-answer pi run with no tools and no session, and
 * hands back the first line. A failure there is the caller's to show, not a message to invent.
 */
import { spawn } from "node:child_process";
import { runGit } from "./exec.ts";
import { piCli } from "../child/argv.ts";
import { modelCatalog } from "../models.ts";

/** One file as the panel draws it: its path from the repository root and the letter on its right. */
export type ScFile = { path: string; kind: string };

/** What the panel is handed: the branch, and the two lists it moves files between. */
export type ScStatus = { branch: string; detached: boolean; staged: ScFile[]; changes: ScFile[] };

/** A call that can fail in a sentence a human can act on. */
export type ScOutcome = { ok: true; status: ScStatus } | { ok: false; error: string };
export type ScCommitOutcome = { ok: true; message: string } | { ok: false; error: string };

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

/** Names that are never a message worth drafting, whatever their price tag says. */
const NOT_DRAFTABLE = ["preview", "research", "robotics", "computer-use", "embedding", "rerank"];

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
 * absolute names, no `.git`. Anything else is an error naming the path, so one bad name refuses the
 * batch rather than quietly staging half of it.
 */
export function cleanPaths(input: unknown): { ok: true; paths: string[] } | { ok: false; error: string } {
	if (!Array.isArray(input)) return { ok: false, error: "a list of files is needed" };
	if (!input.length) return { ok: false, error: "no files were picked" };
	if (input.length > MAX_BATCH) return { ok: false, error: `too many files in one press: ${MAX_BATCH} at most` };
	const paths: string[] = [];
	for (const one of input) {
		if (typeof one !== "string" || !one.trim()) return { ok: false, error: "a file name is not a name" };
		const path = one.trim();
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

/** Read the two lists, the branch, and whether the checkout is detached. */
export async function sourceControlStatus(folder: string): Promise<ScOutcome> {
	const root = await toplevel(folder);
	if (!root) return { ok: false, error: "this folder is not a git repository" };
	const [porcelain, branch] = await Promise.all([
		runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { kind: "read" }),
		runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], { kind: "read" }),
	]);
	if (!porcelain.ok) return { ok: false, error: porcelain.stderr || "git could not read this repository" };
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
			// A rename carries its old path first; the panel lists the file by the name it has now.
			i += 1;
			path = rows[i];
		}
		if (x !== " " && x !== "?") staged.push({ path, kind: kindOf(x, y) });
		if (y !== " " || x === "?") changes.push({ path, kind: kindOf(x, y) });
	}
	const head = branch.ok ? branch.stdout.toString().trim() : "";
	return { ok: true, status: { branch: head, detached: head === "HEAD", staged, changes } };
}

/** Stage or unstage a list of files, and answer with the two lists as they now stand. */
export async function sourceControlStage(folder: string, input: unknown, stage: boolean): Promise<ScOutcome> {
	const root = await toplevel(folder);
	if (!root) return { ok: false, error: "this folder is not a git repository" };
	const cleaned = cleanPaths(input);
	if (!cleaned.ok) return cleaned;
	const args = stage ? ["add", "--end-of-options", ...cleaned.paths] : ["restore", "--staged", "--", ...cleaned.paths];
	const written = await runGit(root, args, { kind: "write" });
	if (!written.ok) return { ok: false, error: written.stderr || "git could not change the staged files" };
	return sourceControlStatus(folder);
}

/** Commit the staged files under a message. Nothing staged, or no message, is a refusal with a reason. */
export async function sourceControlCommit(folder: string, message: unknown): Promise<ScCommitOutcome> {
	const text = typeof message === "string" ? message.trim() : "";
	if (!text) return { ok: false, error: "a commit message is needed" };
	if (text.length > 1000) return { ok: false, error: "that message is too long for one commit" };
	const root = await toplevel(folder);
	if (!root) return { ok: false, error: "this folder is not a git repository" };
	const staged = await runGit(root, ["diff", "--cached", "--name-only", "-z"], { kind: "read" });
	if (!staged.ok) return { ok: false, error: staged.stderr || "git could not read the staged files" };
	if (!staged.stdout.toString().split("\0").some(Boolean)) return { ok: false, error: "nothing is staged: stage a file first" };
	const committed = await runGit(root, ["commit", "-m", text], { kind: "write" });
	if (!committed.ok) return { ok: false, error: committed.stderr || "git could not make the commit" };
	return { ok: true, message: text };
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
		runGit(root, ["diff", "--cached", "--stat"], { kind: "read" }),
		runGit(root, ["diff", "--cached"], { kind: "read", maxBytes: DRAFT_DIFF_CHARS * 4 }),
	]);
	const files = names.ok ? names.stdout.toString().split("\0").filter(Boolean) : [];
	const shown = files.slice(0, DRAFT_FILE_NAMES);
	const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more files` : "";
	return [
		`Staged files (${files.length}):`,
		shown.join("\n"),
		more,
		stat.ok ? stat.stdout.toString().trim() : "",
		"Diff (capped):",
		diff.ok ? diff.stdout.toString().slice(0, DRAFT_DIFF_CHARS) : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** Draft one commit message for the staged files. Never commits, and never invents one on failure. */
export async function sourceControlMessage(folder: string, run: typeof runDraft = runDraft): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
	const status = await sourceControlStatus(folder);
	if (!status.ok) return status;
	if (!status.status.staged.length) return { ok: false, error: "nothing is staged: stage a file first" };
	const catalog = (await modelCatalog()) as { models: { provider: string; model: string }[] } | null;
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
		answer = await run(piCli(), folder, model, prompt);
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
