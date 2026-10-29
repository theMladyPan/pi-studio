// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * What a pi session on disk is: where it lives, what it answered, and the transcript a closed thread
 * can be read back from.
 */
import { join } from "node:path";
import { STATE_DIR } from "./paths.ts";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";



export function sessionDir(workspace) {
	return join(STATE_DIR, "sessions", workspace.id);
}



/** How much of the app's own state a workspace holds: its sessions on disk. */
export function sessionFacts(workspace) {
	const dir = sessionDir(workspace);
	let count = 0;
	let bytes = 0;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			count += 1;
			try {
				bytes += statSync(join(dir, entry.name)).size;
			} catch {
				// A file that vanished between the listing and the stat is not worth a failure.
			}
		}
	} catch {
		// No sessions yet is the normal state of a new workspace.
	}
	return { count, bytes };
}



/**
 * The folder a session was started in, from the header of its file. pi looks `--session <id>` up in the
 * folder it is started in, so whether a thread still belongs where its session was recorded decides how
 * the child has to be started; see `childArgv`. Empty when there is no such session or no header.
 */
export function sessionCwd(dir, id) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return "";
	}
	// pi names a session file `<timestamp>_<id>.jsonl`, and the file itself is where the id is kept.
	const name = names.find((entry) => entry.endsWith(`_${id}.jsonl`));
	if (!name) return "";
	// Only the header matters, and a long session is megabytes, so the start of the file is enough.
	try {
		const handle = openSync(join(dir, name), "r");
		const head = Buffer.alloc(4096);
		const read = readSync(handle, head, 0, head.length, 0);
		closeSync(handle);
		const header = JSON.parse(head.subarray(0, read).toString("utf8").split("\n")[0]);
		return typeof header.cwd === "string" ? header.cwd : "";
	} catch {
		return "";
	}
}



/** The session file pi wrote for a thread, or "" while it has none. */
export function sessionFile(workspace, id) {
	const dir = sessionDir(workspace);
	try {
		const name = readdirSync(dir).find((entry) => entry.endsWith(`_${id}.jsonl`));
		return name ? join(dir, name) : "";
	} catch {
		return "";
	}
}



/** How much of a transcript a drawer asks for, and how much of one block it shows. */
export const TRANSCRIPT_ENTRIES = 600;


export const TRANSCRIPT_BLOCK_CHARS = 4000;



/** One line of an argument object, for the head of a tool call. */
export function argLine(value, width = 120) {
	let text = "";
	if (typeof value === "string") text = value;
	else if (value && typeof value === "object") {
		const pick = ["command", "path", "file", "query", "pattern", "url", "text", "selector"];
		const key = pick.find((name) => typeof value[name] === "string");
		text = key ? value[key] : JSON.stringify(value);
	}
	return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, width);
}



/**
 * A thread's conversation as the drawer reads it: the session file, one entry per thing that happened.
 *
 * This is the rendered conversation rather than the child's protocol stream, because the stream is JSON
 * frames and what a human sees in a terminal is the conversation those frames carry. A block longer
 * than `TRANSCRIPT_BLOCK_CHARS` is cut: a tool result can be megabytes of build output, and a drawer
 * that hands the browser one is a tab that stops answering.
 */
export function transcriptOf(file) {
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const entries = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			// A line cut in half by a crash is not a message.
			continue;
		}
		if (record?.type !== "message") continue;
		const message = record.message ?? {};
		const role = message.role ?? "";
		// The system prompt is the same wall of text in every thread; the drawer is for the conversation.
		if (role === "system") continue;
		const blocks = Array.isArray(message.content) ? message.content : [];
		for (const block of blocks) {
			const kind =
				block?.type === "thinking"
					? "thinking"
					: block?.type === "toolCall"
						? "call"
						: role === "user"
							? "user"
							: role === "toolResult"
								? "result"
								: role === "assistant" && block?.type === "text"
									? "answer"
									: "";
			if (!kind) continue;
			const text = kind === "call" ? `${block.name ?? "tool"} ${argLine(block.arguments)}` : String(block?.text ?? block?.thinking ?? "");
			entries.push({
				kind,
				text: text.slice(0, TRANSCRIPT_BLOCK_CHARS),
				...(kind === "call" && block.name ? { tool: String(block.name) } : {}),
			});
		}
	}
	return entries.length > TRANSCRIPT_ENTRIES ? entries.slice(-TRANSCRIPT_ENTRIES) : entries;
}
