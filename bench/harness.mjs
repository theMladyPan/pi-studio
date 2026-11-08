// Measures the OLD pi-studio code (/tmp/bench/old) against the reconstruction in /tmp/bench/repro.
// Everything it writes is under /tmp/bench.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

const REPRO = process.env.REPRO ?? "/tmp/bench/repro";
const REPO = `${REPRO}/doc-compliance`;
const mode = process.argv[2] ?? "list";
process.env.PI_STUDIO_STATE = process.argv[3] ?? `${REPRO}/stateA`;
const BOARD_ID = "67782bd1546f";

const OLD = process.env.OLD ?? "/tmp/bench/old";
const lifecycle = await import(`${OLD}/server/routes/board/lifecycle.ts`);
const fragments = await import(`${OLD}/server/worktrees/fragments.ts`);
const retire = await import(`${OLD}/server/worktrees/retire.ts`);
const store = await import(`${OLD}/server/store.ts`);

const now = () => Number(process.hrtime.bigint()) / 1e6;
const r1 = (v) => Math.round(v * 10) / 10;
const log = (k, v, unit = "ms") => console.log(`${k}: ${typeof v === "number" ? r1(v) : v}${typeof v === "number" ? unit : ""}`);

function fakeRes() {
	const res = { status: 0, body: "", bytes: 0, writeHead(s) { res.status = s; }, end(b) { res.body = String(b ?? ""); res.bytes = res.body.length; } };
	return res;
}
function fakeClient() {
	return { writableEnded: false, destroyed: false, bytes: 0, frames: 0, write(frame) { this.bytes += frame.length; this.frames += 1; return true; } };
}
const jsonRequest = (body) => Readable.from([Buffer.from(JSON.stringify(body))]);

function loadBoard() {
	const saved = JSON.parse(readFileSync(join(process.env.PI_STUDIO_STATE, "boards", `${BOARD_ID}.json`), "utf8"));
	const board = {
		id: BOARD_ID, folder: REPO, name: "repro",
		threads: new Map(), cards: new Map(), askers: new Map(), children: new Map(),
		clients: new Set(), activity: saved.activity.slice(-300), trees: saved.trees.slice(), trash: [], saveTimer: null,
		config: saved.config,
	};
	for (const raw of saved.threads) { const t = store.restoredThread(raw, REPO); if (t) board.threads.set(t.id, t); }
	for (const raw of saved.cards) { const c = store.restoredPlainCard(raw); if (c) board.cards.set(c.id, c); }
	for (const thread of board.threads.values()) {
		const held = thread.worktree?.path ? board.trees.find((tree) => tree.path === thread.worktree.path) : null;
		if (held) thread.worktree = held;
	}
	return board;
}

// Every git call in this code is spawnSync, so the event loop stops while one runs. A 2 ms timer reports
// that stall on its first tick after the block; the 4 ms sleep below is the floor of the figure.
let gap = 0;
let last = now();
let armed = false;
setInterval(() => { const t = now(); if (armed) gap = Math.max(gap, t - last); last = t; }, 2).unref();
const sleep = (n) => new Promise((r) => setTimeout(r, n));

async function probe(fn) {
	await sleep(6);
	gap = 0; last = now(); armed = true;
	const t = now();
	const out = await fn();
	const took = now() - t;
	const before = gap;
	await sleep(4);
	armed = false;
	return { took, gap: Math.max(before, gap) };
}
const phase = (name) => { if (process.env.GITLOG) appendFileSync(process.env.GITLOG, `# PHASE ${name}\n`); };
const finish = (extra = {}) => { console.log(JSON.stringify(extra)); process.exit(0); };
const tree = (hex) => join(REPO, ".agents", hex);

if (mode === "list") {
	const board = loadBoard();
	const cold = await probe(() => lifecycle.onFragments(jsonRequest({}), (globalThis.__r = fakeRes()), board));
	const items = JSON.parse(globalThis.__r.body).items;
	log("onFragments cold (first call, page cache empty)", cold.took); log("  its freeze", cold.gap);
	const warm = [];
	for (let i = 0; i < 3; i++) {
		const res = fakeRes();
		const p = await probe(() => lifecycle.onFragments(jsonRequest({}), res, board));
		warm.push(p.took);
	}
	warm.sort((a, b) => a - b);
	log("onFragments warm median of 3", warm[1]); log("  its freeze", cold.gap);
	console.log("items", items.length, "kinds", JSON.stringify(items.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {})));
	log("answer bytes", globalThis.__r.bytes, " B");
	finish();
}

if (mode === "scale") {
	const rows = [];
	const full = loadBoard();
	for (const k of [1, 3, 6, 9, 13, 16]) {
		const board = loadBoard();
		board.trees = full.trees.slice(0, k);
		await probe(() => lifecycle.onFragments(jsonRequest({}), fakeRes(), board));
		const times = [];
		let n = 0;
		for (let i = 0; i < 3; i++) {
			const res = fakeRes();
			const p = await probe(() => lifecycle.onFragments(jsonRequest({}), res, board));
			times.push(p.took);
			n = JSON.parse(res.body).items.length;
		}
		times.sort((a, b) => a - b);
		rows.push({ trees: k, items: n, ms: r1(times[1]) });
	}
	console.log(JSON.stringify(rows));
	finish();
}

