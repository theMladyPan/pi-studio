/**
 * The four routes that make the Git Graph Libre page possible: the page itself, the view state it
 * reads, the message it posts, and the bundle's own bytes.
 *
 * They are one file because they are one surface, and they are separated from `server/main.ts` for
 * the same reason every other feature's routes are: the table there names a file, and the answers
 * live beside the thing they answer for. Two of them sit in front of the caller check on purpose —
 * a page is not data — and the other two sit behind it, so a command reaches git only for a caller
 * the daemon has already identified and a workspace it has already loaded.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildViewState } from "../git/gitgraph/config.ts";
import { respond } from "../git/gitgraph/dispatch.ts";
import type { DispatchBoard } from "../git/gitgraph/dispatch.ts";
import { reposFor } from "../git/gitgraph/repos.ts";
import { DEFAULT_REPO_STATE, repoStateFrom, stateFor } from "../git/gitgraph/state.ts";
import type { GitRepoState } from "../git/gitgraph/libre.ts";
import { findBundle } from "../git/gitgraph/vendor.ts";
import { answer, fail, readJson, serveStatic } from "../http.ts";
import type { GitGraphInitPayload } from "../git/gitgraph/libre.ts";

// ---------- the page ----------

const PAGE_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'";

export function onGitPage(res: ServerResponse): void {
	serveStatic(res, "gitgraph.html", "text/html; charset=utf-8", {
		"X-Frame-Options": "SAMEORIGIN",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store",
		"Content-Security-Policy": PAGE_CSP,
	});
}

// ---------- what the page is handed ----------

function stateOf(stored: GitRepoState | undefined, label: string): GitRepoState {
	return stored ? { ...stored, displayName: stored.displayName ?? label } : { ...DEFAULT_REPO_STATE, displayName: label };
}

export async function onGitInit(res: ServerResponse, board: DispatchBoard): Promise<void> {
	const bundle = findBundle();
	const repos = await reposFor(board);
	const paths = [...repos.keys()];
	const state = stateFor(board);
	const unavailable = (reason: string): GitGraphInitPayload => ({ available: false, reason, viewState: null, version: null });
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
		repoStates[path] = stateOf(stored[path], entry?.label ?? path);
	}
	const lastActiveRepo = state.lastActiveRepo !== null && paths.includes(state.lastActiveRepo) ? state.lastActiveRepo : paths[0];
	const viewState = buildViewState(undefined, { repos: repoStates, lastActiveRepo, repoLayout: { worktrees: {}, outside: [] } });
	answer(res, 200, { available: true, reason: null, viewState, version: bundle.version } satisfies GitGraphInitPayload);
}

// ---------- the message ----------

export async function onGitMsg(req: IncomingMessage, res: ServerResponse, board: DispatchBoard): Promise<void> {
	const body = await readJson(req, res);
	if (body === null) return;
	answer(res, 200, await respond(board, body));
}

// ---------- the bundle ----------

/** The files the page may fetch, and what each one is. Anything else is not a bundle path. */
const VENDOR_TYPES: Record<string, string> = {
	"web.min.js": "text/javascript; charset=utf-8",
	"startup.min.js": "text/javascript; charset=utf-8",
	"diffTab.min.js": "text/javascript; charset=utf-8",
	"tokens.css": "text/css; charset=utf-8",
	"base.css": "text/css; charset=utf-8",
	"checkbox.css": "text/css; charset=utf-8",
	"table.css": "text/css; charset=utf-8",
	"commit-details.css": "text/css; charset=utf-8",
	"refs.css": "text/css; charset=utf-8",
	"toolbar.css": "text/css; charset=utf-8",
	"settings.css": "text/css; charset=utf-8",
	"dialogs.css": "text/css; charset=utf-8",
	"dropdown.css": "text/css; charset=utf-8",
	"bundle.l10n.json": "application/json; charset=utf-8",
};

export function onGitVendor(res: ServerResponse, file: string): void {
	const type = VENDOR_TYPES[file];
	if (!type) {
		fail(res, 404, "not a Git Graph bundle file");
		return;
	}
	const bundle = findBundle();
	if (!bundle.ok) {
		fail(res, 404, bundle.reason);
		return;
	}
	const full = bundle.files[file];
	if (!full) {
		fail(res, 404, "not a Git Graph bundle file");
		return;
	}
	let body: Buffer;
	try {
		body = readFileSync(full);
	} catch (error) {
		fail(res, 404, `the Git Graph bundle cannot be read: ${(error as Error).message}`);
		return;
	}
	res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
	res.end(body);
}
