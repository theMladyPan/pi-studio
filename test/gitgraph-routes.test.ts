import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STATE_VERSION, workspaceId } from "../server/paths.ts";
import { ensureWorktree } from "../server/worktrees/make.ts";
import { git, scratchRepo } from "../test-support/git.ts";

/**
 * The three routes, reached the way a browser reaches them: a real daemon, a real token and a real
 * folder. The page is pi-studio's own document and its own client modules, so nothing here needs an
 * installed editor extension: a workspace with a repository is all a tab needs to draw.
 *
 * Two assertions describe the page the frontend delivers — the stylesheet and script it names, and
 * the ids its client reads. They wait for that page to land: `public/gitgraph.html` and
 * `public/client/gitgraph/` are written on their own branch, and this file is where the contract
 * between the two halves is stated. The routes behind them are proven independently of it.
 */
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

type Daemon = { child: { kill: () => void }; base: string; token: string };

/** One daemon against a scratch state folder, with whatever environment a test needs. */
async function boot(env: Record<string, string> = {}, state = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-routes-"))): Promise<Daemon> {
	const child = spawn(process.execPath, [join(repo, "server.ts"), "--no-open"], {
		cwd: repo,
		env: { ...process.env, PI_STUDIO_STATE: state, PI_STUDIO_PORT: "", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const noise: string[] = [];
	child.stderr.on("data", (chunk) => noise.push(String(chunk)));
	const url = await new Promise<string>((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(() => reject(new Error(`no listening line in 20s: ${noise.join("")}`)), 20_000);
		child.stdout.on("data", (chunk) => {
			seen += String(chunk);
			const match = seen.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/);
			if (!match) return;
			clearTimeout(timer);
			resolve(match[1]);
		});
		child.on("exit", (code) => reject(new Error(`the daemon exited with ${code}: ${noise.join("").slice(-400)}`)));
	});
	const parsed = new URL(url);
	return { child, base: parsed.origin, token: parsed.searchParams.get("token") ?? "" };
}

const get = async (daemon: Daemon, path: string, init?: RequestInit) => {
	const res = await fetch(daemon.base + path, init);
	return { status: res.status, type: res.headers.get("content-type") ?? "", headers: res.headers, body: await res.text() };
};

const post = (daemon: Daemon, path: string, body: unknown) =>
	get(daemon, `${path}${path.includes("?") ? "&" : "?"}token=${daemon.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

/** A workspace opened on a folder, which is what every route below needs to name. */
async function openWorkspace(daemon: Daemon, folder: string): Promise<string> {
	const opened = await post(daemon, "/workspace", { folder });
	assert.equal(opened.status, 200, opened.body.slice(0, 200));
	const board = JSON.parse(opened.body).board as { id: string };
	assert.ok(board?.id, "no board came back");
	return board.id;
}

test("the page is served with the headers a framed view needs", async () => {
	const daemon = await boot();
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		const page = await get(daemon, `/git/${board}`);
		assert.equal(page.status, 200);
		assert.match(page.type, /text\/html/);
		assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
		assert.equal(page.headers.get("referrer-policy"), "no-referrer");
		assert.equal(page.headers.get("cache-control"), "no-store");
		const csp = page.headers.get("content-security-policy") ?? "";
		for (const rule of ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'self'"]) {
			assert.ok(csp.includes(rule), `the policy must hold ${rule}: ${csp}`);
		}
		assert.ok(page.body.includes('href="/favicon.svg"'), "and the mark, so a tab does not 404 for one");
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
	}
});

// Waits for the page the frontend branch delivers: the entry document names its own client modules,
// which is what replaces the retired vendor bundle, and carries the ids that client looks up.
test("the page names its own stylesheet and script, and carries the ids its client reads", async () => {
	const daemon = await boot();
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		const page = await get(daemon, `/git/${board}`);
		assert.ok(page.body.includes('href="/client/gitgraph/gitgraph.css"'), "the page names its own stylesheet");
		assert.ok(page.body.includes('src="/client/gitgraph/host.js"'), "the page names its own entry script");
		for (const id of ["topBar", "commitGraph", "commitTable", "repoSelect", "ggViewer", "ggViewerTitle", "ggViewerBody"]) {
			assert.ok(page.body.includes(`id="${id}"`), `the page must hold #${id}`);
		}
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
	}
});

test("the page carries no inline script, which is what the policy forbids", async () => {
	const daemon = await boot();
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		const page = await get(daemon, `/git/${board}`);
		assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(page.body), "an inline script would be refused by connect-src 'self' and would silently not run");
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
	}
});

