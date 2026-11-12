import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_WORKSPACE_PROMPT_CHARS } from "../server/limits.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
/**
 * The shells a check names outright, so that what it asserts does not depend on the `SHELL` of whoever runs
 * the suite: a `!` line resolves its interpreter from that variable, and dash, bash and zsh do not agree.
 */
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "";
const ZSH = existsSync("/usr/bin/zsh") ? "/usr/bin/zsh" : "";

/**
 * One daemon on its own state folder, started the way a human starts it. Nothing is spawned from a
 * thread here, so no `pi` child ever runs and no model is called — except where a test passes `env` to
 * put a stub `pi` in the daemon's way.
 */
async function boot(folder: string, env: Record<string, string> = {}) {
	const child = spawn(process.execPath, [join(repo, "server.ts"), "--no-open"], {
		cwd: repo,
		env: { ...process.env, PI_STUDIO_STATE: folder, PI_STUDIO_PORT: "", ...env },
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
	return { child, noise, base: parsed.origin, token: parsed.searchParams.get("token") ?? "" };
}

type Daemon = { child: { kill: () => void }; noise: string[]; base: string; token: string };
const get = async (daemon: Daemon, path: string, init?: RequestInit) => {
	const res = await fetch(daemon.base + path, init);
	return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
};
const post = (daemon: Daemon, path: string, body?: unknown) =>
	get(daemon, `${path}?token=${daemon.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
/** A POST that names the board it is about, which every card route needs. */
const postTo = (daemon: Daemon, board: string, path: string, body?: unknown) =>
	get(daemon, `${path}?token=${daemon.token}&workspace=${board}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
/** The same, carrying someone else's token: a thread speaks for itself and not for the human. */
const postAs = (daemon: Daemon, token: string, board: string, path: string, body?: unknown) =>
	get(daemon, `${path}?token=${token}&workspace=${board}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});

/**
 * A POST held open as a raw request, so a check can watch when its headers and its body arrive rather than only
 * what the whole answer turned out to be. `fetch` hands back one finished body, which is the wrong shape for
 * watching a response that is still being written.
 */
function heldPost(daemon: Daemon, board: string, path: string, body: unknown) {
	const seen = { status: 0, headersAt: null as number | null, endedAt: null as number | null, chunks: [] as string[] };
	const done = new Promise<typeof seen>((resolve, reject) => {
		const req = request(
			`${daemon.base}${path}?token=${daemon.token}&workspace=${board}`,
			{ method: "POST", headers: { "content-type": "application/json" } },
			(res) => {
				seen.status = res.statusCode ?? 0;
				seen.headersAt = Date.now();
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => seen.chunks.push(chunk));
				res.on("end", () => {
					seen.endedAt = Date.now();
					resolve(seen);
				});
			},
		);
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
	return { seen, done };
}

/** The question card the daemon wrote, read back until it is on the board. */
async function questionCard(daemon: Daemon, board: string) {
	for (let tries = 0; tries < 100; tries++) {
		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board}`)).body);
		const card = (state.cards as any[]).find((one) => one.type === "question");
		if (card) return card;
		await new Promise((done) => setTimeout(done, 50));
	}
	return null;
}

test("the daemon boots, opens a workspace, and answers for its board", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-"));
	const daemon = await boot(folder);
	try {
		const page = await get(daemon, "/");
		assert.equal(page.status, 200);
		assert.match(page.type, /text\/html/);

		const opened = await post(daemon, "/workspace", { folder });
		assert.equal(opened.status, 200);
		const board = JSON.parse(opened.body).board;
		assert.ok(board?.id, "no board came back");

		const state = await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`);
		assert.equal(state.status, 200);
		assert.ok(Array.isArray(JSON.parse(state.body).threads));

		const workspaces = await get(daemon, `/workspaces?token=${daemon.token}`);
		assert.equal(workspaces.status, 200);
		assert.ok(workspaces.body.includes(board.id));

		const models = await get(daemon, `/models?token=${daemon.token}`);
		assert.equal(models.status, 200);
		assert.ok(Array.isArray(JSON.parse(models.body).models));

		const tools = await get(daemon, `/tools?token=${daemon.token}`);
		assert.equal(tools.status, 200);

		const browse = await get(daemon, `/browse?token=${daemon.token}&path=${encodeURIComponent(folder)}`);
		assert.equal(browse.status, 200);

		// The picker opens where the human works: the board names its folder, and a relative path
		// resolves against that folder rather than against where the daemon was launched.
		mkdirSync(join(folder, "inside"));
		const started = await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}&path=`);
		assert.equal(started.status, 200);
		assert.equal(JSON.parse(started.body).path, realpathSync(folder));
		const relative = await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}&path=inside`);
		assert.equal(relative.status, 200);
		assert.equal(JSON.parse(relative.body).path, realpathSync(join(folder, "inside")));

		// A request that names no board keeps the old contract: the daemon's own folder.
		assert.equal((await get(daemon, `/browse?token=${daemon.token}&path=`)).status, 200);
		// A board nobody opened is refused rather than quietly answered from somewhere else.
		assert.equal((await get(daemon, `/browse?token=${daemon.token}&workspace=nope&path=`)).status, 409);

		const layout = await post(daemon, "/layout", { id: board.id, view: { x: 1, y: 2, k: 1 } });
		// 409 is the honest answer for a card that is not on this board, and it means the route was reached.
		assert.ok([200, 409].includes(layout.status), `layout answered ${layout.status}`);

		const detail = await get(daemon, `/transcript?token=${daemon.token}&workspace=${board.id}&thread=nope`);
		assert.ok([200, 400, 404].includes(detail.status), `transcript answered ${detail.status}`);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a workspace-scoped browser lists its folder, refuses the way out, and knows no other board", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-browse-"));
	// The state folder is the daemon's own, so the board's folder is a folder inside it and the files the
	// daemon writes are not part of what a listing shows.
	const folder = join(state, "proj");
	mkdirSync(join(folder, "docs"), { recursive: true });
	const real = realpathSync(folder);
	writeFileSync(join(folder, "docs", "note.md"), "# note\n");
	writeFileSync(join(folder, "readme.md"), "readme\n");
	const daemon = await boot(state);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		assert.equal(opened.status, 200);
		const board = JSON.parse(opened.body).board;
		assert.ok(board?.id, "no board came back");

		// No `path` is the folder itself, and the answer says so in `cwd` rather than in the daemon's own.
		const root = await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}`);
		assert.equal(root.status, 200, root.body);
		const listing = JSON.parse(root.body);
		assert.equal(listing.cwd, real);
		assert.equal(listing.path, real);
		assert.deepEqual(
			listing.entries.map((one: any) => [one.name, one.dir]),
			[
				["docs", true],
				["readme.md", false],
			],
		);

		// The same folder asked for by a relative path, and `/` meaning the root again.
		const sub = await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}&path=docs`);
		assert.equal(sub.status, 200, sub.body);
		const inside = JSON.parse(sub.body);
		assert.equal(inside.path, join(real, "docs"));
		assert.deepEqual(
			inside.entries.map((one: any) => [one.name, one.dir]),
			[["note.md", false]],
		);
		const slash = await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}&path=/`);
		assert.equal(slash.status, 200, slash.body);
		assert.equal(JSON.parse(slash.body).path, real);

		// Nothing above the folder is shown, however the path is written.
		for (const escape of ["../../", "..", "../"]) {
			const out = await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}&path=${encodeURIComponent(escape)}`);
			assert.equal(out.status, 404, `${escape} answered ${out.status}: ${out.body}`);
		}

		const unknown = await get(daemon, `/browse?token=${daemon.token}&workspace=nope`);
		assert.equal(unknown.status, 409);
		assert.match(unknown.body, /no such workspace/);
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});

test("the programs a `!` command can name are read from the daemon's own search path", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-programs-"));
	const first = join(state, "bin-a");
	const second = join(state, "bin-b");
	mkdirSync(first);
	mkdirSync(second);
	// The same program on both search-path entries, a file nobody made executable, a folder, and the name
	// of a program that is not there at all: only the first is a program a command can run.
	writeFileSync(join(first, "fixture-run"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(second, "fixture-run"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(first, "fixture-text"), "plain\n", { mode: 0o644 });
	mkdirSync(join(first, "fixture-dir"));
	// A search-path entry that does not exist is the ordinary case and must not spoil the listing. The shell
	// that runs a `!` line is named outright: this check is about the walk, and a shell with builtins of its
	// own would put names in the answer that are its business and not the path's.
	const daemon = await boot(state, { PATH: [first, join(state, "missing"), second].join(delimiter), SHELL: "/bin/sh" });
	try {
		const listed = await get(daemon, `/programs?token=${daemon.token}&prefix=fixture`);
		assert.equal(listed.status, 200, listed.body);
		assert.deepEqual(JSON.parse(listed.body).programs, ["fixture-run"], listed.body);

		// The prefix is the word the human typed so far, and one that names nothing answers with nothing.
		assert.deepEqual(JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=fixture-t`)).body).programs, []);
		assert.deepEqual(JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=nowhere`)).body).programs, []);

		// `!` and Tab with no word yet asks for `prefix=`, which takes the short way through the path. It
		// still answers with the programs alone: the folder and the file nobody made executable stay out.
		const bare = JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=`)).body);
		assert.deepEqual(bare, { programs: ["fixture-run"], total: 1, truncated: false }, bare.programs);
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});

test(
	"a `!` line under bash names bash's own builtins, and nothing another shell keeps for itself",
	{ skip: BASH ? false : "no /bin/bash here" },
	async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-builtins-"));
		// The real search path but a shell named outright, so the check says the same thing on every machine. A
		// builtin is the proof the answer is more than the files there: `readonly` is no file anywhere on the path.
		const daemon = await boot(state, { SHELL: BASH });
		try {
			const listed = await get(daemon, `/programs?token=${daemon.token}&prefix=readonly`);
			assert.equal(listed.status, 200, listed.body);
			assert.ok(JSON.parse(listed.body).programs.includes("readonly"), listed.body);
			assert.ok(JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=ech`)).body).programs.includes("echo"), listed.body);

			// A name of bash's own that `/bin/sh` here (dash) cannot run is offered, because bash is what runs the
			// line: `compgen` and `source` print `not found` under dash and so used to be filtered out of this list.
			for (const name of ["compgen", "source"]) {
				const prefix = name.slice(0, 4);
				const asked = JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=${prefix}`)).body);
				assert.ok(asked.programs.includes(name), `${prefix}: ${JSON.stringify(asked)}`);
			}
			// A name bash cannot run is never offered: zsh keeps `zle`, `zstyle` and `echotc` for itself and no
			// search path holds them.
			for (const name of ["zle", "zstyle", "echotc"]) {
				const prefix = name.slice(0, 4);
				const asked = JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=${prefix}`)).body);
				assert.ok(!asked.programs.includes(name), `${name}: ${JSON.stringify(asked)}`);
			}
			// A keyword is not a command either: `fi` on its own is a syntax error, not a name to complete.
			const keyword = JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=fi`)).body).programs;
			assert.ok(!keyword.includes("fi"), keyword);

			// The word goes to the shell as an argument, so a word that reads like shell syntax is only a word:
			// nothing in it runs, and no printed line that is not a name reaches the list.
			const odd = await get(daemon, `/programs?token=${daemon.token}&prefix=${encodeURIComponent("'; id #")}`);
			assert.equal(odd.status, 200, odd.body);
			assert.deepEqual(JSON.parse(odd.body).programs, [], odd.body);
			assert.ok(!odd.body.includes("uid="), odd.body);
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	},
);

