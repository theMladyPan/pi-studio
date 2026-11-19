#!/usr/bin/env node
// An end-to-end check of the built plugin against a real repository, with this file playing the daemon.
//
// The Go tests check the history and the patches; this one checks the thing they cannot: the program the
// daemon would spawn, on the pipes it would use, speaking the lines the daemon writes. It is a script and
// not a `node --test` file on purpose: it needs a built binary and a git repository, so it runs when
// someone asks for it, not on every test run of the daemon.
//
//   go build -o git-history .         # in plugins/git-history
//   node scripts/e2e.mjs              # or: node scripts/e2e.mjs /path/to/git-history
//
// It exits 0 when every check passed and 1 with the failing check named.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binary = resolve(process.argv[2] || join(here, "..", "git-history"));
const root = mkdtempSync(join(tmpdir(), "git-history-e2e-"));
let passed = 0;

function check(name, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(`ok   ${name}`);
		return;
	}
	console.log(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	throw new Error(name);
}

function git(folder, args) {
	return execFileSync("git", args, {
		cwd: folder,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "End To End",
			GIT_AUTHOR_EMAIL: "e2e@example.com",
			GIT_AUTHOR_DATE: "2024-02-03T04:05:06+00:00",
			GIT_COMMITTER_NAME: "End To End",
			GIT_COMMITTER_EMAIL: "e2e@example.com",
			GIT_COMMITTER_DATE: "2024-02-03T04:05:06+00:00",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	}).trim();
}

/** A repository with a branch that was merged, a file changed, and a tag on the merge. */
function mergedRepo(name) {
	const folder = join(root, name);
	mkdirSync(folder, { recursive: true });
	git(folder, ["init", "-q", "-b", "main"]);
	writeFileSync(join(folder, "a.txt"), "one\n");
	git(folder, ["add", "--", "a.txt"]);
	git(folder, ["commit", "-q", "-m", "first on main"]);
	git(folder, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(folder, "b.txt"), "feature\n");
	git(folder, ["add", "--", "b.txt"]);
	git(folder, ["commit", "-q", "-m", "work on the feature"]);
	git(folder, ["checkout", "-q", "main"]);
	writeFileSync(join(folder, "a.txt"), "one\ntwo\n");
	git(folder, ["add", "--", "a.txt"]);
	git(folder, ["commit", "-q", "-m", "second on main"]);
	git(folder, ["merge", "-q", "--no-ff", "--no-edit", "feature"]);
	git(folder, ["tag", "-a", "v1.0.0", "-m", "the first release"]);
	return folder;
}

/** A repository with no commit at all. */
function emptyRepo(name) {
	const folder = join(root, name);
	mkdirSync(folder, { recursive: true });
	git(folder, ["init", "-q", "-b", "main"]);
	return folder;
}

/** One running plugin, with this file as the daemon on the other end of its pipes. */
class Host {
	constructor(child, workspace) {
		this.child = child;
		this.workspace = workspace;
		this.pending = new Map();
		this.nextId = 0;
		this.held = [];
		this.hold = false;
		createInterface({ input: child.stdout }).on("line", (line) => this.read(line));
	}

	read(line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			throw new Error(`the plugin wrote a line that is not JSON: ${line}`);
		}
		if (typeof message.method === "string") {
			void this.answer(message);
			return;
		}
		const waiter = this.pending.get(message.id);
		if (!waiter) return;
		this.pending.delete(message.id);
		if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
		else waiter.resolve(message.result);
	}

	/** answer is this daemon's side: the two workspace methods, or a refusal. */
	async answer(call) {
		if (this.hold && call.method === "workspace.list") {
			this.held.push(call);
			if (this.held.length < 2) return;
			for (const waiting of this.held.splice(0)) this.reply(waiting, this.workspaceList());
			return;
		}
		if (call.method === "workspace.list") return this.reply(call, this.workspaceList());
		if (call.method === "workspace.read") {
			return this.reply(call, {
				workspace: this.workspace,
				open: true,
				cards: [{ id: "card-1" }, { id: "card-2" }],
			});
		}
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `${call.method} is not a method this daemon answers` } })}\n`);
	}

	workspaceList() {
		return { workspaces: [this.workspace] };
	}

	reply(call, result) {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: call.id, result })}\n`);
	}

	/** request asks the plugin something and waits for its answer. */
	request(method, params) {
		this.nextId += 1;
		const id = this.nextId;
		const frame = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`the plugin did not answer ${method} in time`));
			}, 30_000);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.child.stdin.write(`${JSON.stringify(frame)}\n`);
		});
	}

	/** start begins a call without waiting for it, so two of them can be in flight at once. */
	start(method, params) {
		return this.request(method, params);
	}

	notify(method) {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
	}
}

/** startPlugin spawns the built program and finishes its handshake, as the daemon's host does. */
async function startPlugin(workspace) {
	const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
	const host = new Host(child, workspace);
	const info = await host.request("initialize", { protocolVersion: 1, plugin: "git-history", client: { name: "pi-studio" } });
	return { child, host, info };
}

