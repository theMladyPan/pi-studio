/**
 * The two instruction files a workspace may keep beside its code: STUDIO.md, which is the studio's own,
 * and AGENTS.md, which belongs to the project.
 *
 * They are files in the workspace folder rather than values on the board, so they travel with the
 * repository, are edited in any editor, and are read at the start of every run rather than when the board
 * was born. The difference between them is who reads them: pi itself reads AGENTS.md in the folder a
 * session starts in and in every folder above it, and reads no other name here, so STUDIO.md reaches a
 * thread on a board and never a plain pi session in the same folder.
 *
 * pi reads AGENTS.md in the copy of the repository the thread works in, so an edit there lands on the
 * threads whose copy carries it. STUDIO.md is read from the workspace folder itself, so an edit there
 * lands on the next message whatever copy a thread is standing in.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The studio's own instructions: the file pi does not look for, so it is the studio's to read. */
export const STUDIO_FILE = "STUDIO.md";

/** The project's instructions. The studio never writes this one; pi reads it on its own account. */
export const AGENTS_FILE = "AGENTS.md";

/** What a workspace's settings page offers, in the order it offers them. */
export const WORKSPACE_PROMPTS = [STUDIO_FILE, AGENTS_FILE];

/**
 * A name a route may touch. The two names above and nothing else, so no request ever carries a path: the
 * page offers two files, and a file it does not offer is not one a route may read or write.
 */
export function workspacePromptName(given: string): string {
	const name = String(given ?? "").trim();
	return WORKSPACE_PROMPTS.includes(name) ? name : "";
}

/** One of those files, or the empty string when it is not there: a caller decides what a miss means. */
export function workspacePromptText(board: { folder: string }, name: string): string {
	if (!workspacePromptName(name)) return "";
	try {
		return readFileSync(join(board.folder, name), "utf8").trim();
	} catch {
		return "";
	}
}

/**
 * Whether another file stands in for AGENTS.md here. pi reads `AGENTS.override.md` first in the folder it
 * starts in, so a page editing AGENTS.md beside one would be editing a file nothing reads. The page says
 * so rather than the daemon guessing which one the human meant.
 */
export function agentsOverride(board: { folder: string }): boolean {
	return existsSync(join(board.folder, "AGENTS.override.md"));
}
