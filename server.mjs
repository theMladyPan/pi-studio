/**
 * pi-studio — a local daemon that owns pi agents.
 *
 * Two surfaces. `/` is the crossroads: the workspaces that exist, a preview of one, and a button that
 * opens it in a tab of its own. `/w/<id>` is that workspace's board: one card per thread, one
 * `pi --mode rpc` child behind each thread, and the composer inside the card being answered.
 *
 * A board tab closing is not an event: children belong to the daemon, so an agent keeps working and
 * the crossroads keeps reporting it as running.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
/**
 * Everything durable lives beside pi's own state under a folder named after the app: the token, the
 * workspaces the human has opened, one board file per workspace, and the pi sessions behind its
 * threads.
 */
const STATE_DIR = join(homedir(), ".pi", "agent", "state", "pi-studio");
const STATE_FILE = join(STATE_DIR, "daemon.json");
const WORKSPACES_FILE = join(STATE_DIR, "workspaces.json");
const PROVIDER = process.env.PI_STUDIO_PROVIDER ?? "klotilda";
const MODEL = process.env.PI_STUDIO_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const TOOLS = "read,bash,edit,write";
const MAX_BODY_BYTES = 1_000_000;
const MAX_ACTIVITY = 300;
const MAX_THREADS = 200;
const STATE_VERSION = 1;
const BROWSE_LIMIT = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Opening a browser is what a desktop app does; a service run asks for `--no-open`. */
const OPEN_BROWSER = !process.argv.includes("--no-open");

/**
 * One exchange with a thread. The card shows the words typed in and the answer once it lands.
 * @typedef {object} Turn
 * @property {string} text
 * @property {"queued"|"sent"|"answered"|"stopped"} status
 * @property {"queue"|"steer"} mode
 * @property {number} at
 * @property {string} [reply]
 */

/**
 * A thread is one card on a board and one child process on demand.
 * @typedef {object} Thread
 * @property {string} id
 * @property {string} title
 * @property {string|null} sessionId
 * @property {"idle"|"running"|"dead"} status
 * @property {string} provider
 * @property {string} model
 * @property {number} at
 * @property {Turn[]} turns
 * @property {string[]} queued
 * @property {{x:number,y:number,w:number,h:number}} [rect]
 * @property {boolean} [mini]
 * @property {number} [runStartedAt]
 * @property {string} [stderrTail]
 */

/**
 * A live board: the workspace it belongs to, what is on it, and who is watching.
 * @typedef {object} Board
 * @property {string} id
 * @property {string} folder
 * @property {string} name
 * @property {Map<string, Thread>} threads
 * @property {object[]} activity
 * @property {Map<string, import("node:child_process").ChildProcess>} children
 * @property {Set<import("node:http").ServerResponse>} clients
 * @property {NodeJS.Timeout|null} saveTimer
 */

// ---------- small filesystem helpers ---------------------------------------

/** Read a JSON file, or the fallback when it is missing, unreadable or not JSON at all. */
function readJsonFile(file, fallback) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

/** Write a JSON file whole, so a crash mid-write cannot leave half a board behind. */
function writeJsonFile(file, data) {
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		console.error(`pi-studio: could not write ${file}: ${error.message}`);
	}
}

/** The commit this copy of the app was started from, or "unknown" outside a checkout. */
function buildHash() {
	const root = dirname(fileURLToPath(import.meta.url));
	try {
		const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
		if (!head.startsWith("ref: ")) return head.slice(0, 7);
		return readFileSync(join(root, ".git", head.slice(5).trim()), "utf8").trim().slice(0, 7);
	} catch {
		return "unknown";
	}
}

function randomToken() {
	return createHash("sha256").update(`${process.pid}-${Date.now()}-${Math.random()}`).digest("hex").slice(0, 32);
}

/** A folder keeps its identity across restarts, which is what makes "continue" mean continue. */
function workspaceId(folder) {
	return createHash("sha256").update(folder).digest("hex").slice(0, 12);
}

// ---------- workspaces -----------------------------------------------------

/**
 * What the human has opened before. A workspace is a folder; its board lives in its own file, and
 * the pi sessions behind its threads are the app's own, referenced by id and never copied here.
 * @typedef {object} Workspace
 * @property {string} id
 * @property {string} folder
 * @property {string} name
 * @property {number} openedAt
 */

