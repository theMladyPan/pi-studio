import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BRANCH_COLOURS } from "../server/git/gitgraph/config.ts";
import { STATE_VERSION, workspaceId } from "../server/paths.ts";
import { ensureWorktree } from "../server/worktrees/make.ts";
import { git, scratchRepo } from "../test-support/git.ts";

/**
 * The four routes, reached the way a browser reaches them: a real daemon, a real token and a real
 * folder. What they cannot show is the bundle itself, so a stand-in extension is written to a temporary
 * folder and pointed at with `PI_STUDIO_GITGRAPH_DIR` — the same door a human who keeps their copy
 * somewhere else uses.
 */
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/** A folder that looks like an installed mhutchie.git-graph 1.30.0, holding the two files it serves. */
function fakeExtension() {
	const dir = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-ext-"));
	mkdirSync(join(dir, "media"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mhutchie.git-graph", version: "1.30.0" }));
	writeFileSync(join(dir, "media", "out.min.js"), "var stoodInForTheBundle = true;\n");
	writeFileSync(join(dir, "media", "out.min.css"), "body { color: #c9d1d9; }\n");
	return dir;
}

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
	const extension = fakeExtension();
	const daemon = await boot({ PI_STUDIO_GITGRAPH_DIR: extension });
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
		// The bundle stops silently without these, so they are part of the contract rather than of taste.
		for (const id of ["view", "controls", "repoDropdown", "branchDropdown", "showRemoteBranchesCheckbox", "findBtn", "terminalBtn", "settingsBtn", "fetchBtn", "refreshBtn", "content", "commitGraph", "commitTable", "footer", "scrollShadow"]) {
			assert.ok(page.body.includes(`id="${id}"`), `the page must hold #${id}`);
		}
		assert.ok(page.body.includes('src="/client/gitgraph/host.js"'), "the page runs one script of ours");
		assert.ok(page.body.includes('href="/gitgraph/vendor/out.min.css"'), "and the bundle's stylesheet");
		assert.ok(page.body.includes('href="/favicon.svg"'), "and the mark, so a tab does not 404 for one");
		// The twelve graph colours are drawn before any script runs, so the page repeats the daemon's list.
		for (const colour of BRANCH_COLOURS) assert.ok(page.body.includes(colour), `the page must carry the graph colour ${colour}`);
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
		rmSync(extension, { recursive: true, force: true });
	}
});

test("the page carries no inline script, which is what the policy forbids", async () => {
	const extension = fakeExtension();
	const daemon = await boot({ PI_STUDIO_GITGRAPH_DIR: extension });
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		const page = await get(daemon, `/git/${board}`);
		assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(page.body), "an inline script would be refused by connect-src 'self' and would silently not run");
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
		rmSync(extension, { recursive: true, force: true });
	}
});

test("every file the page names is served, so nothing it needs is a 404", async () => {
	const extension = fakeExtension();
	const daemon = await boot({ PI_STUDIO_GITGRAPH_DIR: extension });
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		const page = await get(daemon, `/git/${board}`);
		const named = [...page.body.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
		assert.ok(named.includes("/client/gitgraph/host.js"), `the page names its script: ${named.join(", ")}`);
		for (const path of named) {
			// The client module graph is a second hop: host.js imports the viewer, and a module that
			// resolves to a 404 leaves the page silent with nothing but a console line.
			const answered = await get(daemon, path);
			assert.equal(answered.status, 200, `${path} must be served`);
		}
		for (const path of ["/client/gitgraph/host.js", "/client/gitgraph/viewer.js"]) {
			const module = await get(daemon, path);
			assert.match(module.type, /javascript/);
		}
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
		rmSync(extension, { recursive: true, force: true });
	}
});

