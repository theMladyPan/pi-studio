/**
 * What a human thread is for, and the flow a boss runs. A mode is a prompt file in `prompts/modes/`
 * and a tool rule; a boss also carries a path whose own prompt is a file in `prompts/flows/`. The
 * files are the part a human edits; the tool rules live here because they are behaviour rather than
 * advice.
 */
import { readFileSync } from "node:fs";
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