/** @type {Workspace[]} newest first, because that is the order the crossroads shows. */
const workspaces = (() => {
	const saved = readJsonFile(WORKSPACES_FILE, null);
	if (!saved || saved.version !== STATE_VERSION || !Array.isArray(saved.workspaces)) return [];
	return saved.workspaces
		.filter((workspace) => typeof workspace?.folder === "string" && workspace.folder)
		.map((workspace) => ({
			id: typeof workspace.id === "string" && workspace.id ? workspace.id : workspaceId(workspace.folder),
			folder: workspace.folder,
			name: typeof workspace.name === "string" && workspace.name ? workspace.name : basename(workspace.folder),
			openedAt: Number.isFinite(workspace.openedAt) ? workspace.openedAt : 0,
		}));
})();

function saveWorkspaces() {
	writeJsonFile(WORKSPACES_FILE, { version: STATE_VERSION, workspaces });
}

/** @type {Map<string, Board>} boards that this daemon has loaded, one per workspace. */
const boards = new Map();
/** Tabs sitting on the crossroads, so the counts there stay honest without a reload. */
const welcomeClients = new Set();

function boardFile(workspace) {
	return join(STATE_DIR, "boards", `${workspace.id}.json`);
}

function sessionDir(workspace) {
	return join(STATE_DIR, "sessions", workspace.id);
}

/** Everything a `Turn` needs and nothing that dies with the process. */
function savedTurn(turn) {
	return {
		text: turn.text,
		// A turn in flight when the daemon stopped is nobody's work now.
		status: turn.status === "answered" ? "answered" : "stopped",
		mode: turn.mode,
		at: turn.at,
		...(turn.reply ? { reply: turn.reply } : {}),
	};
}

/** Write one board: its threads, their turns, their layout and their session ids. */
function saveBoard(board) {
	const payload = {
		version: STATE_VERSION,
		workspace: { id: board.id, folder: board.folder, name: board.name },
		savedAt: Date.now(),
		activity: board.activity.slice(-MAX_ACTIVITY),
		threads: [...board.threads.values()].map((thread) => ({
			id: thread.id,
			title: thread.title,
			sessionId: thread.sessionId,
			provider: thread.provider,
			model: thread.model,
			at: thread.at,
			turns: thread.turns.map(savedTurn),
			...(thread.rect ? { rect: thread.rect } : {}),
			...(thread.mini ? { mini: true } : {}),
		})),
	};
	writeJsonFile(boardFile(board), payload);
}

/** A burst of turns and moves costs one write per board. */
function scheduleSave(board) {
	if (board.saveTimer) return;
	board.saveTimer = setTimeout(() => {
		board.saveTimer = null;
		saveBoard(board);
	}, 500);
	board.saveTimer.unref();
}

function flushBoard(board) {
	if (board.saveTimer) clearTimeout(board.saveTimer);
	board.saveTimer = null;
	saveBoard(board);
}

/** Rebuild a thread from its file, never as something that is still running. */
function restoredThread(raw, folder) {
	if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
	const turns = (Array.isArray(raw.turns) ? raw.turns : [])
		.filter((turn) => turn && typeof turn.text === "string")
		.map((turn) => ({
			text: String(turn.text),
			status: turn.status === "answered" ? "answered" : "stopped",
			mode: turn.mode === "steer" ? "steer" : "queue",
			at: Number.isFinite(turn.at) ? turn.at : Date.now(),
			...(typeof turn.reply === "string" ? { reply: turn.reply } : {}),
		}));
	const rect =
		raw.rect && Number.isFinite(raw.rect.x) && Number.isFinite(raw.rect.y) && raw.rect.w > 0 && raw.rect.h > 0
			? { x: raw.rect.x, y: raw.rect.y, w: raw.rect.w, h: raw.rect.h }
			: undefined;
	return {
		id: raw.id,
		title: typeof raw.title === "string" && raw.title ? raw.title : "thread",
		sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
		status: "idle",
		provider: typeof raw.provider === "string" ? raw.provider : PROVIDER,
		model: typeof raw.model === "string" ? raw.model : MODEL,
		at: Number.isFinite(raw.at) ? raw.at : Date.now(),
		turns,
		queued: [],
		...(rect ? { rect } : {}),
		...(raw.mini ? { mini: true } : {}),
		folder,
	};
}

/** Load a workspace's board into memory, or hand back the one already there. */
function boardFor(workspace) {
	const existing = boards.get(workspace.id);
	if (existing) {
		// A workspace that has simply been opened again keeps its place in the recent list.
		existing.folder = workspace.folder;
		existing.name = workspace.name;
		return existing;
	}
	/** @type {Board} */
	const board = {
		id: workspace.id,
		folder: workspace.folder,
		name: workspace.name,
		threads: new Map(),
		activity: [],
		children: new Map(),
		clients: new Set(),
		saveTimer: null,
	};
	const saved = readJsonFile(boardFile(workspace), null);
	if (saved && saved.version === STATE_VERSION && Array.isArray(saved.threads)) {
		for (const raw of saved.threads.slice(-MAX_THREADS)) {
			const thread = restoredThread(raw, workspace.folder);
			if (thread && !board.threads.has(thread.id)) board.threads.set(thread.id, thread);
		}
		for (const row of (Array.isArray(saved.activity) ? saved.activity : []).slice(-MAX_ACTIVITY)) {
			if (row && typeof row.id === "string" && row.status !== "running") board.activity.push(row);
		}
	}
	boards.set(board.id, board);
	return board;
}