test(
	"a `!` line under zsh names zsh's own builtins, and no name zsh cannot run",
	{ skip: ZSH ? false : "no /usr/bin/zsh here" },
	async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-zsh-names-"));
		const daemon = await boot(state, { SHELL: ZSH });
		try {
			const echo = JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=ech`)).body).programs;
			assert.ok(echo.includes("echo"), echo);
			// zsh's builtins are in no search path at all, so `echoti` can only come from zsh's own table.
			assert.ok(echo.includes("echoti"), echo);
			// `source` is a zsh builtin and not a dash one, so the old filter against `/bin/sh` hid a name the line
			// can run. It is offered now, because zsh is what runs the line.
			assert.ok(JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=sour`)).body).programs.includes("source"));
			// And the other way: bash's own names, and the language's keywords, are not offered under zsh.
			assert.ok(!JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=compg`)).body).programs.includes("compgen"));
			assert.ok(!JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=sho`)).body).programs.includes("shopt"));
			assert.ok(!JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=fi`)).body).programs.includes("fi"));
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	},
);

test("a `!` line whose `SHELL` is missing falls back, and still lists the search path", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-shell-fallback-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-shell-fallback-work-"));
	// A `SHELL` that names nothing is ordinary: a shell that was uninstalled, a relative path in a profile. The
	// daemon starts under the one shell POSIX guarantees or bash, and the listing is still an answer.
	const daemon = await boot(state, { SHELL: "/nonexistent/not-a-shell" });
	try {
		const listed = await get(daemon, `/programs?token=${daemon.token}&prefix=ech`);
		assert.equal(listed.status, 200, listed.body);
		assert.ok(JSON.parse(listed.body).programs.includes("echo"), listed.body);
		// And a line still runs: the fallback is a shell that started, not only a name.
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		const ran = await postTo(daemon, board.id, "/shell", { command: "echo fallback-ok", cardId: threadId });
		assert.equal(ran.status, 200, ran.body);
		assert.equal(JSON.parse(ran.body).output, "fallback-ok\n");
	} finally {
		daemon.child.kill();
		for (const gone of [state, folder]) rmSync(gone, { recursive: true, force: true });
	}
});

test(
	"a `SHELL` that names nothing falls back to bash, whose own names are then offered",
	{ skip: BASH ? false : "no /bin/bash here" },
	async () => {
		const state = mkdtempSync(join(tmpdir(), "pi-studio-shell-order-"));
		// The fallback names bash before `/bin/sh`, and this says which of the two answered: `compgen` and `shopt`
		// are bash's own and no search path holds them, while a daemon that fell through to `/bin/sh` has no table
		// to ask at all and offers neither. Each daemon resolves the shell in its own process, so the cache in
		// `command-shell.ts` is per-daemon here; its re-ask branch is not what this checks.
		const daemon = await boot(state, { SHELL: "/nonexistent/not-a-shell" });
		try {
			for (const name of ["compgen", "shopt"]) {
				const asked = JSON.parse((await get(daemon, `/programs?token=${daemon.token}&prefix=${name}`)).body);
				assert.ok(asked.programs.includes(name), `${name}: ${JSON.stringify(asked)}`);
			}
		} finally {
			daemon.child.kill();
			rmSync(state, { recursive: true, force: true });
		}
	},
);

test(
	"a `!command` runs under the shell the app resolved, not under `/bin/sh`",
	{ skip: BASH ? false : "no /bin/bash here" },
	async () => {
		const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-shell-bash-"));
		const folder = mkdtempSync(join(tmpdir(), "pi-studio-shell-bash-work-"));
		const daemon = await boot(stateHome, { SHELL: BASH });
		try {
			const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
			const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
			// Brace expansion: bash turns `{one,two}` into two words and dash prints it as it stands, so what comes
			// back says which shell ran the line.
			const ran = await postTo(daemon, board.id, "/shell", { command: "echo {one,two}", cardId: threadId });
			assert.equal(ran.status, 200, ran.body);
			assert.equal(JSON.parse(ran.body).output, "one two\n", "the line did not run under the resolved shell");
		} finally {
			daemon.child.kill();
			for (const gone of [stateHome, folder]) rmSync(gone, { recursive: true, force: true });
		}
	},
);

test("a `!` completion is listed from the tree the command runs in, dot entries and all", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-bang-browse-"));
	const repoFolder = mkdtempSync(join(tmpdir(), "pi-studio-bang-browse-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	// A repository, because a thread only gets a tree of its own in one, and that tree is where a `!`
	// command runs. Never the human's: a throwaway folder with one commit on `dev`.
	const git = (...args: string[]) => execFileSync("git", ["-C", repoFolder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "dev");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	// The folder the human types in `!ls .agents/`, and a child the next Tab has to reach.
	mkdirSync(join(repoFolder, ".agents", "notes"), { recursive: true });
	writeFileSync(join(repoFolder, ".agents", "notes", "hint.md"), "a note\n");
	writeFileSync(join(repoFolder, "readme.md"), "hello\n");
	git("add", ".");
	git("commit", "-m", "first");
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder: repoFolder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		// A message is what cuts the tree the command will stand in.
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		let tree = "";
		for (let tries = 0; tries < 100 && !tree; tries++) {
			const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
			tree = (state.threads as any[]).find((one) => one.id === threadId)?.worktree?.path ?? "";
			if (!tree) await new Promise((done) => setTimeout(done, 20));
		}
		assert.ok(tree && existsSync(tree), `the thread never got a tree of its own: ${tree}`);

		// `!ls .agents/`: the folder itself is offered, and a listing inside it names what Tab can reach next.
		const atRoot = await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}&card=${threadId}&dots=1&path=`);
		assert.equal(atRoot.status, 200, atRoot.body);
		const listed = JSON.parse(atRoot.body);
		assert.equal(listed.path, realpathSync(tree), "the completion did not stand in the thread's tree");
		assert.equal(listed.cwd, realpathSync(tree));
		assert.ok(
			listed.entries.some((one: any) => one.name === ".agents" && one.dir),
			`the .agents folder the human types was not offered: ${JSON.stringify(listed.entries.map((one: any) => one.name))}`,
		);
		const typed = JSON.parse((await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}&card=${threadId}&dots=1&path=.agents`)).body);
		assert.equal(typed.path, join(realpathSync(tree), ".agents"));
		assert.deepEqual(
			typed.entries.map((one: any) => [one.name, one.dir]),
			[["notes", true]],
		);

		// The picker's own listing is what it always was: the board's folder, and no dot entries.
		const picked = JSON.parse((await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}&path=`)).body);
		assert.equal(picked.cwd, realpathSync(repoFolder));
		assert.deepEqual(
			picked.entries.map((one: any) => one.name),
			["readme.md"],
		);

		// The sandbox follows the tree: nothing above it is listed, however the path is written.
		const above = await get(daemon, `/browse?token=${daemon.token}&workspace=${board.id}&card=${threadId}&dots=1&path=${encodeURIComponent("../../")}`);
		assert.equal(above.status, 404, above.body);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, repoFolder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("the crossroads defaults can be changed and are read back", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-"));
	const daemon = await boot(folder);
	try {
		const before = await get(daemon, `/defaults?token=${daemon.token}`);
		assert.equal(before.status, 200);
		const levels = JSON.parse(before.body).levels;
		assert.ok(Array.isArray(levels) && levels.length > 0, "no thinking levels came back");

		const saved = await post(daemon, "/defaults", { thinking: levels[0], dimOthers: false });
		assert.equal(saved.status, 200, saved.body.slice(0, 200));
		const answered = JSON.parse(saved.body).defaults;
		assert.equal(answered.thinking, levels[0]);
		assert.equal(answered.dimOthers, false);

		// Written to the state folder, so the next daemon on this folder starts with them.
		const written = JSON.parse(readFileSync(join(folder, "workspaces.json"), "utf8"));
		assert.equal(written.defaults.thinking, levels[0]);
		assert.equal(written.defaults.dimOthers, false);

		const after = JSON.parse((await get(daemon, `/defaults?token=${daemon.token}`)).body).defaults;
		assert.equal(after.thinking, levels[0]);
		assert.equal(after.dimOthers, false);

		const refused = await post(daemon, "/defaults", { thinking: "shouting" });
		assert.equal(refused.status, 400);

		// The text editor is a default like the rest: one program, saved with them and read back.
		const chosen = await post(daemon, "/defaults", { editor: "  /usr/bin/code  " });
		assert.equal(chosen.status, 200, chosen.body.slice(0, 200));
		assert.equal(JSON.parse(chosen.body).defaults.editor, "/usr/bin/code", "the editor was not trimmed and kept");
		assert.equal(JSON.parse(readFileSync(join(folder, "workspaces.json"), "utf8")).defaults.editor, "/usr/bin/code");
		assert.equal(JSON.parse((await get(daemon, `/defaults?token=${daemon.token}`)).body).defaults.editor, "/usr/bin/code");
		// One program, not a command line: an argument list would be spawned as a file of that name.
		assert.equal((await post(daemon, "/defaults", { editor: "code --wait" })).status, 400);
		// An empty value is how a human clears it, and the defaults answer with nothing rather than dropping it.
		const cleared = await post(daemon, "/defaults", { editor: "" });
		assert.equal(cleared.status, 200);
		assert.equal(JSON.parse(cleared.body).defaults.editor, "");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a code card's file is opened in the editor the crossroads holds, and refused when it cannot be", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-open-"));
	writeFileSync(join(folder, "note.ts"), "export const note = 1;\n");
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		assert.equal(opened.status, 200);
		const board = JSON.parse(opened.body).board;
		const source = await postTo(daemon, board.id, "/card/source", { path: "note.ts" });
		assert.equal(source.status, 200, source.body.slice(0, 200));
		const cardId = JSON.parse(source.body).cardId;

		// Nobody has chosen an editor yet, and the refusal says where to choose one.
		const unset = await postTo(daemon, board.id, "/card/open", { cardId });
		assert.equal(unset.status, 409);
		assert.equal(unset.body, "no text editor is set yet: choose one on the settings page");

		// A program name node cannot find on the search path starts nothing, and says so.
		assert.equal((await post(daemon, "/defaults", { editor: "pi-studio-no-such-editor" })).status, 200);
		const missing = await postTo(daemon, board.id, "/card/open", { cardId });
		assert.equal(missing.status, 409);
		assert.match(missing.body, /could not start pi-studio-no-such-editor/);

		// A value that names the binary itself is checked before anything is started: a path nobody can run is
		// a setting that cannot work, and it says which path it read.
		const unrunnable = join(folder, "not-a-program");
		assert.equal((await post(daemon, "/defaults", { editor: unrunnable })).status, 200);
		const cannot = await postTo(daemon, board.id, "/card/open", { cardId });
		assert.equal(cannot.status, 409);
		assert.equal(cannot.body, `${unrunnable} is not a program this machine can run`);

		// A card whose file is gone is refused before anything is launched: `true` is a program that runs and
		// opens nothing, so the branch under test is the file rather than the editor.
		assert.equal((await post(daemon, "/defaults", { editor: "true" })).status, 200);
		rmSync(join(folder, "note.ts"));
		const gone = await postTo(daemon, board.id, "/card/open", { cardId });
		assert.equal(gone.status, 409);
		assert.match(gone.body, /not a file on disk any more/);

		// A note is not a file, so there is nothing to open.
		const note = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "a note" })).body).cardId;
		assert.equal((await postTo(daemon, board.id, "/card/open", { cardId: note })).status, 409);
		assert.equal((await postTo(daemon, board.id, "/card/open", { cardId: "nope" })).status, 409);

		// An editor that is there and runs answers with the file it was handed. `true` exits at once, so what
		// this checks is the launch, not the program.
		writeFileSync(join(folder, "note.ts"), "export const note = 2;\n");
		const again = JSON.parse((await postTo(daemon, board.id, "/card/source", { path: "note.ts" })).body).cardId;
		const launched = await postTo(daemon, board.id, "/card/open", { cardId: again });
		assert.equal(launched.status, 200, launched.body.slice(0, 200));
		assert.deepEqual(JSON.parse(launched.body), { opened: true, file: join(realpathSync(folder), "note.ts") });
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("the machine's own file dialog is asked once, and a machine without one says so", async () => {
	const bin = mkdtempSync(join(tmpdir(), "pi-studio-routes-bin-"));
	const state = mkdtempSync(join(tmpdir(), "pi-studio-routes-pick-"));
	const picked = join(state, "picked path");
	const chosen = join(state, "zenity-answers");
	// A `zenity` on the daemon's own search path, which is the only way to reach the dialog without a human.
	// It prints what the control file holds and fails when that file is empty, which is a cancelled dialog.
	writeFileSync(
		join(bin, "zenity"),
		`#!/bin/sh\nif [ -s "$PI_STUDIO_TEST_PICK" ]; then read -r line < "$PI_STUDIO_TEST_PICK"; printf '%s\\n' "$line"; exit 0; fi\nexit 1\n`,
		{ mode: 0o755 },
	);
	const daemon = await boot(state, { PATH: bin, PI_STUDIO_TEST_PICK: chosen });
	try {
		writeFileSync(chosen, `${picked}\n`);
		const file = await post(daemon, "/pick-file");
		assert.equal(file.status, 200, file.body.slice(0, 200));
		assert.deepEqual(JSON.parse(file.body), { file: picked });
		// The folder dialog was the same handler, and answers the same way.
		assert.deepEqual(JSON.parse((await post(daemon, "/pick-folder")).body), { folder: picked });

		// Cancelling a dialog is a decision, not a failure.
		rmSync(chosen);
		const cancelled = await post(daemon, "/pick-file");
		assert.equal(cancelled.status, 200, cancelled.body.slice(0, 200));
		assert.deepEqual(JSON.parse(cancelled.body), { cancelled: true });
	} finally {
		daemon.child.kill();
	}

	// The same press on a machine without zenity: one 501, and the daemon keeps answering. The second answer
	// this used to send threw ERR_HTTP_HEADERS_SENT on an ended response, which nothing catches and which
	// stopped the daemon along with every board and child: a daemon still here is the proof of one answer.
	const stripped = await boot(state, { PATH: join(state, "no-programs") });
	try {
		const without = await post(stripped, "/pick-file");
		assert.equal(without.status, 501);
		assert.equal(without.body, "no file dialog on this machine");
		const folderless = await post(stripped, "/pick-folder");
		assert.equal(folderless.status, 501);
		assert.equal(folderless.body, "no folder dialog on this machine");

		assert.equal((await get(stripped, `/workspaces?token=${stripped.token}`)).status, 200, "the daemon stopped");
		assert.doesNotMatch(stripped.noise.join(""), /ERR_HTTP_HEADERS_SENT|UNCAUGHT/);
		await new Promise((done) => setTimeout(done, 300));
		assert.equal((stripped.child as any).exitCode, null, "the daemon is still running");
	} finally {
		stripped.child.kill();
		for (const gone of [bin, state]) rmSync(gone, { recursive: true, force: true });
	}
});