async function main() {
	const merged = mergedRepo("merged");
	const empty = emptyRepo("empty");
	let child = null;
	try {
		// ---------- the handshake ----------
		const started = await startPlugin({ id: "w1", name: "merged", folder: merged, missing: false, scratch: false });
		child = started.child;
		const host = started.host;
		check("initialize answers protocol 1", started.info.protocolVersion === 1, started.info);
		check("initialize names the plugin", started.info.name === "git-history", started.info);
		check("initialize names a version", typeof started.info.version === "string" && started.info.version !== "", started.info);

		// ---------- the header ----------
		const summary = await host.request("visual.request", { workspace: "w1", method: "summary", params: {} });
		check("summary names the workspace", summary.workspace.name === "merged", summary.workspace);
		check("summary read the board", summary.open === true && summary.cards === 2, summary);
		check("summary names the branch", summary.repo.branch === "main" && summary.repo.detached === false, summary.repo);
		check("summary counts the branches", summary.repo.branches === 2, summary.repo);
		check("summary counts the tag", summary.repo.tags === 1, summary.repo);

		// ---------- a page of the graph ----------
		const graph = await host.request("visual.request", { workspace: "w1", method: "history", params: { limit: 10 } });
		check("history draws every commit", graph.rows.length === 4, graph.rows.map((row) => row.subject));
		check("the merge is the newest row", graph.rows[0].parents.length === 2, graph.rows[0]);
		check("the merge carries the tag", graph.rows[0].refs.some((ref) => ref.kind === "tag" && ref.name === "v1.0.0"), graph.rows[0].refs);
		check("a forked line is drawn", graph.rows.some((row) => row.edges.some((edge) => edge.kind === "fork")), graph.rows.map((row) => row.edges));
		check("the two lines meet again", graph.rows.some((row) => row.edges.some((edge) => edge.kind === "merge")), graph.rows.map((row) => row.edges));
		check("the graph needs two lanes", graph.laneCount === 2, graph.laneCount);
		check("every edge stays inside the drawn columns", graph.rows.every((row) => row.edges.every((edge) => edge.from < row.cols && edge.to < row.cols)), graph.rows);
		check("the newest row is the one HEAD points at", graph.rows[0].head === true && graph.rows[0].sha === summary.repo.head, graph.rows[0].sha);
		check("the whole history is counted", graph.page.total === 4, graph.page);

		// ---------- paging ----------
		const firstPage = await host.request("visual.request", { workspace: "w1", method: "history", params: { offset: 0, limit: 2 } });
		check("a small page holds what it asked for", firstPage.rows.length === 2, firstPage.rows.length);
		check("a small page offers the next one", firstPage.page.hasMore === true && firstPage.page.next === 2, firstPage.page);
		const secondPage = await host.request("visual.request", { workspace: "w1", method: "history", params: { offset: 2, limit: 2 } });
		check("the next page continues the history", secondPage.rows.length === 2 && secondPage.rows[0].sha !== firstPage.rows[0].sha, secondPage.rows.map((row) => row.sha));
		const outOfRange = await host.request("visual.request", { workspace: "w1", method: "history", params: { offset: 500, limit: 10 } });
		check("an offset past the history is empty", outOfRange.rows.length === 0 && outOfRange.page.hasMore === false, outOfRange.page);

		// ---------- one commit and one patch ----------
		const mergeSha = graph.rows[0].sha;
		const detail = await host.request("visual.request", { workspace: "w1", method: "commit", params: { sha: mergeSha.slice(0, 8) } });
		check("a short sha finds its commit", detail.sha === mergeSha, detail.sha);
		check("the merge says it is one", detail.merge === true && detail.parents.length === 2, detail);
		check("the merge lists the file it brought in", detail.files.some((file) => file.path === "b.txt"), detail.files);
		const diff = await host.request("visual.request", { workspace: "w1", method: "diff", params: { sha: mergeSha, path: "b.txt" } });
		check("the patch is read against the first parent", diff.parent === detail.parents[0], diff.parent);
		check("the patch adds the line of the file", diff.added === 1 && diff.patch.includes("+feature"), diff);

		// ---------- refusals ----------
		let refused = null;
		try {
			await host.request("visual.request", { workspace: "nope", method: "history", params: {} });
		} catch (error) {
			refused = error.message;
		}
		check("a workspace the daemon does not know is refused", refused !== null && refused.includes("not a workspace"), refused);
		refused = null;
		try {
			await host.request("visual.request", { workspace: "w1", method: "paint", params: {} });
		} catch (error) {
			refused = error.message;
		}
		check("an unknown visual method is refused", refused !== null && refused.includes("is not a method"), refused);

		// ---------- two calls at once ----------
		// The daemon holds both workspace answers until both calls have arrived. A plugin that answered one
		// request to the end before reading the next would sit here until its deadline.
		host.hold = true;
		const both = await Promise.all([
			host.start("visual.request", { workspace: "w1", method: "history", params: { limit: 1 } }),
			host.start("visual.request", { workspace: "w1", method: "history", params: { offset: 1, limit: 1 } }),
		]);
		host.hold = false;
		check("two requests are served at once", both.every((answer) => answer.rows.length === 1), both.map((answer) => answer.rows.length));

		// ---------- a repository with no commits ----------
		const emptyStarted = await startPlugin({ id: "w2", name: "empty", folder: empty, missing: false, scratch: false });
		await emptyStarted.host.request("initialize", { protocolVersion: 1 });
		const emptyGraph = await emptyStarted.host.request("visual.request", { workspace: "w2", method: "history", params: {} });
		check("an empty repository draws no rows", emptyGraph.rows.length === 0, emptyGraph.rows);
		check("an empty repository knows it is empty", emptyGraph.repo.unborn === true && emptyGraph.repo.branch === "main", emptyGraph.repo);
		check("an empty repository has no next page", emptyGraph.page.hasMore === false, emptyGraph.page);
		emptyStarted.host.notify("shutdown");
		await new Promise((done) => emptyStarted.child.once("exit", done));

		// ---------- going away ----------
		host.notify("shutdown");
		const code = await new Promise((done) => child.once("exit", (code) => done(code)));
		check("the plugin stops when the daemon says shutdown", code === 0, code);
		child = null;
		console.log(`\n${passed} checks passed against ${binary}`);
	} finally {
		if (child) child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`\n${error.message}`);
	process.exitCode = 1;
});