/** Remember a folder the human opened, newest first. */
function rememberWorkspace(folder) {
	const resolved = realpathSync(folder);
	let workspace = workspaces.find((candidate) => candidate.folder === resolved);
	if (!workspace) {
		workspace = {
			id: workspaceId(resolved),
			folder: resolved,
			name: basename(resolved) || resolved,
			openedAt: Date.now(),
		};
		workspaces.unshift(workspace);
	} else {
		workspace.openedAt = Date.now();
		workspaces.sort((a, b) => b.openedAt - a.openedAt);
	}
	saveWorkspaces();
	return workspace;
}

function workspaceById(id) {
	return workspaces.find((workspace) => workspace.id === id);
}

// ---------- what the crossroads needs to know ------------------------------

/** A short, honest answer about a folder, cheap enough to run for every row. */
function folderFacts(folder) {
	if (!existsSync(folder) || !statSync(folder).isDirectory()) return { missing: true };
	return { missing: false };
}

/** Branch and dirty count, read from git when it is a repository. Never runs a long command. */
function gitFacts(folder) {
	const run = (args) => {
		try {
			const out = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", timeout: 1500 });
			return out.status === 0 ? out.stdout.trim() : "";
		} catch {
			return "";
		}
	};
	const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch) return null;
	const dirty = run(["status", "--porcelain"]);
	return { branch, modified: dirty ? dirty.split("\n").length : 0 };
}

/** How much of the app's own state a workspace holds: its sessions on disk. */
function sessionFacts(workspace) {
	const dir = sessionDir(workspace);
	let count = 0;
	let bytes = 0;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			count += 1;
			try {
				bytes += statSync(join(dir, entry.name)).size;
			} catch {
				// A file that vanished between the listing and the stat is not worth a failure.
			}
		}
	} catch {
		// No sessions yet is the normal state of a new workspace.
	}
	return { count, bytes };
}

/** The one workspace that matters to a tab: what is on it, and the last thing that happened. */
function describeWorkspace(workspace) {
	const board = boards.get(workspace.id);
	const threads = [...(board?.threads.values() ?? [])];
	const rows = board?.activity ?? readJsonFile(boardFile(workspace), null)?.activity ?? [];
	const last = [...rows].reverse().find((row) => row?.startedAt || row?.at);
	const facts = folderFacts(workspace.folder);
	return {
		...workspace,
		...facts,
		running: threads.filter((thread) => thread.status === "running").length,
		threads: threads
			.slice()
			.sort((a, b) => b.at - a.at)
			.slice(0, 6)
			.map((thread) => ({
				id: thread.id,
				title: thread.title,
				status: thread.status,
				turns: thread.turns.length,
				last: thread.turns[thread.turns.length - 1]?.at ?? thread.at,
			})),
		threadCount: threads.length || countSavedThreads(workspace),
		lastActivity: last ? { label: last.label || last.text || "activity", at: last.startedAt || last.at } : null,
		git: facts.missing ? null : gitFacts(workspace.folder),
		sessions: sessionFacts(workspace),
	};
}

function countSavedThreads(workspace) {
	const saved = readJsonFile(boardFile(workspace), null);
	return saved && Array.isArray(saved.threads) ? saved.threads.length : 0;
}

// ---------- the board the client draws -------------------------------------

/** A thread as the card the browser draws: a title, and the conversation under it. */
function cardFor(thread) {
	const answered = thread.turns.some((turn) => turn.status === "answered");
	const status =
		thread.status === "dead" ? "stopped" : thread.status === "running" ? "sent" : answered ? "answered" : "queued";
	const card = {
		id: thread.id,
		type: "sticky",
		title: thread.title,
		at: thread.at,
		// The conversation lives in the turns; the card's own `text` stays empty so no message is
		// invented for a thread nobody has typed into yet.
		text: "",
		status,
		mode: "queue",
		images: 0,
		turns: thread.turns.map((turn) => ({ ...turn })),
	};
	if (thread.rect) card.rect = thread.rect;
	if (thread.mini) card.mini = true;
	return card;
}

