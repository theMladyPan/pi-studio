/**
 * The prompt files themselves: the roles a spawn may be given, the modes a human thread may pick, and
 * the flows a boss may run. They are plain markdown in `prompts/`, read by the daemon when a thread
 * starts, so an edit here takes effect on the next run and never rewrites one already going.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { answer, fail, readJson } from "../../http.ts";
import { PROMPT_DIR } from "../../child/modes.ts";

/** The folders a prompt may live in, and the names a prompt may have: lowercase, one file each. */
const FOLDERS = ["roles", "modes", "flows"];
const NAME = /^(roles|modes|flows)\/[a-z][a-z-]*\.md$/;

/**
 * A name that came from a request, on the way to a path. The pattern is the whole guard: it has no
 * `..`, no absolute path and no folder of its own invention, so a write can only land in the three
 * folders this page offers.
 */
function promptName(given: string): string {
	const name = String(given ?? "").trim();
	return NAME.test(name) && existsSync(PROMPT_DIR) ? name : "";
}

/** The files there are, with the first line of each, which is what tells a human what it is. */
export function onPrompts(res: ServerResponse) {
	const prompts: { name: string; kind: string; title: string; firstLine: string }[] = [];
	for (const folder of FOLDERS) {
		let files = [];
		try {
			files = readdirSync(join(PROMPT_DIR, folder)).filter((file) => file.endsWith(".md"));
		} catch {
			continue;
		}
		for (const file of files.sort()) {
			const path = join(PROMPT_DIR, folder, file);
			let text = "";
			try {
				text = readFileSync(path, "utf8");
			} catch {
				continue;
			}
			prompts.push({
				name: `${folder}/${file}`,
				kind: folder.replace(/s$/, ""),
				title: file.replace(/\.md$/, ""),
				firstLine: text.split("\n").find((line) => line.trim()) ?? "",
			});
		}
	}
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

/** Saving one. The next thread that starts reads it; nothing already running changes under it. */
export async function onPromptWrite(req: IncomingMessage, res: ServerResponse) {
	const body = await readJson(req, res);
	if (!body) return;
	const name = promptName(body.name);
	if (!name) return void fail(res, 400, "no such prompt");
	if (typeof body.text !== "string") return void fail(res, 400, "a prompt is text");
	writeFileSync(join(PROMPT_DIR, name), body.text);
	answer(res, 200, { name, saved: true });
}