test("the six card defaults are saved, read back and refused when nobody names them", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-cards-"));
	const daemon = await boot(folder);
	try {
		// A folder opened as a workspace is born with whatever /defaults held at that moment.
		const choice = { cardsVerbosity: "quiet", cardsAudience: "designer", showCodeFragments: "none", showReferences: "none", showCharts: "many" };
		const saved = await post(daemon, "/defaults", choice);
		assert.equal(saved.status, 200, saved.body.slice(0, 200));
		const answered = JSON.parse(saved.body).defaults;
		assert.equal(answered.cardsVerbosity, "quiet");
		assert.equal(answered.cardsAudience, "designer");
		assert.equal(answered.showCodeFragments, "none");
		assert.equal(answered.showCharts, "many");
		assert.equal(answered.showMathFormulas, "some", "a switch nobody chose lost its default");

		// Written where the daemon reloads its defaults from, so the next board on this folder inherits them.
		const written = JSON.parse(readFileSync(join(folder, "workspaces.json"), "utf8"));
		assert.equal(written.defaults.cardsVerbosity, "quiet");
		assert.equal(written.defaults.showCodeFragments, "none");

		assert.equal((await post(daemon, "/defaults", { cardsVerbosity: "shouting" })).status, 400);
		assert.equal((await post(daemon, "/defaults", { cardsAudience: "shaman" })).status, 400);
		assert.equal((await post(daemon, "/defaults", { showCharts: "yes" })).status, 400);
		// The first build stored yes/no, and a yes is not a level: the panel cannot write one any more.
		assert.equal((await post(daemon, "/defaults", { showCharts: true })).status, 400);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("what a new board's threads may touch is a default too, and a new board is born with it", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-tools-"));
	const work = mkdtempSync(join(tmpdir(), "pi-studio-routes-tools-work-"));
	const daemon = await boot(folder);
	try {
		// A tool this pi does not have is dropped rather than refused, exactly as POST /config drops it.
		const saved = await post(daemon, "/defaults", { toolsOff: ["bash", "no-such-tool"], path: "simple" });
		assert.equal(saved.status, 200, saved.body.slice(0, 200));
		const answered = JSON.parse(saved.body).defaults;
		assert.deepEqual(answered.toolsOff, ["bash"]);
		assert.deepEqual(answered.extensionsOff, []);
		assert.equal(answered.path, "simple");

		// Written where the daemon reloads its defaults from, so the next board on any folder inherits them.
		const written = JSON.parse(readFileSync(join(folder, "workspaces.json"), "utf8"));
		assert.deepEqual(written.defaults.toolsOff, ["bash"]);
		assert.equal(written.defaults.path, "simple");

		// A flow nobody names and an extension this machine does not have are mistakes, not preferences.
		assert.equal((await post(daemon, "/defaults", { path: "scenic" })).status, 400);
		assert.equal((await post(daemon, "/defaults", { extensionsOff: ["no-such-extension"] })).status, 400);

		// The board opened now is born with the three, because a new board's config is the defaults it found.
		const board = JSON.parse((await post(daemon, "/workspace", { folder: work })).body).board;
		const config = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body).meta.config;
		assert.deepEqual(config.toolsOff, ["bash"]);
		assert.deepEqual(config.extensionsOff, []);
		assert.equal(config.path, "simple");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("a board's card settings are written by /config and read back out of it", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-config-"));
	const work = mkdtempSync(join(tmpdir(), "pi-studio-routes-config-work-"));
	const daemon = await boot(folder);
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder: work })).body).board;
		// A board file with nothing stored reads as the six defaults, which is what the panel draws.
		const fresh = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body).meta.config;
		assert.equal(fresh.cardsVerbosity, "normal");
		assert.equal(fresh.cardsAudience, "programmer");
		assert.equal(fresh.showCodeFragments, "some");

		const saved = await postTo(daemon, board.id, "/config", { cardsVerbosity: "quiet", showReferences: "many" });
		assert.equal(saved.status, 200, saved.body.slice(0, 200));
		const after = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body).meta.config;
		assert.equal(after.cardsVerbosity, "quiet");
		assert.equal(after.showReferences, "many");
		assert.equal(after.showCharts, "some", "a switch nobody touched changed with the one that was");

		assert.equal((await postTo(daemon, board.id, "/config", { cardsAudience: "shaman" })).status, 400);
		assert.equal((await postTo(daemon, board.id, "/config", { showCharts: "yes" })).status, 400);
		assert.equal((await postTo(daemon, board.id, "/config", { showCharts: false })).status, 400);
		assert.equal((await postTo(daemon, board.id, "/config", {})).status, 400);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("a boss starts on the board's flow, whether it was made as one or switched into one", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-boss-flow-"));
	const work = mkdtempSync(join(tmpdir(), "pi-studio-routes-boss-flow-work-"));
	const daemon = await boot(folder);
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder: work })).body).board;
		// A board that has named no flow: a boss decides for itself, and says that it did.
		const bossless = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "boss", mode: "boss" })).body);
		assert.equal(bossless.card.path, "auto");
		assert.equal(bossless.card.pathChosenBy, "auto");
		const bare = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "agent" })).body);
		const bareSwitched = JSON.parse((await postTo(daemon, board.id, "/mode", { cardId: bare.threadId, mode: "boss" })).body);
		assert.equal(bareSwitched.card.path, "auto", "a switch on a board with no flow still starts on auto");
		assert.equal(bareSwitched.card.pathChosenBy, "auto");

		// The board now works one way, so every boss that names no flow of its own starts there.
		assert.equal((await postTo(daemon, board.id, "/config", { path: "simple" })).status, 200);
		const made = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "made a boss", mode: "boss" })).body);
		assert.equal(made.card.path, "simple");
		// Neither the human's pin nor the boss's own pick: the board's, which leaves a boss free to choose.
		assert.equal(made.card.pathChosenBy, "board");

		// A thread made as an agent has no flow to keep, so becoming a boss starts it where one made now starts.
		const agent = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "an agent" })).body);
		assert.equal(agent.card.path, undefined);
		const switched = JSON.parse((await postTo(daemon, board.id, "/mode", { cardId: agent.threadId, mode: "boss" })).body);
		assert.equal(switched.card.path, "simple");
		assert.equal(switched.card.pathChosenBy, "board");

		// A flow the request names is still the human's, and an agent carries none.
		const pinned = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "pinned", mode: "boss", path: "advanced" })).body);
		assert.equal(pinned.card.path, "advanced");
		assert.equal(pinned.card.pathChosenBy, "human");
		const dropped = JSON.parse((await postTo(daemon, board.id, "/mode", { cardId: pinned.threadId, mode: "agent" })).body);
		assert.equal(dropped.card.path, undefined, "a thread turned back into an agent drops the flow");
		assert.equal(dropped.card.pathChosenBy, undefined);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("how a child's work comes back is a default a new board is born with", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-integration-"));
	const daemon = await boot(folder);
	try {
		const saved = await post(daemon, "/defaults", { childIntegration: "cherry-pick" });
		assert.equal(saved.status, 200, saved.body.slice(0, 200));
		const answered = JSON.parse(saved.body).defaults;
		assert.equal(answered.childIntegration, "cherry-pick");

		// Written where the daemon reloads its defaults from, so the next board on this folder inherits it.
		const written = JSON.parse(readFileSync(join(folder, "workspaces.json"), "utf8"));
		assert.equal(written.defaults.childIntegration, "cherry-pick");

		const refused = await post(daemon, "/defaults", { childIntegration: "squash" });
		assert.equal(refused.status, 400);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a board's integration setting is written by /config and read back out of it", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-integration-config-"));
	const work = mkdtempSync(join(tmpdir(), "pi-studio-routes-integration-config-work-"));
	const daemon = await boot(folder);
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder: work })).body).board;
		// A board that has never been configured merges, which is what the boss is told to do.
		const fresh = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body).meta.config;
		assert.equal(fresh.childIntegration, "merge");

		const saved = await postTo(daemon, board.id, "/config", { childIntegration: "rebase", dimOthers: false });
		assert.equal(saved.status, 200, saved.body.slice(0, 200));
		const after = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body).meta.config;
		assert.equal(after.childIntegration, "rebase");

		// A body carries one switch and never has to repeat the rest.
		assert.equal((await postTo(daemon, board.id, "/config", { childIntegration: "merge" })).status, 200);
		const partial = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body).meta.config;
		assert.equal(partial.childIntegration, "merge");
		assert.equal(partial.dimOthers, false, "a switch nobody touched changed with the one that was");

		assert.equal((await postTo(daemon, board.id, "/config", { childIntegration: "squash" })).status, 400);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("a route without the token is refused, and the page is not", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-routes-"));
	const daemon = await boot(folder);
	try {
		assert.equal((await get(daemon, "/state")).status, 403);
		assert.equal((await get(daemon, "/")).status, 200);
		// Every client module is served under /client/; the entry is the only one the page names.
		const script = await get(daemon, "/client/board.js");
		assert.equal(script.status, 200);
		assert.match(script.type, /javascript/);
		// The icon both pages name is served too, and as an image, so a tab shows the mark.
		const icon = await get(daemon, "/favicon.svg");
		assert.equal(icon.status, 200);
		assert.match(icon.type, /image\/svg\+xml/);
		assert.match(icon.body, /<svg/);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

/** The leaves of the whole tree, which is how the page finds the controls it draws. */
function leavesOf(document: any): any[] {
	const found: any[] = [];
	const walk = (group: any) => {
		for (const field of group.fields ?? []) found.push(field);
		for (const child of group.groups ?? []) walk(child);
	};
	for (const group of document.groups ?? []) walk(group);
	return found;
}

test("the settings document is served behind the token, and what /defaults saves reads back in it", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-settings-route-"));
	const daemon = await boot(folder);
	try {
		// It holds the daemon's own defaults, so it is behind the same gate as the routes beside it.
		assert.equal((await get(daemon, "/settings/defaults")).status, 403);

		const served = await get(daemon, `/settings/defaults?token=${daemon.token}`);
		assert.equal(served.status, 200);
		const body = JSON.parse(served.body);
		assert.equal(body.version, 1);
		assert.equal(body.scope, "defaults");
		// The page draws a control per leaf, so the three settings have to be leaves of the tree.
		assert.ok(leavesOf(body).some((field) => field.id === "model"), "no model field in the document");
		const byId = Object.fromEntries(leavesOf(body).map((field) => [field.id, field]));
		// The catalogue is a route the picker reads rather than a list the document has to carry.
		assert.equal(byId.model.source, "/models", "the model field names no catalogue");
		assert.ok((byId.thinking?.options ?? []).length >= 4, "thinking does not carry pi's levels");
		assert.equal(byId.dimOthers?.type, "toggle");

		// Saving a level used to throw `Assignment to constant variable` at the route, which answered 500
		// and lost the choice: the write went to an imported binding instead of to the module that owns it.
		const saved = await post(daemon, "/defaults", { thinking: "low" });
		assert.equal(saved.status, 200, saved.body);
		const after = JSON.parse((await get(daemon, `/settings/defaults?token=${daemon.token}`)).body);
		const thinking = leavesOf(after).find((field) => field.id === "thinking");
		assert.equal(thinking?.value, "low", "the document does not read back what /defaults wrote");
		// And it is on disk, in the one file the daemon reloads its defaults from.
		const kept = JSON.parse(readFileSync(join(folder, "workspaces.json"), "utf8"));
		assert.equal(kept.defaults?.thinking, "low");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a question that takes several answers keeps all of them", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		// The daemon holds this request open until the question is settled, so it is not awaited yet.
		const held = postTo(daemon, board.id, "/card/ask", {
			question: "which of these?",
			options: ["a", "b", "c"],
			multiple: true,
			allowFreeText: false,
		});
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the question never reached the board");
		assert.equal(card.multiple, true);
		assert.equal(card.status, "open");

		// An option list is closed when free text is off, so a pick that is not on it is refused and
		// the question stays open rather than being answered with something nobody offered.
		const stray = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", "z"] });
		assert.equal(stray.status, 400);
		const empty = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: [] });
		assert.equal(empty.status, 400);

		const sent = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", "c"] });
		assert.equal(sent.status, 200);
		// The child that asked reads one line, and the card keeps the two picks apart for the reader.
		const answered = await held;
		assert.equal(answered.status, 200);
		const reply = JSON.parse(answered.body);
		assert.equal(reply.answer, "a, c");
		assert.deepEqual(reply.answers, ["a", "c"]);

		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const settled = (state.cards as any[]).find((one) => one.id === card.id);
		assert.equal(settled.status, "answered");
		assert.deepEqual(settled.answers, ["a", "c"]);

		// A second answer is still the 409 it always was.
		const again = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["b"] });
		assert.equal(again.status, 409);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a question that takes one answer is answered by one click, as before", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-one-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		const held = postTo(daemon, board.id, "/card/ask", { question: "which one?", options: ["a", "b"] });
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the question never reached the board");
		assert.equal(card.multiple, false);
		const sent = await postTo(daemon, board.id, "/answer", { cardId: card.id, answer: "b" });
		assert.equal(sent.status, 200);
		const reply = JSON.parse((await held).body);
		assert.equal(reply.answer, "b");
		assert.equal(reply.answers, undefined);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a card asks up to five questions on tabs, and settles them all at once", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-tabs-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		// A card of six tabs is a form rather than a question, so the daemon refuses it and the card is
		// never written.
		const tooMany = await postTo(daemon, board.id, "/card/ask", {
			questions: Array.from({ length: 6 }, (_, at) => ({ question: `q${at}?`, options: ["a", "b"] })),
		});
		assert.equal(tooMany.status, 400);

		const held = postTo(daemon, board.id, "/card/ask", {
			title: "three things",
			questions: [
				{ question: "which one?", options: ["a", "b"] },
				{ question: "which of these?", options: ["x", "y"], multiple: true, allowFreeText: false },
				{ question: "any words?", options: ["yes", "no"] },
			],
		});
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the questions never reached the board");
		assert.equal(card.questions.length, 3);
		assert.equal(card.questions[1].multiple, true);
		assert.equal(card.questions[1].allowFreeText, false);

		// Every tab sends its own answer, in tab order: a card of tabs is one call and half a form is not
		// a card the child can read.
		const short = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", ["x"]] });
		assert.equal(short.status, 400);
		const stray = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", ["x", "z"], "yes"] });
		assert.equal(stray.status, 400);
		const empty = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["a", ["x"], ""] });
		assert.equal(empty.status, 400);

		const sent = await postTo(daemon, board.id, "/answer", { cardId: card.id, answers: ["b", ["x", "y"], "my own words"] });
		assert.equal(sent.status, 200);
		const reply = JSON.parse((await held).body);
		assert.deepEqual(reply.answers, ["b", "x, y", "my own words"]);
		assert.equal(reply.answer, "b; x, y; my own words");

		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const settled = (state.cards as any[]).find((one) => one.id === card.id);
		assert.equal(settled.status, "answered");
		assert.deepEqual(settled.answers, ["b", "x, y", "my own words"]);
		// The tabs are still on the card once it is settled, so a reader sees what was asked as well as
		// what was answered.
		assert.equal(settled.questions.length, 3);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a question nobody looks at expires, and the child that asked is told so", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-expire-"));
	// The window is a policy constant of five minutes; the checks shorten it through the environment rather
	// than sit one out.
	const daemon = await boot(folder, { PI_STUDIO_ASK_TIMEOUT_MS: "200" });
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		const held = postTo(daemon, board.id, "/card/ask", { question: "which one?", options: ["a", "b"] });
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the question never reached the board");
		// The window the browser counts down is the shortened one, so nothing here waits minutes.
		assert.ok(
			Number.isFinite(card.expiresAt) && card.expiresAt - card.at <= 1000,
			`the question was given ${card.expiresAt - card.at}ms rather than the shortened window`,
		);
		assert.equal(card.paused, false);

		const reply = await Promise.race([
			held,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the question never expired")), 5000)),
		]);
		assert.equal(reply.status, 409);
		const settled = await cardState(daemon, board.id, card.id);
		assert.equal(settled.status, "expired");
		assert.equal(settled.paused, false, "an expired question still says it is being watched");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});


