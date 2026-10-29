// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Naming a thread: asking a model what the request was about, and settling which branch the worktree's
 * own commits ended up on.
 */
import { join, resolve } from "node:path";
import { answer } from "../http.ts";
import { spawn } from "node:child_process";
import { piCli } from "../child/argv.ts";
import { MAX_TITLE_CHARS } from "../limits.ts";
import { update } from "../bus.ts";
import { scheduleSave } from "../store.ts";
import { existsSync } from "node:fs";
import { headBranch, shortId, slugOf, workType } from "./make.ts";
import { gitIn } from "../git/repo.ts";



/** How long a thread's name may be before the first request is cut at a word. */
export const TITLE_FROM_REQUEST_CHARS = 48;


/**
 * The model that names a thread once its first request is in hand. Empty turns naming off.
 * `inception/mercury-3` was the first choice and answers 404 (no endpoints for the routing this
 * machine gets), so the default is the fastest flash model measured here: 2.1s against 10.7s for the
 * copilot one. Any other model is a `PI_STUDIO_NAME_MODEL` away.
 */
export const NAME_MODEL = process.env.PI_STUDIO_NAME_MODEL ?? "openrouter/z-ai/glm-5.3-flash";


export const NAME_TIMEOUT_MS = 8000;


/** Names that describe the fact that a job exists rather than the job. */
export const DULL_TITLES = new Set(["work", "job", "task", "thread", "new thread", "change", "update", "stuff", "question"]);



/**
 * A thread's name from its own first request: the first line, without the markdown that dresses it,
 * cut at a word. It exists so no card is ever nameless and none is called `thread 1`, and so a model
 * that is slow or absent costs a better name rather than any name at all.
 */
export function titleFromRequest(text) {
	const line =
		String(text ?? "")
			.split("\n")
			.map((part) => part.trim())
			.find(Boolean) ?? "";
	const plain = line.replace(/[`*_>#]/g, "").replace(/\s+/g, " ").trim();
	if (plain.length <= TITLE_FROM_REQUEST_CHARS) return plain;
	const cut = plain.slice(0, TITLE_FROM_REQUEST_CHARS);
	const space = cut.lastIndexOf(" ");
	return `${(space > 20 ? cut.slice(0, space) : cut).trim()}…`;
}



/**
 * What to ask the naming model. The gate below is code rather than the model's opinion, so the
 * examples say what a good card name looks like instead of pleading for one.
 */
export function namePrompt(request) {
	return [
		"Name this job for a card on a board of work. Answer with two to four plain words and nothing else.",
		"Examples:",
		'- request: "why does the parser reject empty input?" -> ok: empty input rejection / not ok: parser (says nothing) or: The Parser Rejects Empty Input Because The Tokenizer Splits Wrong (a sentence)',
		'- request: "add a dark theme to the board" -> ok: board dark theme / not ok: add a dark theme to the board (the request repeated)',
		'- request: "the rail keeps no detail for a row" -> ok: rail row detail / not ok: bug (a category, not the work)',
		`Request: ${request}`,
	].join("\n");
}



/** A name as a card title, or "" when it is not one: two to four words that say something. */
export function plausibleTitle(answer) {
	const first =
		String(answer ?? "")
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	const words = first.replace(/[`*_"']/g, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
	const lower = words.toLowerCase();
	if (!lower || DULL_TITLES.has(lower) || /^thread (\d+|[0-9a-f]{8})$/.test(lower)) return "";
	const count = lower.split(" ").length;
	return count >= 2 && count <= 4 ? words : "";
}



/**
 * One question and one answer from a `pi` that must not read stdin: `execFile` leaves stdin an open
 * pipe, and a `pi -p` on an open pipe waits for input that never comes.
 */
export function askOnce(argv, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve("");
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve("");
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out);
		});
	});
}



/**
 * A better name for a thread than its request's own words, asked beside the turn so no model's latency
 * sits in front of the answer. A name the human typed, or one already given by the model, is never
 * overwritten.
 */
export async function nameThread(board, thread, request) {
	const asked = request.slice(0, 2000);
	const cli = piCli();
	const argv = [cli.command, ...cli.args, "-p", "--no-session", "-ne", "-nt", "-nc", "-ns", "--model", NAME_MODEL];
	const said = await askOnce([...argv, namePrompt(asked)], NAME_TIMEOUT_MS);
	const picked = plausibleTitle(said);
	if (!picked) {
		// Said out loud because a name that never arrives looks exactly like a model that is not here.
		console.error(`pi-studio: naming gave no usable name (${JSON.stringify(said.slice(0, 80))})`);
		return;
	}
	// The card may be gone, renamed by the human, or named again while the model was thinking.
	if (!board.threads.has(thread.id) || thread.namedBy !== "request") return;
	thread.title = picked.slice(0, MAX_TITLE_CHARS);
	thread.namedBy = NAME_MODEL;
	update(board, thread);
	scheduleSave(board);
}



/**
 * What the tree has become since the last turn: the branch the child cut for itself, or a branch the
 * board has to cut on its behalf.
 *
 * A child is told to branch before it edits. One that skipped that and committed on the detached base
 * left its commits reachable from the reflog alone, where a sweep reads the tree as empty, so the work
 * is named here rather than lost. The name comes from the commit it wrote, which is the one piece of
 * text that describes what the work turned out to be.
 */
export function settleTreeBranch(board, thread) {
	const tree = thread.worktree;
	if (!tree?.path || !existsSync(tree.path)) return;
	const head = headBranch(tree.path);
	if (head) {
		if (head === tree.branch) return;
		tree.branch = head;
		scheduleSave(board);
		return;
	}
	const ahead = gitIn(tree.path, ["rev-list", "--count", `${tree.base}..HEAD`]);
	if (!ahead.ok || Number(ahead.out) < 1) return;
	const subject = gitIn(tree.path, ["log", "-1", "--format=%s"]).out;
	// The subject carries its own `<type>:` prefix, and a branch that reads `chore/chore-add-a-file` says
	// the kind of change twice. The prefix already chose the type, so the slug is what follows it.
	const bare = subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "");
	const slug = slugOf(bare);
	const branch = `${workType(subject, thread.type)}/${slug === "work" ? "wip" : slug}-${shortId(thread)}`;
	if (!gitIn(tree.path, ["checkout", "-b", branch]).ok) return;
	tree.branch = branch;
	scheduleSave(board);
}
