/**
 * The board's window onto a plugin's own panel: which panels there are, the files one of them loads, and
 * the single call a panel is allowed to make.
 *
 * A plugin runs beside the daemon as a trusted executable and already reaches it over its pipe, so none of
 * this is how a plugin gets work done. It is how a plugin puts a page in front of the human: the daemon
 * serves the files the plugin declared, and a frame on the board shows them. The frame is sandboxed with
 * no origin of its own, so it is handed no cookie and no token, and it cannot read the page around it.
 *
 * Everything it asks for travels one way: a message to the board, one POST here, and one call to the plugin.
 *
 *   GET  /plugins/visual                      → { plugins: [ { name, title, url } ] }
 *   GET  /plugins/visual/<name>/<file>        → one declared file, and nothing beside them
 *   POST /plugins/visual/request?plugin=<name>
 *        { workspace, method, params }        → { result } or { error: { code, message } }
 *
 * The call reaches the plugin as the fixed method `visual.request` with `{ workspace, method, params }`.
 * The workspace in it is resolved from this daemon's own list, so a panel's page can never name a folder,
 * and only a plugin that declared a panel can be asked through it: the executable of a plugin without one
 * has no door a browser can knock on.
 *
 * Only the human at the keyboard may use any of the three. A thread has its own token and no page to draw,
 * and the routes are outside `THREAD_ROUTES` for the same reason every other board route is.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname } from "node:path";
import { answer, fail, readJson } from "../http.ts";
import { pluginManager } from "../plugins/manager.ts";
import { INTERNAL_ERROR, PLUGIN_UNAVAILABLE } from "../plugins/protocol.ts";
import { resolvePluginFile } from "../plugins/registry.ts";
import { workspaceById } from "../workspaces.ts";
import type { PluginVisual } from "../plugins/registry.ts";

/** Where a panel and its files are served from. One prefix, so `main.ts` can route them in one line each. */
export const VISUAL_PREFIX = "/plugins/visual/";

/** The one method a panel's call reaches its plugin as. A plugin answers it or refuses it. */
export const VISUAL_REQUEST = "visual.request";

/**
 * How long a panel waits for its plugin before the daemon answers without it. A panel is a page a human is
 * looking at, so a plugin that is wedged is answered rather than left holding a frame that never settles.
 */
export const VISUAL_TIMEOUT_MS = 15_000;

/**
 * What a file may be, by its extension. A panel is a page: html, the script and style it loads, and the
 * images and fonts they need. Anything else is refused rather than guessed at, so no declared file can be
 * served as something it is not.
 */
const VISUAL_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

/**
 * The document of a panel is sandboxed by the daemon as well as by the frame that shows it. The attribute
 * on the frame is the board's promise; this header is the same promise kept even when the page is opened
 * on its own, and `allow-scripts` without `allow-same-origin` is what leaves the document with an opaque
 * origin: no cookie of this daemon, no storage of this daemon, and nothing to speak for.
 */
const VISUAL_CSP = "sandbox allow-scripts";

/** One panel the board may show: what to call it, and where its frame starts. */
export type VisualPanel = { name: string; title: string; url: string };

/** Who asked, as `main.ts` decided it. A panel is the human's; a thread has no page to draw in. */
type Caller = { human?: unknown } | null | undefined;

/** The running plugins that declared a panel, with the folder their files are served from. */
function visualRoster(): { name: string; root: string; visual: PluginVisual }[] {
	const panels: { name: string; root: string; visual: PluginVisual }[] = [];
	for (const one of pluginManager()?.roster() ?? []) {
		// A plugin that failed to start has no page to ask, so its door is not offered either.
		if (!one.running || !one.visual) continue;
		panels.push({ name: one.name, root: dirname(one.command), visual: one.visual });
	}
	return panels;
}

/** The doors the board draws, one per plugin that has a panel. */
export function onVisualPanels(res: ServerResponse): void {
	answer(res, 200, {
		plugins: visualRoster().map((one) => ({ name: one.name, title: one.visual.title, url: `${VISUAL_PREFIX}${encodeURIComponent(one.name)}/${one.visual.entry}` })),
	});
}