function boardMeta(board) {
	const working = [...board.threads.values()].filter((thread) => thread.status === "running");
	return {
		folder: board.name,
		cwd: board.folder,
		port,
		model: MODEL,
		tokensIn: 0,
		tokensOut: 0,
		cost: 0,
		// The client draws a board of threads: no bottom composer, a + that starts one, and the field
		// inside the card being answered.
		mode: "threads",
		workspace: { id: board.id, folder: board.folder, name: board.name },
		contextPercent: null,
		running: working.length > 0,
		runStartedAt: working.length ? Math.min(...working.map((thread) => thread.runStartedAt ?? thread.at)) : null,
	};
}

function send(target, payload) {
	const frame = `data: ${JSON.stringify(payload)}\n\n`;
	for (const client of target) {
		// A tab that closed is still in the set for a moment; writing to its dead socket would raise
		// an error nobody is listening for.
		if (client.writableEnded || client.destroyed) {
			target.delete(client);
			continue;
		}
		client.write(frame);
	}
}

function broadcast(board, payload) {
	send(board.clients, payload);
}

/** The crossroads shows counts, so it hears about every change that alters one. */
function nudgeWelcome() {
	if (!welcomeClients.size) return;
	send(welcomeClients, { type: "workspaces", workspaces: workspaces.map(describeWorkspace) });
}

const card = (board, thread) => {
	broadcast(board, { type: "card", card: cardFor(thread) });
	scheduleSave(board);
	nudgeWelcome();
};
const update = (board, thread) => {
	broadcast(board, { type: "update", card: cardFor(thread) });
	scheduleSave(board);
	nudgeWelcome();
};

function addRow(board, row) {
	board.activity.push(row);
	if (board.activity.length > MAX_ACTIVITY) board.activity.splice(0, board.activity.length - MAX_ACTIVITY);
	broadcast(board, { type: "activity", row });
}

function patchRow(board, id, patch) {
	const row = board.activity.find((candidate) => candidate.id === id);
	if (!row) return;
	Object.assign(row, patch);
	broadcast(board, { type: "activity", row });
}

/** Something the daemon cannot paper over: the card shows it as stopped and the console says why. */
function threadError(board, thread, message) {
	console.error(`pi-studio: ${board.name}/${thread.title}: ${message}`);
	thread.status = "dead";
	const last = thread.turns[thread.turns.length - 1];
	if (last && last.status !== "answered") last.status = "stopped";
	addRow(board, { id: randomUUID(), kind: "reply", status: "error", startedAt: Date.now(), text: message });
	update(board, thread);
	board.children.get(thread.id)?.stdin?.end();
}

// ---------- the child ------------------------------------------------------

/**
 * The CLI a child needs. Same order as the rest of the tooling: the script this process is already
 * running pi from, then the managed install, then the `pi` binary on PATH.
 */
function piCli() {
	const script = process.argv[1];
	if (script && existsSync(script) && (basename(script) === "pi" || script.includes("pi-coding-agent"))) {
		return { command: process.execPath, args: [script] };
	}
	const root = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
	try {
		const version = readFileSync(join(root, "current-version"), "utf8").trim();
		const cli = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		if (version && existsSync(cli)) return { command: process.execPath, args: [cli] };
	} catch {
		// No managed install here; PATH is the last resort.
	}
	return { command: "pi", args: [] };
}

/** The short text a rail row shows. Arguments stay out of it: the row is a signpost, not a log. */
function describeTool(name, args) {
	if (name === "read" || name === "write" || name === "edit") return `${name} ${String(args.path ?? args.file_path ?? "")}`.trim();
	if (name === "bash") {
		const command = String(args.command ?? "").replace(/\s+/g, " ");
		return `$ ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`;
	}
	if (name === "grep") return `grep ${String(args.pattern ?? "")}`;
	if (name === "find") return `find ${String(args.pattern ?? "*")}`;
	return name;
}

/** What a rail row says once the call is over: its first line of output, cut short. */
function firstLine(result) {
	const content = Array.isArray(result?.content) ? result.content : [];
	const text = content
		.filter((part) => part?.type === "text")
		.map((part) => String(part.text ?? ""))
		.join("\n");
	return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 140) ?? "";
}

function childArgv(board, thread) {
	// A child writes its session where pi-studio keeps them, not in pi's own session list: this app
	// owns these conversations, and a thread that already has one resumes it so the card stays
	// continuous across a daemon restart.
	const session = thread.sessionId ? ["--session", thread.sessionId] : [];
	return [
		"--mode",
		"rpc",
		"--session-dir",
		sessionDir(board),
		...session,
		"-ne",
		"--tools",
		TOOLS,
		"--provider",
		thread.provider,
		"--model",
		thread.model,
	];
}

