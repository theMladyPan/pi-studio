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
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
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
// Pi names seven levels and clamps whatever is chosen to what the model offers.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CATALOG_TTL_MS = 10 * 60_000;
const run = promisify(execFile);
/** Read once from pi, kept for a while: the picker must work before any thread has a child. */
let catalog = null;
let catalogAt = 0;

/**
 * The models this machine can actually run. `pi --list-models` prints a table for humans, so the
 * columns are split on the runs of spaces that separate them, and the trailing yes/no columns say
 * whether a model thinks and takes images.
 */
async function modelCatalog() {
	if (catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
	const cli = piCli();
	let table = "";
	try {
		const result = await run(cli.command, [...cli.args, "--list-models"], { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 });
		table = String(result.stdout ?? "");
	} catch (error) {
		table = String(error.stdout ?? "");
	}
	const models = [];
	for (const line of table.split("\n").slice(1)) {
		const cells = line.trim().split(/\s{2,}/);
		if (cells.length < 3) continue;
		const [provider, model, context, maxOut, thinking, images] = cells;
		models.push({
			provider,
			model,
			context: context ?? "",
			maxOut: maxOut ?? "",
			thinking: thinking !== "no",
			images: images === "yes",
		});
	}
	// A machine with no credentials still has a board, so an empty table is answered with the levels and
	// no models rather than with an error. The empty answer is kept too: otherwise every open of the
	// picker would spawn pi again.
	catalog = { models, levels: THINKING_LEVELS };
	catalogAt = Date.now();
	return catalog;
}

/** What a new thread starts with: the last choice made on this board, else the daemon's own. */
function runtimeDefaults(board) {
	const chosen = board.defaults ?? {};
	return {
		provider: typeof chosen.provider === "string" && chosen.provider ? chosen.provider : PROVIDER,
		model: typeof chosen.model === "string" && chosen.model ? chosen.model : MODEL,
		...(THINKING_LEVELS.includes(chosen.thinking) ? { thinking: chosen.thinking } : {}),
	};
}
/**
 * Left to itself a thread has the same tools as a pi started in a terminal: the built-in four plus
 * whatever is installed here. `PI_STUDIO_TOOLS` narrows that to a named allowlist instead.
 */
const TOOLS = process.env.PI_STUDIO_TOOLS ?? "";
/** The extension a child loads so a thread can draw on the board it belongs to. */
const BRIDGE = join(dirname(PUBLIC_DIR), "bridge", "child-bridge.mjs");
/**
 * Extensions a thread may load: everything installed on this machine, less what cannot come along.
 *
 *   dashboard        it is the old board, it registers the same tool names as the bridge, and it
 *                    would open a board server and rewrite its state file once per running thread
 *   browser-screenshot, ytrack
 *                    one drives the human's browser, the other answers through a 2FA gateway; neither
 *                    is a thing a thread does on its own
 *
 * `-ne` keeps discovery off so the list is this one, plainly; `-e` still loads what it names.
 * `PI_STUDIO_CHILD_EXCLUDE` changes the exclusions, `PI_STUDIO_CHILD_EXTENSIONS` names an exact list.
 */
const CHILD_EXCLUDE = new Set(
	(process.env.PI_STUDIO_CHILD_EXCLUDE ?? "dashboard,browser-screenshot,ytrack")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean),
);

/**
 * A test script in the extensions folder is not an extension: it exports no factory, so pi refuses to
 * load it and the thread dies before it can answer. Shipped extensions are never named like this.
 */
function isTestFile(name) {
	return /^test[-.]/.test(name) || /\.test\./.test(name) || /\.spec\./.test(name);
}

/** Every extension this machine has installed, minus the exclusions above. */
function installedExtensions() {
	const named = process.env.PI_STUDIO_CHILD_EXTENSIONS;
	if (named) {
		return named
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean)
			.map((name) => (name.includes("/") ? name : join(extensionsDir(), name, "index.ts")))
			.filter((path) => existsSync(path));
	}
	const dir = extensionsDir();
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found = [];
	for (const entry of entries) {
		const bare = entry.name.replace(/\.(ts|mts|js|mjs)$/, "");
		if (entry.name.startsWith(".") || CHILD_EXCLUDE.has(entry.name) || CHILD_EXCLUDE.has(bare)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			const entryPoint = ["index.ts", "index.js", "index.mjs"]
				.map((name) => join(full, name))
				.find((path) => existsSync(path));
			if (entryPoint) found.push(entryPoint);
		} else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !isTestFile(entry.name)) {
			found.push(full);
		}
	}
	return found;
}

const CHILD_EXTENSIONS = installedExtensions();
const MAX_BODY_BYTES = 1_000_000;
const MAX_ACTIVITY = 300;
const MAX_THREADS = 200;
const MAX_PLAIN_CARDS = 200;
/** A note is markdown the board repaints on every change, so its size has a ceiling. */
const MAX_NOTE_CHARS = 100_000;
/** A source card carries a whole file, so the ceiling is higher and still finite. */
const MAX_SOURCE_CHARS = 200_000;
/** A question whose agent is waiting holds that child's turn open, so it cannot wait forever. */
const ASK_TIMEOUT_MS = 5 * 60_000;
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
 * @property {string} [thinking]
 * @property {number} at
 * @property {Turn[]} turns
 * @property {(string|{message: string, text: string, target?: {cardId: string, turn: number}})[]} queued
 * @property {{cardId: string, turn: number}|null} [answering]
 * @property {{x:number,y:number,w:number,h:number}} [rect]
 * @property {boolean} [mini]
 * @property {number} [runStartedAt]
 * @property {string} [stderrTail]
 * @property {string} [threadRoot]
 * @property {string} [behind] the card this thread answers for, when it is not drawn itself
 */

