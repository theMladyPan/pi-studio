/**
 * The three routes that make the Git Graph page possible: the page itself, the view state it reads,
 * and the message it posts.
 *
 * They are one file because they are one surface, and they are separated from `server/main.ts` for
 * the same reason every other feature's routes are: the table there names a file, and the answers
 * live beside the thing they answer for. The page sits in front of the caller check on purpose — a
 * page is not data — and the other two sit behind it, so a command reaches git only for a caller the
 * daemon has already identified and a workspace it has already loaded.
 *
 * The page and the client modules it loads are pi-studio's own, served by the `/client` rule in
 * `main.ts`; nothing here looks for a copy of anybody's browser extension, and no route serves one.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildViewState } from "../git/gitgraph/config.ts";
import { respond } from "../git/gitgraph/dispatch.ts";
import type { DispatchBoard } from "../git/gitgraph/dispatch.ts";
import { reposFor } from "../git/gitgraph/repos.ts";
import { DEFAULT_REPO_STATE, stateFor } from "../git/gitgraph/state.ts";
import type { GitRepoState } from "../git/gitgraph/libre.ts";
import { answer, readJson, serveStatic } from "../http.ts";
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

/**
 * The three globals the page reads before it draws, and whether it may draw at all.
 *
 * A board whose folder is no repository is the one refusal left: there is nothing to draw and the
 * sentence says which folder was looked at. `version` is the page's own version slot and this daemon
 * has no second copy to name, so it answers `null`; a tab that reads it gets one value forever.
 */
export async function onGitInit(res: ServerResponse, board: DispatchBoard): Promise<void> {
	const repos = await reposFor(board);
	const paths = [...repos.keys()];
	const state = stateFor(board);
	const unavailable = (reason: string): GitGraphInitPayload => ({ available: false, reason, viewState: null, version: null });
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
	answer(res, 200, { available: true, reason: null, viewState, version: null } satisfies GitGraphInitPayload);
}

// ---------- the message ----------

export async function onGitMsg(req: IncomingMessage, res: ServerResponse, board: DispatchBoard): Promise<void> {
	const body = await readJson(req, res);
	if (body === null) return;
	answer(res, 200, await respond(board, body));
}