/** The thread's child, started on first use. One child per thread, reused until it exits. */
function ensureChild(board, thread) {
	const existing = board.children.get(thread.id);
	if (existing && existing.exitCode === null && existing.stdin?.writable) return existing;
	const cli = piCli();
	const child = spawn(cli.command, [...cli.args, ...childArgv(board, thread)], {
		cwd: board.folder,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	board.children.set(thread.id, child);
	// A child that died between two messages turns the next write into EPIPE. That is a card error,
	// not a daemon crash.
	child.stdin.on("error", (error) => threadError(board, thread, `child stdin failed: ${error.message}`));
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) handleChildLine(board, thread, line);
	});
	// Stdout is protocol only; diagnostics arrive here. The tail is kept as well as logged, because a
	// child that dies at startup can say why in one line and the card should repeat it.
	child.stderr.on("data", (chunk) => {
		const text = String(chunk);
		thread.stderrTail = `${thread.stderrTail ?? ""}${text}`.slice(-1000);
		process.stderr.write(`[${board.name}/${thread.title}] ${text}`);
	});
	child.on("error", (error) => {
		board.children.delete(thread.id);
		threadError(board, thread, `child failed to start: ${error.message}`);
	});
	child.on("close", (code, signal) => {
		board.children.delete(thread.id);
		// An exit after `agent_settled` is the orderly shutdown this daemon asked for. An exit while a
		// run is live is the child dying mid-answer.
		if (thread.status !== "running") return;
		const reason = /no session found/i.test(thread.stderrTail ?? "")
			? "the pi session behind this thread is gone — start a new thread"
			: `child exited (${signal ?? code}) before it settled`;
		threadError(board, thread, reason);
	});
	// RPC mode emits no session header, so get_state is the only place a session id can come from.
	child.stdin.write(`${JSON.stringify({ id: "session", type: "get_state" })}\n`);
	return child;
}