test("a question the human has touched keeps waiting after its window has passed", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-pause-"));
	const daemon = await boot(folder, { PI_STUDIO_ASK_TIMEOUT_MS: "200" });
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		const held = postTo(daemon, board.id, "/card/ask", { question: "which one?", options: ["a", "b"] });
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the question never reached the board");

		// The human touched the card: the clock stops there, and saying so twice is not an error.
		const paused = await postTo(daemon, board.id, "/card/pause", { cardId: card.id });
		assert.equal(paused.status, 200);
		assert.equal(JSON.parse(paused.body).cardId, card.id);
		assert.equal((await postTo(daemon, board.id, "/card/pause", { cardId: card.id })).status, 200);
		const seen = await cardState(daemon, board.id, card.id);
		assert.equal(seen.status, "open");
		assert.equal(seen.paused, true);

		// Longer than the window the question was given, and it is still there to answer.
		await new Promise((done) => setTimeout(done, 400));
		const stillThere = await cardState(daemon, board.id, card.id);
		assert.equal(stillThere.status, "open", "a question the human had touched expired anyway");
		assert.equal(stillThere.paused, true);

		// Answering it after the window has passed is the whole point: the child gets its answer.
		assert.equal((await postTo(daemon, board.id, "/answer", { cardId: card.id, answer: "b" })).status, 200);
		const reply = await held;
		assert.equal(reply.status, 200);
		assert.equal(JSON.parse(reply.body).answer, "b");
		// Settled, and no longer saying anything is being watched.
		assert.equal((await cardState(daemon, board.id, card.id)).paused, false);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a paused question keeps its response alive past the ask window", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-keepalive-"));
	// The window and the keep-alive tick are policy constants of minutes; the check shortens both through the
	// environment rather than sit one out.
	const daemon = await boot(folder, { PI_STUDIO_ASK_TIMEOUT_MS: "400", PI_STUDIO_ASK_KEEPALIVE_MS: "100" });
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		const askedAt = Date.now();
		const held = heldPost(daemon, board.id, "/card/ask", { question: "which one?", options: ["a", "b"] });
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the question never reached the board");
		// A question nobody is reading is answered in one piece, so nothing has come back yet.
		assert.equal(held.seen.headersAt, null, "the hold answered before the question was settled");

		// The human touched the card, and from here the wait may outlive any client's deadline on a
		// response that has said nothing: the headers arrive at the pause, not at the answer.
		assert.equal((await postTo(daemon, board.id, "/card/pause", { cardId: card.id })).status, 200);
		await new Promise((done) => setTimeout(done, 150));
		assert.equal(held.seen.status, 200, "no response headers arrived when the question was paused");

		// Past the window the question was given, and still waiting: the body went quiet for longer than a client
		// waits on a quiet body, so what arrived so far is whitespace and nothing else.
		await new Promise((done) => setTimeout(done, 500));
		assert.ok(Date.now() - askedAt > 400, "the check did not wait past the ask window");
		assert.equal((await cardState(daemon, board.id, card.id)).status, "open", "a question the human had touched expired anyway");
		assert.equal(held.seen.endedAt, null, "the hold ended before the question was answered");
		const waiting = held.seen.chunks.join("");
		assert.ok(waiting.length > 1, `only ${waiting.length} keep-alive bytes arrived while the question waited`);
		assert.match(waiting, /^ +$/, "the body said something other than keep-alive whitespace");

		assert.equal((await postTo(daemon, board.id, "/answer", { cardId: card.id, answer: "b" })).status, 200);
		const read = await held.done;
		assert.equal(read.status, 200);
		// Whitespace before a JSON body is legal, so the child that asked parses its answer out of the same call.
		assert.equal(JSON.parse(read.chunks.join("")).answer, "b");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a pause on an unknown or settled question is refused, and a thread cannot pause its own", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-pause-refused-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		// Nothing on the board has that id, and a pause is not a way to ask whether a card exists.
		const unknown = await postTo(daemon, board.id, "/card/pause", { cardId: "nobody" });
		assert.equal(unknown.status, 404);

		const held = postTo(daemon, board.id, "/card/ask", { question: "which one?", options: ["a", "b"] });
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the question never reached the board");
		assert.equal((await postTo(daemon, board.id, "/answer", { cardId: card.id, answer: "a" })).status, 200);
		assert.equal((await held).status, 200);
		// A settled question has no clock left to stop.
		const late = await postTo(daemon, board.id, "/card/pause", { cardId: card.id });
		assert.equal(late.status, 409);
		assert.equal(late.body, "that question is already settled");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a thread's own token cannot pause the clock on its own question", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-ask-pause-token-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-ask-pause-token-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		const child = await childEnvOf(daemon, stub.envFile);

		// The clock on a question is the human's, so the route is not in THREAD_ROUTES and the refusal comes
		// before the body is read: a thread that could pause would never be timed out.
		const peeked = await postAs(daemon, child.token, board.id, "/card/pause", { cardId: "any" });
		assert.equal(peeked.status, 403);
		assert.equal(peeked.body, "a thread may not use that");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a closed note comes back on /undo, with its id and its key", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-undo-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		const base = JSON.parse((await postTo(daemon, board.id, "/card/note", { key: "base", markdown: "what it builds on" })).body).cardId;
		const made = await postTo(daemon, board.id, "/card/note", {
			key: "kept",
			title: "a note",
			markdown: "as written",
			size: "wide",
			after: ["base"],
		});
		assert.equal(made.status, 200);
		const id = JSON.parse(made.body).cardId;

		assert.equal((await postTo(daemon, board.id, "/close", { cardId: id })).status, 200);
		const gone = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		assert.equal(gone.cards.some((card: any) => card.id === id), false, "the note was not closed");

		const undone = await postTo(daemon, board.id, "/undo", {});
		assert.equal(undone.status, 200);
		assert.equal(JSON.parse(undone.body).restored, id);
		const back = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const restored = (back.cards as any[]).find((card) => card.id === id);
		assert.ok(restored, "the note did not come back");
		// The key is what a `[[key]]` resolves to, so a card back with a different one is a dead link.
		assert.equal(restored.key, "kept");
		assert.equal(restored.markdown, "as written");
		// The shape and the arrows are part of the card: a note back in a different shape or with its
		// predecessors gone is a card the human has to put together again.
		assert.equal(restored.size, "wide");
		assert.deepEqual(restored.after, [base]);

		// Nothing else was closed, so the second press has nothing to give and says so.
		const empty = await postTo(daemon, board.id, "/undo", {});
		assert.equal(empty.status, 409);
		assert.equal(empty.body, "nothing to undo");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a pinned card makes room by evicting the second-oldest note", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-pinned-"));
	const daemon = await boot(folder);
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const kept = JSON.parse((await postTo(daemon, board.id, "/card/note", { key: "pinned", markdown: "the one the human keeps" })).body).cardId;
		// Eviction is by age, and two cards made in one breath would tie on `at`.
		await new Promise((done) => setTimeout(done, 5));
		const second = JSON.parse((await postTo(daemon, board.id, "/card/note", { key: "second", markdown: "the oldest unpinned" })).body).cardId;
		for (let made = 2; made < 200; made++) {
			const filler = await postTo(daemon, board.id, "/card/note", { key: `filler-${made}`, markdown: "filler" });
			assert.equal(filler.status, 200);
		}
		// The oldest card is pinned, so a new card has to take the one after it instead.
		const pin = await postTo(daemon, board.id, "/layout", { cardId: kept, rect: { x: 0, y: 0, w: 300, h: 200 }, pinned: true });
		assert.equal(pin.status, 200);
		assert.equal((await postTo(daemon, board.id, "/card/note", { key: "newest", markdown: "the newcomer" })).status, 200);

		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const cards = state.cards as any[];
		const pinned = cards.find((card) => card.id === kept);
		assert.ok(pinned, "the pinned card was evicted");
		assert.equal(pinned.pinned, true);
		assert.equal(cards.some((card) => card.id === second), false, "the second-oldest card was not the one evicted");
		assert.equal(cards.length, 200);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a card dragged west or north of the origin keeps the place it was given", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-north-west-"));
	const daemon = await boot(folder);
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const made = JSON.parse((await postTo(daemon, board.id, "/card/note", { key: "far", markdown: "northwest" })).body).cardId;
		// The board is endless both ways: a card above or left of the origin is a place, not a mistake.
		const rect = { x: -1840, y: -1260, w: 320, h: 240 };
		const moved = await postTo(daemon, board.id, "/layout", { cardId: made, rect });
		assert.equal(moved.status, 200);

		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const card = (state.cards as any[]).find((one) => one.id === made);
		assert.ok(card, "the card is not on the board");
		assert.deepEqual(card.rect, rect);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a note whose chart fence is not JSON answers with a report naming the fault", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-note-report-"));
	const daemon = await boot(folder);
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		// Bare keys are the failure a chart fence makes most: the model writes JavaScript, not JSON.
		const markdown = ["the shape of it", "```chart", '{ type: "bar", data: { labels: ["a"] } }', "```"].join("\n");
		const made = await postTo(daemon, board.id, "/card/note", { key: "a-chart", markdown });
		assert.equal(made.status, 200);
		// The model cannot see the card, so a fence it cannot read has to be said back to it.
		const report = JSON.parse(made.body).report;
		assert.equal(typeof report, "string", `a chart the board cannot read went unreported, got ${made.body.slice(0, 200)}`);
		assert.match(report, /not JSON/);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a note with no chart carries no report on the wire", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-note-quiet-"));
	const daemon = await boot(folder);
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const made = await postTo(daemon, board.id, "/card/note", { key: "plain", markdown: "# a heading\n\nand a sentence about it." });
		assert.equal(made.status, 200);
		// Nothing to say about a card the board draws as written, so the key is not there at all.
		const answered = JSON.parse(made.body);
		assert.equal(Object.hasOwn(answered, "report"), false, `a note with no chart has nothing to report, got ${JSON.stringify(answered)}`);
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a thread card closed with nothing behind it is put back by /undo", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-undo-thread-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		// A thread with no message never spawns a child, so this is a card and nothing else.
		const made = await postTo(daemon, board.id, "/thread", { title: "a thread" });
		const threadId = JSON.parse(made.body).threadId;
		assert.equal((await postTo(daemon, board.id, "/close", { cardId: threadId })).status, 200);

		const closed = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		assert.equal(closed.threads.some((thread: any) => thread.id === threadId), false, "the thread was not closed");

		assert.equal((await postTo(daemon, board.id, "/undo", {})).status, 200);
		const back = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		const restored = (back.cards as any[]).find((card) => card.id === threadId);
		assert.ok(restored, "the thread card did not come back");
		assert.equal(restored.title, "a thread");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("the event stream opens with a snapshot the client can draw from", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-events-"));
	const daemon = await boot(folder);
	try {
		const opened = await post(daemon, "/workspace", { folder });
		const board = JSON.parse(opened.body).board;
		const controller = new AbortController();
		const response = await fetch(`${daemon.base}/events?token=${daemon.token}&workspace=${board.id}`, { signal: controller.signal });
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /event-stream/);
		assert.ok(response.body, "no stream body");
		const reader = response.body.getReader();
		const { value } = await reader.read();
		controller.abort();
		const text = new TextDecoder().decode(value ?? new Uint8Array());
		const line = text.split("\n").find((each) => each.startsWith("data: "));
		assert.ok(line, `no data line in the first chunk: ${text.slice(0, 120)}`);
		const payload = JSON.parse(line.slice("data: ".length));
		// The whole client renders from this one message: the cards, what was closed, the rail's rows,
		// the board's meta and the git strip.
		assert.equal(payload.type, "snapshot");
		assert.ok(Array.isArray(payload.cards));
		assert.ok(Array.isArray(payload.closed));
		assert.ok(Array.isArray(payload.activity));
		assert.ok(payload.meta, "the snapshot carries no meta");
		assert.ok("git" in payload, "the snapshot carries no git picture");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

/**
 * A `pi` that is not pi, at the path the daemon looks for one.
 *
 * A thread's token is minted inside the spawn and handed to the child alone: `/state` does not carry it
 * and neither does the board file. So the only way for a test to hold a real one is to be the child.
 * This stub writes down the three variables the daemon gave it, answers the frames the daemon waits on,
 * and exits when its stdin closes. It is a string rather than a file of its own because `node --test`
 * runs every file it finds under `test/`, and a stub waiting on stdin would sit in the suite as a test
 * that never ends.
 */
const STUB_PI = String.raw`
const { appendFileSync, existsSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

// The catalogue: pi --list-models is a table for humans, and the daemon reads one. Two models on two
// providers is enough for a check that a card's own model choice is looked at before it is stored.
if (process.argv.includes("--list-models")) {
	const rows = [
		["github-copilot", "gemini-4-argon", "1.0M", "65.5K", "yes", "yes"],
		["klotilda", "deepseek-ai/DeepSeek-V4.1-Flash-1017", "1.0M", "65.5K", "yes", "yes"],
	];
	const line = (cells) => cells.map((cell, at) => (at < 2 ? cell.padEnd(at ? 37 : 14) : cell)).join("  ");
	process.stdout.write(line(["provider", "model", "context", "max-out", "thinking", "images"]) + "\n");
	for (const row of rows) process.stdout.write(line(row) + "\n");
	process.exit(0);
}

// A naming run is the other shape of invocation and carries no thread token, so it has nothing to say
// here and leaves rather than wait on a stdin nobody will write.
if (!process.env.PI_STUDIO_TOKEN) process.exit(0);

writeFileSync(join(__dirname, "child-env.json"), JSON.stringify({
	token: process.env.PI_STUDIO_TOKEN,
	workspace: process.env.PI_STUDIO_WORKSPACE,
	thread: process.env.PI_STUDIO_THREAD,
}));

const say = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
// Every frame this child was sent, so a test can say what reached it rather than what the answer was.
const wrote = (frame) => appendFileSync(join(__dirname, "frames.jsonl"), JSON.stringify(frame) + "\n");
// A file in the stub's own folder stands in for the state a real child keeps: compaction writes it,
// and the stats answer reads it, which is how the smaller context reaches the board.
const flag = (name) => join(__dirname, name);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() || "";
	for (const line of lines) {
		if (!line.trim()) continue;
		const frame = JSON.parse(line);
		wrote(frame);
		// The session id is the one thing the daemon cannot do without: it resumes the thread with it.
		if (frame.type === "get_state") say({ type: "response", command: "get_state", success: true, data: { sessionId: "stub-session" } });
		// Asked after the run settles, and the child is closed once it answers.
		if (frame.type === "get_session_stats") {
			const tokens = existsSync(flag("compacted")) ? 32000 : 150000;
			say({ type: "response", command: "get_session_stats", success: true, data: { tokens: { input: 1, output: 1, total: 2 }, totalMessages: 1, contextUsage: { tokens, contextWindow: 200000, percent: Math.round((tokens / 200000) * 100) } } });
		}
		// Compaction: the summary a real child writes, and the flag the next stats answer reads.
		if (frame.type === "compact") {
			// A "die" file is a child that exits without answering, which the board must not wait out.
			if (existsSync(flag("die"))) process.exit(0);
			writeFileSync(flag("compacted"), "1");
			say({ type: "response", command: "compact", success: true, data: { summary: "a shorter conversation", tokensBefore: 150000, estimatedTokensAfter: 32000 } });
		}
		if (frame.type === "prompt") {
			// A "hold" file keeps the run open, which is the state a compaction has to refuse.
			if (existsSync(flag("hold"))) continue;
			// A "cut" file is a run the board stopped before it said anything: the empty, aborted answer
			// that leaves its turn reading stopped.
			if (existsSync(flag("cut"))) {
				say({ type: "turn_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
				say({ type: "agent_settled" });
				continue;
			}
			// A "slow" file delays one answer, which is the window a second message is queued in. It is
			// spent on the first prompt so the rest of the run answers at once.
			if (existsSync(flag("slow"))) {
				unlinkSync(flag("slow"));
				setTimeout(() => {
					say({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "the stub answered" }] } });
					say({ type: "agent_settled" });
				}, 600);
				continue;
			}
			say({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "the stub answered" }] } });
			say({ type: "agent_settled" });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
`;

/** Write that stub into a temp folder shaped like the managed install the daemon drives. */
function stubPi(root: string) {
	const version = "0.0.0-test";
	const packageDir = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	const bundle = join(packageDir, "dist", "bundle");
	const cli = join(bundle, "cli.js");
	mkdirSync(bundle, { recursive: true });
	writeFileSync(join(root, "current-version"), `${version}\n`);
	// The install carries its own manifest, so the stub is read as CommonJS whatever folder the temp
	// root happened to be made in.
	writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "commonjs" })}\n`);
	writeFileSync(cli, STUB_PI);
	// A stub that was not written would leave the daemon falling back to a real `pi` on PATH, which is
	// the one thing a test may not start.
	assert.ok(existsSync(cli), `the stub pi was not written to ${cli}`);
	return { root, envFile: join(bundle, "child-env.json") };
}

/**
 * The token the daemon minted for a thread, read back from the child that was handed it. The file is
 * written by that child, so finding it is waiting for the spawn the token belongs to rather than for a
 * guessed number of milliseconds.
 */
async function childEnvOf(daemon: Daemon, file: string) {
	for (let tries = 0; tries < 100; tries++) {
		try {
			const env = JSON.parse(readFileSync(file, "utf8"));
			if (env?.token) return env as { token: string; workspace: string; thread: string };
		} catch {
			// The child has not written it yet.
		}
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`no child token was written to ${file}: ${daemon.noise.join("").slice(-400)}`);
}

/**
 * A card's model is a pair this machine can run, or it is a card that dies at startup. The spawn tool
 * takes a provider and a model from an agent, and a quote that rode along with a provider name reached
 * pi as `--provider "github-copilot"`, which pi refuses with `Unknown provider` before the child says
 * anything at all. So the pair is checked against the catalogue when the card is made.
 */
test("a card is not born on a model this machine does not have", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-model-choice-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-model-choice-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		// The catalogue is pi's table, read once and handed to the picker with the scope it resolves.
		const catalog = JSON.parse((await get(daemon, `/models?token=${daemon.token}`)).body);
		assert.deepEqual(
			catalog.models.map((one: { provider: string; model: string }) => `${one.provider}/${one.model}`),
			["github-copilot/gemini-4-argon", "klotilda/deepseek-ai/DeepSeek-V4.1-Flash-1017"],
		);
		assert.equal(catalog.trouble, "", "a table the stub printed was read as trouble");

		// The pair a boss really sent: quotes around both halves, straight out of a tool argument.
		const quoted = await postTo(daemon, board.id, "/thread", { provider: '"github-copilot"', model: '"gemini-4-argon"' });
		assert.equal(quoted.status, 409);
		assert.match(quoted.body, /is not a model this machine has/);

		// Half a pair is a caller that meant one thing and wrote another, and is refused the same way.
		const half = await postTo(daemon, board.id, "/thread", { provider: "github-copilot" });
		assert.equal(half.status, 409);
		assert.match(half.body, /provider and model belong together/);

		// A pair the catalogue names is the card it asked for, provider and all.
		const good = await postTo(daemon, board.id, "/thread", { provider: "github-copilot", model: "gemini-4-argon" });
		assert.equal(good.status, 200);
		const made = JSON.parse(good.body).card;
		assert.equal(made.provider, "github-copilot");
		assert.equal(made.model, "gemini-4-argon");

		// A card with no choice of its own still starts on the board's default, and nothing is read for it.
		const plain = await postTo(daemon, board.id, "/thread", {});
		assert.equal(plain.status, 200);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a thread's own token reaches /card/ask over http and is refused the human's routes", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-thread-token-"));
	// A plain temp folder: a thread there works in place, so the run leaves no worktree behind.
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-thread-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	// Naming a thread is a second `pi` the daemon would start for it, and the stub is not one.
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		// A message is what starts the child, and the child is what a token is minted for.
		const said = await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" });
		assert.equal(said.status, 200);
		const child = await childEnvOf(daemon, stub.envFile);
		assert.notEqual(child.token, daemon.token, "a thread was handed the daemon's own token");
		assert.equal(child.workspace, board.id);
		assert.equal(child.thread, threadId);

		// What belongs to the human stays out of a thread's reach, over the real wire this time.
		const read = await get(daemon, `/state?token=${child.token}&workspace=${board.id}`);
		assert.equal(read.status, 403);
		assert.equal(read.body, "a thread may not use that");
		const layout = await postAs(daemon, child.token, board.id, "/layout", { id: board.id, view: { x: 1, y: 1, k: 1 } });
		assert.equal(layout.status, 403);
		assert.equal(layout.body, "a thread may not use that");

		// The route board_ask uses, asked by the thread itself. The daemon holds this request open until
		// the human answers it, so it is not awaited yet.
		const held = postAs(daemon, child.token, board.id, "/card/ask", { question: "which way?", options: ["left", "right"] });
		const card = await questionCard(daemon, board.id);
		assert.ok(card, "the thread's question never reached the board");
		assert.equal(card.question, "which way?");
		assert.equal(card.status, "open");
		const early = await Promise.race([
			held.then(() => "settled" as const),
			new Promise<"held">((done) => setTimeout(() => done("held"), 250)),
		]);
		assert.equal(early, "held", "the question settled before the human answered it");

		const clicked = await postTo(daemon, board.id, "/answer", { cardId: card.id, answer: "right" });
		assert.equal(clicked.status, 200);
		const reply = await held;
		assert.equal(reply.status, 200);
		assert.equal(JSON.parse(reply.body).answer, "right");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a thread closes a spent card, and a pin stops it", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-thread-close-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-thread-close-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		// A message is what starts the child, and the child is what a token is minted for.
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		const child = await childEnvOf(daemon, stub.envFile);
		const spent = JSON.parse((await postTo(daemon, board.id, "/card/note", { key: "spent", markdown: "done with", threadRoot: threadId })).body).cardId;
		const kept = JSON.parse((await postTo(daemon, board.id, "/card/note", { key: "kept", markdown: "in sight", threadRoot: threadId })).body).cardId;
		const pin = await postTo(daemon, board.id, "/layout", { cardId: kept, rect: { x: 0, y: 0, w: 300, h: 200 }, pinned: true });
		assert.equal(pin.status, 200);

		// A spent card is the thread's to tidy, and the key it read off its own board is enough to name it.
		const closed = await postAs(daemon, child.token, board.id, "/close", { cardId: "spent" });
		assert.equal(closed.status, 200);
		assert.equal(JSON.parse(closed.body).closed, spent);

		// A pin is the human's, so the same caller is refused the card they keep in sight.
		const refused = await postAs(daemon, child.token, board.id, "/close", { cardId: kept });
		assert.equal(refused.status, 409);
		assert.equal(refused.body, "that card is pinned");

		// The person who pinned it closes it as before: the pin protects the card from a thread alone.
		assert.equal((await postTo(daemon, board.id, "/close", { cardId: kept })).status, 200);

		// The card a thread answers on is the one card it may not close: the close would run `closeThread`
		// on the caller itself, and the SIGKILL would land before the answer did.
		const self = await postAs(daemon, child.token, board.id, "/close", { cardId: threadId });
		assert.equal(self.status, 409);
		assert.equal(self.body, "a thread cannot close its own card");

		// A card that belongs to no thread is the human's, and an agent does not tidy the board for them.
		const loose = JSON.parse((await postTo(daemon, board.id, "/card/note", { key: "loose", markdown: "the human's own" })).body).cardId;
		const unowned = await postAs(daemon, child.token, board.id, "/close", { cardId: loose });
		assert.equal(unowned.status, 409);
		assert.equal(unowned.body, "a thread closes only the cards it wrote");

		// Another thread's card is that thread's, so the same caller is refused it by id and by key.
		const otherThread = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "someone else" })).body).threadId;
		const theirs = JSON.parse((await postTo(daemon, board.id, "/card/note", { key: "theirs", markdown: "not yours", threadRoot: otherThread })).body).cardId;
		const notMine = await postAs(daemon, child.token, board.id, "/close", { cardId: theirs });
		assert.equal(notMine.status, 409);
		assert.equal(notMine.body, "a thread closes only the cards it wrote");

		// A child a thread spawned is a row that thread retires when it is done: closing it is the one thread
		// card a caller may close, and the rest of the board stays where it is.
		const spawnedThread = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "a child", parentThread: threadId })).body).threadId;
		assert.equal((await postAs(daemon, child.token, board.id, "/close", { cardId: spawnedThread })).status, 200);

		// Another root thread was not spawned by this one, so its card is refused like any other stranger's.
		const stranger = await postAs(daemon, child.token, board.id, "/close", { cardId: otherThread });
		assert.equal(stranger.status, 409);
		assert.equal(stranger.body, "a thread closes only a thread it spawned");

		// Two threads hold a card keyed `plan`, and the key resolves to the caller's own: a board-wide match
		// would hand back whichever card was inserted first, which is how one thread closed another's.
		writeFileSync(join(folder, "plan.ts"), "export const plan = 1;\n");
		const theirPlan = JSON.parse((await postTo(daemon, board.id, "/card/note", { key: "plan", markdown: "their plan", threadRoot: otherThread })).body).cardId;
		const myPlan = JSON.parse((await postTo(daemon, board.id, "/card/source", { path: "plan.ts", key: "plan", threadRoot: threadId })).body).cardId;
		const plan = await postAs(daemon, child.token, board.id, "/close", { cardId: "plan" });
		assert.equal(plan.status, 200);
		assert.equal(JSON.parse(plan.body).closed, myPlan, "the key resolved to another thread's card");
		const after = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		assert.ok(after.cards.some((card: any) => card.id === theirPlan), "the other thread's plan was closed");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

/** One thread as `/state` reports it, which is where its numbers are read. */
async function threadState(daemon: Daemon, board: string, id: string) {
	const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board}`)).body);
	return (state.threads as any[]).find((one) => one.id === id) ?? null;
}

