// @ts-nocheck -- the daemon's assembly files carry no annotations yet, so this one does not either.
/**
 * The three routes the logs drawer reads and the one a child writes with.
 *
 * A snapshot for the first paint and for a tab whose stream fell back to a poll, a stream for the tail,
 * and `POST /log` so a child can say something in its own words instead of leaving it in a stderr nobody
 * reads. All three sit behind the caller check in `server/main.ts` like every other data route, so an
 * anonymous request reaches none of them.
 */
import { answer, fail, readJson } from "../http.ts";
import { levelOf, log, snapshot, subscribe } from "../logs.ts";

/** How long a stream waits before sending a comment, so a proxy does not drop an idle one. */
const KEEP_ALIVE_MS = 20_000;

/** What the drawer paints on its way up: every line the ring still holds, oldest first. */
export function onLogs(res) {
	answer(res, 200, { entries: snapshot() });
}

/**
 * The tail. A late joiner gets the snapshot as its first event and every new line after it, so a drawer
 * opened an hour after the daemon started shows the hour rather than only what happens next.
 */
export function onLogsStream(req, res) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
	res.write(`event: snapshot\ndata: ${JSON.stringify({ entries: snapshot() })}\n\n`);
	const stop = subscribe((entry) => {
		if (res.writableEnded || res.destroyed) return;
		res.write(`event: entry\ndata: ${JSON.stringify(entry)}\n\n`);
	});
	const keepAlive = setInterval(() => {
		if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
	}, KEEP_ALIVE_MS);
	keepAlive.unref?.();
	const forget = () => {
		clearInterval(keepAlive);
		stop();
	};
	req.on("close", forget);
	res.on("error", forget);
}

/** How much of a caller's word is kept: the drawer draws a source in one column and a message in a row. */
const SOURCE_MAX = 80;

/**
 * One line, written by whoever the caller proved to be. A child says what it was doing — a command of
 * its own, a refusal from a tool — and it lands in the same drawer as the daemon's own lines, with the
 * thread's source so the human can tell whose it was.
 */
export async function onLog(req, res, _board, caller) {
	const body = await readJson(req, res);
	if (body === null) return;
	const message = typeof body?.message === "string" ? body.message.trim() : "";
	if (!message) return void fail(res, 400, "a message is required");
	const asked = typeof body?.source === "string" && body.source.trim() ? body.source.trim() : "";
	// A child is named by the thread it proved, so two children cannot both claim one source.
	const source = caller?.thread ? `child:${caller.thread.id}${asked ? ` ${asked}` : ""}` : asked || "client";
	const meta = body?.meta && typeof body.meta === "object" && !Array.isArray(body.meta) ? body.meta : undefined;
	const entry = log(levelOf(body?.level), source.slice(0, SOURCE_MAX), message, meta);
	answer(res, 200, { id: entry.id, ts: entry.ts });
}