test("init refuses a caller without a token and answers a signed-in one with the three globals", async () => {
	const extension = fakeExtension();
	const daemon = await boot({ PI_STUDIO_GITGRAPH_DIR: extension });
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		assert.equal((await get(daemon, `/git/init?workspace=${board}`)).status, 403, "the token guards the data route");

		const init = await get(daemon, `/git/init?token=${daemon.token}&workspace=${board}`);
		assert.equal(init.status, 200);
		const payload = JSON.parse(init.body);
		assert.equal(payload.available, true);
		assert.equal(payload.reason, null);
		assert.equal(payload.initialState.loadViewTo, null);
		assert.equal(payload.initialState.loadRepoInfoRefreshId, 0);
		assert.equal(payload.initialState.loadCommitsRefreshId, 0);
		assert.equal(payload.initialState.config.fetchAvatars, false, "no avatar is fetched on a human's behalf");
		const paths = Object.keys(payload.initialState.repos);
		assert.equal(paths.length, 1);
		assert.equal(paths[0], realpathSync(folder));
		assert.equal(payload.initialState.repos[paths[0]].name, folder.split("/").pop(), "a repository nobody renamed is labelled by its folder");
		assert.equal(payload.initialState.lastActiveRepo, paths[0]);
		assert.deepEqual(payload.globalState, { alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false });
		assert.deepEqual(payload.workspaceState, { findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false });
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
		rmSync(extension, { recursive: true, force: true });
	}
});

test("init says why a tab cannot draw, and never fails the request", async () => {
	const daemon = await boot({ PI_STUDIO_GITGRAPH_DIR: join(tmpdir(), "pi-studio-no-extension-here") });
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		const init = await get(daemon, `/git/init?token=${daemon.token}&workspace=${board}`);
		assert.equal(init.status, 200);
		const payload = JSON.parse(init.body);
		assert.equal(payload.available, false);
		assert.match(payload.reason, /PI_STUDIO_GITGRAPH_DIR/);
		assert.equal(payload.initialState, null);
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
	}
});