/** One prompt, either a new question or what was waiting behind the run in flight. */
function prompt(board, thread, text) {
	const turn = thread.turns[thread.turns.length - 1];
	if (turn) turn.status = "sent";
	thread.status = "running";
	thread.runStartedAt = Date.now();
	update(board, thread);
	try {
		const child = ensureChild(board, thread);
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "prompt", message: text })}\n`);
	} catch (error) {
		threadError(board, thread, `could not send to the child: ${error.message}`);
	}
}

function handleChildLine(board, thread, line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		process.stderr.write(`[${board.name}/${thread.title}] unparsed child line: ${line.slice(0, 200)}\n`);
		return;
	}
	if (event.type === "response") {
		if (event.command === "get_state" && typeof event.data?.sessionId === "string") {
			thread.sessionId = event.data.sessionId;
			update(board, thread);
		} else if (event.command === "prompt" && event.success === false) {
			// A rejected prompt starts no run, so no agent_settled would ever arrive.
			threadError(board, thread, `prompt rejected: ${event.error ?? "unknown reason"}`);
		} else if (event.command === "prompt" && event.data?.disposition === "handled") {
			threadError(board, thread, "the message was handled as a command, so no run started");
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		addRow(board, {
			id: String(event.toolCallId),
			kind: "tool",
			tool: String(event.toolName ?? "tool"),
			label: describeTool(event.toolName, event.args ?? {}),
			status: "running",
			startedAt: Date.now(),
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		patchRow(board, String(event.toolCallId), {
			status: event.isError ? "error" : "ok",
			durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
			summary: firstLine(event.result),
		});
		return;
	}
	if (event.type === "turn_end" && event.message?.role === "assistant") {
		const message = event.message;
		const text = (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block?.type === "text")
			.map((block) => String(block.text ?? ""))
			.join("")
			.trim();
		if (!text) return;
		const turn = thread.turns[thread.turns.length - 1];
		if (turn) {
			turn.reply = text;
			turn.status = "answered";
		}
		addRow(board, { id: randomUUID(), kind: "reply", status: "ok", startedAt: Date.now(), text: text.slice(0, 4000) });
		update(board, thread);
		return;
	}
	if (event.type === "agent_settled") {
		thread.status = "idle";
		// A turn whose answer was redirected by a steer, or whose run was stopped, never gets a reply
		// of its own. It reads as stopped rather than as a message still being worked on.
		for (const turn of thread.turns) if (turn.status === "sent") turn.status = "stopped";
		update(board, thread);
		// Nothing runs after settle, so closing stdin is what lets the child exit.
		board.children.get(thread.id)?.stdin?.end();
		const next = thread.queued.shift();
		if (next) {
			thread.turns.push({ text: next, status: "queued", mode: "queue", at: Date.now() });
			update(board, thread);
			prompt(board, thread, next);
		}
	}
}

// ---------- http plumbing --------------------------------------------------

function readBody(req, limit = MAX_BODY_BYTES) {
	return new Promise((done) => {
		const chunks = [];
		let size = 0;
		let oversized = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) oversized = true;
			else chunks.push(chunk);
		});
		req.on("end", () => done(oversized ? undefined : Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => done(undefined));
	});
}

/** Read and parse a JSON body. Answers 400 or 413 itself and returns null, so the caller stops. */
async function readJson(req, res) {
	const body = await readBody(req);
	if (body === undefined) {
		fail(res, 413, "body too large");
		return null;
	}
	if (!body.trim()) return {};
	try {
		return JSON.parse(body);
	} catch {
		fail(res, 400, "bad json");
		return null;
	}
}

function fail(res, status, message) {
	res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
	res.end(message);
	return undefined;
}

function answer(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(payload));
}

function serveStatic(res, file, type) {
	try {
		const body = readFileSync(join(PUBLIC_DIR, file));
		res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
		res.end(body);
	} catch (error) {
		console.error(`pi-studio: cannot serve ${file}: ${error.message}`);
		fail(res, 404, "not found");
	}
}

/** The board a request is about, from `?workspace=`; answers 409 itself when there is none. */
function boardFrom(url, res) {
	const id = url.searchParams.get("workspace") ?? "";
	const workspace = workspaceById(id);
	if (!workspace) {
		fail(res, 409, "no such workspace");
		return null;
	}
	return boardFor(workspace);
}

// ---------- routes: the crossroads -----------------------------------------

async function onOpenWorkspace(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	let folder = typeof body.folder === "string" ? body.folder.trim() : "";
	if (folder.startsWith("~/")) folder = join(homedir(), folder.slice(2));
	if (!folder) return void fail(res, 400, "a folder is required");
	const absolute = resolve(folder);
	if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
		// A typo fails here rather than creating a tree somewhere the human did not look.
		return void fail(res, 404, `no such folder: ${absolute}`);
	}
	const workspace = rememberWorkspace(absolute);
	const board = boardFor(workspace);
	nudgeWelcome();
	answer(res, 200, { workspace: describeWorkspace(workspace), board: { id: board.id }, cards: [...board.threads.values()].map(cardFor) });
}

/** A real folder dialog, because a browser cannot be told an absolute path any other way. */
function onPickFolder(res) {
	let child;
	try {
		child = spawn("zenity", ["--file-selection", "--directory", "--title=Open a workspace"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return void fail(res, 501, "no folder dialog on this machine");
	}
	let out = "";
	child.stdout.on("data", (chunk) => {
		out += String(chunk);
	});
	child.on("error", () => fail(res, 501, "no folder dialog on this machine"));
	child.on("close", (code) => {
		const folder = out.trim().split("\n")[0];
		// Cancelling a dialog is a decision, not a failure.
		if (code !== 0 || !folder) return void answer(res, 200, { cancelled: true });
		answer(res, 200, { folder });
	});
}

// ---------- routes: the board ----------------------------------------------

async function onThread(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = {
		id: randomUUID(),
		title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : `thread ${board.threads.size + 1}`,
		sessionId: null,
		status: "idle",
		provider: PROVIDER,
		model: typeof body.model === "string" && body.model ? body.model : MODEL,
		at: Date.now(),
		turns: [],
		queued: [],
		folder: board.folder,
	};
	// Creation does not spawn: the child starts on the first message, so an empty board costs nothing.
	board.threads.set(thread.id, thread);
	card(board, thread);
	answer(res, 200, { threadId: thread.id, card: cardFor(thread) });
}

async function onMessage(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return void fail(res, 400, "empty message");
	const mode = body.mode === "steer" ? "steer" : "queue";
	const asked = typeof body.cardId === "string" ? body.cardId : "";
	let thread = asked ? board.threads.get(asked) : undefined;
	if (asked && !thread) return void fail(res, 409, "no such card");
	if (!thread) {
		// A message with no card behind it starts a thread of its own, named after what was asked.
		thread = {
			id: randomUUID(),
			title: text.slice(0, 60),
			sessionId: null,
			status: "idle",
			provider: PROVIDER,
			model: MODEL,
			at: Date.now(),
			turns: [],
			queued: [],
			folder: board.folder,
		};
		board.threads.set(thread.id, thread);
		card(board, thread);
	}
	if (thread.status === "dead") return void fail(res, 409, "thread ended");

	thread.turns.push({ text: text.slice(0, 4000), status: "queued", mode, at: Date.now() });
	const index = thread.turns.length - 1;
	update(board, thread);
	const running = thread.status === "running";
	if (running && mode === "steer") {
		// A steer joins the run in flight instead of waiting behind it.
		try {
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "steer", message: text })}\n`);
		} catch (error) {
			threadError(board, thread, `could not steer the child: ${error.message}`);
		}
	} else if (running) {
		thread.queued.push(text);
	} else {
		prompt(board, thread, text);
	}
	answer(res, 200, { id: thread.id, turn: index });
}