// Also waits for the delivered page: the rule that serves a client module is what this proves, and
// only the page's own list of names says which modules that is.
test("every file the page names is served, so nothing it needs is a 404", async () => {
	const daemon = await boot();
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		const page = await get(daemon, `/git/${board}`);
		const named = [...page.body.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
		assert.ok(named.includes("/client/gitgraph/host.js"), `the page names its script: ${named.join(", ")}`);
		assert.ok(named.includes("/client/gitgraph/gitgraph.css"), `the page names its stylesheet: ${named.join(", ")}`);
		for (const path of named) {
			const answered = await get(daemon, path);
			assert.equal(answered.status, 200, `${path} must be served`);
		}
		const script = await get(daemon, "/client/gitgraph/host.js");
		assert.match(script.type, /javascript/);
		const style = await get(daemon, "/client/gitgraph/gitgraph.css");
		assert.match(style.type, /text\/css/);
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
	}
});

test("init refuses a caller without a token and answers a signed-in one with the view state", async () => {
	const daemon = await boot();
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		assert.equal((await get(daemon, `/git/init?workspace=${board}`)).status, 403, "the token guards the data route");

		const init = await get(daemon, `/git/init?token=${daemon.token}&workspace=${board}`);
		assert.equal(init.status, 200);
		const payload = JSON.parse(init.body);
		assert.equal(payload.available, true, payload.reason);
		assert.equal(payload.reason, null);
		assert.equal(payload.viewState.lastActiveRepo, realpathSync(folder));
		assert.equal(payload.viewState.fetchAvatars, false, "no avatar is fetched on a human's behalf");
		const paths = Object.keys(payload.viewState.repos);
		assert.equal(paths.length, 1);
		assert.equal(paths[0], realpathSync(folder));
		assert.equal(payload.viewState.repos[paths[0]].displayName, folder.split("/").pop(), "a repository nobody renamed is labelled by its folder");
		// Nothing on this machine has to be installed for the page to draw, so there is no bundle version
		// to name: the slot is answered, and it is empty for every tab.
		assert.equal(payload.version, null);
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
	}
});