/** The frames the stub child was sent, in order. A child that was never started has written nothing. */
function framesOf(stub: { root: string; envFile: string }) {
	const file = join(dirname(stub.envFile), "frames.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * A tab on the board's event stream, kept open for the length of one test. What the client draws is the
 * card in a frame, so the tests that ask what a person sees read that rather than the board in memory.
 */
async function watching(daemon: Daemon, board: string) {
	const controller = new AbortController();
	const response = await fetch(`${daemon.base}/events?token=${daemon.token}&workspace=${board}`, { signal: controller.signal });
	assert.equal(response.status, 200);
	assert.ok(response.body, "no stream body");
	const frames: any[] = [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	void (async () => {
		let buffer = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let cut = buffer.indexOf("\n\n");
				while (cut >= 0) {
					const frame = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 2);
					for (const line of frame.split("\n")) if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
					cut = buffer.indexOf("\n\n");
				}
			}
		} catch {
			// The test closed the stream.
		}
	})();
	const card = (id: string) => frames.filter((frame) => frame.type === "update" && frame.card?.id === id).at(-1)?.card ?? null;
	return {
		/** The card the client last received, or null while it has heard nothing about it. */
		card,
		/** Wait for the card to read the way the test expects a settled one to, and hand it back. */
		async until(id: string, reads: (card: any) => boolean) {
			let shown = null;
			for (let tries = 0; tries < 200; tries++) {
				shown = card(id);
				if (shown && reads(shown)) return shown;
				await new Promise((done) => setTimeout(done, 25));
			}
			throw new Error(`the client never drew the card that way: ${JSON.stringify(shown?.turns ?? shown)}`);
		},
		stop: () => controller.abort(),
	};
}