async function onLayout(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = board.threads.get(String(body.cardId ?? ""));
	const rect = body.rect;
	if (!thread || !rect) return void fail(res, 409, "no such card");
	const clamp = (value) => Math.max(0, Math.min(40000, Math.round(Number.isFinite(Number(value)) ? Number(value) : 0)));
	thread.rect = { x: clamp(rect.x), y: clamp(rect.y), w: clamp(rect.w), h: clamp(rect.h) };
	if (typeof body.mini === "boolean") thread.mini = body.mini;
	broadcast(board, { type: "move", id: thread.id, rect: thread.rect, mini: thread.mini === true });
	scheduleSave(board);
	answer(res, 200, { placed: thread.id });
}

async function onClose(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = String(body.cardId ?? "");
	const thread = board.threads.get(id);
	if (!thread) return void fail(res, 404, "no such card");
	board.threads.delete(id);
	board.children.get(id)?.kill("SIGKILL");
	board.children.delete(id);
	broadcast(board, { type: "remove", id });
	scheduleSave(board);
	nudgeWelcome();
	answer(res, 200, { closed: id });
}

function onStop(res, board) {
	const running = [...board.threads.values()].filter((thread) => thread.status === "running");
	if (!running.length) return void fail(res, 409, "no run in progress");
	for (const thread of running) {
		try {
			// Abort lets the child settle and report; the kill is only for a child that will not.
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`);
		} catch {
			// A child already gone has nothing to abort.
		}
	}
	answer(res, 200, { stopped: running.map((thread) => thread.id) });
}

/** The composer's file picker walks folders and answers with paths, never with file contents. */
function onBrowse(url, res) {
	const start = process.cwd();
	const asked = url.searchParams.get("path") ?? "";
	let dir = start;
	let named = "";
	if (asked) {
		const expanded = asked === "~" ? homedir() : asked.startsWith("~/") ? join(homedir(), asked.slice(2)) : resolve(start, asked);
		try {
			dir = realpathSync(expanded);
			if (!statSync(dir).isDirectory()) {
				named = basename(dir);
				dir = dirname(dir);
			}
		} catch {
			return void fail(res, 404, `no such folder: ${asked}`);
		}
	}
	const query = (url.searchParams.get("q") ?? named).trim().toLowerCase();
	const entries = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			if (CONTROL_CHARS.test(entry.name)) continue;
			if (query && !entry.name.toLowerCase().includes(query)) continue;
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = statSync(join(dir, entry.name)).isDirectory();
				} catch {
					continue; // a link to nothing would only fail after it was picked
				}
			}
			entries.push({ name: entry.name, path: join(dir, entry.name), dir: isDir });
		}
	} catch {
		return void fail(res, 403, `cannot list ${dir}`);
	}
	entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
	answer(res, 200, {
		path: dir,
		parent: dirname(dir),
		home: homedir(),
		cwd: start,
		entries: entries.slice(0, BROWSE_LIMIT),
		total: entries.length,
		truncated: entries.length > BROWSE_LIMIT,
	});
}

// ---------- the server -----------------------------------------------------

const token = (() => {
	const saved = readJsonFile(STATE_FILE, null);
	return typeof saved?.token === "string" && saved.token ? saved.token : randomToken();
})();

const server = createServer((req, res) => {
	void (async () => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		// Static assets carry no session data, so the token only guards the data routes.
		if (req.method === "GET") {
			const statics = {
				"/": ["welcome.html", "text/html; charset=utf-8"],
				"/welcome.js": ["welcome.js", "text/javascript; charset=utf-8"],
				"/welcome.css": ["welcome.css", "text/css; charset=utf-8"],
				"/board.js": ["board.js", "text/javascript; charset=utf-8"],
			};
			const hit = statics[url.pathname];
			if (hit) {
				serveStatic(res, hit[0], hit[1]);
				return;
			}
			// A workspace's board is the same page for every folder; the id in the path tells it which.
			if (/^\/w\/[0-9a-f]{6,64}\/?$/.test(url.pathname)) {
				serveStatic(res, "index.html", "text/html; charset=utf-8");
				return;
			}
		}
		if (url.searchParams.get("token") !== token) {
			// A refused POST has to have its body taken off the wire, otherwise the client's next
			// request rides the same socket into the leftovers and reads as a reset.
			req.resume();
			fail(res, 403, "forbidden");
			return;
		}

		// ----- streams -----
		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
			const scope = url.searchParams.get("scope");
			if (scope === "welcome") {
				// The crossroads only needs counts and previews, and it needs them as they change.
				send(new Set([res]), { type: "workspaces", workspaces: workspaces.map(describeWorkspace) });
				welcomeClients.add(res);
				const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
				const forget = () => {
					clearInterval(keepAlive);
					welcomeClients.delete(res);
				};
				req.on("close", forget);
				res.on("error", forget);
				return;
			}
			const board = boardFrom(url, res);
			if (!board) return;
			send(new Set([res]), {
				type: "snapshot",
				cards: [...board.threads.values()].map(cardFor),
				activity: board.activity,
				meta: boardMeta(board),
			});
			board.clients.add(res);
			const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
			const forget = () => {
				clearInterval(keepAlive);
				board.clients.delete(res);
			};
			req.on("close", forget);
			res.on("error", forget);
			return;
		}

		// ----- crossroads -----
		if (req.method === "GET" && url.pathname === "/workspaces") {
			answer(res, 200, { workspaces: workspaces.map(describeWorkspace) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/workspace") {
			await onOpenWorkspace(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/pick-folder") {
			req.resume();
			onPickFolder(res);
			return;
		}
		if (req.method === "GET" && url.pathname === "/browse") {
			onBrowse(url, res);
			return;
		}
		// The rail's detail panel has no payloads here yet, so it says so instead of hanging.
		if (req.method === "GET" && url.pathname.startsWith("/activity/")) return void fail(res, 404, "no detail kept for this row");

		// ----- board -----
		if (req.method === "GET" && url.pathname === "/state") {
			const board = boardFrom(url, res);
			if (!board) return;
			answer(res, 200, {
				workspace: describeWorkspace({ id: board.id, folder: board.folder, name: board.name, openedAt: 0 }),
				threads: [...board.threads.values()].map((thread) => ({ ...thread, live: board.children.has(thread.id) })),
				cards: [...board.threads.values()].map(cardFor),
				activity: board.activity,
				meta: boardMeta(board),
			});
			return;
		}
		if (req.method === "POST") {
			const routing = {
				"/thread": onThread,
				"/message": onMessage,
				"/layout": onLayout,
				"/close": onClose,
			};
			const handler = routing[url.pathname];
			if (handler) {
				const board = boardFrom(url, res);
				if (!board) return;
				await handler(req, res, board);
				return;
			}
			if (url.pathname === "/stop") {
				const board = boardFrom(url, res);
				if (!board) return;
				req.resume();
				onStop(res, board);
				return;
			}
			// Everything the board had for a single session: kept honest by refusing rather than lying.
			if (url.pathname === "/compact") return void fail(res, 409, "compaction belongs to the child, and no run is waiting on it");
			if (url.pathname === "/answer") return void fail(res, 409, "questions are not wired to the daemon yet");
			if (url.pathname === "/edit") return void fail(res, 409, "not an editable note");
		}
		fail(res, 404, "not found");
	})().catch((error) => {
		// A handler that throws used to leave the request unanswered, which the browser shows as a
		// reset. Answer something and keep the daemon serving.
		console.error(`pi-studio: ${error.stack ?? error}`);
		if (!res.headersSent) fail(res, 500, "board error");
		else res.end();
	});
});

function shutdown() {
	// What the debounce still holds is the last thing the human did, so it goes to disk first.
	for (const board of boards.values()) flushBoard(board);
	for (const board of boards.values()) for (const child of board.children.values()) child.kill("SIGKILL");
	server.close(() => process.exit(0));
	// A socket that will not close must not keep a stopped daemon alive.
	setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// A daemon that dies without a signal would otherwise leave its children running.
process.on("exit", () => {
	for (const board of boards.values()) for (const child of board.children.values()) if (child.exitCode === null) child.kill("SIGKILL");
});

let port = 0;
server.listen(0, "127.0.0.1", () => {
	port = server.address().port;
	writeJsonFile(STATE_FILE, { token, port, at: new Date().toISOString() });
	const url = `http://127.0.0.1:${port}/?token=${token}`;
	console.log(`pi-studio listening on ${url}`);
	// Which build is answering matters the moment a tab looks wrong, so it is said out loud.
	console.log(`build ${buildHash()}`);
	if (workspaces.length) console.log(`${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}, newest ${workspaces[0].name}`);
	else console.log("no workspace yet — open one on the crossroads");
	// The crossroads is where a desktop app starts, so it starts in the browser.
	if (OPEN_BROWSER) {
		try {
			spawn("xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
		} catch {
			// A machine without a browser opener still has the URL above.
		}
	}
});
