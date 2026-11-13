/**
 * The three flow drawings, read from the document that draws them.
 *
 * `docs/boss-and-subagents.md` holds one picture per flow under a `### <name>` heading, once, so the
 * diagram and the steps under it are read together. The board's flow chip shows that same picture while a
 * pointer rests on it, which is why this reads the document instead of keeping a copy of the drawings in
 * code: an edit to the document is what the hover shows, and there is one drawing rather than two that
 * can drift apart.
 *
 * A document a human edits is not something a hover may fail on, so a missing file, a vanished heading or
 * a fence somebody deleted answers with what is left, or with nothing at all.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PATH_NAMES } from "./child/modes.ts";
import { REPO_DIR } from "./paths.ts";

/**
 * The document the drawings live in, relative to the repository. Its own text says each flow is drawn
 * once here, so this name is the only place the drawings are named.
 */
export const FLOW_DOC = "docs/boss-and-subagents.md";

/** One flow's drawing: the path it is drawn for, and the ```svg fence under that path's heading. */
export type FlowDiagram = { path: string; svg: string };

/**
 * The first ```svg fence under the `### <name>` heading, or the empty string when the heading or the
 * fence is gone. Only the section that names this flow is read, so a fence that belongs to another flow
 * is never handed back under this one's name.
 */
function drawingIn(text: string, name: string): string {
	let inside = false;
	let body: string[] | null = null;
	for (const line of text.split("\n")) {
		// Any heading closes the section: the next one may be another flow, or a part of the document
		// that draws nothing at all.
		const heading = line.match(/^(#{1,3})\s+(\S+)/);
		if (heading) {
			inside = heading[1] === "###" && heading[2] === name;
			body = null;
			continue;
		}
		if (!inside) continue;
		if (!body) {
			if (line.trim() === "```svg") body = [];
			continue;
		}
		if (line.trim() === "```") {
			const svg = body.join("\n").trim();
			return svg.startsWith("<svg") ? svg : "";
		}
		body.push(line);
	}
	return "";
}

/**
 * The drawings there are, one per flow, in the order `PATH_NAMES` names them. `auto` carries none: a boss
 * on it chooses its own steps, so the list is short by one and the panel stays away for it.
 *
 * `root` is the repository the document is read from, which a test points elsewhere to see a miss.
 */
export async function flowDiagrams(root = REPO_DIR): Promise<FlowDiagram[]> {
	let text = "";
	try {
		text = await readFile(join(root, FLOW_DOC), "utf8");
	} catch {
		return [];
	}
	const found: FlowDiagram[] = [];
	for (const path of PATH_NAMES) {
		const svg = drawingIn(text, path);
		if (svg) found.push({ path, svg });
	}
	return found;
}
