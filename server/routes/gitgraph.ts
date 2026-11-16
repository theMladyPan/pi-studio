/**
 * The four routes that make the Git Graph page possible: the page itself, the three globals it reads,
 * the message it posts, and the bundle's own bytes.
 *
 * They are one file because they are one surface, and they are separated from `server/main.ts` for the
 * same reason every other feature's routes are: the table there names a file, and the answers live
 * beside the thing they answer for. Two of them sit in front of the caller check on purpose — a page is
 * not data — and the other two sit behind it, so a command reaches git only for a caller the daemon has
 * already identified and a workspace it has already loaded.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildViewConfig } from "../git/gitgraph/config.ts";
import { respond } from "../git/gitgraph/dispatch.ts";
import type { DispatchBoard } from "../git/gitgraph/dispatch.ts";
import { reposFor } from "../git/gitgraph/repos.ts";
import { DEFAULT_REPO_STATE, repoStateFrom, stateFor } from "../git/gitgraph/state.ts";
import type { GitRepoState } from "../git/gitgraph/protocol.ts";
import { findBundle } from "../git/gitgraph/vendor.ts";
import { answer, fail, readJson, serveStatic } from "../http.ts";
import type { GitGraphInitPayload } from "../types.ts";

// ---------- the page ----------

/**
 * The Content Security Policy the page runs under. Every script and stylesheet comes from this daemon,
 * the only inline style is the one that carries the graph colours, and a frame may only be this
 * daemon's own: the vendor bundle is somebody else's code, so what it may reach is said here rather
 * than left to the browser's defaults.
 */
const PAGE_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'";

/**
 * The page. It is served before the caller check, like the board's own page, because a page carries no
 * data: what is behind it is `/git/init` and `/git/msg`, and both of those are behind the token. The
 * frame headers say a board may frame it deliberately and a stranger may not, and `no-store` keeps a
 * stale page from outliving a daemon restart that changed the page.
 */
export function onGitPage(res: ServerResponse): void {
	serveStatic(res, "gitgraph.html", "text/html; charset=utf-8", {
		"X-Frame-Options": "SAMEORIGIN",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store",
		"Content-Security-Policy": PAGE_CSP,
	});
}

// ---------- what the page is handed ----------

/** The arrangement the page draws a repository with when it has never seen it: the defaults. */
function stateOf(stored: GitRepoState | undefined): GitRepoState {
	return stored ? repoStateFrom(stored) : { ...DEFAULT_REPO_STATE };
}

/**
 * The three globals the bundle reads, and whether it may be started at all.
 *
 * A missing bundle and a workspace with no repository are both answered as a 200 with `available:
 * false` and a sentence: the page shows it, the human reads it and fixes the one thing that is wrong.
 * A 404 in a tab would say the route was wrong, which it is not.
 */
export async function onGitInit(res: ServerResponse, board: DispatchBoard): Promise<void> {
	const bundle = findBundle();
	const repos = await reposFor(board);
	const paths = [...repos.keys()];
	const state = stateFor(board);
	const unavailable = (reason: string): GitGraphInitPayload => ({ available: false, reason, initialState: null, globalState: null, workspaceState: null });
	if (!bundle.ok) {
		answer(res, 200, unavailable(bundle.reason));
		return;
	}
	if (paths.length === 0) {
		answer(res, 200, unavailable(`this workspace has no repository to show: ${board.folder} is not one, and none of its trees is`));
		return;
	}
	const stored = state.repos;
	const repoStates: Record<string, GitRepoState> = {};
	for (const path of paths) {
		const entry = repos.get(path);
		const held = stateOf(stored[path]);
		// The name a human gave a repository is theirs; the label the dropdown would otherwise show is
		// the folder's own name or the tree's branch, which is what they see before renaming it.
		repoStates[path] = { ...held, name: held.name ?? (entry?.label ?? null) };
	}
	answer(res, 200, {
		available: true,
		reason: null,
		initialState: {
			config: buildViewConfig(),
			lastActiveRepo: state.lastActiveRepo !== null && paths.includes(state.lastActiveRepo) ? state.lastActiveRepo : paths[0],
			// Null rather than an empty object: the bundle compares this with `null` before it decides
			// whether to open a particular commit, and a string there makes it report a load failure.
			loadViewTo: null,
			repos: repoStates,
			loadRepoInfoRefreshId: 0,
			loadCommitsRefreshId: 0,
		},
		globalState: state.globalViewState,
		workspaceState: state.workspaceViewState,
	} satisfies GitGraphInitPayload);
}

// ---------- the message ----------

/**
 * One message from the page, its replies.
 *
 * `readJson` answers a body that is not JSON or is too large itself, so a null from it means the reply
 * has already been sent. Everything else goes to `respond`, which never throws: what comes back is
 * always an array of replies, and the page has one listener for all of them.
 */
export async function onGitMsg(req: IncomingMessage, res: ServerResponse, board: DispatchBoard): Promise<void> {
	const body = await readJson(req, res);
	if (body === null) return;
	answer(res, 200, await respond(board, body));
}

// ---------- the bundle ----------

/** The two files the page may fetch, and what each one is. Anything else is not a bundle path. */
const VENDOR_FILES: Record<string, { key: "jsPath" | "cssPath"; type: string }> = {
	"out.min.js": { key: "jsPath", type: "text/javascript; charset=utf-8" },
	"out.min.css": { key: "cssPath", type: "text/css; charset=utf-8" },
};

/**
 * The bundle's own bytes, read out of the human's installed extension.
 *
 * These are the only vendor paths there are: the file name is looked up in a table, so nothing a page
 * sends is ever joined onto a path. They are served without the caller check because they carry no
 * data — they are the same two files for every tab — and reading them from the human's own copy of the
 * extension is what keeps this daemon from redistributing code it has no licence to ship.
 */
export function onGitVendor(res: ServerResponse, file: string): void {
	const wanted = VENDOR_FILES[file];
	if (!wanted) {
		fail(res, 404, "not a Git Graph bundle file");
		return;
	}
	const bundle = findBundle();
	if (!bundle.ok) {
		fail(res, 404, bundle.reason);
		return;
	}
	let body: Buffer;
	try {
		body = readFileSync(bundle[wanted.key]);
	} catch (error) {
		fail(res, 404, `the Git Graph bundle cannot be read: ${(error as Error).message}`);
		return;
	}
	res.writeHead(200, { "Content-Type": wanted.type, "Cache-Control": "no-store" });
	res.end(body);
}
