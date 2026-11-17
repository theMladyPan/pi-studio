/**
 * What a human thread is for, and the flow a boss runs. A mode is a prompt file in `prompts/modes/`
 * and a tool rule; a boss also carries a path whose own prompt is a file in `prompts/flows/`. The
 * files are the part a human edits; the tool rules live here because they are behaviour rather than
 * advice.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { effectivePromptText, listPromptOverrides, PROMPT_FILE_NAME, PROMPT_FILE_STEM, PROMPT_OVERRIDE_FOLDERS, readPromptOverride } from "../prompt-overrides.ts";

/** A human thread picks one of these. A spawned thread carries a role instead, never a mode. */
export const MODE_NAMES = ["agent", "plan", "boss", "discuss"];

/** The paths a boss can be on, one prompt file each. `auto` is the one with no recipe: the boss decides. */
export const PATH_NAMES = ["auto", "simple", "advanced", "complex"];

/**
 * A planner writes its throwaway scripts with `bash` under `/tmp`, a boss only spawns, and a discuss thread
 * only reads and checks: none of them may edit the tree it is judging, which is what keeps a plan a plan,
 * a boss a pair of hands that are somebody else's, and an answer an answer.
 */
export const MODE_TOOLS_OFF = { plan: ["write", "edit"], boss: ["write", "edit"], discuss: ["write", "edit"] };

export const PROMPT_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

/**
 * The folders a prompt may live in, in the order the settings page lists them. A file in `verbosity/` or
 * `audiences/` is chosen by a board's card settings rather than by a spawn, and the page edits it like
 * any other: the ids a board may hold are in `card-settings.ts`, the words are here. `board/` is what
 * every thread the human starts reads before it writes anything, `conventions.md` being the general one.
 *
 * These files are one copy for the whole studio, so they are edited on the crossroads page alone. The two
 * files a single workspace may add are in its own folder and are named in `workspace-prompt.ts`.
 * The list itself is the one in `prompt-overrides.ts`, shared with the prompt routes.
 */
export const PROMPT_FOLDERS = PROMPT_OVERRIDE_FOLDERS;

/** One prompt file on disk: the name a route takes, and the whole text a thread would be given. */
export type PromptFile = { name: string; folder: string; file: string; text: string; firstLine: string };

/**
 * Every prompt file there is, folder by folder, each folder in name order. Read per call rather than
 * kept, because a file a human added to `prompts/` is a prompt that exists: the settings page lists
 * what is there, not what was there when the daemon started. A saved override under the state folder
 * replaces the shipped copy, and an override-only name is listed too, so a file the page lists is a
 * file a save accepts and a run reads.
 */
export function promptFiles(stateDir?: string): PromptFile[] {
	const byName = new Map<string, PromptFile>();
	for (const folder of PROMPT_FOLDERS) {
		let files: string[] = [];
		try {
			files = readdirSync(join(PROMPT_DIR, folder))
				// The names the write guard takes, so a file the page lists is a file a save accepts.
				.filter((file) => PROMPT_FILE_NAME.test(file))
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
			const name = `${folder}/${file}`;
			const effective = effectivePromptText(name, text, stateDir);
			byName.set(name, { name, folder, file, text: effective, firstLine: effective.split("\n").find((line) => line.trim()) ?? "" });
		}
	}
	for (const name of listPromptOverrides(stateDir)) {
		if (byName.has(name)) continue;
		const text = readPromptOverride(name, stateDir) ?? "";
		const [folder, file] = name.split("/");
		byName.set(name, { name, folder, file, text, firstLine: text.split("\n").find((line) => line.trim()) ?? "" });
	}
	return [...byName.values()].sort((a, b) => PROMPT_FOLDERS.indexOf(a.folder) - PROMPT_FOLDERS.indexOf(b.folder) || a.file.localeCompare(b.file));
}

/**
 * One prompt file, or the empty string when it is missing: a caller decides what a miss means. A saved
 * override under the state folder is what is read. The folder and name are guarded so a stored value
 * cannot step outside the folders a prompt may live in.
 */
export function promptText(folder: string, name: string, stateDir?: string): string {
	if (!PROMPT_FOLDERS.includes(folder) || !PROMPT_FILE_STEM.test(name)) return "";
	let shipped = "";
	let held = false;
	try {
		shipped = readFileSync(join(PROMPT_DIR, folder, `${name}.md`), "utf8");
		held = true;
	} catch {
		held = false;
	}
	const override = readPromptOverride(`${folder}/${name}.md`, stateDir);
	if (!held && override === null) return "";
	return (override ?? shipped).trim();
}

/**
 * What a thread is told about its mode, appended to whatever the board itself says. `agent` is the
 * baseline and adds nothing, so a board that never picks a mode behaves exactly as it did before. A boss
 * also carries a path, and that path's file is what it is told to run: a recipe, or on `auto` the roster
 * of agents with no recipe above it.
 */
export function modeSystemPrompt(mode?: string, path?: string): string {
	if (!mode || !MODE_NAMES.includes(mode) || mode === "agent") return "";
	const text = promptText("modes", mode);
	if (!text) return "";
	const flow = mode === "boss" && path && PATH_NAMES.includes(path) ? promptText("flows", path) : "";
	return [text, flow].filter(Boolean).join("\n\n");
}

/**
 * What a thread is told when the mode it was started under is no longer the mode it has. A mode reaches a
 * thread twice, as the prompt its process is started with and as the tools that process is denied, so a
 * change can only land between two runs. The new mode's own words arrive that way, in the system prompt.
 * What cannot arrive that way is the withdrawal of the old ones: the conversation carries every turn the
 * old mode wrote, and a model told nothing reads its own last turns as the instruction.
 *
 * A thread that has never run has no earlier mode to withdraw, and a spawned child carries a role instead,
 * so neither is given this note.
 */
export function modeChangeNote(from?: string, to?: string): string {
	if (!from || !to || from === to) return "";
	return [
		"[board note · this thread's mode has changed]",
		`You were started as a ${from}, and that is over. The ${from} instructions you were given apply to nothing you do now, and you do not carry on anything you began as a ${from}.`,
		to === "agent"
			? "You are an agent now: you do the work yourself, with the tools you have."
			: `You are a ${to} now, and the ${to} instructions in your system prompt are the ones that hold from here.`,
		"Examples of right and wrong:",
		`- right: the thread was a boss and the human made it an agent, so the next request is answered by reading, checking and changing files here yourself.`,
		`- wrong: the same request is answered by spawning a scout, because that is what the last few turns of this conversation did.`,
	].join("\n");
}
