/**
 * What a human thread is for, and the flow a boss runs. A mode is a prompt file in `prompts/modes/`
 * and a tool rule; a boss also carries a path whose own prompt is a file in `prompts/flows/`. The
 * files are the part a human edits; the tool rules live here because they are behaviour rather than
 * advice.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** A human thread picks one of these. A spawned thread carries a role instead, never a mode. */
export const MODE_NAMES = ["agent", "plan", "boss"];

/** The flows a boss can run, and `auto` for the one the model picks at its first turn. */
export const PATH_NAMES = ["auto", "simple", "advanced", "complex"];

/**
 * A planner writes its throwaway scripts with `bash` under `/tmp`, and a boss only spawns: neither may
 * edit the tree it is judging, which is what keeps a plan a plan and a boss a pair of hands that are
 * somebody else's.
 */
export const MODE_TOOLS_OFF = { plan: ["write", "edit"], boss: ["write", "edit"] };

export const PROMPT_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

/** The folders a prompt may live in, in the order the settings page lists them. */
export const PROMPT_FOLDERS = ["roles", "modes", "flows"];

/** One prompt file on disk: the name a route takes, and the whole text a thread would be given. */
export type PromptFile = { name: string; folder: string; file: string; text: string; firstLine: string };

/**
 * Every prompt file on disk right now, folder by folder, each folder in name order. Read per call rather
 * than kept, because a file a human added to `prompts/` is a prompt that exists: the settings page lists
 * what is there, not what was there when the daemon started.
 */
export function promptFiles(): PromptFile[] {
	const found: PromptFile[] = [];
	for (const folder of PROMPT_FOLDERS) {
		let files: string[] = [];
		try {
			files = readdirSync(join(PROMPT_DIR, folder))
				.filter((file) => file.endsWith(".md"))
				.sort();
		} catch {
			continue;
		}
		for (const file of files) {
			let text = "";
			try {
				text = readFileSync(join(PROMPT_DIR, folder, file), "utf8");
			} catch {
				continue;
			}
			found.push({ name: `${folder}/${file}`, folder, file, text, firstLine: text.split("\n").find((line) => line.trim()) ?? "" });
		}
	}
	return found;
}

/** One prompt file, or the empty string when it is missing: a caller decides what a miss means. */
export function promptText(folder: string, name: string): string {
	try {
		return readFileSync(join(PROMPT_DIR, folder, `${name}.md`), "utf8").trim();
	} catch {
		return "";
	}
}

/**
 * What a thread is told about its mode, appended to whatever the board itself says. `agent` is the
 * baseline and adds nothing, so a board that never picks a mode behaves exactly as it did before.
 */
export function modeSystemPrompt(mode?: string, path?: string): string {
	if (!mode || !MODE_NAMES.includes(mode) || mode === "agent") return "";
	const text = promptText("modes", mode);
	if (!text) return "";
	const flow = mode === "boss" && path && PATH_NAMES.includes(path) && path !== "auto" ? promptText("flows", path) : "";
	return [text, flow].filter(Boolean).join("\n\n");
}