test("a message waiting behind a run can be rewritten or taken back before the child reads it", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-queue-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-queue-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	// The stub's own switches, in the folder it was written to: `hold` keeps a run open, `slow` delays one.
	const flags = dirname(stub.envFile);
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;

		// A run that never settles is the window a second message waits in.
		writeFileSync(join(flags, "hold"), "1");
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "the first words" })).status, 200);
		const asked = await postTo(daemon, board.id, "/message", { cardId: threadId, text: "the words I regret" });
		assert.equal(asked.status, 200);
		const at = JSON.parse(asked.body).turn as number;
		const waiting = await threadState(daemon, board.id, threadId);
		assert.equal(waiting.turns[at].status, "queued", "a message sent behind a run was not queued");
		assert.equal(waiting.queued.length, 1);
		const told = (words: string) => framesOf(stub).some((frame) => frame.type === "prompt" && String(frame.message).includes(words));
		assert.equal(told("regret"), false, "the child was given a message that was still waiting");

		const edited = await postTo(daemon, board.id, "/message/edit", { cardId: threadId, turn: at, text: "the words I meant" });
		assert.equal(edited.status, 200, edited.body);
		const after = await threadState(daemon, board.id, threadId);
		assert.equal(after.turns[at].text, "the words I meant", "the card still shows the words that were replaced");
		assert.equal(after.turns[at].status, "queued");
		assert.equal(after.queued.length, 1);
		// The board named the section the words belong to, and the rewrite keeps that name around them.
		assert.equal(after.queued[0].message, "[user message]\nthe words I meant", "the edited words never reached the queue");

		// The turn the child already reads is not a draft, and says so rather than rewriting what it read.
		const tooLate = await postTo(daemon, board.id, "/message/edit", { cardId: threadId, turn: 0, text: "too late" });
		assert.equal(tooLate.status, 409);
		assert.match(tooLate.body, /not waiting/);

		const spare = await postTo(daemon, board.id, "/message", { cardId: threadId, text: "never mind" });
		const spareAt = JSON.parse(spare.body).turn as number;
		assert.equal((await postTo(daemon, board.id, "/message/drop", { cardId: threadId, turn: spareAt })).status, 200);
		const dropped = await threadState(daemon, board.id, threadId);
		assert.equal(dropped.queued.length, 1, "the withdrawn message is still waiting");
		assert.equal(dropped.turns[spareAt].status, "stopped");
		assert.equal(dropped.turns[spareAt].error, "withdrawn");
		assert.equal(told("never mind"), false);

		// A second thread, and a run slow enough to queue behind: what the child is finally told is the
		// message as it reads now, not as it was first typed.
		rmSync(join(flags, "hold"));
		writeFileSync(join(flags, "slow"), "1");
		const second = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: second, text: "slow words" })).status, 200);
		const late = JSON.parse((await postTo(daemon, board.id, "/message", { cardId: second, text: "a first draft" })).body);
		const rewritten = await postTo(daemon, board.id, "/message/edit", { cardId: second, turn: late.turn, text: "the second draft" });
		assert.equal(rewritten.status, 200, rewritten.body);
		for (let tries = 0; tries < 100; tries++) {
			const thread = await threadState(daemon, board.id, second);
			if (thread?.turns?.[late.turn]?.status === "answered") break;
			await new Promise((done) => setTimeout(done, 50));
		}
		assert.equal(told("a first draft"), false, "the child was told the draft that was replaced");
		assert.equal(told("the second draft"), true, `the child was told ${JSON.stringify(framesOf(stub).filter((frame) => frame.type === "prompt").map((frame) => frame.message))}`);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a run that read a steer keeps the steer's own words, and the answer stays on the run's turn", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-steer-spent-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-steer-spent-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const flags = dirname(stub.envFile);
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	let tab: { stop: () => void } | null = null;
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "a thread" })).body).threadId;
		const seen = await watching(daemon, board.id);
		tab = seen;
		// A run slow enough that a steer lands while it is live, which is the only way a steer is spent.
		writeFileSync(join(flags, "slow"), "1");
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "the first words" })).status, 200);
		const steered = await postTo(daemon, board.id, "/message", { cardId: threadId, text: "and this instead", mode: "steer" });
		assert.equal(steered.status, 200);
		const at = JSON.parse(steered.body).turn as number;
		for (let tries = 0; tries < 100 && !framesOf(stub).some((frame) => frame.type === "steer"); tries++) {
			await new Promise((done) => setTimeout(done, 20));
		}
		assert.ok(framesOf(stub).some((frame) => frame.type === "steer"), "the steer never reached the child, so it was never spent");
		// The frame the settle sends is the one a person reads the card from: the thread reads answered once
		// the run is over, and every frame before that one still says a run is going.
		const card = await seen.until(threadId, (shown) => shown.status === "answered");
		assert.equal(card.turns[0].status, "answered", "the run's own turn kept no answer");
		assert.equal(card.turns[0].reply, "the stub answered");
		assert.equal(card.turns[at].status, "sent", "the steer the run read was relabelled as stopped");
		assert.equal(card.turns[at].mode, "steer");
		assert.equal(card.turns[at].reply, undefined, "the steer took the run's answer");
	} finally {
		tab?.stop();
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a steer sent to an idle thread is that run's own turn, and a run that never answered reads stopped", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-steer-idle-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-steer-idle-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const flags = dirname(stub.envFile);
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	let tab: { stop: () => void } | null = null;
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "a thread" })).body).threadId;
		const seen = await watching(daemon, board.id);
		tab = seen;
		// The composer sends `steer` whether a run is live or not, so this turn is the run's own turn. The
		// child says nothing at all, which is a run that was cut before it answered.
		writeFileSync(join(flags, "cut"), "1");
		const sent = await postTo(daemon, board.id, "/message", { cardId: threadId, text: "the only words", mode: "steer" });
		assert.equal(sent.status, 200);
		const at = JSON.parse(sent.body).turn as number;
		const card = await seen.until(threadId, (shown) => shown.turns?.[at]?.status !== "sent" && shown.turns?.[at]?.streaming !== true);
		assert.equal(card.turns[at].status, "stopped", "a steer on an idle thread kept the label of a run that never answered");
		assert.equal(card.turns[at].mode, "steer");
		assert.equal(card.turns[at].reply, undefined, "a run that said nothing left an answer");
	} finally {
		tab?.stop();
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a spawned child reports the turn that answered, and one that never answered reports stopped", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-spawn-report-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-spawn-report-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const flags = dirname(stub.envFile);
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const parentId = JSON.parse((await postTo(daemon, board.id, "/thread", { title: "the master" })).body).threadId;
		// A run slow enough that a steer lands while the spawn is waiting for the answer.
		writeFileSync(join(flags, "slow"), "1");
		const spawn = postTo(daemon, board.id, "/thread/spawn", {
			task: "look at it",
			title: "the child",
			parentThread: parentId,
			timeoutSeconds: 30,
		});
		// The child's own thread is on the board before its run ends, and that is the window a steer is sent in.
		let childId = "";
		for (let tries = 0; tries < 200 && !childId; tries++) {
			const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
			childId = (state.threads as any[]).find((one) => one.parentThread === parentId)?.id ?? "";
			if (!childId) await new Promise((done) => setTimeout(done, 20));
		}
		assert.ok(childId, "the spawned thread never reached the board");
		const steered = await postTo(daemon, board.id, "/message", { cardId: childId, text: "and this instead", mode: "steer" });
		assert.equal(steered.status, 200);
		const answered = await spawn;
		assert.equal(answered.status, 200);
		const report = JSON.parse(answered.body);
		assert.equal(report.status, "done", `a run that answered was reported as ${report.status}`);
		assert.equal(report.output, "the stub answered", "the report took the steer's words instead of the answer");
		// Where the words landed is the other half of the report being right: the steer took nothing.
		const child = await threadState(daemon, board.id, childId);
		assert.equal(child.turns[0].status, "answered");
		assert.equal(child.turns[0].reply, "the stub answered", "the steer took the run's answer");
		assert.equal(child.turns[1].status, "sent");

		// A child that said nothing has no answering turn to report, so it is a run that stopped.
		writeFileSync(join(flags, "cut"), "1");
		const quiet = await postTo(daemon, board.id, "/thread/spawn", { task: "say nothing", title: "the quiet child", parentThread: parentId, timeoutSeconds: 30 });
		assert.equal(quiet.status, 200);
		const cut = JSON.parse(quiet.body);
		assert.equal(cut.status, "stopped", `a run that never answered was reported as ${cut.status}`);
		assert.equal(cut.output, "");
		assert.equal(cut.error, undefined);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a compaction reaches the thread's child, and the context comes back smaller", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-compact-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-compact-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		// The run has to be over and its child gone: a compaction starts a child rather than interrupting one.
		for (let tries = 0; tries < 100; tries++) {
			const thread = await threadState(daemon, board.id, threadId);
			if (thread && thread.status === "idle" && thread.live === false) break;
			await new Promise((done) => setTimeout(done, 50));
		}
		const before = await threadState(daemon, board.id, threadId);
		assert.equal(before?.stats?.context, 150000, "the stub's first context never reached the board");

		// A card no thread answers has nothing to compact, and says so rather than starting a child.
		const nowhere = await postTo(daemon, board.id, "/compact", { cardId: "no-such-card" });
		assert.equal(nowhere.status, 409);
		assert.equal(nowhere.body, "no thread answers this card");

		const compacted = await postTo(daemon, board.id, "/compact", { cardId: threadId });
		assert.equal(compacted.status, 200, compacted.body);
		const said = JSON.parse(compacted.body);
		assert.equal(said.threadId, threadId);
		assert.equal(said.tokensBefore, 150000);
		assert.equal(said.estimatedTokensAfter, 32000);
		assert.ok(framesOf(stub).some((frame: any) => frame.type === "compact"), "no compact frame reached the child");

		// The figures are read again after the summary, so the button has a smaller number to show.
		let after = await threadState(daemon, board.id, threadId);
		for (let tries = 0; tries < 100 && after?.stats?.context !== 32000; tries++) {
			await new Promise((done) => setTimeout(done, 50));
			after = await threadState(daemon, board.id, threadId);
		}
		assert.equal(after?.stats?.context, 32000);
		assert.equal(after?.stats?.contextMax, 200000);
		// pi reports the window as `contextWindow`, which is the denominator the meter needs.
		assert.equal(after?.stats?.contextPercent, 16);

		// The card the composer sends is not always the thread: a note the thread wrote carries the
		// thread in `ownerThread`, and that is the walk the model and thinking chips already use.
		const note = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "a note", key: "under-test", threadRoot: threadId })).body);
		// The child that answered is closing, and a frame written now would never be read.
		for (let tries = 0; tries < 100; tries++) {
			if ((await threadState(daemon, board.id, threadId))?.live === false) break;
			await new Promise((done) => setTimeout(done, 50));
		}
		const throughNote = await postTo(daemon, board.id, "/compact", { cardId: note.cardId });
		assert.equal(throughNote.status, 200, throughNote.body);
		assert.equal(JSON.parse(throughNote.body).threadId, threadId);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a compaction is refused while the thread is answering, and nothing reaches the child", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-compact-busy-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-compact-busy-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	// The stub holds the run open, which is the one state a compaction may not cut into.
	writeFileSync(join(dirname(stub.envFile), "hold"), "1");
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "keep working" })).status, 200);
		for (let tries = 0; tries < 100; tries++) {
			const thread = await threadState(daemon, board.id, threadId);
			if (thread?.status === "running") break;
			await new Promise((done) => setTimeout(done, 50));
		}
		const refused = await postTo(daemon, board.id, "/compact", { cardId: threadId });
		assert.equal(refused.status, 409);
		assert.equal(refused.body, "this thread is answering: compact when it is idle");
		assert.ok(!framesOf(stub).some((frame: any) => frame.type === "compact"), "a compaction reached a busy child");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a compaction is refused before a thread has run, because there is no context yet", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-compact-fresh-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-compact-fresh-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		const refused = await postTo(daemon, board.id, "/compact", { cardId: threadId });
		assert.equal(refused.status, 409);
		assert.equal(refused.body, "this thread has not run yet, so there is nothing to compact");
		assert.deepEqual(framesOf(stub), [], "a child was started for a thread with no session");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a child that dies before it answers is reported, not waited out", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-compact-die-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-compact-die-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		for (let tries = 0; tries < 100; tries++) {
			const thread = await threadState(daemon, board.id, threadId);
			if (thread && thread.status === "idle" && thread.live === false && thread.sessionId) break;
			await new Promise((done) => setTimeout(done, 50));
		}
		writeFileSync(join(dirname(stub.envFile), "die"), "1");
		// The next child exits without answering the compaction, and the press hears about it at once
		// rather than sitting on the route until the ceiling gives up on it.
		const started = Date.now();
		const gone = await postTo(daemon, board.id, "/compact", { cardId: threadId });
		assert.equal(gone.status, 409);
		assert.match(gone.body, /the child exited before it answered/);
		assert.ok(Date.now() - started < 20_000, "the press waited on a child that was already gone");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

/** Wait until a thread has run everything asked of it, which is where its turns can be read. */
async function settledThread(daemon: Daemon, board: string, id: string, turns: number) {
	let seen = null;
	for (let tries = 0; tries < 200; tries++) {
		seen = await threadState(daemon, board, id);
		const done = (seen?.turns ?? []).length >= turns && (seen?.turns ?? []).every((turn: any) => turn.status !== "sent" && turn.status !== "queued");
		if (done && seen?.status === "idle") return seen;
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`thread ${id} never settled: ${JSON.stringify(seen?.turns ?? seen)}`);
}

