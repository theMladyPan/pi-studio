// @ts-nocheck -- mirrors the naming helper: prompts are verbatim, untyped by design.
/**
 * One sentence of help for a git failure: what happened and what to do next.
 *
 * Asked once with the helper model, thinking off, beside the failure rather than in
 * front of it. The dialog already shows git's own words; this fills in beside them
 * and never replaces them. A failed call answers nothing, because the details stay
 * readable on their own and a second error dialog would hide them.
 */
import { spawn } from "node:child_process";
import { piCli } from "../../child/argv.ts";
import { helperModel } from "../../workspaces.ts";

/** How much of git's output one explanation may read. */
export const EXPLAIN_INPUT_CHARS = 4000;
/** A draft that takes longer than this is not help, it is a wait. */
export const EXPLAIN_TIMEOUT_MS = 8000;
/** One sentence asked for; anything past this is not one sentence. */
export const EXPLAIN_BYTES = 4 * 1024;
/** How much of the answer the dialog shows. */
export const EXPLAIN_CHARS = 600;

/**
 * What to ask the helper. The gate in `plausibleHelp` is code rather than the
 * model's opinion, so the examples say what a good answer looks like.
 */
export function explainPrompt(command, details) {
	const clean = String(details ?? "").trim().slice(0, EXPLAIN_INPUT_CHARS);
	const what = typeof command === "string" && command ? ` The git command was ${command}.` : "";
	return [
		`Explain this git failure in exactly one sentence: what happened and what to do next.${what} No code, no list, no greeting.`,
		"Examples:",
		'- failure: "CONFLICT (content): Merge conflict in f.txt\\nAutomatic merge failed" -> ok: Both branches changed f.txt, so resolve the conflict, stage the file and commit. / not ok: Merge conflict (says nothing) or: A merge conflict happened because both branches edited the same file and you need to resolve it by editing the file and staging it and then committing the result (a paragraph)',
		'- failure: "fatal: The current branch \'main\' has no upstream branch" -> ok: Main has no upstream, so push with -u origin main to set one. / not ok: You cannot push (says nothing) or: error: src refspec main does not match any (the output repeated)',
		'- failure: "error: branch \'feat/x\' is not fully merged" -> ok: Feat/x is not merged, so force-delete with -D or merge it first. / not ok: hi — how can I help? (a reply to the failure)',
		"",
		`Failure: ${clean}`,
		"Answer with one sentence only.",
	].join("\n");
}

/**
 * The answer as one sentence, or "" when it is not one: the first line, without
 * quotes, fences or a bullet, cut to what the dialog shows.
 */
export function plausibleHelp(answer) {
	const first =
		String(answer ?? "")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !/^```/.test(line))
			.find(Boolean) ?? "";
	if (!first || /how can i help\?/i.test(first) || /^["'`\s]*(hi|hello)\b/i.test(first)) return "";
	const words = first
		.replace(/^```\w*\n?/, "")
		.replace(/```$/, "")
		.replace(/^[#>*\s-]+/, "")
		.replace(/^\d+[.)]\s*/, "")
		.replace(/^[`*"']+|[`*"'\s]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!words) return "";
	// Keep the first sentence only: the model was asked for one and may still add a second.
	const end = words.search(/[.!?]\s/);
	const sentence = end > 0 ? words.slice(0, end + 1) : words;
	return sentence.slice(0, EXPLAIN_CHARS);
}

/**
 * One single-answer pi run: no tools, no session, thinking off, one call, hard ceiling.
 * Mirrors the commit draft in `source-control.ts`, narrowed to one sentence.
 */
export function runExplain(cli, folder, prompt, model, timeoutMs = EXPLAIN_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			cli.command,
			[...cli.args, "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", model, "--thinking", "off", prompt],
			{ cwd: folder, stdio: ["ignore", "pipe", "pipe"] },
		);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let bytes = 0;
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes <= EXPLAIN_BYTES) out.push(chunk);
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

/** One sentence for a git failure, or null when no model answers. Never throws. */
export async function explainGitError(details, command, deps = {}) {
	const text = String(details ?? "").trim();
	if (!text) return null;
	const model = deps.model ?? helperModel();
	if (!model) return null;
	const folder = deps.folder ?? process.cwd();
	try {
		const answer = await (deps.run ?? runExplain)(piCli(), folder, explainPrompt(command, text), model, deps.timeoutMs ?? EXPLAIN_TIMEOUT_MS);
		const help = plausibleHelp(answer);
		if (!help) {
			console.error(`pi-studio: explain gave no usable sentence (${JSON.stringify(String(answer).slice(0, 80))})`);
			return null;
		}
		return help;
	} catch (error) {
		console.error(`pi-studio: explain failed: ${(error as Error).message}`);
		return null;
	}
}
