/**
 * What a child's `entry_appended` frame says to a human, as one reply row's worth of words.
 *
 * An extension reports what it did by appending an entry: `scan-codebase-report` carries the file count,
 * the size, the line count and the first rows of the tree, and pi's own TUI draws it with the renderer the
 * extension registered. The daemon has no renderer, so it read the frame as nothing, and a human who pressed
 * `/scan_codebase` learned what had been scanned only by reading the agent's terminal. There is no second
 * card vocabulary to build for it: the numbers are the report, and a reply row is where the rail already
 * says something to the human.
 *
 * Two kinds of entry arrive this way and only one is drawn. A `custom` entry is what an extension appends
 * for a human, and its payload is a handful of fields. A `custom_message` entry is the message an extension
 * sends to the model — `scan-codebase` and `dump-codebase` both send the whole tree that way, with
 * `display: false` — and its content is written for the agent's context, never for the rail: drawing it
 * would put a megabyte of code in front of someone who asked for a file count.
 */
import { MAX_ROW_CHARS } from "../limits.ts";

/** The first rows of a tree or a dump are what says what was read; the rest belongs in the context. */
const PREVIEW_ROWS = 8;

/** One row is read at a glance, so a report that came with a long preview is cut here. */
const MAX_REPORT_CHARS = 4000;

/**
 * The row an entry earns, or "" when it earns none.
 *
 * The fields are read as they are named rather than against a list of the types the daemon knows: an
 * extension is one a folder carries, so a list here would be a second copy that falls behind the first.
 * The preview is printed when the payload carries one, because the rest of it rode the next message into
 * the agent's context, and the row is the only place the human is told that.
 */
export function reportText(entry: unknown): string {
	const { customType, data } = oneEntry(entry);
	if (!customType || !data) return "";
	const said: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (key === "preview") continue;
		// A number is the report of what was done and a name is what it was done to; a flag is worth a
		// word only when it is set, so `capped: false` says nothing rather than saying "capped false".
		if (typeof value === "number" || typeof value === "string") said.push(`${words(key)} ${value}`);
		else if (value === true) said.push(words(key));
	}
	const preview = typeof data.preview === "string" ? data.preview.split("\n").slice(0, PREVIEW_ROWS).join("\n").trim() : "";
	if (!said.length && !preview) return "";
	const lines = [`${words(customType)}${said.length ? ` — ${said.join(", ")}` : ""}`];
	if (preview) {
		lines.push(preview);
		// Where the tree itself went. An extension delivers it to the model with the next message, so the
		// row that carries the numbers is also the row that says the whole of it is not lost.
		lines.push("the whole of it reaches the agent with the next message");
	}
	return lines.join("\n").slice(0, Math.min(MAX_REPORT_CHARS, MAX_ROW_CHARS));
}

/** The two fields a `custom` entry is read for, or nothing when this is not one. */
function oneEntry(entry: unknown): { customType: string; data?: Record<string, unknown> } {
	if (!entry || typeof entry !== "object") return { customType: "" };
	const held = entry as { type?: unknown; customType?: unknown; data?: unknown };
	if (held.type !== "custom" || typeof held.customType !== "string" || !held.customType) return { customType: "" };
	const data = held.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return { customType: "" };
	return { customType: held.customType, data: data as Record<string, unknown> };
}

/** `ignoredFiles` is said as `ignored files`, because a row is read as words and not as a field name. */
function words(key: string): string {
	return key
		.replace(/[-_]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.trim()
		.toLowerCase();
}
