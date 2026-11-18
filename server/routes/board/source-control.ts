/**
 * The source control drawer's routes: the status it reads, the staging it asks for, the commit it
 * makes, and the message it drafts.
 *
 * They are one file because they are one surface, and they read `board.folder` and nothing else,
 * the way the Explorer does: never a thread's tree, never a path a request names above the
 * repository. None of them is in THREAD_ROUTES: a child reports in its last message instead of
 * staging or committing in the human's checkout, the way it may not rename or delete its files.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sourceControlCommit, sourceControlMessage, sourceControlStage, sourceControlStatus } from "../../git/source-control.ts";
import { answer, fail, readJson } from "../../http.ts";

/** The board's folder is the whole of this surface's world; nothing else is read from a board. */
type BoardFolder = { folder: string };

/** The two lists and the branch, as they stand now. */
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
	if (!outcome.ok) return void fail(res, 409, outcome.error);
	answer(res, 200, { ok: true, message: outcome.message });
}

/** Draft a message for the staged files with the cheapest model the board knows about. */
export async function onSourceControlMessage(_req: IncomingMessage, res: ServerResponse, board: BoardFolder): Promise<void> {
	const outcome = await sourceControlMessage(board.folder);
	if (!outcome.ok) return void fail(res, 409, outcome.error);
	answer(res, 200, { ok: true, message: outcome.message });
}