/** One card as `/state` draws it. */
async function cardState(daemon: Daemon, board: string, id: string) {
	const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board}`)).body);
	return (state.cards as any[]).find((one) => one.id === id) ?? null;
}

test("a question about a note is answered on the thread's card, and the note keeps no turn", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-note-reply-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-note-reply-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		await settledThread(daemon, board.id, threadId, 1);

		// The note the thread made is the artifact the human reads, and the card the composer sends.
		const note = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "the artifact", key: "an-artifact", threadRoot: threadId })).body);
		assert.equal(note.card.ownerThread, threadId, "the note was not owned by the thread that wrote it");

		const asked = await postTo(daemon, board.id, "/message", { cardId: note.cardId, text: "what does this show?" });
		assert.equal(asked.status, 200);
		const settled = await settledThread(daemon, board.id, threadId, 2);

		// The answer is the thread's own turn, next to the words that asked for it.
		assert.equal(settled.turns.length, 2, "the thread's conversation has one turn too many or too few");
		assert.equal(settled.turns[1].text, "what does this show?");
		assert.equal(settled.turns[1].status, "answered");
		assert.equal(settled.turns[1].reply, "the stub answered");
		// The card stays the artifact it was: it is quoted at the child, and written on by nobody.
		const card = await cardState(daemon, board.id, note.cardId);
		assert.deepEqual(card.turns ?? [], [], "the note kept the turn");
		const prompts = framesOf(stub).filter((frame: any) => frame.type === "prompt");
		assert.match(prompts[1].message, /The card says: the artifact/, "the child was not told which card it is about");
		// The board's own text is a section of its own: the card list as bullets, then a divided-off line
		// naming where the human's words begin.
		assert.match(prompts[1].message, /^\[board state\]\n- /, "the board's cards were not listed as bullets");
		assert.match(prompts[1].message, /\n---\n\[user message\]\nwhat does this show\?$/, "the human's words were not told apart from the board's");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a fork answers on a card of its own, and the note keeps its owner and its turns", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-fork-thread-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-fork-thread-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		await settledThread(daemon, board.id, threadId, 1);
		const note = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "the artifact", key: "a-forked-artifact", threadRoot: threadId })).body);

		const asked = await postTo(daemon, board.id, "/message", { cardId: note.cardId, fork: true, text: "what does this show?" });
		assert.equal(asked.status, 200);
		const forkId = JSON.parse(asked.body).id;
		assert.notEqual(forkId, threadId, "the fork was answered by the thread that made the card");

		// A fork is a thread of its own, read in a card of its own that cascades under the card asked about.
		const settled = await settledThread(daemon, board.id, forkId, 1);
		assert.equal(settled.hidden ?? false, false, "the fork is not drawn as a card");
		assert.equal(settled.threadRoot, note.cardId, "the fork does not hang under the card it was asked about");
		assert.equal(settled.turns[0].text, "what does this show?");
		assert.equal(settled.turns[0].reply, "the stub answered");
		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board.id}`)).body);
		assert.ok(
			state.cards.some((one: any) => one.id === forkId),
			"the fork answers where nothing is drawn",
		);

		// The card was only asked about: it keeps its owner and gains no turn of another thread.
		const card = await cardState(daemon, board.id, note.cardId);
		assert.equal(card.ownerThread, threadId, "the fork took the card over");
		assert.deepEqual(card.turns ?? [], [], "the note kept the fork's turn");
		const prompts = framesOf(stub).filter((frame: any) => frame.type === "prompt");
		assert.match(prompts[1].message, /The card says: the artifact/, "the fork was not told which card it is about");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("one message can name several cards, and each is quoted to the child", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-refs-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-refs-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		const first = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "the first artifact", key: "named-first", threadRoot: threadId })).body);
		const second = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "the second artifact", key: "named-second", threadRoot: threadId })).body);

		// The field lives in the thread's own card, and the cards it names travel beside it: that is the
		// shape a message typed about several artifacts arrives in.
		const asked = await postTo(daemon, board.id, "/message", {
			cardId: threadId,
			refs: [first.cardId, second.cardId, "no-such-card"],
			text: "compare these two",
		});
		assert.equal(asked.status, 200, asked.body);
		await settledThread(daemon, board.id, threadId, 1);

		const prompt = framesOf(stub).filter((frame: any) => frame.type === "prompt")[0].message;
		assert.match(prompt, /The card says: the first artifact/, "the first card the message named was not quoted");
		assert.match(prompt, /The card says: the second artifact/, "the second card the message named was not quoted");
		assert.match(prompt, /compare these two/, "the words the human typed did not reach the child");
		// A card that is not on the board is passed over rather than refusing the message.
		assert.doesNotMatch(prompt, /no-such-card/, "an unknown reference reached the child");
		// The turn belongs to the thread's card, and the cards named keep their own text and no turn.
		const settled = await threadState(daemon, board.id, threadId);
		assert.deepEqual(settled.turns.map((turn: any) => turn.text), ["compare these two"]);
		assert.deepEqual((await cardState(daemon, board.id, first.cardId))?.turns ?? [], []);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a message queued behind a run lands on its own turn, once", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-queue-turns-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-queue-turns-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	// The first answer is held back, which is the window the second message is queued in.
	writeFileSync(join(dirname(stub.envFile), "slow"), "1");
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		const note = JSON.parse((await postTo(daemon, board.id, "/card/note", { markdown: "the artifact", key: "queued-artifact", threadRoot: threadId })).body);
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "first" })).status, 200);
		for (let tries = 0; tries < 100; tries++) {
			if ((await threadState(daemon, board.id, threadId))?.status === "running") break;
			await new Promise((done) => setTimeout(done, 20));
		}
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: note.cardId, text: "second" })).status, 200);

		const settled = await settledThread(daemon, board.id, threadId, 2);
		// One turn per message: the queued one is marked where it waits, not pushed a second time.
		assert.deepEqual(settled.turns.map((turn: any) => turn.text), ["first", "second"]);
		assert.ok(settled.turns.every((turn: any) => turn.status === "answered"), `turns were left waiting: ${JSON.stringify(settled.turns.map((turn: any) => turn.status))}`);
		assert.deepEqual((await cardState(daemon, board.id, note.cardId))?.turns ?? [], [], "the note kept the queued turn");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a prompt file's own bytes go back through POST /prompt, and the repository keeps them", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-prompt-route-"));
	const daemon = await boot(folder);
	// The file the settings page writes is a file in the repository, so it is put back exactly as it was.
	const path = join(repo, "prompts", "roles", "scout.md");
	const original = readFileSync(path, "utf8");
	try {
		const listed = JSON.parse((await get(daemon, `/prompts?token=${daemon.token}`)).body);
		assert.ok(listed.prompts.some((one: any) => one.name === "roles/scout.md"), "the file is not in GET /prompts");
		const one = await get(daemon, `/prompt?token=${daemon.token}&name=${encodeURIComponent("roles/scout.md")}`);
		assert.equal(one.status, 200);
		assert.equal(JSON.parse(one.body).text, original);

		// Saving it unchanged is the write the page's `save` makes: same bytes in, same bytes on disk.
		const wrote = await post(daemon, "/prompt", { name: "roles/scout.md", text: original });
		assert.equal(wrote.status, 200, wrote.body);
		assert.equal(readFileSync(path, "utf8"), original);

		// The document the page draws names the file and the route that writes it; the bytes it shows are the
		// ones read above, because a prompt leaf is a file rather than a value.
		const document = JSON.parse((await get(daemon, `/settings/defaults?token=${daemon.token}`)).body);
		const field = leavesOf(document).find((leaf) => leaf.id === "prompt-roles-scout");
		assert.equal(field?.file, "roles/scout.md", "the prompt field does not name its file");
		assert.equal(field?.value, "", "a prompt leaf carries a value the editor would overwrite");
		assert.equal(field?.write?.route, "/prompt");

		// And the route still refuses a name it does not own, which is the answer the field shows.
		const refused = await post(daemon, "/prompt", { name: "../../etc/passwd", text: "x" });
		assert.equal(refused.status, 400);
	} finally {
		writeFileSync(path, original);
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a workspace's two instruction files are read and saved where they sit, and nothing else is", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-workspace-prompt-"));
	const daemon = await boot(folder);
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		// A workspace nobody has written anything in yet answers with an empty box rather than a refusal.
		const quiet = await get(daemon, `/workspace-prompt?token=${daemon.token}&workspace=${board.id}&name=STUDIO.md`);
		assert.equal(quiet.status, 200, quiet.body);
		assert.deepEqual(JSON.parse(quiet.body), { name: "STUDIO.md", text: "" });
		assert.ok(!existsSync(join(folder, "STUDIO.md")), "reading created the file");

		const said = "# Studio\n\nCards on this project carry the build number.";
		const wrote = await postTo(daemon, board.id, "/workspace-prompt", { name: "STUDIO.md", text: said });
		assert.equal(wrote.status, 200, wrote.body);
		// The file is the workspace's own, beside its code, which is what lets it travel with the repository.
		assert.equal(readFileSync(join(folder, "STUDIO.md"), "utf8"), said);
		const read = await get(daemon, `/workspace-prompt?token=${daemon.token}&workspace=${board.id}&name=STUDIO.md`);
		assert.equal(JSON.parse(read.body).text, said);
		// The same two steps for the project's own file, which the page edits and pi reads.
		assert.equal((await postTo(daemon, board.id, "/workspace-prompt", { name: "AGENTS.md", text: "run the tests with npm test\n" })).status, 200);
		assert.match(readFileSync(join(folder, "AGENTS.md"), "utf8"), /npm test/);

		// pi reads an override file ahead of AGENTS.md, so the answer says the box is not the file a run reads.
		writeFileSync(join(folder, "AGENTS.override.md"), "prefer this one\n");
		const overridden = JSON.parse((await get(daemon, `/workspace-prompt?token=${daemon.token}&workspace=${board.id}&name=AGENTS.md`)).body);
		assert.equal(overridden.override, true);

		// Two names, and no request ever carries a path: a file the workspace page does not offer is not one
		// a route may read or write.
		for (const name of ["../../etc/passwd", "notes.md", "STUDIO.md/../x", "", "studio.md"]) {
			const refused = await postTo(daemon, board.id, "/workspace-prompt", { name, text: "x" });
			assert.equal(refused.status, 400, `${name} was accepted`);
		}
		const asked = await get(daemon, `/workspace-prompt?token=${daemon.token}&workspace=${board.id}&name=notes.md`);
		assert.equal(asked.status, 400);
		// A save that would grow the file without end is refused with the reason rather than cut short.
		const tooLong = await postTo(daemon, board.id, "/workspace-prompt", { name: "STUDIO.md", text: "x".repeat(MAX_WORKSPACE_PROMPT_CHARS + 1) });
		assert.equal(tooLong.status, 413);
		assert.equal(readFileSync(join(folder, "STUDIO.md"), "utf8"), said, "a refused save changed the file");

		// The page is drawn from the document, and it offers exactly these two leaves and no studio file.
		const document = JSON.parse((await get(daemon, `/settings/board?token=${daemon.token}&workspace=${board.id}`)).body);
		const prompts = document.groups.find((group: any) => group.id === "prompts");
		const leaves = prompts.fields ?? [];
		assert.deepEqual(leaves.map((leaf: any) => leaf.label), ["STUDIO.md", "AGENTS.md"]);
		assert.ok(leaves.every((leaf: any) => leaf.write.route === "/workspace-prompt"));
		assert.ok(!JSON.stringify(document.groups).includes("prompt-roles-"), "the studio's prompt files are on a board's page");
	} finally {
		daemon.child.kill();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a `!command` runs where the thread works, and the next message carries what it printed", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-shell-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-shell-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	// `SHELL` is named outright so the line is the same shell on every machine that runs this suite.
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "", SHELL: "/bin/sh" });
	try {
		writeFileSync(join(folder, "a-listing.txt"), "one\ntwo\n");
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;

		// A plain command answers with what it printed, and leaves a card behind.
		const ran = await postTo(daemon, board.id, "/shell", { command: "ls", cardId: threadId });
		assert.equal(ran.status, 200, ran.body);
		const said = JSON.parse(ran.body);
		assert.equal(said.exitCode, 0);
		assert.equal(said.timedOut, false);
		assert.equal(said.truncated, false);
		assert.match(said.output, /a-listing\.txt/, "the command did not run in the board's folder");
		assert.ok(said.cardId, "no card came back");
		// A command is not work: no tree is cut for an `ls`.
		assert.equal(existsSync(join(folder, ".agents")), false, "running a command made a worktree");

		const note = await cardState(daemon, board.id, said.cardId);
		assert.ok(note, "the command's card never reached the board");
		assert.equal(note.type, "note");
		assert.match(note.markdown, /\$ ls/);
		assert.match(note.markdown, /a-listing\.txt/);
		assert.doesNotMatch(note.markdown, /exit /, "a command that succeeded was marked as a failure");

		// Naming that card is the whole prepend: the child is told what the command printed, ahead of the
		// words the human typed, without the message being rewritten anywhere.
		const asked = await postTo(daemon, board.id, "/message", { cardId: threadId, refs: [said.cardId], text: "what is in here" });
		assert.equal(asked.status, 200, asked.body);
		await settledThread(daemon, board.id, threadId, 1);
		const prompt = framesOf(stub).filter((frame: any) => frame.type === "prompt")[0]?.message ?? "";
		assert.match(prompt, /a-listing\.txt/, "the command's output never reached the child");
		assert.match(prompt, /what is in here/, "the words the human typed did not reach the child");
		assert.ok(
			prompt.indexOf("a-listing.txt") < prompt.indexOf("what is in here"),
			"the output was not in front of the message it was meant to inform",
		);

		// A command that fails is not a refusal: it ran, and the exit code comes back in the body the field
		// reads its hint from, with the card carrying the same words.
		const failed = await postTo(daemon, board.id, "/shell", { command: "exit 7", cardId: threadId });
		assert.equal(failed.status, 200, failed.body);
		const sad = JSON.parse(failed.body);
		assert.equal(sad.exitCode, 7);
		assert.match((await cardState(daemon, board.id, sad.cardId)).markdown, /exit 7/);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a `!command` that prints more than the ceiling is cut on the card and says where", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-shell-cut-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-shell-cut-work-"));
	const daemon = await boot(stateHome, { SHELL: "/bin/sh" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		// A pipe as well as a big output, because a whole shell line is what the human typed.
		const ran = await postTo(daemon, board.id, "/shell", { command: "head -c 30000 /dev/zero | tr '\\0' 'x'", cardId: threadId });
		assert.equal(ran.status, 200, ran.body);
		const said = JSON.parse(ran.body);
		assert.equal(said.truncated, true, "a command that printed 30k characters was not cut");
		assert.ok(said.output.length < 21_000, `the output was not cut: ${said.output.length} characters`);
		assert.match(said.output, /\[cut: the output stopped at 20000 characters\]/);
		const note = await cardState(daemon, board.id, said.cardId);
		assert.match(note.markdown, /\[cut: the output stopped at 20000 characters\]/, "the card does not say its output was cut");

		// Nothing to run is refused where it is typed, and nothing is left on the board for it.
		const empty = await postTo(daemon, board.id, "/shell", { command: "   ", cardId: threadId });
		assert.equal(empty.status, 400);
		assert.equal(empty.body, "empty command");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a `!command` that outlives its limit is stopped with everything it started", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-shell-stop-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-shell-stop-work-"));
	// The limit is a policy constant of a minute; the checks shorten it through the environment rather than
	// sit one out.
	const daemon = await boot(stateHome, { PI_STUDIO_SHELL_TIMEOUT_MS: "300", SHELL: "/bin/sh" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		// A command that forks. Killing only the shell in front of it would leave the sleeper holding the pipes
		// open, and this promise would settle when the sleeper finished rather than when the limit ran out —
		// which is what the clock below measures.
		const started = Date.now();
		const ran = await postTo(daemon, board.id, "/shell", { command: "sleep 5 & wait", cardId: threadId });
		const took = Date.now() - started;
		assert.equal(ran.status, 200, ran.body);
		const said = JSON.parse(ran.body);
		assert.equal(said.timedOut, true, "a command that outlived its limit was not reported as stopped");
		assert.equal(said.exitCode, null);
		assert.ok(took < 3000, `the command was still running ${took}ms after a 300ms limit`);
		assert.match((await cardState(daemon, board.id, said.cardId)).markdown, /stopped at the/);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a thread's token cannot reach the shell route, whatever it writes in the body", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-shell-token-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-shell-token-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(stateHome, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		const child = await childEnvOf(daemon, stub.envFile);

		// The route is not in THREAD_ROUTES, so the refusal comes before the body is read: a thread has no shell.
		const ran = await postAs(daemon, child.token, board.id, "/shell", { command: "touch a-thread-was-here", cardId: threadId });
		assert.equal(ran.status, 403);
		assert.equal(ran.body, "a thread may not use that");
		assert.equal(existsSync(join(folder, "a-thread-was-here")), false, "a thread ran a command through the board");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("the crossroads always has a scratch row, and its empty press takes the files and the cards", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-scratch-"));
	const daemon = await boot(stateHome);
	// A daemon with a state folder of its own keeps its scratch beside it, which is what keeps this test out
	// of the human's folder and leaves nothing in the temp area once the state folder goes.
	const scratch = join(stateHome, "scratch");
	try {
		const list = JSON.parse((await get(daemon, `/workspaces?token=${daemon.token}`)).body).workspaces;
		assert.equal(list.length, 1, "an unopened studio has more than the scratch row");
		assert.equal(list[0].scratch, true, "the first row is not the scratch folder");
		assert.equal(list[0].folder, realpathSync(scratch));
		assert.equal(list[0].missing, false);
		assert.equal(list[0].name, "scratch");

		// Deleted by hand, it is made again by the next read: a row whose folder is gone is a row nobody can open.
		rmSync(scratch, { recursive: true, force: true });
		const again = JSON.parse((await get(daemon, `/workspaces?token=${daemon.token}`)).body).workspaces;
		assert.equal(again[0].missing, false, "the scratch row came back missing");
		assert.ok(existsSync(scratch), "the folder was not made again");

		const board = again[0].id;
		// A real folder opened beside it keeps its own place: the scratch row is first, not instead.
		const project = mkdtempSync(join(tmpdir(), "pi-studio-scratch-project-"));
		assert.equal((await post(daemon, "/workspace", { folder: project })).status, 200);
		const rows = JSON.parse((await get(daemon, `/workspaces?token=${daemon.token}`)).body).workspaces;
		assert.deepEqual(
			rows.map((row: any) => row.scratch),
			[true, false],
			"the scratch row is not the first of two",
		);

		assert.equal((await postTo(daemon, board, "/card/note", { markdown: "throwaway", key: "n1" })).status, 200);
		mkdirSync(join(scratch, "deeper"));
		writeFileSync(join(scratch, "try.py"), "print(1)\n");
		writeFileSync(join(scratch, "deeper", "x.txt"), "x\n");
		// A setting is the board's shape, not its mess, so the press must leave it alone.
		assert.equal((await postTo(daemon, board, "/config", { cardsVerbosity: "verbose" })).status, 200);

		const emptied = await post(daemon, "/scratch/empty");
		assert.equal(emptied.status, 200);
		assert.equal(JSON.parse(emptied.body).removed, 2, "the press did not count what it took");
		assert.deepEqual(readdirSync(scratch), [], "something is still in the scratch folder");
		assert.ok(existsSync(scratch), "the folder itself went with the press");

		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board}`)).body);
		assert.deepEqual(state.cards, [], "a card survived the press");
		assert.equal(state.meta.config.cardsVerbosity, "verbose", "the press took a setting with the mess");
		rmSync(project, { recursive: true, force: true });
	} finally {
		daemon.child.kill();
		rmSync(stateHome, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("a link planted at the scratch path is replaced, never walked into", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-scratch-link-"));
	// The temp area is writable by everyone on the machine, so a link standing at the scratch name is what a
	// stranger, or a mistake, leaves there. Empty must take the link and never what it points at.
	const kept = mkdtempSync(join(tmpdir(), "pi-studio-scratch-kept-"));
	writeFileSync(join(kept, "keep.txt"), "keep\n");
	symlinkSync(kept, join(stateHome, "scratch"));
	const daemon = await boot(stateHome);
	try {
		const row = JSON.parse((await get(daemon, `/workspaces?token=${daemon.token}`)).body).workspaces[0];
		assert.equal(row.scratch, true);
		assert.equal(row.missing, false);
		const emptied = await post(daemon, "/scratch/empty");
		assert.equal(emptied.status, 200);
		assert.equal(existsSync(join(kept, "keep.txt")), true, "the press deleted a folder through the link");
		const root = lstatSync(join(stateHome, "scratch"));
		assert.equal(root.isSymbolicLink(), false, "the link is still standing at the scratch path");
		assert.equal(root.isDirectory(), true);
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, kept]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a file where the scratch folder belongs does not stop the daemon, and the row is made", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-scratch-file-"));
	writeFileSync(join(stateHome, "scratch"), "not a folder\n");
	const daemon = await boot(stateHome);
	try {
		// A throw from the folder setup used to take the whole daemon down at its listening line.
		const row = JSON.parse((await get(daemon, `/workspaces?token=${daemon.token}`)).body).workspaces[0];
		assert.equal(row.scratch, true);
		assert.equal(row.missing, false, "the row is missing with a file in the folder's place");
		assert.equal(lstatSync(join(stateHome, "scratch")).isDirectory(), true);
	} finally {
		daemon.child.kill();
		rmSync(stateHome, { recursive: true, force: true });
	}
});

test("an id written onto the scratch row by hand cannot point its press at another board", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-scratch-id-"));
	const project = mkdtempSync(join(tmpdir(), "pi-studio-scratch-id-project-"));
	const scratch = realpathSync(mkdirSync(join(stateHome, "scratch"), { recursive: true }) ?? join(stateHome, "scratch"));
	// The identity rule the daemon uses: the first twelve hex of the folder's sha256.
	const idOf = (folder: string) => createHash("sha256").update(folder).digest("hex").slice(0, 12);
	const projectId = idOf(realpathSync(project));
	// A file that names the project's board on the scratch row as well: every card route would clear the project.
	writeFileSync(
		join(stateHome, "workspaces.json"),
		JSON.stringify({
			version: 1,
			workspaces: [
				{ id: projectId, folder: realpathSync(project), name: "project", openedAt: 1 },
				{ id: projectId, folder: scratch, name: "scratch", openedAt: 0 },
			],
			defaults: {},
		}),
	);
	const daemon = await boot(stateHome);
	try {
		const rows = JSON.parse((await get(daemon, `/workspaces?token=${daemon.token}`)).body).workspaces;
		assert.equal(rows[0].scratch, true);
		assert.notEqual(rows[0].id, projectId, "the scratch row kept an id that belongs to another folder");
		assert.equal(rows[0].id, idOf(scratch));

		assert.equal((await postTo(daemon, projectId, "/card/note", { markdown: "a project's work", key: "p1" })).status, 200);
		assert.equal((await post(daemon, "/scratch/empty")).status, 200);
		const kept = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${projectId}`)).body);
		assert.equal(kept.cards.length, 1, "the press emptied a board that was not the scratch one");
	} finally {
		daemon.child.kill();
		for (const gone of [stateHome, project]) rmSync(gone, { recursive: true, force: true });
	}
});