test("a workspace that is not a repository is told so rather than shown an empty graph", async () => {
	const extension = fakeExtension();
	const daemon = await boot({ PI_STUDIO_GITGRAPH_DIR: extension });
	try {
		const plain = mkdtempSync(join(tmpdir(), "pi-studio-gitgraph-plain-"));
		const board = await openWorkspace(daemon, plain);
		const init = await get(daemon, `/git/init?token=${daemon.token}&workspace=${board}`);
		const payload = JSON.parse(init.body);
		assert.equal(payload.available, false);
		assert.match(payload.reason, /no repository/);
		rmSync(plain, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
		rmSync(extension, { recursive: true, force: true });
	}
});

test("the bundle's two files are served from the installed copy, and nothing else is", async () => {
	const extension = fakeExtension();
	const daemon = await boot({ PI_STUDIO_GITGRAPH_DIR: extension });
	try {
		// No token on purpose: these bytes carry no data, and the page fetches them before it is signed in.
		const script = await get(daemon, "/gitgraph/vendor/out.min.js");
		assert.equal(script.status, 200);
		assert.match(script.type, /javascript/);
		assert.equal(script.headers.get("cache-control"), "no-store");
		assert.match(script.body, /stoodInForTheBundle/);
		const style = await get(daemon, "/gitgraph/vendor/out.min.css");
		assert.equal(style.status, 200);
		assert.match(style.type, /text\/css/);
		// A path that is not one of the two is not a vendor path at all, so it falls through to the token
		// check; with a token it reaches the route, which refuses it by name rather than by path.
		const elsewhere = await get(daemon, `/gitgraph/vendor/%2e%2e%2fout.min.js?token=${daemon.token}`);
		assert.equal(elsewhere.status, 404, "a path that escapes the bundle folder is refused before anything is read");
		const madeUp = await get(daemon, `/gitgraph/vendor/not-a-bundle.js?token=${daemon.token}`);
		assert.equal(madeUp.status, 404);
	} finally {
		daemon.child.kill();
		rmSync(extension, { recursive: true, force: true });
	}
});

test("one message is answered with its replies, and refused without the token", async () => {
	const extension = fakeExtension();
	const daemon = await boot({ PI_STUDIO_GITGRAPH_DIR: extension });
	try {
		const folder = scratchRepo();
		const board = await openWorkspace(daemon, folder);
		const refused = await get(daemon, `/git/msg?workspace=${board}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: "loadRepos", check: false }),
		});
		assert.equal(refused.status, 403);

		const answered = await post(daemon, `/git/msg?workspace=${board}`, { command: "loadRepoInfo", repo: folder, refreshId: 5, showRemoteBranches: true, showStashes: false, hideRemotes: [] });
		assert.equal(answered.status, 200);
		const replies = JSON.parse(answered.body) as Array<Record<string, unknown>>;
		assert.equal(replies.length, 1);
		assert.equal(replies[0].command, "loadRepoInfo");
		assert.equal(replies[0].refreshId, 5);
		assert.deepEqual(replies[0].branches, ["dev"]);

		const notOpen = await post(daemon, `/git/msg?workspace=${board}`, { command: "loadRepoInfo", repo: "/nowhere-at-all", refreshId: 6, showRemoteBranches: true, showStashes: false, hideRemotes: [] });
		assert.equal(JSON.parse(notOpen.body)[0].error, "That repository is no longer open in this tab.");
		rmSync(folder, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
		rmSync(extension, { recursive: true, force: true });
	}
});

test("a board with a worktree offers the dropdown two repositories, and the tree is labelled by its branch and its thread", async () => {
	const extension = fakeExtension();
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
	const daemon = await boot({ PI_STUDIO_GITGRAPH_DIR: extension }, state);
	try {
		const board = await openWorkspace(daemon, folder);
		assert.equal(board, boardId, "a folder keeps its identity, which is how the board file was found");
		const init = await get(daemon, `/git/init?token=${daemon.token}&workspace=${board}`);
		assert.equal(init.status, 200);
		const payload = JSON.parse(init.body);
		assert.equal(payload.available, true, payload.reason);
		const repos = payload.initialState.repos as Record<string, { name: string | null }>;
		const paths = Object.keys(repos);
		assert.equal(paths.length, 2, `expected the folder and its tree, got ${paths.join(", ")}`);
		assert.equal(paths[0], realpathSync(folder), "the folder the workspace opened comes first");
		assert.equal(paths[1], realpathSync(tree.path), "the tree is keyed by its own path");
		assert.equal(repos[paths[0]].name, folder.split("/").pop(), "the folder is labelled by its own name");
		assert.equal(repos[paths[1]].name, "feat/drawer · the drawer's tree", "the tree carries its branch and the thread's title");
		assert.equal(payload.initialState.lastActiveRepo, paths[0], "the dropdown opens on the folder");
		// The page refreshes itself by re-reading this same list through the message route, and the answer to
		// that is the one the dropdown is drawn from: a name the init route filled and this one left `null`
		// would be wiped back to the tree's own folder id, which is what a human would then read instead.
		const listed = await post(daemon, `/git/msg?workspace=${board}`, { command: "loadRepos", check: false });
		assert.equal(listed.status, 200);
		const replies = JSON.parse(listed.body) as Array<{ command: string; repos: Record<string, { name: string | null }> }>;
		assert.equal(replies.length, 1);
		assert.equal(replies[0].command, "loadRepos");
		assert.equal(replies[0].repos[paths[1]].name, "feat/drawer · the drawer's tree", "the message route labels the tree exactly as the init route did");
		assert.equal(replies[0].repos[paths[0]].name, folder.split("/").pop(), "and the folder by its own name, so the two routes agree on every entry");
		// This is what makes the dropdown exist at all, and it is the bundle's decision rather than this
		// daemon's: `loadRepos` in the installed `media/out.min.js` sets the `singleRepo` class on
		// `#controls` from `Object.keys(repos).length === 1`, and `media/out.min.css` carries
		// `.singleRepo #repoControl{display:none;}`. With two keys the class is not set and `#repoControl`
		// is drawn. Unverified in a browser from here: that is the bundle's code, and this daemon only
		// answers the two keys.
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
		rmSync(extension, { recursive: true, force: true });
	}
});
