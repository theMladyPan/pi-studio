/**
 * The prompt files themselves: the roles a spawn may be given, the modes a human thread may pick, the
 * flows a boss may run, and the two instruction files a workspace may keep in its own folder. The studio's
 * files are plain markdown in `prompts/`, read by the daemon when a thread starts, so an edit here takes
 * effect on the next run and never rewrites one already going.
 */
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { answer, fail, readJson } from "../../http.ts";
import { PROMPT_DIR, promptFiles } from "../../child/modes.ts";
import { AGENTS_FILE, agentsOverride, workspacePromptName, workspacePromptText } from "../../workspace-prompt.ts";
import { MAX_WORKSPACE_PROMPT_CHARS } from "../../limits.ts";

/** The names a prompt may have: lowercase, one file each, in one of the folders the daemon reads. */
const NAME = /^(board|roles|modes|flows|verbosity|audiences|skills)\/[a-z][a-z-]*\.md$/;

/**
 * A name that came from a request, on the way to a path. The pattern is the whole guard: it has no
 * `..`, no absolute path and no folder of its own invention, so a write can only land in the folders
 * this page offers.
 */
function promptName(given: string): string {
	const name = String(given ?? "").trim();
	return NAME.test(name) && existsSync(PROMPT_DIR) ? name : "";
}

/** The files there are, with the first line of each, which is what tells a human what it is. */
export function onPrompts(res: ServerResponse) {
	const prompts = promptFiles().map((one) => ({
		name: one.name,
		kind: one.folder.replace(/s$/, ""),
		title: one.file.replace(/\.md$/, ""),
		firstLine: one.firstLine,
	}));
	answer(res, 200, { prompts });
}

/** One file, whole: the editor shows exactly what the daemon will read. */
export function onPrompt(url: URL, res: ServerResponse) {
	const name = promptName(url.searchParams.get("name") ?? "");
	if (!name) return void fail(res, 400, "no such prompt");
	try {
		answer(res, 200, { name, text: readFileSync(join(PROMPT_DIR, name), "utf8") });
	} catch {
		fail(res, 404, "no such prompt");
	}
}

/**
 * A file a thread reads while it starts is replaced in one move, so no run ever reads half of one. A
 * symlink is refused rather than followed: the name is what guards where a write lands, and a link would
 * step outside it.
 */
function replaceFile(path: string, text: string): { ok: true } | { ok: false; status: number; reason: string } {
	if (existsSync(path) && !lstatSync(path).isFile()) {
		return { ok: false, status: 409, reason: "that is not a plain file" };
	}
	const temporary = `${path}.tmp-${process.pid}`;
	try {
		writeFileSync(temporary, text);
		renameSync(temporary, path);
		return { ok: true };
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// Nothing was left behind, which is the usual case for a failed write.
		}
		return { ok: false, status: 500, reason: (error as Error).message };
	}
}

/** Saving one. The next thread that starts reads it; nothing already running changes under it. */
export async function onPromptWrite(req: IncomingMessage, res: ServerResponse) {
	const body = await readJson(req, res);
	if (!body) return;
	const name = promptName(body.name);
	if (!name) return void fail(res, 400, "no such prompt");
	if (typeof body.text !== "string") return void fail(res, 400, "a prompt is text");
	const written = replaceFile(join(PROMPT_DIR, name), body.text);
	if (!written.ok) return void fail(res, written.status, `could not save that prompt: ${written.reason}`);
	answer(res, 200, { name, saved: true });
}

/**
 * One of the two instruction files a workspace may carry. The name is one of those two and the folder is
 * the board's, so nothing in the request is a path: a workspace keeps its instructions where its code is,
 * which is what lets them travel with the repository instead of staying with this daemon's state.
 *
 * A workspace with neither file answers with empty text rather than a refusal, because "I have not written
 * this one yet" is a page with an empty box and not an error to read.
 */
export function onWorkspacePrompt(url: URL, res: ServerResponse, board: { folder: string }) {
	const name = workspacePromptName(url.searchParams.get("name") ?? "");
	if (!name) return void fail(res, 400, "only STUDIO.md and AGENTS.md belong to a workspace");
	// pi reads an override file ahead of AGENTS.md, so the page can say that the box it offers is not the
	// one a run would read.
	const override = name === AGENTS_FILE && agentsOverride(board);
	answer(res, 200, { name, text: workspacePromptText(board, name), ...(override ? { override: true } : {}) });
}

/** Saving one of the two. Like a prompt, the next run reads it and no run already going changes under it. */
export async function onWorkspacePromptWrite(req: IncomingMessage, res: ServerResponse, board: { folder: string }) {
	const body = await readJson(req, res);
	if (!body) return;
	const name = workspacePromptName(body.name);
	if (!name) return void fail(res, 400, "only STUDIO.md and AGENTS.md belong to a workspace");
	if (typeof body.text !== "string") return void fail(res, 400, "an instruction file is text");
	if (body.text.length > MAX_WORKSPACE_PROMPT_CHARS) {
		return void fail(res, 413, `${name} is longer than ${MAX_WORKSPACE_PROMPT_CHARS} characters`);
	}
	const written = replaceFile(join(board.folder, name), body.text);
	if (!written.ok) return void fail(res, written.status, `could not save ${name}: ${written.reason}`);
	answer(res, 200, { name, saved: true });
}