test("a command still running when the scratch row is emptied writes nothing back", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-scratch-late-"));
	const daemon = await boot(stateHome);
	const scratch = join(stateHome, "scratch");
	try {
		const board = JSON.parse((await get(daemon, `/workspaces?token=${daemon.token}`)).body).workspaces[0].id;
		// The line a human would type in the composer: it writes its file half a second from now.
		const running = postTo(daemon, board, "/shell", { command: "sleep 0.5; printf late > late.txt" });
		await new Promise((done) => setTimeout(done, 120));
		assert.equal((await post(daemon, "/scratch/empty")).status, 200);
		await running;
		// Long enough that the command would have finished and put its note on the board.
		await new Promise((done) => setTimeout(done, 900));
		assert.equal(existsSync(join(scratch, "late.txt")), false, "a killed command wrote its file back");
		const state = JSON.parse((await get(daemon, `/state?token=${daemon.token}&workspace=${board}`)).body);
		assert.deepEqual(state.cards, [], "a killed command put its note back on the emptied board");
	} finally {
		daemon.child.kill();
		rmSync(stateHome, { recursive: true, force: true });
	}
});

// ---------- the session cookie -----------------------------------------------

/** Trades the printed link for a cookie, the way a browser does, and hands back its `name=value` pair. */
async function signIn(daemon: Daemon, search = "") {
	const res = await fetch(`${daemon.base}/?token=${daemon.token}${search}`, { redirect: "manual" });
	const set = res.headers.get("set-cookie") ?? "";
	return { res, set, cookie: set.split(";")[0] };
}
const asCookie = (cookie: string, init: RequestInit = {}) => ({ ...init, headers: { cookie, ...(init.headers as object) } });
/**
 * A POST built by hand, because `fetch` will not write `Host` and the guard reads it beside `Origin`. The
 * socket still reaches this machine; the headers are the claim a browser on the network makes.
 */
function rawPost(daemon: Daemon, path: string, headers: Record<string, string>) {
	const target = new URL(daemon.base);
	return new Promise<number>((resolve, reject) => {
		const sent = request({ host: target.hostname, port: target.port, path, method: "POST", headers }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		sent.on("error", reject);
		sent.end();
	});
}

test("the link pi prints is traded for a session cookie, and the cookie alone opens the data routes", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-cookie-"));
	const daemon = await boot(state);
	try {
		const { res, set, cookie } = await signIn(daemon, "&workspace=abc123def");
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), "/?workspace=abc123def");
		assert.equal(res.headers.get("cache-control"), "no-store");
		assert.equal(res.headers.get("referrer-policy"), "no-referrer");
		assert.match(set, /^pi-studio-[0-9a-f]{8}=[0-9a-f]{32}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
		assert.ok(!daemon.token.includes(cookie.split("=")[1]), "the session id is not the token");
		// The state file keeps a hash, not the id the browser holds.
		const saved = readFileSync(join(state, "sessions.json"), "utf8");
		assert.ok(!saved.includes(cookie.split("=")[1]));

		assert.equal((await get(daemon, "/workspaces", asCookie(cookie))).status, 200);
		// The token still works unchanged, and a board path is traded the same way.
		assert.equal((await get(daemon, `/workspaces?token=${daemon.token}`)).status, 200);
		const board = await fetch(`${daemon.base}/w/abcdef12/?token=${daemon.token}`, { redirect: "manual" });
		assert.equal(board.status, 303);
		assert.equal(board.headers.get("location"), "/w/abcdef12");
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});

test("no credential, a wrong token and a master token in a cookie are all refused, and a wrong token earns no cookie", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-cookie-"));
	const daemon = await boot(state);
	try {
		assert.equal((await get(daemon, "/workspaces")).status, 403);
		const wrong = await fetch(`${daemon.base}/?token=${"0".repeat(32)}`, { redirect: "manual" });
		assert.equal(wrong.status, 200);
		assert.equal(wrong.headers.get("set-cookie"), null);
		// A wrong token does not fall back to a good cookie.
		const { cookie } = await signIn(daemon);
		assert.equal((await get(daemon, `/workspaces?token=${"0".repeat(32)}`, asCookie(cookie))).status, 403);
		// An empty one does.
		assert.equal((await get(daemon, "/workspaces?token=", asCookie(cookie))).status, 200);
		// The cookie holds a session id, so the master token in its place is only a stranger.
		const name = cookie.split("=")[0];
		assert.equal((await get(daemon, "/workspaces", asCookie(`${name}=${daemon.token}`))).status, 403);
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});

test("a change made on a cookie has to come from this origin, and a token needs no such word", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-cookie-"));
	const daemon = await boot(state);
	try {
		const { cookie } = await signIn(daemon);
		// An address the daemon would answer on when it is bound beyond this machine. Nothing there is https,
		// so a browser sends no `Sec-Fetch-Site` at all and `Origin` is the only word it has.
		const host = "192.168.1.5:5173";
		const send = (headers: Record<string, string>) => rawPost(daemon, "/defaults", { cookie, host, ...headers });
		assert.equal(await send({ "sec-fetch-site": "same-origin" }), 200);
		assert.equal(await send({ "sec-fetch-site": "cross-site" }), 403);
		// The plain-http LAN case: no `Sec-Fetch-*` header, and an `Origin` whose host and port are the `Host`.
		assert.equal(await send({ origin: `http://${host}` }), 200);
		assert.equal(await send({ origin: "http://192.168.1.6:5173" }), 403);
		// A form from another site sends no `Origin`, and a sandboxed frame sends the string `null`.
		assert.equal(await send({}), 403);
		assert.equal(await send({ origin: "null" }), 403);
		// A token is written into the request, which no other site can do, so it needs neither header.
		assert.equal((await post(daemon, "/defaults")).status, 200);
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});

test("a session ends at logout, and Secure rides only behind a TLS proxy", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-cookie-"));
	const daemon = await boot(state);
	try {
		const proxied = await fetch(`${daemon.base}/?token=${daemon.token}`, { redirect: "manual", headers: { "x-forwarded-proto": "https" } });
		assert.match(proxied.headers.get("set-cookie") ?? "", /; Secure$/);
		const { cookie, set } = await signIn(daemon);
		assert.ok(!/Secure/.test(set));
		const out = await fetch(`${daemon.base}/logout`, { method: "POST", headers: { cookie, "sec-fetch-site": "same-origin" } });
		assert.equal(out.status, 200);
		assert.match(out.headers.get("set-cookie") ?? "", new RegExp(`^${cookie.split("=")[0]}=; .*Max-Age=0`));
		assert.equal((await get(daemon, "/workspaces", asCookie(cookie))).status, 403);
		// The other session lives on.
		const other = proxied.headers.get("set-cookie")!.split(";")[0];
		assert.equal((await get(daemon, "/workspaces", asCookie(other))).status, 200);
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});

test("an expired session stays refused after a restart, and a changed token drops every session", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-cookie-"));
	let daemon = await boot(state);
	try {
		const { cookie } = await signIn(daemon);
		daemon.child.kill();
		const file = join(state, "sessions.json");
		const kept = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(Object.keys(kept.sessions).length, 1);
		// Still running after a restart…
		daemon = await boot(state);
		assert.equal((await get(daemon, "/workspaces", asCookie(cookie))).status, 200);
		daemon.child.kill();
		// …and gone once its time has passed.
		const expired = { ...kept, sessions: { [Object.keys(kept.sessions)[0]]: Date.now() - 1000 } };
		writeFileSync(file, JSON.stringify(expired));
		daemon = await boot(state);
		assert.equal((await get(daemon, "/workspaces", asCookie(cookie))).status, 403);
		// A load prunes in memory and writes nothing, so the spent session is still in the file it was read
		// from; the first create or logout after it is what clears the file out.
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).sessions, expired.sessions);
		await signIn(daemon);
		const keptNow = JSON.parse(readFileSync(file, "utf8")).sessions;
		assert.equal(Object.keys(keptNow).length, 1);
		assert.equal(keptNow[Object.keys(expired.sessions)[0]], undefined);
		// Another token owns none of what the file holds.
		daemon.child.kill();
		const foreign = { owner: "0".repeat(16), sessions: { [Object.keys(kept.sessions)[0]]: Date.now() + 1e9 } };
		writeFileSync(file, JSON.stringify(foreign));
		daemon = await boot(state);
		assert.equal((await get(daemon, "/workspaces", asCookie(cookie))).status, 403);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).sessions, foreign.sessions);
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});

test("the store keeps at most 32 sessions, and the oldest is the one that goes", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-cookie-"));
	const daemon = await boot(state);
	try {
		// One sign-in is one session, and each answer carries the cookie for its own.
		const cookies: string[] = [];
		for (let made = 0; made < 33; made++) cookies.push((await signIn(daemon)).cookie);
		const kept = JSON.parse(readFileSync(join(state, "sessions.json"), "utf8")).sessions;
		assert.equal(Object.keys(kept).length, 32, "the store grew past its cap");
		// The cookie made one past the cap is the oldest that survives, and the newest signs in beside it.
		assert.equal((await get(daemon, "/workspaces", asCookie(cookies[0]))).status, 403);
		assert.equal((await get(daemon, "/workspaces", asCookie(cookies[1]))).status, 200);
		assert.equal((await get(daemon, "/workspaces", asCookie(cookies[32]))).status, 200);
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});

test("a thread's token opens no session from the page", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-cookie-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-cookie-work-"));
	const stub = stubPi(mkdtempSync(join(tmpdir(), "pi-studio-stub-pi-")));
	const daemon = await boot(state, { PI_MANAGED_INSTALL_ROOT: stub.root, PI_STUDIO_NAME_MODEL: "" });
	try {
		const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
		const threadId = JSON.parse((await postTo(daemon, board.id, "/thread", {})).body).threadId;
		assert.equal((await postTo(daemon, board.id, "/message", { cardId: threadId, text: "say one thing" })).status, 200);
		const child = await childEnvOf(daemon, stub.envFile);
		// The page is served, as it is to anyone who carries no credential, and nothing comes back with it:
		// only the human's own token is traded for a session.
		const page = await fetch(`${daemon.base}/?token=${child.token}`, { redirect: "manual" });
		assert.equal(page.status, 200);
		assert.equal(page.headers.get("set-cookie"), null);
		assert.equal(page.headers.get("location"), null);
	} finally {
		daemon.child.kill();
		for (const gone of [state, folder, stub.root]) rmSync(gone, { recursive: true, force: true });
	}
});

test("logout cannot be forged, because a cookie carries no word of its own origin with it", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-cookie-"));
	const daemon = await boot(state);
	try {
		const { cookie } = await signIn(daemon);
		// The shape a form on another site posts: neither `Sec-Fetch-Site` nor `Origin`. Logout changes state
		// on the strength of a cookie, so the same-origin rule decides it like any other POST.
		assert.equal(await rawPost(daemon, "/logout", { cookie }), 403);
		// The refusal ends nothing.
		assert.equal((await get(daemon, "/workspaces", asCookie(cookie))).status, 200);
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});

test("the redirect after a sign-in stays a path on this daemon", async () => {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-cookie-"));
	const daemon = await boot(state);
	try {
		// The query is carried over as it arrived, so what it holds cannot steer the browser at another host:
		// the answer is this page's own path, and the `//` in the query is a value, not a host.
		const res = await fetch(`${daemon.base}/?token=${daemon.token}&next=//evil.com`, { redirect: "manual" });
		assert.equal(res.status, 303);
		const location = res.headers.get("location") ?? "";
		assert.equal(location, "/?next=%2F%2Fevil.com");
		assert.ok(location.startsWith("/") && !location.startsWith("//"), `the redirect left this daemon: ${location}`);
		// Resolved the way a browser resolves it, it lands on this daemon.
		assert.equal(new URL(location, daemon.base).origin, daemon.base);
	} finally {
		daemon.child.kill();
		rmSync(state, { recursive: true, force: true });
	}
});
