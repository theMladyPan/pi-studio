/**
 * The kontainer drawer's routes: state, stats, detail, disk usage, the events
 * stream and POST actions. Thin handlers over `server/kontainer/`; the board
 * is handed in by `main.ts` exactly like the gitgraph routes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { answer, fail, readJson } from "../http.ts";
import { handleAction } from "../kontainer/actions.ts";
import { discoverRuntimes, openSocketStream, resolveRuntime } from "../kontainer/socket.ts";
import { fetchDetail, fetchDf, fetchStats, getState } from "../kontainer/topology.ts";
import type { Scope } from "../kontainer/topology.ts";

export interface KontainerBoard {
	folder: string;
}

function asScope(value: string | null): Scope {
	return value === "all" ? "all" : "workspace";
}

function runtimeParam(url: URL): string | null {
	return url.searchParams.get("runtime");
}

export async function onKontainerState(_req: IncomingMessage, res: ServerResponse, url: URL, board: KontainerBoard): Promise<void> {
	const state = await getState({ folder: board.folder ?? "", scope: asScope(url.searchParams.get("scope")), runtimeId: runtimeParam(url) });
	answer(res, 200, state);
}

export async function onKontainerStats(_req: IncomingMessage, res: ServerResponse, url: URL, board: KontainerBoard): Promise<void> {
	const runtimes = discoverRuntimes();
	const runtime = resolveRuntime(runtimes, runtimeParam(url));
	if (!runtime) {
		answer(res, 200, { stats: {} });
		return;
	}
	const ids = (url.searchParams.get("ids") ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter((id) => /^[a-zA-Z0-9_.-]{1,128}$/.test(id));
	const stats = ids.length > 0 ? await fetchStats(runtime, ids) : {};
	answer(res, 200, { stats });
}

export async function onKontainerDetail(_req: IncomingMessage, res: ServerResponse, url: URL, board: KontainerBoard): Promise<void> {
	const runtimes = discoverRuntimes();
	const runtime = resolveRuntime(runtimes, runtimeParam(url));
	if (!runtime) {
		fail(res, 503, "no Docker or Podman socket found");
		return;
	}
	const kind = url.searchParams.get("kind") ?? "";
	const id = url.searchParams.get("id") ?? "";
	const tab = url.searchParams.get("tab") ?? "";
	if (!["container", "image"].includes(kind) || !id || !["logs", "inspect", "layers"].includes(tab) || (kind === "image" && tab === "logs")) {
		fail(res, 400, "bad detail request");
		return;
	}
	const tailParam = url.searchParams.get("tail");
	try {
		const detail = await fetchDetail(runtime, { kind, id, tab, tail: tailParam ? Number(tailParam) : undefined });
		answer(res, 200, detail);
	} catch (error) {
		fail(res, 502, error instanceof Error ? error.message : String(error));
	}
}

export async function onKontainerDf(_req: IncomingMessage, res: ServerResponse, url: URL, board: KontainerBoard): Promise<void> {
	const runtimes = discoverRuntimes();
	const runtime = resolveRuntime(runtimes, runtimeParam(url));
	if (!runtime) {
		fail(res, 503, "no Docker or Podman socket found");
		return;
	}
	try {
		answer(res, 200, await fetchDf(runtime));
	} catch (error) {
		fail(res, 502, error instanceof Error ? error.message : String(error));
	}
}

const EVENT_FILTERS = encodeURIComponent(JSON.stringify({ type: ["container", "image", "network", "volume"] }));

/**
 * The live events feed. The upstream Engine stream is destroyed the moment
 * either side closes, so closing the drawer leaks no socket, timer or CPU.
 */
export async function onKontainerEvents(req: IncomingMessage, res: ServerResponse, url: URL, board: KontainerBoard): Promise<void> {
	const runtimes = discoverRuntimes();
	const runtime = resolveRuntime(runtimes, runtimeParam(url));
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-store",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	if (!runtime) {
		res.write(`event: error\ndata: ${JSON.stringify({ error: "no Docker or Podman socket found" })}\n\n`);
		res.end();
		return;
	}

	let buffer = "";
	let closed = false;
	let ping: ReturnType<typeof setInterval> | null = null;
	let upstream: { close: () => void } | null = null;
	const teardown = () => {
		if (closed) return;
		closed = true;
		if (ping) clearInterval(ping);
		upstream?.close();
	};
	/** An engine that fails mid-stream ends the feed with an `error` event instead of a silent stall. */
	const failStream = (error: Error) => {
		if (closed) return;
		if (ping) clearInterval(ping);
		closed = true;
		upstream?.close();
		try {
			if (!res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
		} catch {}
		res.end();
	};
	upstream = openSocketStream(runtime, `/events?filters=${EVENT_FILTERS}`, (chunk) => {
		if (closed) return;
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line && line.startsWith("{")) {
				res.write(`event: change\ndata: ${line}\n\n`);
			}
			newline = buffer.indexOf("\n");
		}
	}, failStream);
	ping = setInterval(() => {
		if (!closed) res.write(": ping\n\n");
	}, 25_000);
	req.on("close", teardown);
	res.on("close", teardown);
}

export async function onKontainerAction(req: IncomingMessage, res: ServerResponse, board: KontainerBoard): Promise<void> {
	const body = await readJson(req, res);
	if (body === null) return;
	answer(res, 200, await handleAction(board, body));
}
