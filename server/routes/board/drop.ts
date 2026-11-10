// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * A file dropped onto a message field.
 *
 * The field attaches paths, because that is what the agent's own tools read. A browser hands over the
 * bytes of a dropped file and no path at all, so the daemon keeps a copy in its temp folder — a drop is
 * temporary, and a copy inside the workspace would turn up in the human's `git status` — and answers with
 * that copy's path, which the field carries exactly like a path picked with the files button.
 */
import { answer, fail, readBytes } from "../../http.ts";
import { CONTROL_CHARS, MAX_DROPPED_FILES, MAX_DROPPED_TOTAL, MAX_DROP_BYTES } from "../../limits.ts";
import { droppedDir } from "../../paths.ts";
import { basename, extname, join } from "node:path";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";



/**
 * The name a dropped file keeps. It arrives from the browser rather than from the disk it was dropped
 * from, so it is taken as a name and nothing else: no folder of its own, no control characters, and
 * short enough to read in a message.
 */
function safeName(asked) {
	const last = basename(String(asked ?? "").replace(/\\/g, "/")).replace(CONTROL_CHARS, "").trim();
	const kept = last.replace(/[<>:"|?*]/g, "-").slice(-80);
	return kept && !/^\.+$/.test(kept) ? kept : "dropped-file";
}

/**
 * The path the copy takes. Two files with one name — the same `report.pdf` dropped from two folders —
 * are two files, so the second lands beside the first with a number rather than over it, and the
 * message never names a copy the agent has already been shown.
 */
function freePath(dir, name) {
	const stem = basename(name, extname(name));
	const tail = extname(name);
	for (let n = 1; n < 500; n += 1) {
		const file = join(dir, n === 1 ? name : `${stem}-${n}${tail}`);
		try {
			statSync(file);
		} catch {
			return file;
		}
	}
	return join(dir, `${stem}-${Date.now().toString(36)}${tail}`);
}

/**
 * Keep the newest drops and let the oldest go, so a temp folder filled by drops does not grow for ever.
 * Newest first by the time each file was written, and both a count and a total size.
 */
function prune(dir) {
	let files = [];
	try {
		files = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const file = join(dir, entry.name);
				try {
					const stat = statSync(file);
					return { file, size: stat.size, at: stat.mtimeMs };
				} catch {
					return null;
				}
			})
			.filter(Boolean)
			.sort((a, b) => b.at - a.at);
	} catch {
		return;
	}
	let kept = 0;
	let bytes = 0;
	for (const one of files) {
		kept += 1;
		bytes += one.size;
		if (kept <= MAX_DROPPED_FILES && bytes <= MAX_DROPPED_TOTAL) continue;
		try {
			unlinkSync(one.file);
		} catch {
			// A file that will not go is left where it is: the next drop tries again rather than failing.
		}
	}
}

/** One file's bytes in, the path of the copy out. The name travels in the query, because the body is the file. */
export async function onDrop(req, res, board, askedName = "") {
	const name = safeName(askedName);
	const bytes = await readBytes(req, MAX_DROP_BYTES);
	if (bytes === undefined) return void fail(res, 413, `a dropped file holds at most ${MAX_DROP_BYTES} bytes`);
	if (bytes.length === 0) return void fail(res, 400, "empty file");
	const dir = droppedDir(board?.id);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		return void fail(res, 500, "cannot keep a dropped file");
	}
	const file = freePath(dir, name);
	try {
		writeFileSync(file, bytes, { mode: 0o600 });
	} catch {
		return void fail(res, 500, "cannot keep a dropped file");
	}
	prune(dir);
	answer(res, 200, { path: file, name: basename(file), bytes: bytes.length });
}