/**
 * A card with no child behind it: markdown a note carries, or a file a source card shows. The daemon
 * keeps them beside the threads and the client draws them by `type`.
 * @typedef {object} PlainCard
 * @property {string} id
 * @property {"note"|"source"|"question"} type
 * @property {string} title
 * @property {string} [question]
 * @property {string[]} [options]
 * @property {boolean} [allowFreeText]
 * @property {"open"|"answered"|"expired"} [status]
 * @property {string} [answer]
 * @property {number} [expiresAt]
 * @property {string} [markdown]
 * @property {string} [path]
 * @property {string} [content]
 * @property {number} [line]
 * @property {string} [key]
 * @property {string} [threadRoot] where the card cascades
 * @property {string} [ownerThread] the thread that answers comments on it
 * @property {Turn[]} [turns] what was asked about this card, and what came back
 * @property {number} at
 * @property {number} [updatedAt]
 * @property {{x:number,y:number,w:number,h:number}} [rect]
 * @property {boolean} [mini]
 */

/**
 * A live board: the workspace it belongs to, what is on it, and who is watching.
 * @typedef {object} Board
 * @property {string} id
 * @property {string} folder
 * @property {string} name
 * @property {Map<string, Thread>} threads
 * @property {Map<string, PlainCard>} cards
 * @property {Map<string, {resolve: (value: {status: string, answer?: string}) => void}>} askers
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

/** A saved card position, or undefined when the file holds something that is not one. */
function cleanRect(rect) {
	return rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.w > 0 && rect.h > 0
		? { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
		: undefined;
}

/** Write one board: its threads, their turns, their layout and their session ids, and its notes. */
function saveBoard(board) {
	const payload = {
		version: STATE_VERSION,
		workspace: { id: board.id, folder: board.folder, name: board.name },
		savedAt: Date.now(),
		activity: board.activity.slice(-MAX_ACTIVITY),
		...(board.defaults ? { defaults: board.defaults } : {}),
		threads: [...board.threads.values()].map((thread) => ({
			id: thread.id,
			title: thread.title,
			sessionId: thread.sessionId,
			provider: thread.provider,
			model: thread.model,
			...(thread.thinking ? { thinking: thread.thinking } : {}),
			at: thread.at,
			turns: thread.turns.map(savedTurn),
			...(thread.rect ? { rect: thread.rect } : {}),
			...(thread.mini ? { mini: true } : {}),
			...(thread.threadRoot ? { threadRoot: thread.threadRoot } : {}),
			...(thread.behind ? { behind: thread.behind } : {}),
		})),
		cards: [...board.cards.values()].map((card) => ({
			id: card.id,
			type: card.type,
			title: card.title,
			at: card.at,
			...(typeof card.markdown === "string" ? { markdown: card.markdown } : {}),
			...(typeof card.path === "string" ? { path: card.path } : {}),
			...(typeof card.content === "string" ? { content: card.content } : {}),
			...(Number.isFinite(card.line) ? { line: card.line } : {}),
			...(typeof card.question === "string" ? { question: card.question } : {}),
			...(Array.isArray(card.options) ? { options: card.options } : {}),
			...(card.type === "question" ? { allowFreeText: card.allowFreeText !== false } : {}),
			...(typeof card.status === "string" ? { status: card.status } : {}),
			...(typeof card.answer === "string" ? { answer: card.answer } : {}),
			...(Number.isFinite(card.expiresAt) ? { expiresAt: card.expiresAt } : {}),
			...(card.updatedAt ? { updatedAt: card.updatedAt } : {}),
			...(card.key ? { key: card.key } : {}),
			...(card.threadRoot ? { threadRoot: card.threadRoot } : {}),
			...(card.ownerThread ? { ownerThread: card.ownerThread } : {}),
			...(card.turns?.length ? { turns: card.turns.map(savedTurn) } : {}),
			...(card.rect ? { rect: card.rect } : {}),
			...(card.mini ? { mini: true } : {}),
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
function restoredTurns(raw) {
	return (Array.isArray(raw) ? raw : [])
		.filter((turn) => turn && typeof turn.text === "string")
		.map((turn) => ({
			text: String(turn.text),
			status: turn.status === "answered" ? "answered" : "stopped",
			mode: turn.mode === "steer" ? "steer" : "queue",
			at: Number.isFinite(turn.at) ? turn.at : Date.now(),
			...(typeof turn.reply === "string" ? { reply: turn.reply } : {}),
		}));
}

function restoredThread(raw, folder) {
	if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
	const turns = restoredTurns(raw.turns);
	const rect = cleanRect(raw.rect);
	return {
		id: raw.id,
		title: typeof raw.title === "string" && raw.title ? raw.title : "thread",
		sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
		status: "idle",
		provider: typeof raw.provider === "string" ? raw.provider : PROVIDER,
		model: typeof raw.model === "string" ? raw.model : MODEL,
		...(THINKING_LEVELS.includes(raw.thinking) ? { thinking: raw.thinking } : {}),
		at: Number.isFinite(raw.at) ? raw.at : Date.now(),
		turns,
		queued: [],
		...(rect ? { rect } : {}),
		...(raw.mini ? { mini: true } : {}),
		...(typeof raw.threadRoot === "string" && raw.threadRoot ? { threadRoot: raw.threadRoot } : {}),
		...(typeof raw.behind === "string" && raw.behind ? { behind: raw.behind } : {}),
		folder,
	};
}

/** Rebuild a plain card from its file. One without the body its type needs is nothing, so it goes. */
function restoredPlainCard(raw) {
	if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
	// Files written before source cards existed carried notes under their own key and no type.
	const type = raw.type === "source" || raw.type === "question" ? raw.type : "note";
	if (type === "note" && typeof raw.markdown !== "string") return null;
	if (type === "source" && (typeof raw.path !== "string" || typeof raw.content !== "string")) return null;
	if (type === "question" && typeof raw.question !== "string") return null;
	const rect = cleanRect(raw.rect);
	const card = {
		id: raw.id,
		type,
		title: typeof raw.title === "string" && raw.title ? raw.title : type,
		at: Number.isFinite(raw.at) ? raw.at : Date.now(),
		...(type === "note"
			? { markdown: raw.markdown }
			: type === "source"
				? { path: raw.path, content: raw.content }
				: { question: raw.question, options: Array.isArray(raw.options) ? raw.options.filter((one) => typeof one === "string") : [] }),
		// A question is answered by an agent that was waiting for it, and that agent is gone: whatever
		// the file says, a restored question is settled.
		...(type === "question" ? { status: "expired", allowFreeText: raw.allowFreeText !== false } : {}),
		...(typeof raw.answer === "string" ? { answer: raw.answer } : {}),
		...(Number.isFinite(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
		...(Number.isFinite(raw.line) ? { line: raw.line } : {}),
		...(typeof raw.key === "string" && raw.key ? { key: raw.key } : {}),
		...(typeof raw.threadRoot === "string" && raw.threadRoot ? { threadRoot: raw.threadRoot } : {}),
		...(typeof raw.ownerThread === "string" && raw.ownerThread ? { ownerThread: raw.ownerThread } : {}),
		...(() => {
			const turns = restoredTurns(raw.turns);
			return turns.length ? { turns } : {};
		})(),
		...(rect ? { rect } : {}),
		...(raw.mini ? { mini: true } : {}),
	};
	return card;
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
		cards: new Map(),
		askers: new Map(),
		activity: [],
		children: new Map(),
		clients: new Set(),
		saveTimer: null,
	};
	const saved = readJsonFile(boardFile(workspace), null);
	if (saved && saved.defaults && typeof saved.defaults === "object") board.defaults = saved.defaults;
	if (saved && saved.version === STATE_VERSION && Array.isArray(saved.threads)) {
		for (const raw of saved.threads.slice(-MAX_THREADS)) {
			const thread = restoredThread(raw, workspace.folder);
			if (thread && !board.threads.has(thread.id)) board.threads.set(thread.id, thread);
		}
		// A board written before source cards existed kept its notes under `notes`.
		const plain = Array.isArray(saved.cards) ? saved.cards : Array.isArray(saved.notes) ? saved.notes : [];
		for (const raw of plain.slice(-MAX_PLAIN_CARDS)) {
			const card = restoredPlainCard(raw);
			if (card && !board.cards.has(card.id)) board.cards.set(card.id, card);
		}
		for (const row of (Array.isArray(saved.activity) ? saved.activity : []).slice(-MAX_ACTIVITY)) {
			if (row && typeof row.id === "string" && row.status !== "running") board.activity.push(row);
		}
		// A card and the child that answers for it belong together, and pruning can part them. Repair it
		// here rather than let a card quietly re-fork because a thread id in it means nothing.
		for (const thread of [...board.threads.values()]) {
			if (thread.behind && !board.cards.has(thread.behind)) board.threads.delete(thread.id);
		}
		for (const card of board.cards.values()) {
			if (card.ownerThread && !board.threads.has(card.ownerThread)) delete card.ownerThread;
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
	// A thread that serves a card is not a thread anyone can open: counting it would report more
	// threads than the board has cards.
	const threads = [...(board?.threads.values() ?? [])].filter((thread) => !thread.behind);
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
	// The client cascades a card under the one its reply was asked on, and a note can be that one.
	if (thread.threadRoot) card.threadRoot = thread.threadRoot;
	// What this card answers with, so the composer can show the truth instead of the daemon's hope.
	card.provider = thread.provider;
	card.model = thread.model;
	if (thread.thinking) card.thinking = thread.thinking;
	return card;
}

/** A plain card as the browser draws it: markdown under a title, or a file, with no run behind it. */
function plainCardFor(card, board = null) {
	const shown = {
		id: card.id,
		type: card.type,
		title: card.title,
		at: card.at,
		text: "",
		status: "answered",
		mode: "queue",
		images: 0,
		...(card.turns?.length ? { turns: card.turns } : {}),
		...(card.type === "note"
			? { markdown: card.markdown }
			: card.type === "source"
				? { path: card.path, content: card.content, ...(Number.isFinite(card.line) ? { line: card.line } : {}) }
				: {
						question: card.question,
						options: card.options,
						allowFreeText: card.allowFreeText !== false,
						status: card.status ?? "expired",
						...(card.answer ? { answer: card.answer } : {}),
						...(Number.isFinite(card.expiresAt) ? { expiresAt: card.expiresAt } : {}),
					}),
	};
	if (card.updatedAt) shown.updatedAt = card.updatedAt;
	if (card.rect) shown.rect = card.rect;
	if (card.mini) shown.mini = true;
	if (card.threadRoot) shown.threadRoot = card.threadRoot;
	if (card.ownerThread) shown.ownerThread = card.ownerThread;
	// The card carries the runtime of whoever answers it, so the composer's pickers can name and change
	// it without the thread that serves the card ever being drawn.
	// Boards written before ownership was its own field have only the thread that made the card, and a
	// thread that has ended answers nothing: the next child will, and that is what the pickers show.
	const ownerId = card.ownerThread ?? card.threadRoot;
	const owner = board && ownerId ? board.threads.get(ownerId) : undefined;
	if (owner && owner.status !== "dead") {
		shown.answersWith = {
			provider: owner.provider,
			model: owner.model,
			...(owner.thinking ? { thinking: owner.thinking } : {}),
		};
	}
	return shown;
}

/** Every card on a board: the threads, then the cards the human and the agents put there. */
function cardsFor(board) {
	// A thread that answers for a card is not a card of its own: that card is the surface, and drawing
	// both would show one conversation on two cards.
	return [...board.threads.values()]
		.filter((thread) => !thread.behind)
		.map(cardFor)
		.concat([...board.cards.values()].map((card) => plainCardFor(card, board)));
}

function boardMeta(board) {
	const working = [...board.threads.values()].filter((thread) => thread.status === "running");
	return {
		folder: board.name,
		cwd: board.folder,
		port,
		model: MODEL,
		// What the next thread starts with, so the composer's chips can say it instead of guessing.
		defaults: runtimeDefaults(board),
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
	// A thread that answers for a card is not drawn: what changes is that card, and broadcasting the
	// thread would put a second card on the board for the same conversation.
	const shown = thread.behind ? board.cards.get(thread.behind) : thread;
	if (shown) broadcast(board, { type: "update", card: thread.behind ? plainCardFor(shown, board) : cardFor(shown) });
	scheduleSave(board);
	nudgeWelcome();
};
/** A card without a child changes the same way, and is broadcast in its own shape. */
const updateCard = (board, held) => {
	broadcast(board, { type: "update", card: plainCardFor(held, board) });
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
	// A question that was written on a card is stuck in the same way the thread's own turn is.
	const asked = thread.answering ? board.cards.get(thread.answering.cardId) : undefined;
	const cardTurn = asked?.turns?.[thread.answering.turn];
	if (cardTurn && cardTurn.status !== "answered") {
		cardTurn.status = "stopped";
		updateCard(board, asked);
	}
	thread.answering = null;
	addRow(board, { id: randomUUID(), kind: "reply", status: "error", startedAt: Date.now(), text: message });
	update(board, thread);
	board.children.get(thread.id)?.stdin?.end();
}

// ---------- the child ------------------------------------------------------

/**
 * The CLI a child needs. Same order as the rest of the tooling: the script this process is already
 * running pi from, then the managed install, then the `pi` binary on PATH.
 */
/** Where pi keeps the install this app drives, and the extensions beside it. */
function installRoot() {
	return process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
}

function extensionsDir() {
	return join(dirname(installRoot()), "extensions");
}

function piCli() {
	const script = process.argv[1];
	if (script && existsSync(script) && (basename(script) === "pi" || script.includes("pi-coding-agent"))) {
		return { command: process.execPath, args: [script] };
	}
	const root = installRoot();
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

/** The thread's own card, and the board around it, said plainly enough that an agent uses it. */
function boardPrompt(board, thread) {
	return [
		`You are thread "${thread.title}" on a board, working in the folder ${board.folder}.`,
		"The human reads cards on that board, not a terminal log.",
		"Your answer is shown inside your own card, so write it as prose for a person, and keep long material out of it.",
		"board_note puts a note on the board: use it for a diagram (a fenced svg block draws a picture), a table, a file tree, a todo list you will keep revising under the same key, or a finding worth keeping visible.",
		"board_source shows the human a real file from this workspace, scrolled to a line, instead of quoting it at them.",
	].join("\n");
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
		// `-ne` stops discovery, and an explicit `-e` still loads: that is how a thread gets its verbs
		// and the research tools, without anything else coming along.
		...(existsSync(BRIDGE) ? ["-e", BRIDGE] : []),
		...CHILD_EXTENSIONS.flatMap((path) => ["-e", path]),
		// No allowlist unless one was asked for: a thread gets the tools a console pi gets.
		...(TOOLS ? ["--tools", TOOLS] : []),
		"--append-system-prompt",
		boardPrompt(board, thread),
		"--provider",
		thread.provider,
		"--model",
		thread.model,
		...(thread.thinking ? ["--thinking", thread.thinking] : []),
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
		// The bridge reads these: where the board is, what it may write to, and whose card it is.
		env: {
			...process.env,
			PI_STUDIO_URL: `http://127.0.0.1:${port}`,
			PI_STUDIO_TOKEN: token,
			PI_STUDIO_WORKSPACE: board.id,
			PI_STUDIO_THREAD: thread.id,
		},
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
	// A child replaced by a fresh one is not this thread's voice any more: its exit is its own business.
	const mine = () => board.children.get(thread.id) === child;
	child.on("error", (error) => {
		if (!mine()) return;
		board.children.delete(thread.id);
		threadError(board, thread, `child failed to start: ${error.message}`);
	});
	child.on("close", (code, signal) => {
		if (!mine()) return;
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
function prompt(board, thread, text, target = null) {
	// A question written on a card is answered on that card, and the run in flight remembers which
	// one, so the reply lands where the human typed rather than on the thread's own card.
	thread.answering = target;
	if (target) {
		const held = board.cards.get(target.cardId);
		const turn = held?.turns?.[target.turn];
		if (held && turn) {
			turn.status = "sent";
			updateCard(board, held);
		}
	} else {
		const turn = thread.turns[thread.turns.length - 1];
		if (turn) turn.status = "sent";
	}
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
		} else if ((event.command === "set_model" || event.command === "set_thinking_level") && event.success === false) {
			// The chip already shows the choice, so a refusal has to be said out loud.
			addRow(board, {
				id: randomUUID(),
				kind: "reply",
				status: "error",
				startedAt: Date.now(),
				text: `${event.command} refused: ${event.error ?? "unknown reason"}`,
			});
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
		// When the run was answering for a card, only that card may receive the reply. Falling back to
		// the thread's own turn would overwrite an older answer with a card's answer.
		const asked = thread.answering ? board.cards.get(thread.answering.cardId) : undefined;
		const turn = thread.answering ? asked?.turns?.[thread.answering.turn] : thread.turns[thread.turns.length - 1];
		if (turn) {
			turn.reply = text;
			turn.status = "answered";
		}
		addRow(board, { id: randomUUID(), kind: "reply", status: "ok", startedAt: Date.now(), text: text.slice(0, 4000) });
		if (turn && asked) updateCard(board, asked);
		else if (!thread.answering) update(board, thread);
		return;
	}
	if (event.type === "agent_settled") {
		thread.status = "idle";
		// A turn whose answer was redirected by a steer, or whose run was stopped, never gets a reply
		// of its own. It reads as stopped rather than as a message still being worked on.
		for (const turn of thread.turns) if (turn.status === "sent") turn.status = "stopped";
		const parked = thread.answering ? board.cards.get(thread.answering.cardId) : undefined;
		if (parked) {
			for (const turn of parked.turns ?? []) if (turn.status === "sent") turn.status = "stopped";
			updateCard(board, parked);
		}
		thread.answering = null;
		update(board, thread);
		const next = thread.queued.shift();
		if (next) {
			// An older board file queued plain strings; a card quote travels with the message now.
			const text = typeof next === "string" ? next : next.text;
			const target = typeof next === "string" ? null : (next.target ?? null);
			if (target) {
				const held = board.cards.get(target.cardId);
				if (held?.turns?.[target.turn]) {
					held.turns[target.turn].status = "queued";
					updateCard(board, held);
				}
			} else {
				thread.turns.push({ text, status: "queued", mode: "queue", at: Date.now() });
				update(board, thread);
			}
			prompt(board, thread, typeof next === "string" ? next : next.message, target);
			return;
		}
		// Nothing follows, so closing stdin is what lets the child exit. Doing it before the queue was
		// drained killed the run the next message started.
		board.children.get(thread.id)?.stdin?.end();
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
		...runtimeDefaults(board),
		...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
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

/** The card a key already addresses, so a caller that repeats itself revises instead of stacking. */
function cardByKey(board, key, type) {
	if (!key) return undefined;
	return [...board.cards.values()].find((card) => card.key === key && card.type === type);
}

/** A string field from a request body, trimmed and cut short. */
function field(value, limit = 80) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : "";
}

/** Where a card goes when the caller gave it a place, rounded to whole pixels. */
function placedRect(body) {
	const rect = cleanRect(body.rect);
	return rect
		? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
		: undefined;
}

/**
 * What a card carries, quoted for the agent that is asked about it. A card without a child has no
 * conversation of its own, so the quote is how the agent that is asked learns what it is being asked
 * about. It is capped: the card is on the board, and the rest of a long note is not worth paying for
 * twice.
 */
function cardPreamble(card, whole = false) {
	const title = String(card.title ?? card.path ?? card.type).replace(/\s+/g, " ").trim().slice(0, 60);
	if (card.type === "source") {
		const lines = String(card.content ?? "").split("\n");
		const focus = Math.max(1, Math.min(card.line ?? 1, lines.length));
		const from = Math.max(1, focus - 8);
		const to = Math.min(lines.length, focus + 12);
		const numbered = lines
			.slice(from - 1, to)
			.map((line, index) => `${from + index}| ${line}`)
			.join("\n")
			.slice(0, 1500);
		return `[board reply · card ${card.id} · "${title}"]\nThe card shows ${card.path}, lines ${from}-${to}:\n${numbered || "(empty)"}\n\n`;
	}
	const body = String(card.type === "question" ? [card.question, card.answer ?? ""].join("\n") : (card.markdown ?? ""))
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 1500);
	// A chain of comments is the card's own history. A thread that already answered on this card holds
	// it in its own session, so it only needs a reminder. A fork, or a thread that has to be restarted,
	// starts clean and gets the whole chain — it owns this card and nothing else, so what happened on
	// other cards is none of its business.
	const turns = card.turns ?? [];
	const chain = (whole ? turns : turns.slice(-3))
		.map((turn) => {
			const room = whole ? 400 : 200;
			const asked = String(turn.text ?? "").replace(/\s+/g, " ").trim().slice(0, room);
			const said = String(turn.reply ?? "").replace(/\s+/g, " ").trim().slice(0, room);
			return `- asked: ${asked}${said ? `\n  answered: ${said}` : ""}`;
		})
		.join("\n")
		// The newest turns matter most, so cutting from the front keeps the end intact.
		.slice(-(whole ? 4000 : 900));
	return `[board reply · card ${card.id} · "${title}"]\nThe card says: ${body || "(empty)"}\n${chain ? `Earlier about this card:\n${chain}\n` : ""}\n`;
}

/** The thread a card should cascade under, when the caller named one that exists. */
function rootOf(board, body) {
	const root = field(body.threadRoot, 100);
	return root && board.threads.has(root) ? root : undefined;
}

/**
 * Where a card a thread writes should cascade. Usually the thread's own card, but a child that answers
 * for a card has no card of its own, so its notes land under the card it serves.
 */
function anchorOf(board, threadId) {
	const thread = threadId ? board.threads.get(threadId) : undefined;
	return thread?.behind ?? threadId;
}

/**
 * A card that leaves the board takes its child with it. Nothing can reach a thread the board cannot
 * draw, so keeping one alive would leave a session and a process behind every closed note; and a run
 * that was answering for the card must not write its reply onto some other card's turn.
 */
function forgetCard(board, cardId) {
	for (const thread of [...board.threads.values()]) {
		if (thread.answering?.cardId === cardId) {
			const turn = board.cards.get(cardId)?.turns?.[thread.answering.turn];
			if (turn && turn.status !== "answered") turn.status = "stopped";
			thread.answering = null;
		}
		if (thread.behind !== cardId) continue;
		try {
			board.children.get(thread.id)?.stdin?.end();
		} catch {
			// The child is already gone, which is what this wanted.
		}
		board.children.delete(thread.id);
		board.threads.delete(thread.id);
	}
}

/** Keep the board bounded: the oldest plain card goes when a new one arrives and there is no room. */
function makeRoom(board) {
	while (board.cards.size >= MAX_PLAIN_CARDS) {
		const oldest = [...board.cards.values()].sort((a, b) => a.at - b.at)[0];
		if (!oldest) break;
		board.cards.delete(oldest.id);
		forgetCard(board, oldest.id);
		broadcast(board, { type: "remove", id: oldest.id });
	}
}

async function onNote(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const markdown = typeof body.markdown === "string" ? body.markdown : "";
	if (!markdown.trim()) return void fail(res, 400, "empty note");
	if (markdown.length > MAX_NOTE_CHARS) return void fail(res, 413, `a note holds at most ${MAX_NOTE_CHARS} characters`);
	const title = field(body.title);
	const key = field(body.key);
	const root = rootOf(board, body);
	// A key makes the card stable: saying the same thing twice revises one note instead of stacking
	// a second copy of it on the board, which is what a running agent stepping through a job does.
	const held = cardByKey(board, key, "note");
	if (held) {
		held.markdown = markdown;
		held.updatedAt = Date.now();
		if (title) held.title = title;
		// Ownership moves only when a fork takes the card or a new thread starts answering it, so a
		// revision never changes who is responsible for the card it revises.
		if (root && !held.ownerThread) held.ownerThread = root;
		const rect = placedRect(body);
		if (rect) held.rect = rect;
		broadcast(board, { type: "update", card: plainCardFor(held, board) });
		scheduleSave(board);
		answer(res, 200, { cardId: held.id, card: plainCardFor(held, board), updated: true });
		return;
	}
	makeRoom(board);
	const note = {
		id: randomUUID(),
		type: "note",
		title: title || "note",
		markdown,
		at: Date.now(),
		...(key ? { key } : {}),
		...(root ? { threadRoot: anchorOf(board, root), ownerThread: root } : {}),
	};
	const rect = placedRect(body);
	if (rect) note.rect = rect;
	board.cards.set(note.id, note);
	broadcast(board, { type: "card", card: plainCardFor(note, board) });
	scheduleSave(board);
	answer(res, 200, { cardId: note.id, card: plainCardFor(note, board) });
}

/** Read a file inside the workspace, refusing anything that leaves it. */
function readInsideWorkspace(folder, wanted) {
	const target = resolve(folder, String(wanted ?? ""));
	const root = resolve(folder);
	if (target !== root && !target.startsWith(`${root}/`)) {
		throw new Error(`${wanted} is outside the workspace`);
	}
	const stat = statSync(target, { throwIfNoEntry: false });
	if (!stat) throw new Error(`${wanted} does not exist`);
	if (!stat.isFile()) throw new Error(`${wanted} is not a file`);
	if (stat.size > MAX_SOURCE_CHARS) throw new Error(`${wanted} is larger than ${MAX_SOURCE_CHARS} bytes`);
	const content = readFileSync(target, "utf8");
	// A binary file read as text is a card full of replacement characters, so say so instead.
	if (content.includes("\u0000")) throw new Error(`${wanted} is not a text file`);
	return content;
}

async function onSource(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const wanted = field(body.path, 400);
	if (!wanted) return void fail(res, 400, "path is required");
	let content;
	try {
		content = readInsideWorkspace(board.folder, wanted);
	} catch (error) {
		return void fail(res, 409, error.message);
	}
	const key = field(body.key, 400) || wanted;
	const title = field(body.title) || basename(wanted) || wanted;
	const line = Number.isFinite(body.line) && body.line > 0 ? Math.round(body.line) : undefined;
	const root = rootOf(board, body);
	const held = cardByKey(board, key, "source");
	if (held) {
		// The file may have changed since the card was opened, which is the point of opening it again.
		held.path = wanted;
		held.content = content;
		held.title = title;
		held.updatedAt = Date.now();
		if (line) held.line = line;
		else delete held.line;
		if (root && !held.ownerThread) held.ownerThread = root;
		broadcast(board, { type: "update", card: plainCardFor(held, board) });
		scheduleSave(board);
		const lines = content.split("\n").length;
		answer(res, 200, { cardId: held.id, card: { ...plainCardFor(held, board), lines }, updated: true });
		return;
	}
	makeRoom(board);
	const card = {
		id: randomUUID(),
		type: "source",
		title,
		path: wanted,
		content,
		key,
		at: Date.now(),
		...(line ? { line } : {}),
		...(root ? { threadRoot: anchorOf(board, root), ownerThread: root } : {}),
	};
	board.cards.set(card.id, card);
	broadcast(board, { type: "card", card: plainCardFor(card, board) });
	scheduleSave(board);
	answer(res, 200, { cardId: card.id, card: { ...plainCardFor(card, board), lines: content.split("\n").length } });
}

/** The note the human edited: the text is theirs, so it is stored as written. */
async function onEdit(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const held = board.cards.get(String(body.cardId ?? ""));
	const note = held && held.type === "note" ? held : undefined;
	if (!note) return void fail(res, 409, "not an editable note");
	if (typeof body.markdown !== "string") return void fail(res, 400, "markdown is required");
	if (body.markdown.length > MAX_NOTE_CHARS) return void fail(res, 413, `a note holds at most ${MAX_NOTE_CHARS} characters`);
	note.markdown = body.markdown;
	note.updatedAt = Date.now();
	broadcast(board, { type: "update", card: plainCardFor(note, board) });
	scheduleSave(board);
	answer(res, 200, { card: plainCardFor(note, board) });
}

/** Settle a question, tell whoever was waiting, and keep the card honest about what happened. */
function settleQuestion(board, card, status, answer) {
	card.status = status;
	card.updatedAt = Date.now();
	if (answer) card.answer = answer;
	broadcast(board, { type: "update", card: plainCardFor(card, board) });
	scheduleSave(board);
	const waiting = board.askers.get(card.id);
	board.askers.delete(card.id);
	if (waiting) waiting.resolve({ status, answer });
}

/**
 * Ask the human, and hold this request open until they answer.
 *
 * The response stays open for as long as the child's turn is waiting, because the answer travels
 * back in it: option clicked, words typed, or a failure the tool can read and act on.
 */
async function onAsk(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const question = field(body.question, 2000);
	const options = (Array.isArray(body.options) ? body.options : []).map((one) => field(one, 120)).filter(Boolean);
	if (!question) return void fail(res, 400, "a question needs words");
	if (options.length < 2) return void fail(res, 400, "a question needs two to four options");
	makeRoom(board);
	const card = {
		id: randomUUID(),
		type: "question",
		title: field(body.title) || "question",
		question,
		options: options.slice(0, 4),
		allowFreeText: body.allowFreeText !== false,
		status: "open",
		at: Date.now(),
		expiresAt: Date.now() + ASK_TIMEOUT_MS,
		...(rootOf(board, body)
			? { threadRoot: anchorOf(board, rootOf(board, body)), ownerThread: rootOf(board, body) }
			: {}),
	};
	board.cards.set(card.id, card);
	broadcast(board, { type: "card", card: plainCardFor(card, board) });
	scheduleSave(board);

	const settled = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			settleQuestion(board, card, "expired");
		}, ASK_TIMEOUT_MS);
		board.askers.set(card.id, {
			resolve: (value) => {
				clearTimeout(timer);
				resolve(value);
			},
		});
		// A closed tab must not leave the child's turn waiting for a click nobody can make.
		res.on("close", () => {
			if (card.status !== "open") return;
			settleQuestion(board, card, "expired");
		});
	});
	if (settled.status === "answered") answer(res, 200, { cardId: card.id, answer: settled.answer ?? "" });
	else fail(res, 409, "nobody answered this question");
}

/** The human's click, arriving from whichever tab they were looking at. */
async function onAnswer(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const card = board.cards.get(String(body.cardId ?? ""));
	if (!card || card.type !== "question") return void fail(res, 404, "no such question");
	if (card.status !== "open") return void fail(res, 409, "that question is already settled");
	const reply = field(body.answer, 2000);
	if (!reply) return void fail(res, 400, "empty answer");
	settleQuestion(board, card, "answered", reply);
	answer(res, 200, { cardId: card.id });
}

async function onMessage(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return void fail(res, 400, "empty message");
	const mode = body.mode === "steer" ? "steer" : "queue";
	const asked = typeof body.cardId === "string" ? body.cardId : "";
	const fork = body.fork === true;
	// A thread answers about itself. A card without a child — a note, a source, a question — is asked
	// of the thread that made it, quoted, so the agent that wrote it is the one that answers. A fork,
	// or a thread that has since ended, starts a thread of its own under the card instead.
	const askedCard = asked ? board.cards.get(asked) : undefined;
	let thread = asked && !askedCard ? board.threads.get(asked) : undefined;
	if (asked && !askedCard && !thread) return void fail(res, 409, "no such card");
	// Only an existing thread answering for its own card keeps the question on that card. A fork, or
	// a card nobody answers for, gets a thread of its own, and a thread card is where its turns belong.
	let answeredByOwner = false;
	if (askedCard && !fork) {
		// Boards written before ownership was its own field have only the thread that made the card.
		const ownerId = askedCard.ownerThread ?? askedCard.threadRoot;
		const owner = ownerId ? board.threads.get(ownerId) : undefined;
		if (owner && owner.status !== "dead") {
			thread = owner;
			answeredByOwner = true;
		}
	}
	const preamble = askedCard ? cardPreamble(askedCard, !answeredByOwner) : "";
	if (!thread) {
		// A card gets a child, not a second card: the child answers for the card and is not drawn,
		// because the card already is the surface this conversation is read on.
		const title = askedCard?.title ?? text;
		thread = {
			id: randomUUID(),
			title: title.slice(0, 60),
			sessionId: null,
			status: "idle",
			...runtimeDefaults(board),
			at: Date.now(),
			turns: [],
			queued: [],
			...(askedCard ? { threadRoot: askedCard.id, behind: askedCard.id } : {}),
			folder: board.folder,
		};
		board.threads.set(thread.id, thread);
		// Only a thread with a card of its own is drawn; a child behind a card is announced through it.
		if (askedCard) updateCard(board, askedCard);
		else card(board, thread);
		// The thread that answers for a card owns it. That is what makes a fork a fork: the new thread
		// inherits this card, and every later comment on it is answered by the new thread.
		if (askedCard) {
			askedCard.ownerThread = thread.id;
			updateCard(board, askedCard);
		}
	}
	if (thread.status === "dead") return void fail(res, 409, "thread ended");

	// The card shows what the human typed; the child is told what card it is about. A comment on a
	// card is kept on that card, so its chain reads there and the thread card keeps only what was
	// asked on it directly.
	const message = `${preamble}${text}`;
	let target = null;
	let index;
	if (askedCard) {
		askedCard.turns = askedCard.turns ?? [];
		// A steer joins the run in flight, so the turn is already being acted on.
		askedCard.turns.push({ text: text.slice(0, 4000), status: mode === "steer" ? "sent" : "queued", mode, at: Date.now() });
		index = askedCard.turns.length - 1;
		target = { cardId: askedCard.id, turn: index };
		updateCard(board, askedCard);
	} else {
		thread.turns.push({ text: text.slice(0, 4000), status: "queued", mode, at: Date.now() });
		index = thread.turns.length - 1;
		update(board, thread);
	}
	const running = thread.status === "running";
	if (running && mode === "steer") {
		// A steer joins the run in flight instead of waiting behind it.
		try {
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "steer", message })}\n`);
		} catch (error) {
			threadError(board, thread, `could not steer the child: ${error.message}`);
		}
	} else if (running) {
		thread.queued.push({ message, text, target });
	} else {
		prompt(board, thread, message, target);
	}
	answer(res, 200, { id: thread.id, turn: index });
}

/**
 * Every card this thread answers for carries its runtime, so a model or level change has to reach those
 * cards as well as the thread's own card. A card that is not told keeps showing the old model.
 */
function refreshOwned(board, thread) {
	for (const held of board.cards.values()) {
		if (held.ownerThread === thread.id) updateCard(board, held);
	}
}

/**
 * The thread a runtime choice applies to. A card id names the thread that answers for the card, so the
 * composer can set the model of a card whose child is not drawn anywhere.
 */
function threadForRuntime(board, cardId) {
	const id = String(cardId ?? "");
	const thread = board.threads.get(id);
	if (thread) return thread;
	const card = board.cards.get(id);
	const ownerId = card ? (card.ownerThread ?? card.threadRoot) : "";
	return ownerId ? board.threads.get(ownerId) : undefined;
}

/**
 * Choosing the model a thread answers with. Without a `cardId` the choice belongs to the board
 * instead, which is what the next thread starts with; with one it is written on the thread and sent
 * to a live child, which uses it for its next request.
 */
async function onModel(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const provider = field(body.provider, 80);
	const model = field(body.model, 120);
	if (!provider || !model) return void fail(res, 400, "provider and model are required");
	const { models } = await modelCatalog();
	if (models.length && !models.some((one) => one.provider === provider && one.model === model)) {
		return void fail(res, 409, `${provider}/${model} is not a model this machine has`);
	}
	const thread = threadForRuntime(board, body.cardId);
	if (!thread || thread.status === "dead") {
		// Nothing answers this card any more, so the choice belongs where the next child comes from.
		board.defaults = { ...(board.defaults ?? {}), provider, model };
		scheduleSave(board);
		return void answer(res, 200, { defaults: board.defaults });
	}
	thread.provider = provider;
	thread.model = model;
	// A child whose stdin is closing is not this thread's voice any more; the next one starts with the
	// choice. Writing to it would end the thread with "write after end".
	const child = board.children.get(thread.id);
	if (child?.stdin?.writable) {
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "set_model", provider, modelId: model })}\n`);
	}
	update(board, thread);
	refreshOwned(board, thread);
	answer(res, 200, { card: thread.behind ? plainCardFor(board.cards.get(thread.behind), board) : cardFor(thread) });
}

/** The thinking level, with the same shape: a thread's own, or the board's default for new ones. */
async function onThinking(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const level = field(body.level, 20);
	if (!THINKING_LEVELS.includes(level)) return void fail(res, 400, `a level is one of ${THINKING_LEVELS.join(", ")}`);
	const thread = threadForRuntime(board, body.cardId);
	if (!thread || thread.status === "dead") {
		board.defaults = { ...(board.defaults ?? {}), thinking: level };
		scheduleSave(board);
		return void answer(res, 200, { defaults: board.defaults });
	}
	thread.thinking = level;
	const child = board.children.get(thread.id);
	if (child?.stdin?.writable) {
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "set_thinking_level", level })}\n`);
	}
	update(board, thread);
	refreshOwned(board, thread);
	answer(res, 200, { card: thread.behind ? plainCardFor(board.cards.get(thread.behind), board) : cardFor(thread) });
}

async function onLayout(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = String(body.cardId ?? "");
	// A plain card is dragged and resized like a thread, and its place is kept the same way.
	const held = board.threads.get(id) ?? board.cards.get(id);
	const rect = body.rect;
	if (!held || !rect) return void fail(res, 409, "no such card");
	const clamp = (value) => Math.max(0, Math.min(40000, Math.round(Number.isFinite(Number(value)) ? Number(value) : 0)));
	held.rect = { x: clamp(rect.x), y: clamp(rect.y), w: clamp(rect.w), h: clamp(rect.h) };
	if (typeof body.mini === "boolean") held.mini = body.mini;
	broadcast(board, { type: "move", id: held.id, rect: held.rect, mini: held.mini === true });
	scheduleSave(board);
	answer(res, 200, { placed: held.id });
}

async function onClose(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = String(body.cardId ?? "");
	const plain = board.cards.get(id);
	if (plain) {
		board.cards.delete(id);
		forgetCard(board, id);
		broadcast(board, { type: "remove", id });
		scheduleSave(board);
		answer(res, 200, { closed: id });
		return;
	}
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
				cards: cardsFor(board),
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
		// What the composer's pickers offer: every model this machine can run, and the levels pi names.
		if (req.method === "GET" && url.pathname === "/models") {
			answer(res, 200, await modelCatalog());
			return;
		}
		if (req.method === "GET" && url.pathname === "/state") {
			const board = boardFrom(url, res);
			if (!board) return;
			answer(res, 200, {
				workspace: describeWorkspace({ id: board.id, folder: board.folder, name: board.name, openedAt: 0 }),
				threads: [...board.threads.values()].map((thread) => ({ ...thread, live: board.children.has(thread.id) })),
				cards: cardsFor(board),
				activity: board.activity,
				meta: boardMeta(board),
			});
			return;
		}
		if (req.method === "POST") {
			const routing = {
				"/thread": onThread,
				"/card/note": onNote,
				"/card/source": onSource,
				"/card/ask": onAsk,
				"/edit": onEdit,
				"/answer": onAnswer,
				"/message": onMessage,
				"/layout": onLayout,
				"/close": onClose,
				"/model": onModel,
				"/thinking": onThinking,
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