if (mode === "remove") {
	const stepHex = process.argv[4];
	const routeHex = process.argv[5];
	const board = loadBoard();
	const client = fakeClient();
	board.clients = new Set([client]);
	const branchOf = (hex) => board.trees.find((x) => x.path === tree(hex))?.branch ?? "";

	// The route's own steps, in the order removeFragment runs them, each timed on its own folder.
	await sleep(10);
	// One listing first, unmeasured: `git status` in a worktree whose index a fresh checkout has just made
	// stale re-reads every file, and the human's leftovers are not fresh checkouts.
	fragments.fragmentsOf(board);
	phase(`remove-steps-${stepHex}`);
	const listing = await probe(() => fragments.fragmentsOf(board));
	log("i   the listing the press redoes (fragmentsOf)", listing.took); log("  its freeze", listing.gap);
	const item = fragments.fragmentsOf(board).find((c) => c.path === tree(stepHex));
	if (!item) { console.log("no such fragment", stepHex); process.exit(1); }
	const record = board.trees.find((held) => retire.sameFolder(held.path, item.path)) ?? { path: item.path, branch: item.branch ?? "", repo: REPO };
	phase(`delete-tree-${stepHex}`);
	const treeStep = await probe(() => retire.discardTree(board, record));
	log("ii  folder deletion (discardTree -> git worktree remove --force)", treeStep.took); log("  its freeze", treeStep.gap);
	phase(`delete-branch-${stepHex}`);
	const branchStep = await probe(() => retire.discardBranch(REPO, item.branch));
	log("iii branch deletion (discardBranch -> git update-ref -d)", branchStep.took); log("  its freeze", branchStep.gap);
	console.log("steps", JSON.stringify({ tree: treeStep.took && recordOut(treeStep), branch: branchStep.took && "ok" }));
	function recordOut() { return "see freeze"; }

	// The whole route on a second folder of the same class, with one tab listening.
	phase(`route-${routeHex}`);
	const res = fakeRes();
	const route = await probe(() => lifecycle.onFragmentRemove(jsonRequest({ kind: "tree", path: tree(routeHex), branch: branchOf(routeHex) }), res, board));
	log("onFragmentRemove end to end (other folder, one tab attached)", route.took); log("  its freeze", route.gap);
	console.log("answer bytes", res.bytes, "snapshot pushed to the tab", client.bytes, "B in", client.frames, "frames");
	phase("save");
	const save = await probe(() => store.flushBoard(board));
	log("the board file the press schedules (flushBoard, 1.1 MB)", save.took); log("  its freeze", save.gap);
	finish();
}

if (mode === "sweep") {
	const board = loadBoard();
	const only = (process.argv[4] ?? "").split(",").filter(Boolean);
	const trees = board.trees.slice().filter((t) => !only.length || only.includes(t.path.split("/").pop()));
	const per = [];
	let total = 0;
	let freeze = 0;
	for (const one of trees) {
		phase(`tree-${one.path.split("/").pop()}`);
		const p = await probe(() => retire.retireWorktree(board, one));
		total += p.took;
		freeze = Math.max(freeze, p.gap);
		per.push({ folder: one.path.split("/").pop(), ms: r1(p.took), gap: r1(p.gap) });
	}
	log("retireWorktree over every tree on the board, summed", total);
	log("worst single folder freeze", freeze);
	console.log("per folder:", JSON.stringify(per));
	const out = [];
	for (const one of per) out.push(one.folder);
	// Which folders were left standing, and why, from a second pass over what is still there.
	const kept = fragments.fragmentsOf(board).filter((i) => i.kind === "tree" || i.kind === "orphan");
	console.log("still on the disk afterwards:", kept.length, JSON.stringify(kept.map((i) => [i.path.split("/").pop(), i.note])));
	finish();
}

if (mode === "sweeproute") {
	const board = loadBoard();
	const client = fakeClient();
	board.clients = new Set([client]);
	phase("onCleanClosed");
	const res = fakeRes();
	const p = await probe(() => lifecycle.onCleanClosed(jsonRequest({}), res, board));
	log("onCleanClosed end to end", p.took); log("  its freeze", p.gap);
	const result = JSON.parse(res.body);
	console.log("removed", result.removed.length, "kept", result.kept.length, "answer bytes", res.bytes, "snapshot bytes", client.bytes);
	console.log(JSON.stringify(result.kept.map((k) => [k.path.split("/").pop(), k.reason])));
	finish();
}

if (mode === "resync") {
	const bus = await import(`${OLD}/server/bus.ts`);
	const board = loadBoard();
	const client = fakeClient();
	board.clients = new Set([client]);
	await probe(() => bus.resync(board));
	phase("resync");
	const p = await probe(() => bus.resync(board));
	log("resync(board) with one tab attached (snapshot + refreshGit over every folder)", p.took);
	log("  its freeze", p.gap);
	console.log("snapshot bytes", client.bytes, "frames", client.frames);
	finish();
}

if (mode === "open") {
	const workspaces = await import(`${OLD}/server/workspaces.ts`);
	await sleep(10);
	gap = 0; last = now(); armed = true;
	const t0 = now();
	const board = store.boardFor(workspaces.workspaceById(BOARD_ID));
	const load = now() - t0;
	setImmediate(() => setImmediate(async () => {
		const total = now() - t0;
		const before = gap;
		await sleep(4);
		armed = false;
		phase("open-done");
		log("boardFor() handed the board back", load);
		log("boardFor() up to the end of its queued startup sweep", total);
		log("  the freeze", Math.max(before, gap));
		console.log("trees left on the board", board.trees.length);
		finish();
	}));
}