test("a workspace that is not a repository is told so rather than shown an empty graph", async () => {
	const daemon = await boot();
	try {
		const plain = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-plain-"));
		const board = await openWorkspace(daemon, plain);
		const init = await get(daemon, `/git/init?token=${daemon.token}&workspace=${board}`);
		assert.equal(init.status, 200);
		const payload = JSON.parse(init.body);
		assert.equal(payload.available, false);
		assert.match(payload.reason, /no repository/);
		assert.equal(payload.viewState, null);
		rmSync(plain, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
	}
});

test("the retired vendor route is gone, and no path under it is served", async () => {
	const daemon = await boot();
	try {
		// The files a borrowed extension used to provide are not this daemon's to serve any more, so every
		// spelling of that path is an unknown route: with a token it is the route table's 404, and without
		// one it is the caller check's 403.
		assert.equal((await get(daemon, "/gitgraph/vendor/web.min.js")).status, 403);
		assert.equal((await get(daemon, `/gitgraph/vendor/web.min.js?token=${daemon.token}`)).status, 404);
		assert.equal((await get(daemon, `/gitgraph/vendor/base.css?token=${daemon.token}`)).status, 404);
		assert.equal((await get(daemon, `/gitgraph/vendor/%2e%2e%2fweb.min.js?token=${daemon.token}`)).status, 404);
	} finally {
		daemon.child.kill();
	}
});

test("one message is answered with its replies, and refused without the token", async () => {
	const daemon = await boot();
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		const refused = await get(daemon, `/git/msg?workspace=${board}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: "loadRepos", check: false }),
		});
		assert.equal(refused.status, 403);

		const resolved = realpathSync(folder);
		const answered = await post(daemon, `/git/msg?workspace=${board}`, { command: "loadRepoInfo", requestId: 5, repo: resolved, showStashes: false });
		assert.equal(answered.status, 200);
		const replies = JSON.parse(answered.body) as Array<Record<string, unknown>>;
		assert.equal(replies.length, 1);
		assert.equal(replies[0].command, "loadRepoInfo");
		assert.equal(replies[0].requestId, 5);
		assert.equal((replies[0].repoInfo as { head: string }).head, "dev");

		const notOpen = await post(daemon, `/git/msg?workspace=${board}`, { command: "loadRepoInfo", requestId: 6, repo: "/nowhere-at-all", showStashes: false });
		assert.equal((JSON.parse(notOpen.body)[0].error as { message: string }).message, "That repository is no longer open in this tab.");
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
	}
});

test("a board with a worktree offers the dropdown two repositories, and the tree is labelled by its branch and its thread", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-two-"));
	const folder = scratchRepo();
	// The tree a thread works in, made the way the daemon makes one: `ensureWorktree` on a plain board,
	// because the daemon only ever makes one for a child that is spawning, and no child runs in a test.
	const plain = { folder, trees: [] as Array<{ path: string; branch?: string }>, threads: new Map(), children: new Map() };
	const thread = { id: "thread-gitgraph-1", title: "the drawer's tree", folder };
	plain.threads.set(thread.id, thread);
	const tree = ensureWorktree(plain, thread);
	assert.ok(tree.path, `no worktree made: ${JSON.stringify(tree)}`);
	git(tree.path, "checkout", "-b", "feat/drawer");
	writeFileSync(join(tree.path, "tree.txt"), "tree\n");
	git(tree.path, "add", ".");
	git(tree.path, "commit", "-m", "tree work");
	tree.branch = "feat/drawer";
	const boardId = workspaceId(folder);
	// A daemon reads a board out of its own state folder, so the record is written before it boots. The
	// path is `paths.ts`'s `boardFile`, which a test process cannot call: its `STATE_DIR` is not this one.
	mkdirSync(join(state, "boards"), { recursive: true });
	writeFileSync(
		join(state, "boards", `${boardId}.json`),
		JSON.stringify({
			version: STATE_VERSION,
			workspace: { id: boardId, folder, name: "pi-studio" },
			trees: [tree],
			threads: [{ id: thread.id, title: thread.title, at: Date.now(), turns: [] }],
		}),
	);
	const daemon = await boot({}, state);
	try {
		const board = await openWorkspace(daemon, folder);
		assert.equal(board, boardId, "a folder keeps its identity, which is how the board file was found");
		const init = await get(daemon, `/git/init?token=${daemon.token}&workspace=${board}`);
		assert.equal(init.status, 200);
		const payload = JSON.parse(init.body);
		assert.equal(payload.available, true, payload.reason);
		const repos = payload.viewState.repos as Record<string, { displayName: string | null }>;
		const paths = Object.keys(repos);
		assert.equal(paths.length, 2, `expected the folder and its tree, got ${paths.join(", ")}`);
		assert.equal(paths[0], realpathSync(folder), "the folder the workspace opened comes first");
		assert.equal(paths[1], realpathSync(tree.path), "the tree is keyed by its own path");
		assert.equal(repos[paths[0]].displayName, folder.split("/").pop(), "the folder is labelled by its own name");
		assert.equal(repos[paths[1]].displayName, "feat/drawer · the drawer's tree", "the tree carries its branch and the thread's title");
		assert.equal(payload.viewState.lastActiveRepo, paths[0], "the dropdown opens on the folder");
		// The page refreshes itself by re-reading this same list through the message route, and the answer to
		// that is the one the dropdown is drawn from: a name the init route filled and this one left `null`
		// would be wiped back to the tree's own folder id, which is what a human would then read instead.
		const listed = await post(daemon, `/git/msg?workspace=${board}`, { command: "loadRepos", check: false });
		assert.equal(listed.status, 200);
		const replies = JSON.parse(listed.body) as Array<{ command: string; repos: Record<string, { displayName: string | null }> }>;
		assert.equal(replies.length, 1);
		assert.equal(replies[0].command, "loadRepos");
		assert.equal(replies[0].repos[paths[1]].displayName, "feat/drawer · the drawer's tree", "the message route labels the tree exactly as the init route did");
		assert.equal(replies[0].repos[paths[0]].displayName, folder.split("/").pop(), "and the folder by its own name, so the two routes agree on every entry");
		// The branch list follows the repository the page names, and only that one: a drawer that reads one
		// checkout while another selects a different repository in the dropdown must not be answered about
		// the wrong tree. Without a name it falls back to the selected repository, which is the folder here.
		const named = await post(daemon, `/git/msg?workspace=${board}`, { command: "loadBranches", requestId: 9, repo: paths[1], showRemoteBranches: false });
		const namedReply = (JSON.parse(named.body) as Array<Record<string, unknown>>)[0];
		assert.equal(namedReply.command, "loadBranches");
		assert.equal(namedReply.requestId, 9);
		assert.equal(namedReply.isRepo, true);
		assert.equal(namedReply.head, "feat/drawer", "the branches are the named tree's");
		const unnamed = await post(daemon, `/git/msg?workspace=${board}`, { command: "loadBranches", requestId: 10, showRemoteBranches: false });
		const unnamedReply = (JSON.parse(unnamed.body) as Array<Record<string, unknown>>)[0];
		assert.equal(unnamedReply.head, "dev", "a page that names no repository is answered about the selected one");
		// A path this board does not list is refused with the query shape, so the page drops the answer rather
		// than drawing branches of a checkout the tab never opened.
		const refused = await post(daemon, `/git/msg?workspace=${board}`, { command: "loadBranches", requestId: 11, repo: "/nowhere-at-all" });
		const refusedReply = (JSON.parse(refused.body) as Array<Record<string, unknown>>)[0];
		assert.equal(refusedReply.requestId, 11);
		assert.equal((refusedReply.error as { message: string }).message, "That repository is no longer open in this tab.");
		assert.equal(refusedReply.branches, undefined, "and no branches of a checkout the tab never opened are named");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});