/**
 * One file of one panel. The name in the path is the plugin's, and the rest of the path has to be one of
 * the files that plugin declared — a lookup in a list, not a path joined to a folder, so nothing outside
 * the list can be asked for however it is spelled. What is left is the filesystem's own answer, which
 * `resolvePluginFile` gives: a plain file inside the plugin's folder, never a link.
 */
export function onVisualFile(res: ServerResponse, pathname: string): void {
	const rest = pathname.slice(VISUAL_PREFIX.length);
	const cut = rest.indexOf("/");
	if (cut < 1) return void fail(res, 404, "not a plugin panel file");
	let name: string;
	try {
		name = decodeURIComponent(rest.slice(0, cut));
	} catch {
		return void fail(res, 404, "not a plugin panel file");
	}
	const file = rest.slice(cut + 1);
	const panel = visualRoster().find((one) => one.name === name);
	if (!panel || !panel.visual.files.includes(file)) return void fail(res, 404, "not a plugin panel file");
	const type = VISUAL_TYPES[extname(file).toLowerCase()];
	if (!type) return void fail(res, 404, "not a plugin panel file");
	const full = resolvePluginFile(panel.root, file);
	if (!full) return void fail(res, 404, "not a file the plugin declared");
	let body: Buffer;
	try {
		body = readFileSync(full);
	} catch (error) {
		fail(res, 404, `the plugin's file cannot be read: ${(error as Error).message}`);
		return;
	}
	const headers: Record<string, string> = {
		"Content-Type": type,
		"Cache-Control": "no-store",
		// Nothing is sniffed and nothing is referred: a panel's page is not a place a request leaves from
		// with this daemon's address in its `Referer`.
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	};
	if (type.startsWith("text/html")) headers["Content-Security-Policy"] = VISUAL_CSP;
	res.writeHead(200, headers);
	res.end(body);
}

/**
 * The workspace a panel named, from this daemon's own list. The list is untyped at this boundary, so the one
 * field a call needs is named here and the id is only ever an id the daemon itself wrote.
 */
function workspaceNamed(id: unknown): { id: string } | undefined {
	return typeof id === "string" ? (workspaceById(id) as { id: string } | undefined) : undefined;
}

/**
 * One call a panel made, answered with what its plugin said or with why the daemon would not ask.
 *
 * The body is the envelope the frame sent: the method its plugin should answer and its params. The
 * workspace is the daemon's own, resolved here from its list by id — the panel names an id it was given,
 * never a folder — and it is what the plugin is told it is being asked about.
 */
export async function onVisualRequest(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller): Promise<void> {
	// Every route here is the human's. A thread's token never reaches this one — it is not in
	// `THREAD_ROUTES` — and the check is repeated because that list is a decision made elsewhere.
	if (caller?.human !== true) {
		req.resume();
		return void fail(res, 403, "only the human at the keyboard may ask a plugin panel");
	}
	const body = await readJson(req, res);
	if (body === null) return;
	const name = url.searchParams.get("plugin") ?? "";
	const panel = visualRoster().find((one) => one.name === name);
	if (!panel) return void fail(res, 404, "no plugin panel by that name");
	if (typeof body !== "object" || body === null || Array.isArray(body)) return void fail(res, 400, "a panel call is one object");
	const asked = body as Record<string, unknown>;
	const workspace = workspaceNamed(asked.workspace);
	if (!workspace) {
		const said = typeof asked.workspace === "string" ? `${asked.workspace} is` : "workspace is";
		return void fail(res, 400, `${said} not a workspace this daemon knows`);
	}
	const method = asked.method;
	if (typeof method !== "string" || method.trim() === "" || method.length > 200) return void fail(res, 400, "method must be one line naming what the panel wants");
	const manager = pluginManager();
	if (!manager) return void fail(res, 503, "this daemon runs no plugins");
	try {
		const result = await manager.request(name, VISUAL_REQUEST, { workspace: workspace.id, method, params: asked.params ?? {} }, VISUAL_TIMEOUT_MS);
		answer(res, 200, { result: result ?? null });
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		const failure = typeof code === "number" ? code : INTERNAL_ERROR;
		// A plugin that is gone or never answered is the daemon's upstream failing, and the panel is told so;
		// a call the plugin itself refused keeps its own code and travels as the answer it is.
		const status = failure === PLUGIN_UNAVAILABLE ? 502 : 200;
		answer(res, status, { error: { code: failure, message: (error as Error).message } });
	}
}
