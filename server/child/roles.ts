// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The roles a spawned thread may be given. A role is a prompt file in `prompts/roles/`, a pair of tool
 * rules, and a thinking level to start from. The files are the part a human edits; the rules are here
 * because they are behaviour rather than advice.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";



export const ROLE_NAMES = ["scout", "implement", "review", "chore", "architect"];


/** A read-only role cannot edit the tree it is judging; `bash` still lets it run checks. */
export const ROLE_TOOLS_OFF = { scout: ["write", "edit"], review: ["write", "edit"], architect: ["write", "edit"] };


export const ROLE_THINKING = { scout: "medium", implement: "high", review: "high", chore: "medium", architect: "high" };


export const ROLE_DIR = fileURLToPath(new URL("../../prompts/roles/", import.meta.url));



/**
 * What a role may send to a child: nothing when the role is unknown or its file is missing, because a
 * role with no prompt is a thread that does not know what it is for.
 */
export function roleSystemPrompt(role) {
	if (!ROLE_NAMES.includes(role)) return "";
	let text = "";
	try {
		text = readFileSync(join(ROLE_DIR, `${role}.md`), "utf8").trim();
	} catch {
		return "";
	}
	return [
		`You are a delegated ${role} agent, spawned by another thread on this board. That thread reads your last message, so it is the whole report.`,
		text,
		"You work in your own worktree. Read and change only what the task needs.",
		"You cannot ask the human anything. If the task is contradictory or rests on a false premise, say so with evidence and propose a corrected assignment instead of forcing it.",
		"Answer in short, direct prose or bullets, with file paths and line numbers where they matter.",
	].join("\n\n");
}
