/**
 * The source control drawer's routes: the status it reads, the staging it asks for, the commit it
 * makes, the message it drafts, and the conflict read, resolve and continue that conclude a merge.
 *
 * They are one file because they are one surface, and they read `board.folder` and nothing else,
 * the way the Explorer does: never a thread's tree, never a path a request names above the
 * repository. None of them is in THREAD_ROUTES: a child reports in its last message instead of
 * staging, committing or resolving in the human's checkout, the way it may not rename or delete
 * its files. Failures answer JSON, so the panel can show git's own reason — a hook refusal or a
 * missing identity is not the same sentence as "the daemon answered 409".
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sourceControlCommit, sourceControlConflict, sourceControlContinue, sourceControlMessage, sourceControlResolve, sourceControlStage, sourceControlStatus } from "../../git/source-control.ts";
import { answer, readJson } from "../../http.ts";

/** The board's folder is the whole of this surface's world; nothing else is read from a board. */
type BoardFolder = { folder: string };

/** A refusal as JSON, so the panel reads the reason rather than a status code. */
function refuse(res: ServerResponse, error: string): void {
	answer(res, 409, { ok: false, error });
}

/** The two lists, the conflicts, and any merge in flight, as they stand now. */
export async function onSourceControlStatus(_req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const outcome = await sourceControlStatus(board.folder);
	if (!outcome.ok) return void answer(res, 200, { ok: false, error: outcome.error });
	answer(res, 200, { ok: true, ...outcome.status });
}

/** Stage the files a press picked, and answer with the lists as they now stand. */
export async function onSourceControlStage(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readJson(req, res);
	if (body === null) return;
	const outcome = await sourceControlStage(board.folder, body.paths, true);
	if (!outcome.ok) return void answer(res, 200, { ok: false, error: outcome.error });
	answer(res, 200, { ok: true, ...outcome.status });
}

/** Unstage the files a press picked, and answer with the lists as they now stand. */
export async function onSourceControlUnstage(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readJson(req, res);
	if (body === null) return;
	const outcome = await sourceControlStage(board.folder, body.paths, false);
	if (!outcome.ok) return void answer(res, 200, { ok: false, error: outcome.error });
	answer(res, 200, { ok: true, ...outcome.status });
}

/** Commit the staged files under the message the field holds. */
export async function onSourceControlCommit(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readJson(req, res);
	if (body === null) return;
	const outcome = await sourceControlCommit(board.folder, body.message);
	if (!outcome.ok) return void refuse(res, outcome.error);
	answer(res, 200, { ok: true, message: outcome.message });
}

/** Draft a message for the staged files with the cheapest model the board knows about. */
export async function onSourceControlMessage(_req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const outcome = await sourceControlMessage(board.folder);
	if (!outcome.ok) return void refuse(res, outcome.error);
	answer(res, 200, { ok: true, message: outcome.message });
}

/** One conflicted file's text and the version it was read at, for the merge editor. */
export async function onSourceControlConflict(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const outcome = await sourceControlConflict(board.folder, url.searchParams.get("path"));
	if (!outcome.ok) return void refuse(res, outcome.error);
	answer(res, 200, { ok: true, path: outcome.path, mergeId: outcome.mergeId, content: outcome.content, version: outcome.version });
}

/** Save a resolved file and stage exactly it, answering with the lists as they now stand. */
export async function onSourceControlResolve(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readJson(req, res);
	if (body === null) return;
	const outcome = await sourceControlResolve(board.folder, body);
	if (!outcome.ok) return void refuse(res, outcome.error);
	answer(res, 200, { ok: true, ...outcome.status });
}

/** Conclude the merge: commit the index as it stands under the merge message. */
export async function onSourceControlContinue(req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const body = await readJson(req, res);
	if (body === null) return;
	const outcome = await sourceControlContinue(board.folder, body);
	if (!outcome.ok) return void refuse(res, outcome.error);
	answer(res, 200, { ok: true, ...outcome.status });
}
