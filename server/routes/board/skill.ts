/**
 * A skill: a document a thread loads when its work needs one, instead of every thread carrying every
 * grammar in its prompt. `prompts/skills/chart.md` is the chart block, and `board_skill` is the tool
 * that reaches this route.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { answer, fail, readJson } from "../../http.ts";
import { promptText } from "../../child/modes.ts";

/**
 * The name a skill may have: lowercase letters and hyphens. The pattern is the whole guard — it admits
 * no `/`, no `.` and no `..` — so a name from a request can only reach a file in `prompts/skills/`.
 */
const NAME = /^[a-z][a-z-]*$/;

/** One skill, whole. A name with no file behind it is a 404 that says which skill was missing. */
export async function onSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = await readJson(req, res);
	if (!body) return;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!NAME.test(name)) return void fail(res, 400, "no such skill");
	const text = promptText("skills", name);
	if (!text) return void fail(res, 404, `no skill named ${name}`);
	answer(res, 200, { name, text });
}
