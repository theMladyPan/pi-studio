// @ts-nocheck -- the scaffold. Every module is lifted out of here; the pragma shrinks as they are typed.
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
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	readSync,
	renameSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
	BRIDGE,
	INSTANCE,
	PUBLIC_DIR,
	STATE_DIR,
	STATE_FILE,
	WORKSPACES_FILE,
	buildHash,
	randomToken,
	readJsonFile,
	workspaceId,
	writeJsonFile,
} from "./paths.ts";
/** Opening a browser is what a desktop app does; a service run asks for `--no-open`. */
export const OPEN_BROWSER = !process.argv.includes("--no-open");

export function sessionDir(workspace) {
	return join(STATE_DIR, "sessions", workspace.id);
}

// ---------- the git picture the strip draws -------------------------------

/** Where a board keeps the trees it makes, inside the repository the workspace is. */
export const AGENTS_DIR = ".agents";

// ---------- worktrees ------------------------------------------------------

/** The kinds of branch a thread can be given, and the words in a title that pick one. */
export const WORK_TYPES = [
	["fix", /\b(fix|fixed|bug|broken|breaks|repair|wrong|fails?|failing|regression)\b/],
	["refactor", /\b(refactor|rename|extract|split|move|tidy|simplif(y|ies)|clean ?up)\b/],
	["docs", /\b(docs?|readme|document|documentation|comment|comments)\b/],
	["test", /\b(tests?|spec|specs|coverage)\b/],
	["chore", /\b(chore|bump|upgrade|deps?|dependencies|lint)\b/],
];

/** The kind of change a title reads like, so a branch says what it carries. */
export function workType(title, wanted) {
	if (WORK_TYPES.some(([type]) => type === wanted)) return wanted;
	const words = String(title ?? "").toLowerCase();
	return WORK_TYPES.find(([, pattern]) => pattern.test(words))?.[0] ?? "feat";
}

/** A title as a branch and folder segment: lowercase words with hyphens between them. */
export function slugOf(text) {
	return (
		String(text ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40) || "work"
	);
}

/**
 * What a thread's branch and folder are told apart by: the first eight hex of its own id.
 * `8c53f1d7` is unique without a counter and without a suffix for two threads that share a title,
 * and it is short enough to read in a path.
 */
export function shortId(thread) {
	return String(thread.id).slice(0, 8);
}

/**
 * The tree a thread works in, made the first time it is asked to do something. A board runs several
 * threads against one folder; a tree of its own is what keeps two of them out of the same file, and
 * what the card can point at when the human wants to see the work.
 */
export function ensureWorktree(board, thread) {
	if (thread.worktree) return thread.worktree;
	const repo = repoOf(thread.folder ?? board.folder);
	if (!repo) {
		thread.worktree = { skipped: "this folder is not a git repository" };
		return thread.worktree;
	}
	const base = baseRef(repo);
	if (!base) {
		thread.worktree = { skipped: "the repository has no branch to cut from" };
		return thread.worktree;
	}
	const short = shortId(thread);
	const path = join(repo, AGENTS_DIR, short);
	// Detached on purpose. A branch is a name for work, and the work is not known until the child has
	// read the code: a name invented from the request is one the work has to be renamed out of later,
	// and a request that is only a question never earns a branch at all.
	const added = gitIn(repo, ["worktree", "add", "--detach", path, base], 10_000);
	if (!added.ok) {
		thread.worktree = { skipped: `git worktree add failed: ${added.err.split("\n")[0] || "no reason given"}` };
		return thread.worktree;
	}
	const tree = {
		path,
		base,
		repo,
		// A tree git can see is a tree in `git status` of the main checkout, which is what the human
		// reads. Said on the card rather than fixed behind their back.
		ignored: gitIn(repo, ["check-ignore", "--quiet", join(AGENTS_DIR, short)]).ok,
		thread: thread.id,
		title: thread.title,
		at: Date.now(),
	};
	// The board keeps the record, not only the thread: a thread that is closed or cleared would
	// otherwise leave a tree on disk that nothing knows about, and no later `clean` could retire it.
	board.trees.push(tree);
	thread.worktree = tree;
	return tree;
}

/** Where a thread works: its own tree while that is still on disk, else the workspace folder. */
export function workdirOf(board, thread) {
	const tree = thread.worktree;
	return tree?.path && existsSync(tree.path) ? tree.path : board.folder;
}

/** The branch a tree is standing on, or "" while it is detached or unreadable. */
export function headBranch(path) {
	const head = gitIn(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return head.ok && head.out && head.out !== "HEAD" ? head.out : "";
}

/** How long a thread's name may be before the first request is cut at a word. */
export const TITLE_FROM_REQUEST_CHARS = 48;
/**
 * The model that names a thread once its first request is in hand. Empty turns naming off.
 * `inception/mercury-3` was the first choice and answers 404 (no endpoints for the routing this
 * machine gets), so the default is the fastest flash model measured here: 2.1s against 10.7s for the
 * copilot one. Any other model is a `PI_STUDIO_NAME_MODEL` away.
 */
export const NAME_MODEL = process.env.PI_STUDIO_NAME_MODEL ?? "openrouter/z-ai/glm-5.3-flash";
export const NAME_TIMEOUT_MS = 8000;
/** Names that describe the fact that a job exists rather than the job. */
export const DULL_TITLES = new Set(["work", "job", "task", "thread", "new thread", "change", "update", "stuff", "question"]);

/**
 * A thread's name from its own first request: the first line, without the markdown that dresses it,
 * cut at a word. It exists so no card is ever nameless and none is called `thread 1`, and so a model
 * that is slow or absent costs a better name rather than any name at all.
 */
export function titleFromRequest(text) {
	const line =
		String(text ?? "")
			.split("\n")
			.map((part) => part.trim())
			.find(Boolean) ?? "";
	const plain = line.replace(/[`*_>#]/g, "").replace(/\s+/g, " ").trim();
	if (plain.length <= TITLE_FROM_REQUEST_CHARS) return plain;
	const cut = plain.slice(0, TITLE_FROM_REQUEST_CHARS);
	const space = cut.lastIndexOf(" ");
	return `${(space > 20 ? cut.slice(0, space) : cut).trim()}…`;
}

/**
 * What to ask the naming model. The gate below is code rather than the model's opinion, so the
 * examples say what a good card name looks like instead of pleading for one.
 */
export function namePrompt(request) {
	return [
		"Name this job for a card on a board of work. Answer with two to four plain words and nothing else.",
		"Examples:",
		'- request: "why does the parser reject empty input?" -> ok: empty input rejection / not ok: parser (says nothing) or: The Parser Rejects Empty Input Because The Tokenizer Splits Wrong (a sentence)',
		'- request: "add a dark theme to the board" -> ok: board dark theme / not ok: add a dark theme to the board (the request repeated)',
		'- request: "the rail keeps no detail for a row" -> ok: rail row detail / not ok: bug (a category, not the work)',
		`Request: ${request}`,
	].join("\n");
}

/** A name as a card title, or "" when it is not one: two to four words that say something. */
export function plausibleTitle(answer) {
	const first =
		String(answer ?? "")
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	const words = first.replace(/[`*_"']/g, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
	const lower = words.toLowerCase();
	if (!lower || DULL_TITLES.has(lower) || /^thread (\d+|[0-9a-f]{8})$/.test(lower)) return "";
	const count = lower.split(" ").length;
	return count >= 2 && count <= 4 ? words : "";
}

/**
 * One question and one answer from a `pi` that must not read stdin: `execFile` leaves stdin an open
 * pipe, and a `pi -p` on an open pipe waits for input that never comes.
 */
export function askOnce(argv, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve("");
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve("");
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out);
		});
	});
}

/**
 * A better name for a thread than its request's own words, asked beside the turn so no model's latency
 * sits in front of the answer. A name the human typed, or one already given by the model, is never
 * overwritten.
 */
export async function nameThread(board, thread, request) {
	const asked = request.slice(0, 2000);
	const cli = piCli();
	const argv = [cli.command, ...cli.args, "-p", "--no-session", "-ne", "-nt", "-nc", "-ns", "--model", NAME_MODEL];
	const said = await askOnce([...argv, namePrompt(asked)], NAME_TIMEOUT_MS);
	const picked = plausibleTitle(said);
	if (!picked) {
		// Said out loud because a name that never arrives looks exactly like a model that is not here.
		console.error(`pi-studio: naming gave no usable name (${JSON.stringify(said.slice(0, 80))})`);
		return;
	}
	// The card may be gone, renamed by the human, or named again while the model was thinking.
	if (!board.threads.has(thread.id) || thread.namedBy !== "request") return;
	thread.title = picked.slice(0, MAX_TITLE_CHARS);
	thread.namedBy = NAME_MODEL;
	update(board, thread);
	scheduleSave(board);
}

/**
 * What the tree has become since the last turn: the branch the child cut for itself, or a branch the
 * board has to cut on its behalf.
 *
 * A child is told to branch before it edits. One that skipped that and committed on the detached base
 * left its commits reachable from the reflog alone, where a sweep reads the tree as empty, so the work
 * is named here rather than lost. The name comes from the commit it wrote, which is the one piece of
 * text that describes what the work turned out to be.
 */
export function settleTreeBranch(board, thread) {
	const tree = thread.worktree;
	if (!tree?.path || !existsSync(tree.path)) return;
	const head = headBranch(tree.path);
	if (head) {
		if (head === tree.branch) return;
		tree.branch = head;
		scheduleSave(board);
		return;
	}
	const ahead = gitIn(tree.path, ["rev-list", "--count", `${tree.base}..HEAD`]);
	if (!ahead.ok || Number(ahead.out) < 1) return;
	const subject = gitIn(tree.path, ["log", "-1", "--format=%s"]).out;
	// The subject carries its own `<type>:` prefix, and a branch that reads `chore/chore-add-a-file` says
	// the kind of change twice. The prefix already chose the type, so the slug is what follows it.
	const bare = subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "");
	const slug = slugOf(bare);
	const branch = `${workType(subject, thread.type)}/${slug === "work" ? "wip" : slug}-${shortId(thread)}`;
	if (!gitIn(tree.path, ["checkout", "-b", branch]).ok) return;
	tree.branch = branch;
	scheduleSave(board);
}

/**
 * Let a tree go, but only one with nothing worth keeping: uncommitted changes or a commit the base
 * does not have are reported, never deleted. `clean` is the only caller, so a tree outlives its thread
 * until the human asks for the sweep.
 */
export function retireWorktree(board, tree) {
	if (!tree?.path) return null;
	const repo = (existsSync(tree.path) ? mainRepoOf(tree.path) : "") || tree.repo || repoOf(board.folder);
	// A tree still on its detached base has no branch yet, so what it holds is asked of HEAD inside the
	// tree. `tree.branch` is only filled in once the child cut one or the board cut one for it.
	const branch = typeof tree.branch === "string" ? tree.branch : "";
	const label = branch || `detached at ${tree.base}`;
	if (!repo) return { path: tree.path, branch: label, kept: "not a repository any more" };
	if (existsSync(tree.path)) {
		const dirty = gitIn(tree.path, ["status", "--porcelain"]);
		if (!dirty.ok) return { path: tree.path, branch: label, kept: "git could not read it" };
		if (dirty.out) {
			return { path: tree.path, branch: label, kept: `${dirty.out.split("\n").length} uncommitted change(s)` };
		}
	} else {
		// A tree somebody deleted by hand is already gone; its registration in .git/worktrees is not.
		gitIn(repo, ["worktree", "prune"]);
	}
	// A branch deleted by hand takes the tree with it in every real case, so the record has nothing left
	// to protect. Without this check the unreadable count below would report a phantom tree for ever.
	if (branch && !gitIn(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
		const gone = board.trees.findIndex((candidate) => candidate.path === tree.path);
		if (gone !== -1) board.trees.splice(gone, 1);
		return { path: tree.path, branch: label, removed: true, note: "the branch is already gone" };
	}
	// The branch is what holds the work, and a count git cannot read is not a zero: a renamed or
	// deleted base made `rev-list` fail here once and the branch was deleted with commits on it.
	const ahead = branch
		? gitIn(repo, ["rev-list", "--count", `${tree.base}..${branch}`])
		: existsSync(tree.path)
			? gitIn(tree.path, ["rev-list", "--count", `${tree.base}..HEAD`])
			: { ok: false, out: "" };
	if (!ahead.ok) {
		return { path: tree.path, branch: label, kept: `could not read ${tree.base}..${branch || "HEAD"}` };
	}
	const commits = Number(ahead.out) || 0;
	if (commits > 0) return { path: tree.path, branch: label, kept: `${commits} commit(s) not in ${tree.base}` };
	if (existsSync(tree.path)) {
		const removed = gitIn(repo, ["worktree", "remove", tree.path], 10_000);
		if (!removed.ok) {
			return { path: tree.path, branch: label, kept: removed.err.split("\n")[0] || "could not be removed" };
		}
		// A tree made by the older `<agent>/<slug>` layout leaves an empty folder behind; one made by the
 		// current layout sits directly in `.agents` and must not take that folder with it. `rmdir`
		// refuses a folder that still holds another thread's tree, which is the answer wanted.
		if (basename(dirname(tree.path)) !== AGENTS_DIR) {
			try {
				rmdirSync(dirname(tree.path));
			} catch {
				// Something else lives there, or it is already gone.
			}
		}
	}
	// Nothing is ahead of the base, so the branch holds no work of its own. A detached tree has no branch
	// to delete: its commits were never given a name, and there were none.
	const branchGone = branch ? gitIn(repo, ["branch", "-D", branch]) : { ok: true, out: "" };
	const at = board.trees.findIndex((candidate) => candidate.path === tree.path);
	if (at !== -1) board.trees.splice(at, 1);
	return {
		path: tree.path,
		branch: label,
		removed: true,
		...(branchGone.ok ? {} : { branchKept: branchGone.err.split("\n")[0] || "git refused" }),
	};
}

/** How much of the app's own state a workspace holds: its sessions on disk. */
export function sessionFacts(workspace) {
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

/**
 * The folder a session was started in, from the header of its file. pi looks `--session <id>` up in the
 * folder it is started in, so whether a thread still belongs where its session was recorded decides how
 * the child has to be started; see `childArgv`. Empty when there is no such session or no header.
 */
export function sessionCwd(dir, id) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return "";
	}
	// pi names a session file `<timestamp>_<id>.jsonl`, and the file itself is where the id is kept.
	const name = names.find((entry) => entry.endsWith(`_${id}.jsonl`));
	if (!name) return "";
	// Only the header matters, and a long session is megabytes, so the start of the file is enough.
	try {
		const handle = openSync(join(dir, name), "r");
		const head = Buffer.alloc(4096);
		const read = readSync(handle, head, 0, head.length, 0);
		closeSync(handle);
		const header = JSON.parse(head.subarray(0, read).toString("utf8").split("\n")[0]);
		return typeof header.cwd === "string" ? header.cwd : "";
	} catch {
		return "";
	}
}

/** The session file pi wrote for a thread, or "" while it has none. */
export function sessionFile(workspace, id) {
	const dir = sessionDir(workspace);
	try {
		const name = readdirSync(dir).find((entry) => entry.endsWith(`_${id}.jsonl`));
		return name ? join(dir, name) : "";
	} catch {
		return "";
	}
}

/** How much of a transcript a drawer asks for, and how much of one block it shows. */
export const TRANSCRIPT_ENTRIES = 600;
export const TRANSCRIPT_BLOCK_CHARS = 4000;

/** One line of an argument object, for the head of a tool call. */
export function argLine(value, width = 120) {
	let text = "";
	if (typeof value === "string") text = value;
	else if (value && typeof value === "object") {
		const pick = ["command", "path", "file", "query", "pattern", "url", "text", "selector"];
		const key = pick.find((name) => typeof value[name] === "string");
		text = key ? value[key] : JSON.stringify(value);
	}
	return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, width);
}

/**
 * A thread's conversation as the drawer reads it: the session file, one entry per thing that happened.
 *
 * This is the rendered conversation rather than the child's protocol stream, because the stream is JSON
 * frames and what a human sees in a terminal is the conversation those frames carry. A block longer
 * than `TRANSCRIPT_BLOCK_CHARS` is cut: a tool result can be megabytes of build output, and a drawer
 * that hands the browser one is a tab that stops answering.
 */
export function transcriptOf(file) {
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const entries = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			// A line cut in half by a crash is not a message.
			continue;
		}
		if (record?.type !== "message") continue;
		const message = record.message ?? {};
		const role = message.role ?? "";
		// The system prompt is the same wall of text in every thread; the drawer is for the conversation.
		if (role === "system") continue;
		const blocks = Array.isArray(message.content) ? message.content : [];
		for (const block of blocks) {
			const kind =
				block?.type === "thinking"
					? "thinking"
					: block?.type === "toolCall"
						? "call"
						: role === "user"
							? "user"
							: role === "toolResult"
								? "result"
								: role === "assistant" && block?.type === "text"
									? "answer"
									: "";
			if (!kind) continue;
			const text = kind === "call" ? `${block.name ?? "tool"} ${argLine(block.arguments)}` : String(block?.text ?? block?.thinking ?? "");
			entries.push({
				kind,
				text: text.slice(0, TRANSCRIPT_BLOCK_CHARS),
				...(kind === "call" && block.name ? { tool: String(block.name) } : {}),
			});
		}
	}
	return entries.length > TRANSCRIPT_ENTRIES ? entries.slice(-TRANSCRIPT_ENTRIES) : entries;
}

/** Two folders naming the same place: a worktree reached through a symlink is still the same worktree. */
export function sameFolder(one, other) {
	if (!one || !other) return false;
	const real = (path) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return real(one) === real(other);
}

// ---------- the child ------------------------------------------------------

/**
 * The CLI a child needs. Same order as the rest of the tooling: the script this process is already
 * running pi from, then the managed install, then the `pi` binary on PATH.
 */
/** Where pi keeps the install this app drives, and the extensions beside it. */
export function installRoot() {
	return process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
}

export function extensionsDir() {
	return join(dirname(installRoot()), "extensions");
}

export function piCli() {
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
export function describeTool(name, args) {
	if (name === "read" || name === "write" || name === "edit") return `${name} ${String(args.path ?? args.file_path ?? "")}`.trim();
	if (name === "bash") {
		const command = String(args.command ?? "").replace(/\s+/g, " ");
		return `$ ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`;
	}
	if (name === "grep") return `grep ${String(args.pattern ?? "")}`;
	if (name === "find") return `find ${String(args.pattern ?? "*")}`;
	return name;
}

/** The one line of an error a card can show, or what to say when pi gave no reason. */
export function headline(text) {
	return (
		String(text ?? "")
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0)
			?.slice(0, 160) ?? "the run failed"
	);
}

/** The text a tool result carries, in the order the tool said it. */
export function resultText(result) {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content
		.filter((part) => part?.type === "text")
		.map((part) => String(part.text ?? ""))
		.join("\n");
}

/** What a rail row says once the call is over: its first line of output, cut short. */
export function firstLine(result) {
	return resultText(result).split("\n").map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 140) ?? "";
}

/** A field of a row, cut to the ceiling and saying whether it was. */
export function ceiling(value) {
	const text = String(value ?? "");
	return { text: text.slice(0, MAX_ROW_CHARS), cut: text.length > MAX_ROW_CHARS };
}

/**
 * A tool's arguments with any one string cut to the ceiling, so a call that carries a whole file keeps
 * its shape and the panel still knows what tool it is looking at.
 */
export function keptArgs(args, cut) {
	if (!args || typeof args !== "object") return args;
	const hold = (value) => {
		if (typeof value !== "string") return value;
		const held = ceiling(value);
		if (held.cut) cut.add("args");
		return held.text;
	};
	// One level is enough: the arguments pi tools take are a flat record, or a list of flat records.
	const keep = (one) => {
		if (!one || typeof one !== "object") return hold(one);
		const out = {};
		for (const [key, value] of Object.entries(one)) out[key] = hold(value);
		return out;
	};
	if (Array.isArray(args)) return args.map(keep);
	const out = {};
	for (const [key, value] of Object.entries(args)) out[key] = Array.isArray(value) ? value.map(keep) : keep(value);
	return out;
}

/**
 * What a finished call leaves behind: the words it said, the diff it made, its exit code, and the
 * picture it took. The panel draws these fields; nothing here is a JSON dump of the result, which is
 * why most of what a row used to weigh is gone.
 */
export function rowResult(result) {
	// A tool may hand its result over as bare text rather than as parts.
	if (typeof result === "string") return { output: ceiling(result).text };
	const content = Array.isArray(result?.content) ? result.content : [];
	const cut = new Set();
	const said = ceiling(resultText(result));
	if (said.cut) cut.add("output");
	// A tool that said nothing in words still has to be readable, so its JSON is the last resort.
	const dump = !said.text && result !== undefined ? ceiling(JSON.stringify(result, null, 2)) : null;
	if (dump?.cut) cut.add("output");
	const output = said.text || dump?.text || "";
	const details = result?.details && typeof result.details === "object" ? result.details : {};
	const structured = result?.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : {};
	const diff = typeof details.diff === "string" && details.diff ? ceiling(details.diff) : null;
	if (diff?.cut) cut.add("diff");
	// Only the newest picture is kept: a screenshot is read while the row is open, and a row holds one.
	const image = [...content].reverse().find((part) => part?.type === "image" && part.data);
	return {
		output,
		...(diff ? { diff: diff.text } : {}),
		...(Number.isFinite(structured.exit_code) ? { exitCode: structured.exit_code } : {}),
		...(resultsTruncated(structured) ? { truncated: true } : {}),
		...(image ? { images: [{ mime: String(image.mimeType || "image/png"), data: String(image.data) }] } : {}),
		...(cut.size ? { cut: [...cut] } : {}),
	};
}

/** Whether the tool itself says it cut what it returned, which is worth saying in the panel. */
export function resultsTruncated(structured) {
	return structured.truncated === true || structured.truncated === "true";
}

/** The last line a child wrote on stderr, which is often the only explanation there is. */
export function lastLine(tail) {
	const lines = String(tail ?? "")
		.replace(/\u001b\[[0-9;]*m/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines[lines.length - 1]?.slice(0, 160) ?? "";
}

/**
 * What a thread is told about the folder it works in. The board makes the tree before the child is
 * spawned, so this is a fact to report, not an instruction to obey: `2e6c8db` asked the child to run
 * `git worktree add` itself, and a rule a model may skip is a rule that half the time is skipped.
 *
 * The tree starts detached, so the branch is the one thing here the child does create. It is told to
 * cut it before its first edit and to name it after the work it turned out to be, because a name
 * decided from the request describes the question rather than the answer.
 */
export function worktreePrompt(board, thread) {
	const tree = thread.worktree;
	const short = shortId(thread);
	const lines = [];
	if (tree?.path) {
		lines.push(
			`Other threads may be working in ${board.folder} at the same time. The board gives each thread its own git worktree, so a change of yours cannot collide with one of theirs.`,
			`Your worktree is ${tree.path}, detached on ${tree.base}: no branch has been cut yet, and nothing is committed there. Read and analyze in it as long as you like without one.`,
			`Before your first edit, cut your own branch with \`git checkout -b <type>/<slug>-${short}\`: <type> is fix, feat, refactor, docs, test or chore, and <slug> says what the work turned out to be, in kebab-case. Commit there. A request that only asks a question leaves the tree detached and writes no branch.`,
			`That tree is yours alone. Stay on your branch while you edit and commit: it is your playground, and the human reads it as your work. You may check out ${tree.base} or another branch to read and compare, as long as nothing is left uncommitted when you switch back.`,
			`If the work turns out to be something other than the branch name says, rename it with \`git branch -m <type>/<slug>-${short}\` and report the new name.`,
			`If files changed, name the branch and the path in one clause; nothing more. Nobody merges for you: cutting a branch and merging one are the human's decisions.`,
		);
		if (!existsSync(tree.path)) {
			lines.push(
				`That tree is no longer on disk, so work in ${board.folder} and say so when you report.`,
			);
		}
		if (tree.ignored === false) {
			lines.push(
				`\`.agents/\` is not in that repository's .gitignore, so the tree shows up as an untracked folder in the main checkout. Say so when you report; do not edit .gitignore unless the job asks for it.`,
			);
		}
	} else {
		lines.push(
			`No worktree was made: ${tree?.skipped ?? "the board has none for this thread"}. Work in ${board.folder} itself, where there is no branch to cut and no separate tree: edit the files in place, and say so when you report.`,
		);
	}
	lines.push(
		"Examples of right and wrong:",
		`- right: the job is to rewrite the parser in a repository: read first, cut \`feat/rewrite-the-parser-${short}\`, edit files under ${tree?.path ?? `${board.folder}/${AGENTS_DIR}/<your tree>`}, commit there, and stop.`,
		`- right: "how does the router pick a board?" is answered with reads on the detached tree, which stays detached and holds no branch.`,
		`- wrong: cutting a branch named after the request before you have read anything, or editing parser.ts in ${board.folder} itself, or merging your branch into ${tree?.base ?? "the base branch"}, because another thread may have the same files open.`,
	);
	return lines.join("\n");
}

/**
 * The thread's own card, and the board around it, said plainly enough that an agent uses it.
 *
 * The board is the product, and the chat is only the wire under it: the answer is a pointer to the
 * cards, so a thread that writes its findings in prose has done the work where nobody reads it.
 */
export function boardPrompt(board, thread) {
	const workdir = workdirOf(board, thread);
	return [
		`You are thread "${thread.title}" on a board, working in the folder ${workdir}.`,
		`The workspace this board opened is ${board.folder}, which is where the rest of the board reads files from.`,
		"The human reads cards on that board, not a chat log or a terminal. Put the work on cards.",
		"What you say in the chat is a pointer to those cards, one or two lines: like \"I read the request; the shapes are in [[errors-by-hour]] and the plan in [[fix-plan]]\". A bare [[key]] links the card, and the human clicks it.",
		"A [[key]] only works if the card carries that exact key, so pass a short key to board_note every time and name the card by it.",
		"Do not narrate what you are about to do, and do not add a summary under the pointer. \"I will read both files first\" and \"short version: ...\" are both the report the cards were meant to replace.",
		"Examples:",
		'- right: "Two failing paths, both in the retry loop: [[retry-trace]] and the todo in [[retry-fix]]."',
		'- right: "The numbers did not support it, so the card [[load-shape]] is a corrected chart and one line of why."',
		'- wrong: a paragraph, or a list, restating what a card already says. That belongs on the card, not beside it.',
		"One card holds one kind of thing: a chart with its caption, a piece of markdown analysis, a diagram, a checklist, a tree, a snippet of source. A chart and a todo on the same card makes both harder to read, so split them.",
		"Look at the board before you write. If a card already covers the subject, revise it by passing its key again rather than adding a near-duplicate; open a new card for a new artefact.",
		"Prefer showing to telling: only fenced ```svg blocks and markdown tables are drawn, so a chart or a diagram is svg and never mermaid. board_note writes the card; board_source opens a real file, scrolled to a line, instead of quoting it.",
		"Detail on request: the human can ask you to expand anything in the chat, so do not spend the answer on a summary of what the board already shows.",
		worktreePrompt(board, thread),
	].join("\n");
}

/**
 * The extensions this board's threads load: what this machine has, less the folders the panel turned
 * off. A board is one human's answer to what these agents may do, so the switches are kept per board
 * and read when a child is spawned, which is why they land on the next thread.
 */
export function extensionsFor(board) {
	const off = new Set(board.config?.extensionsOff ?? []);
	return CHILD_EXTENSIONS.filter((one) => !off.has(one.name)).map((one) => one.path);
}

/** The built-in tools this board does not hand a new thread. */
export function toolsOffFor(board) {
	const off = board.config?.toolsOff;
	return Array.isArray(off) ? off.filter((name) => BUILTIN_TOOLS.includes(name)) : [];
}

export function childArgv(board, thread) {
	// A child writes its session where pi-studio keeps them, not in pi's own session list: this app
	// owns these conversations, and a thread that already has one resumes it so the card stays
	// continuous across a daemon restart.
	//
	// Unless the thread has moved since: pi resolves `--session <id>` against the folder the child is
	// started in, and a session recorded in the workspace folder belongs to another project once the
	// child runs in the thread's worktree. pi's answer to that is a question on stdin — "Fork this
	// session into current directory? [y/N]" — and a board never answers it, so the child exits before
	// it settles and the card reads that question as its error. `--fork` is the same move without the
	// question: the history comes along into the folder the thread works in now, and the new id the
	// child reports on `get_state` is what the next run resumes.
	const workdir = workdirOf(board, thread);
	const recorded = thread.sessionId ? sessionCwd(sessionDir(board), thread.sessionId) : "";
	const moved = recorded && !sameFolder(recorded, workdir);
	const session = thread.sessionId ? [moved ? "--fork" : "--session", thread.sessionId] : [];
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
		...extensionsFor(board).flatMap((path) => ["-e", path]),
		// No allowlist unless one was asked for: a thread gets the tools a console pi gets.
		...(TOOLS ? ["--tools", TOOLS] : []),
		// What the board itself leaves out, by pi's own tool names. `--exclude-tools` is applied after
		// every other selection option, so a tool the panel turned off stays off.
		...(toolsOffFor(board).length ? ["--exclude-tools", toolsOffFor(board).join(",")] : []),
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
export function ensureChild(board, thread) {
	const existing = board.children.get(thread.id);
	if (existing && existing.exitCode === null && existing.stdin?.writable) return existing;
	const cli = piCli();
	const child = spawn(cli.command, [...cli.args, ...childArgv(board, thread)], {
		// A thread with a tree works in it: the child's whole notion of `here` is its own branch.
		cwd: workdirOf(board, thread),
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
			: /fork this session into current directory/i.test(thread.stderrTail ?? "")
				? "this thread's session was recorded in another folder and could not be carried into its worktree"
				: `child exited (${signal ?? code}) before it settled`;
		// A child that dies at startup says why on stderr, and that line is the whole explanation.
		const said = lastLine(thread.stderrTail);
		threadError(board, thread, said ? `${reason}: ${said}` : reason);
	});
	// RPC mode emits no session header, so get_state is the only place a session id can come from.
	child.stdin.write(`${JSON.stringify({ id: "session", type: "get_state" })}\n`);
	return child;
}

/** One prompt, either a new question or what was waiting behind the run in flight. */
export function prompt(board, thread, text, target = null) {
	// The tree is made here, before anything is spawned: this is the first moment the thread is going
	// to do something, and the child's working folder is decided by it.
	ensureWorktree(board, thread);
	// A thread with no name takes one from its first request: the request's own words at once, and a
	// better name from a fast model afterwards if it offers one.
	if (!thread.title) {
		thread.title = titleFromRequest(text) || shortId(thread);
		thread.namedBy = "request";
		update(board, thread);
		if (NAME_MODEL) void nameThread(board, thread, text);
	}
	// A question written on a card is answered on that card, and the run in flight remembers which
	// one, so the reply lands where the human typed rather than on the thread's own card.
	thread.answering = target;
	if (target) {
		const held = board.cards.get(target.cardId);
		const turn = held?.turns?.[target.turn];
		if (held && turn) {
			turn.status = "sent";
			// The caret says a run is writing this turn, from the moment it is asked: the first word
			// can take seconds, and a card that looks idle until then is a card that looks stuck.
			turn.streaming = true;
			updateCard(board, held);
		}
	} else {
		const turn = thread.turns[thread.turns.length - 1];
		if (turn) {
			turn.status = "sent";
			turn.streaming = true;
		}
	}
	thread.status = "running";
	thread.runStartedAt = Date.now();
	// A stop pressed before the child got going has nothing to abort yet; `onStop` remembers it and the
	// first event of the run repeats it.
	thread.abortWanted = false;
	// A new run starts with nothing said yet, whatever the last one left behind.
	thread.streamDone = "";
	thread.streamParts = new Map();
	thinkingRuns.delete(thread);
	update(board, thread);
	try {
		const child = ensureChild(board, thread);
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "prompt", message: text })}\n`);
	} catch (error) {
		threadError(board, thread, `could not send to the child: ${error.message}`);
	}
}

/**
 * How often a running answer reaches the browser. Deltas arrive far faster than anyone can read, and
 * every tick costs a whole card.
 */
export const STREAM_MS = 100;

/** The turn a running answer is written into, and the card that holds it when there is one. */
export function liveTurn(board, thread) {
	const asked = thread.answering ? board.cards.get(thread.answering.cardId) : undefined;
	const turn = thread.answering ? asked?.turns?.[thread.answering.turn] : thread.turns[thread.turns.length - 1];
	return { turn, card: asked };
}

/** The answer as it reads this instant: the messages that finished, then the one still arriving. */
export function runText(thread) {
	const arriving = [...(thread.streamParts?.values() ?? [])].join("");
	return [thread.streamDone ?? "", arriving].filter((part) => part).join("\n\n");
}

/**
 * The flush a thread has pending, kept off the thread itself: `/state` serialises whole threads, and a
 * Node timer is a circular object that would make that request throw.
 */
export const streamTimers = new WeakMap();

/** A flush still pending belongs to a run that is over, and is worth nothing. */
export function stopStream(thread) {
	const pending = streamTimers.get(thread);
	if (pending) clearTimeout(pending);
	streamTimers.delete(thread);
}

/**
 * Put what the child has said so far on the turn and tell the browsers. The board file is not
 * written: half a sentence is not a thing to reopen tomorrow.
 */
export function streamTick(board, thread) {
	streamTimers.delete(thread);
	// A child that has been written off is not producing an answer any more, whatever it still sends.
	if (thread.status !== "running") return;
	const { turn, card: held } = liveTurn(board, thread);
	if (!turn) return;
	turn.reply = runText(thread);
	turn.streaming = true;
	// The card that holds the turn is the one to repaint: a run answering a note writes the note's
	// turn, and a run answering its own card writes the card. Falling back to `homeCard` while the
	// thread is drawn would repaint an unrelated note the thread once wrote.
	if (held) broadcast(board, { type: "update", card: plainCardFor(held, board), quiet: true });
	else if (!thread.hidden) broadcast(board, { type: "update", card: cardFor(thread, board), quiet: true });
	else {
		const shown = homeCard(board, thread);
		if (shown) broadcast(board, { type: "update", card: plainCardFor(shown, board), quiet: true });
	}
}

// ---------- the thought ----------------------------------------------------

/**
 * A thought is not the answer and does not belong on the card, but it is the only thing a run says
 * while it is looking something up. So each thinking block gets a row of its own: four tails a second
 * while it streams, the whole block kept for the panel where it is actually read.
 */
export const THOUGHT_PUSH_MS = 250;
/** A few lines is all the rail can show, so the row carries the tail and no more. */
export const THOUGHT_TAIL = 400;
/** A few seconds of samples read as a rate, and cost nothing to keep. */
export const THOUGHT_WINDOW_MS = 5000;
/** Providers count thinking their own way; four characters each is the usual estimate. */
export const CHARS_PER_TOKEN = 4;

/**
 * The thinking blocks of the run in progress, off the thread itself: `/state` serialises whole threads,
 * and a Map is not part of a thread's shape.
 */
export const thinkingRuns = new WeakMap();
/**
 * The text of every block still streaming, by row id. A row carries only its tail while it runs, so
 * the panel reads the whole thought from here through `GET /activity/<id>`.
 */
export const liveThoughts = new Map();

/** The newest characters, without splitting a surrogate pair, so no emoji turns into a box. */
export function tailOf(text, keep) {
	const start = Math.max(0, text.length - keep);
	return /[\uDC00-\uDFFF]/.test(text[start] ?? "") ? text.slice(start + 1) : text.slice(start);
}

/** Tokens a second over the newest samples, which the rail labels as the estimate it is. */
export function thoughtRate(block) {
	const first = block.samples[0];
	const last = block.samples[block.samples.length - 1];
	const seconds = first && last ? (last.at - first.at) / 1000 : 0;
	return seconds > 0 ? Math.round((last.chars - first.chars) / seconds / CHARS_PER_TOKEN) : 0;
}

/** What a row carries while its block streams: the tail, the estimate, and the rate. */
export function pushThought(board, block) {
	patchRow(board, block.id, {
		status: "running",
		text: `${block.cut ? "…" : ""}${block.tail}`,
		rate: thoughtRate(block),
		tokens: Math.round(block.chars / CHARS_PER_TOKEN),
		tokensEstimated: true,
	});
}

export function thoughtState(thread) {
	let state = thinkingRuns.get(thread);
	if (!state) {
		state = { message: 0, blocks: new Map() };
		thinkingRuns.set(thread, state);
	}
	return state;
}

/** A block's own row, from its first delta to the end that carries the whole of it. */
export function thoughtEvent(board, thread, update, at) {
	const state = thoughtState(thread);
	const key = `${state.message}:${at}`;
	const now = Date.now();
	if (update.type === "thinking_start") {
		// The id is random rather than counted: a board keeps its rows, and the second run of a thread
		// must not take the id of the first run's block.
		const block = { id: `think-${randomUUID()}`, startedAt: now, chars: 0, tail: "", cut: false, samples: [], pushedAt: now, text: "" };
		state.blocks.set(key, block);
		liveThoughts.set(block.id, "");
		addRow(board, {
			id: block.id,
			kind: "thinking",
			label: "thinking",
			status: "running",
			startedAt: now,
			text: "",
			tokens: 0,
			tokensEstimated: true,
			thread: threadRef(thread),
		});
		return;
	}
	const block = state.blocks.get(key);
	if (!block) return;
	if (update.type === "thinking_delta") {
		const delta = String(update.delta ?? "");
		block.chars += delta.length;
		block.text += delta;
		block.tail += delta;
		if (block.tail.length > THOUGHT_TAIL) {
			block.tail = tailOf(block.tail, THOUGHT_TAIL);
			block.cut = true;
		}
		// The row keeps a tail, the panel the whole thought, and only that is worth a ceiling: a
		// thought this long is served on request rather than pushed with every tail.
		liveThoughts.set(block.id, block.text.slice(0, MAX_ROW_CHARS));
		// One sample per delta would cost more than the rate is worth, so a sample lands with each push.
		const last = block.samples[block.samples.length - 1];
		if (!last || now - last.at >= THOUGHT_PUSH_MS) {
			block.samples.push({ at: now, chars: block.chars });
			while (block.samples.length > 2 && block.samples[0].at < now - THOUGHT_WINDOW_MS) block.samples.shift();
		}
		// A fast provider would flood the stream, so a delta reaches the board four times a second.
		if (now - block.pushedAt >= THOUGHT_PUSH_MS) {
			block.pushedAt = now;
			pushThought(board, block);
		}
		return;
	}

	// The end carries the authoritative text, so the row follows it and stops with its total.
	const content = typeof update.content === "string" && update.content ? update.content : block.text;
	const over = content.length > THOUGHT_TAIL;
	patchRow(board, block.id, {
		status: "ok",
		durationMs: now - block.startedAt,
		text: `${over ? "…" : ""}${over ? tailOf(content, THOUGHT_TAIL) : content}`,
		thinking: content.slice(0, MAX_ROW_CHARS),
		...(content.length > MAX_ROW_CHARS ? { cut: ["thinking"] } : {}),
		rate: undefined,
		tokens: Math.round(Math.max(block.chars, content.length) / CHARS_PER_TOKEN),
		tokensEstimated: true,
	});
	liveThoughts.delete(block.id);
	state.blocks.delete(key);
}

/** A block that never got its end — an abort, a failure — stops where it stands and keeps what it said. */
export function settleThoughts(board, thread) {
	const state = thinkingRuns.get(thread);
	if (!state) return;
	for (const block of state.blocks.values()) {
		patchRow(board, block.id, {
			status: "stopped",
			durationMs: Date.now() - block.startedAt,
			...(block.text ? { thinking: block.text.slice(0, MAX_ROW_CHARS) } : {}),
			rate: undefined,
			tokens: Math.round(block.chars / CHARS_PER_TOKEN),
			tokensEstimated: true,
		});
		liveThoughts.delete(block.id);
	}
	state.blocks.clear();
	thinkingRuns.delete(thread);
}

/** A row as the panel reads it: the whole thought while it streams, the row's own text once it ends. */
export function rowWithThought(row) {
	const live = liveThoughts.get(row.id);
	return row.kind === "thinking" && typeof live === "string" ? { ...row, thinking: live } : row;
}

export function handleChildLine(board, thread, line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		process.stderr.write(`[${board.name}/${thread.title}] unparsed child line: ${line.slice(0, 200)}\n`);
		return;
	}
	if (event.type === "response") {
		if (event.command === "get_session_stats" && event.data?.tokens) {
			const data = event.data;
			// Context is what the last request carried, so it is the number a compaction turns on; the
			// totals are what this thread has spent since it started.
			thread.stats = {
				input: data.tokens.input ?? 0,
				output: data.tokens.output ?? 0,
				cacheRead: data.tokens.cacheRead ?? 0,
				total: data.tokens.total ?? 0,
				cost: typeof data.cost === "number" ? data.cost : 0,
				messages: data.totalMessages ?? 0,
				tools: data.toolCalls ?? 0,
				...(data.contextUsage ? { context: data.contextUsage.tokens ?? data.contextUsage.used } : {}),
				...(data.contextUsage?.maxTokens ? { contextMax: data.contextUsage.maxTokens } : {}),
			};
			if (thread.pendingClose) {
				thread.pendingClose = false;
				board.children.get(thread.id)?.stdin?.end();
			}
			update(board, thread);
			scheduleSave(board);
		} else if (event.command === "get_state" && typeof event.data?.sessionId === "string") {
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
				thread: threadRef(thread),
			});
		}
		return;
	}
	if (thread.abortWanted && (event.type === "turn_start" || event.type === "message_start")) {
		thread.abortWanted = false;
		try {
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`);
		} catch {
			// The child is gone; its exit says so.
		}
	}
	if (event.type === "message_start" && event.message?.role === "assistant") {
		// `contentIndex` counts from zero in every message, so a message is what keeps two blocks apart.
		thoughtState(thread).message += 1;
		return;
	}
	if (event.type === "message_update") {
		const next = event.assistantMessageEvent;
		const at = Number.isInteger(next?.contentIndex) ? next.contentIndex : 0;
		// A thought is what the run is doing while it says nothing, so it gets a row of its own.
		if (next?.type === "thinking_start" || next?.type === "thinking_delta" || next?.type === "thinking_end") {
			thoughtEvent(board, thread, next, at);
			return;
		}
		// A finished block is authoritative, so a delta dropped on the way cannot leave a hole. Tool
		// arguments ride the same stream and stay off the card.
		if (next?.type === "text_delta" || next?.type === "text_end") {
			thread.streamParts ??= new Map();
			const said = next.type === "text_end" ? String(next.content ?? "") : `${thread.streamParts.get(at) ?? ""}${String(next.delta ?? "")}`;
			thread.streamParts.set(at, said);
		} else {
			return;
		}
		if (!streamTimers.has(thread)) {
			const pending = setTimeout(() => streamTick(board, thread), STREAM_MS);
			pending.unref?.();
			streamTimers.set(thread, pending);
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		const cut = new Set();
		const args = keptArgs(event.args, cut);
		addRow(board, {
			id: String(event.toolCallId),
			kind: "tool",
			tool: String(event.toolName ?? "tool"),
			label: describeTool(event.toolName, args ?? {}),
			status: "running",
			startedAt: Date.now(),
			thread: threadRef(thread),
			args,
			...(cut.size ? { cut: [...cut] } : {}),
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		patchRow(board, String(event.toolCallId), {
			status: event.isError ? "error" : "ok",
			durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
			summary: firstLine(event.result),
			...rowResult(event.result),
		});
		return;
	}
	if (event.type === "turn_end" && event.message?.role === "assistant") {
		// A thought whose message ended without its end event stops where it stands.
		settleThoughts(board, thread);
		const message = event.message;
		const text = (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block?.type === "text")
			.map((block) => String(block.text ?? ""))
			.join("")
			.trim();
		const thinking = (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block?.type === "thinking")
			.map((block) => String(block.thinking ?? ""))
			.join("")
			.trim();
		// When the run was answering for a card, only that card may receive the reply. Falling back to
		// the thread's own turn would overwrite an older answer with a card's answer.
		const { turn, card: asked } = liveTurn(board, thread);
		// The answer is what the whole run said. A run that talks, calls a tool and talks again would
		// otherwise drop its first half the moment its second arrived.
		const said = [thread.streamDone ?? "", text].filter(Boolean).join("\n\n");
		const aborted = message.stopReason === "aborted";
		const failed = message.stopReason === "error";
		// Why a run stopped belongs on the turn. A card that reads only "stopped" sends the human looking
		// through session files for the reason, and a connection error is the common case.
		const reason = failed ? headline(message.errorMessage) : undefined;
		// A message pi is about to retry is not half an answer: keeping it would make the retry's full
		// text read twice.
		thread.streamDone = failed ? "" : said;
		thread.streamParts = new Map();
		stopStream(thread);
		if (!text) {
			// A message of nothing but tool calls settles nothing: the turn keeps what has arrived and
			// the caret stays until a message has words in it. A failed one has no words coming, so it
			// ends here, carrying the reason.
			if (turn) {
				turn.error = reason;
				if (reason) turn.status = "stopped";
				if (turn.streaming) turn.reply = said;
				if (reason || turn.streaming) {
					if (asked) updateCard(board, asked);
					else update(board, thread);
				}
			}
			return;
		}
		if (turn) {
			turn.reply = said;
			// An aborted or failed message is not an answer, however much of it arrived before it was
			// cut. Saying `answered` over half a sentence would be a card that lies.
			turn.status = aborted || failed ? "stopped" : "answered";
			turn.error = reason;
		}
		addRow(board, {
			id: randomUUID(),
			kind: "reply",
			status: "ok",
			startedAt: Date.now(),
			text: text.slice(0, 4000),
			...(thinking ? { thinking: thinking.slice(0, 4000) } : {}),
			thread: threadRef(thread),
		});
		if (turn && asked) updateCard(board, asked);
		else if (!thread.answering) update(board, thread);
		return;
	}
	if (event.type === "agent_settled") {
		thread.status = "idle";
		thread.abortWanted = false;
		stopStream(thread);
		settleThoughts(board, thread);
		// A run that edited has either cut its own branch or committed on the detached base, and this is
		// the moment the board learns which and puts a name on the work.
		settleTreeBranch(board, thread);
		// The turn has just finished, and whatever it did to the disk is what the strip must show.
		noteGit(board);
		// A turn whose answer was redirected by a steer, or whose run was stopped, never gets a reply
		// of its own. It reads as stopped rather than as a message still being worked on, and the
		// caret goes because nothing is being written any more.
		for (const turn of thread.turns) {
			turn.streaming = false;
			if (turn.status === "sent") turn.status = "stopped";
		}
		const parked = thread.answering ? board.cards.get(thread.answering.cardId) : undefined;
		if (parked) {
			for (const turn of parked.turns ?? []) {
				turn.streaming = false;
				if (turn.status === "sent") turn.status = "stopped";
			}
			updateCard(board, parked);
		}
		thread.answering = null;
		update(board, thread);
		// The cards this thread answers through carried `answersWith.running` while it ran, and a card
		// still offering a stop for a run that has finished is a button that cannot work.
		refreshOwned(board, thread);
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
		// What the run spent is only known to the child, so it is asked before stdin closes. The close
		// waits for the answer.
		const child = board.children.get(thread.id);
		if (child?.stdin?.writable) {
			thread.pendingClose = true;
			try {
				child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "get_session_stats" })}\n`);
			} catch {
				thread.pendingClose = false;
				child.stdin.end();
			}
		}
	}
}

// ---------- routes: the crossroads -----------------------------------------

export async function onOpenWorkspace(req, res) {
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

/**
 * The crossroads' defaults. A model has to exist on this machine, because a default that cannot run is
 * a board that cannot start a thread.
 */
export async function onDefaults(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	const next = { ...homeDefaults };
	if (typeof body.dimOthers === "boolean") next.dimOthers = body.dimOthers;
	if (typeof body.thinking === "string") {
		if (!THINKING_LEVELS.includes(body.thinking)) return void fail(res, 400, `a level is one of ${THINKING_LEVELS.join(", ")}`);
		next.thinking = body.thinking;
	}
	if (typeof body.provider === "string" && typeof body.model === "string") {
		const { models } = await modelCatalog();
		if (!models.some((one) => one.provider === body.provider && one.model === body.model)) {
			return void fail(res, 409, "this machine cannot run that model");
		}
		next.provider = body.provider;
		next.model = body.model;
	}
	homeDefaults = next;
	saveWorkspaces();
	answer(res, 200, { defaults: activeHomeDefaults() });
}

/** A real folder dialog, because a browser cannot be told an absolute path any other way. */
export function onPickFolder(res) {
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

export async function onThread(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = {
		id: randomUUID(),
		title: typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_CHARS) : "",
		// No name until the human types one or the first request supplies it: a card that invents its own
		// name is a card called `thread 3`, which says nothing and is wrong the moment the work starts.
		sessionId: null,
		status: "idle",
		...(WORK_TYPES.some(([type]) => type === body.type) ? { type: body.type } : {}),
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
	answer(res, 200, { threadId: thread.id, card: cardFor(thread, board) });
}

/** The card a key already addresses, so a caller that repeats itself revises instead of stacking. */
export function cardByKey(board, key, type) {
	if (!key) return undefined;
	return [...board.cards.values()].find((card) => card.key === key && card.type === type);
}

/** A string field from a request body, trimmed and cut short. */
export function field(value, limit = 80) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : "";
}

/** Where a card goes when the caller gave it a place, rounded to whole pixels. */
export function placedRect(body) {
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
export function cardPreamble(card, whole = false) {
	const title = String(card.title ?? card.path ?? card.type).replace(/\s+/g, " ").trim().slice(0, 60);
	let about;
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
		about = `The card shows ${card.path}, lines ${from}-${to}:\n${numbered || "(empty)"}`;
	} else {
		const body = String(card.type === "question" ? [card.question, card.answer ?? ""].join("\n") : (card.markdown ?? ""))
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 1500);
		about = `The card says: ${body || "(empty)"}`;
	}
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
	return `[board reply · card ${card.id} · "${title}"]\n${about}\n${chain ? `Earlier about this card:\n${chain}\n` : ""}\n`;
}

/** The thread a card should cascade under, when the caller named one that exists. */
export function rootOf(board, body) {
	const root = field(body.threadRoot, 100);
	return root && board.threads.has(root) ? root : undefined;
}

/**
 * Where a card a thread writes should cascade. Usually the thread's own card, but a child that answers
 * for a card has no card of its own, so its notes land under the card it serves.
 */
export function anchorOf(board, threadId) {
	const thread = threadId ? board.threads.get(threadId) : undefined;
	if (!thread?.hidden) return threadId;
	return homeCard(board, thread)?.id ?? threadId;
}

/**
 * A card that leaves the board takes its child with it. Nothing can reach a thread the board cannot
 * draw, so keeping one alive would leave a session and a process behind every closed note; and a run
 * that was answering for the card must not write its reply onto some other card's turn.
 */
/** The child goes with its last card. Nothing can reach a thread the board cannot draw. */
export function closeThread(board, thread) {
	// The child is ended, not merely asked to leave: it is working in a tree, and a tree whose thread
	// is gone is what `clean` may sweep. A run still writing there would write into nothing.
	killChild(board, thread);
	try {
		board.children.get(thread.id)?.stdin?.end();
	} catch {
		// The child is already gone, which is what this wanted.
	}
	board.children.delete(thread.id);
	board.threads.delete(thread.id);
	// A thread that goes takes its place in the closed list with it.
	nudgeClosed(board);
}

/**
 * End a child without ending its thread. The session file stays, so the next message starts a fresh
 * child with the conversation it had; only the process goes.
 */
export function killChild(board, thread) {
	const child = board.children.get(thread.id);
	if (!child) return false;
	// The child stops being this thread's voice before it is killed, so its death is not the run failing.
	board.children.delete(thread.id);
	const asked = thread.answering ? board.cards.get(thread.answering.cardId) : undefined;
	const turn = thread.answering ? asked?.turns?.[thread.answering.turn] : thread.turns[thread.turns.length - 1];
	if (turn) {
		turn.streaming = false;
		if (turn.status !== "answered") turn.status = "stopped";
	}
	stopStream(thread);
	// Nothing will arrive to drain the queue now, so what was waiting says stopped instead of waiting.
	for (const next of thread.queued) {
		const held = typeof next === "string" || !next.target ? undefined : board.cards.get(next.target.cardId);
		const parked = held?.turns?.[next.target.turn];
		if (parked && parked.status === "queued") {
			parked.status = "stopped";
			updateCard(board, held);
		}
	}
	thread.queued = [];
	thread.answering = null;
	thread.abortWanted = false;
	thread.status = "idle";
	try {
		// Stop asks the child to give up; kill is what happens when it does not.
		child.kill("SIGKILL");
	} catch {
		// Already gone, which is what this wanted.
	}
	// A note that was being answered has to be told, or its caret blinks for ever.
	if (asked) updateCard(board, asked);
	update(board, thread);
	scheduleSave(board);
	return true;
}

export function forgetCard(board, cardId) {
	for (const thread of [...board.threads.values()]) {
		if (thread.answering?.cardId === cardId) {
			const turn = board.cards.get(cardId)?.turns?.[thread.answering.turn];
			if (turn) {
				turn.streaming = false;
				if (turn.status !== "answered") turn.status = "stopped";
			}
			// Pinned to nowhere rather than forgotten: a run still going would otherwise fall back to
			// the thread's own last turn and overwrite an older answer with this card's.
			thread.answering = { cardId, turn: -1 };
		}
	}
	// A child lives while it has a card, so a hidden one that has just lost its last card goes with it.
	for (const thread of [...board.threads.values()]) {
		if (thread.hidden && !ownedCards(board, thread.id).length) closeThread(board, thread);
	}
}

/** Keep the board bounded: the oldest plain card goes when a new one arrives and there is no room. */
export function makeRoom(board) {
	while (board.cards.size >= MAX_PLAIN_CARDS) {
		const oldest = [...board.cards.values()].sort((a, b) => a.at - b.at)[0];
		if (!oldest) break;
		board.cards.delete(oldest.id);
		forgetCard(board, oldest.id);
		broadcast(board, { type: "remove", id: oldest.id });
	}
}

export async function onNote(req, res, board) {
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
export function readInsideWorkspace(folder, wanted) {
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

export async function onSource(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const wanted = field(body.path, 400);
	if (!wanted) return void fail(res, 400, "path is required");
	// A child works in its own tree, and what it asks to show is relative to where it stands. The card
	// is still the board's, so the path is resolved and named against that thread's folder.
	const owner = board.threads.get(field(body.threadRoot, 100));
	const folder = owner ? workdirOf(board, owner) : board.folder;
	let content;
	try {
		content = readInsideWorkspace(folder, wanted);
	} catch (error) {
		return void fail(res, 409, error.message);
	}
	const key = field(body.key, 400) || wanted;
	// The head says which file first, so a card is recognisable without opening it, then what the caller
	// called the place in it.
	const named = relative(folder, resolve(folder, wanted)) || basename(wanted) || wanted;
	const label = field(body.title, 200);
	const title = label ? `${named} - ${label}` : named;
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
export async function onEdit(req, res, board) {
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

/**
 * The human names a card. A thread is drawn as a card of its own, so its name lives on the thread;
 * every other card carries its own title. A name the human typed is theirs, kept as written.
 */
export async function onRename(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const title = field(body.title, MAX_TITLE_CHARS);
	if (!title) return void fail(res, 400, "title is required");
	const id = String(body.cardId ?? "");
	const card = board.cards.get(id);
	if (card) {
		card.title = title;
		card.updatedAt = Date.now();
		updateCard(board, card);
		answer(res, 200, { cardId: card.id, card: plainCardFor(card, board) });
		return;
	}
	const thread = board.threads.get(id);
	if (!thread) return void fail(res, 409, "no such card");
	thread.title = title;
	update(board, thread);
	answer(res, 200, { cardId: thread.id, card: cardFor(thread, board) });
}

/** Settle a question, tell whoever was waiting, and keep the card honest about what happened. */
export function settleQuestion(board, card, status, answer) {
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
export async function onAsk(req, res, board) {
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
export async function onAnswer(req, res, board) {
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

export async function onMessage(req, res, board) {
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
			...(askedCard ? { threadRoot: askedCard.id, hidden: true } : {}),
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
/** The cards a thread answers for. In creation order, so the newest is last. */
export function ownedCards(board, threadId) {
	return [...board.cards.values()].filter((card) => card.ownerThread === threadId);
}

/** The card a hidden thread is read through: the newest one it answers for. */
export function homeCard(board, thread) {
	const owned = ownedCards(board, thread.id);
	return owned[owned.length - 1];
}

export function refreshOwned(board, thread) {
	for (const held of board.cards.values()) {
		if (held.ownerThread === thread.id) updateCard(board, held);
	}
}

/** What the rail draws under "closed", told to every tab. */
export function nudgeClosed(board) {
	broadcast(board, { type: "closed", closed: closedCards(board) });
}

/**
 * The thread a runtime choice applies to. A card id names the thread that answers for the card, so the
 * composer can set the model of a card whose child is not drawn anywhere.
 */
export function threadForRuntime(board, cardId) {
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
export async function onModel(req, res, board) {
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
		board.config = { ...(board.config ?? {}), provider, model };
		scheduleSave(board);
		broadcast(board, { type: "config", config: activeConfig(board) });
		return void answer(res, 200, { config: activeConfig(board) });
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
	const home = thread.hidden ? homeCard(board, thread) : undefined;
	answer(res, 200, { card: home ? plainCardFor(home, board) : cardFor(thread, board) });
}

/** The thinking level, with the same shape: a thread's own, or the board's default for new ones. */
export async function onThinking(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const level = field(body.level, 20);
	if (!THINKING_LEVELS.includes(level)) return void fail(res, 400, `a level is one of ${THINKING_LEVELS.join(", ")}`);
	const thread = threadForRuntime(board, body.cardId);
	if (!thread || thread.status === "dead") {
		board.config = { ...(board.config ?? {}), thinking: level };
		scheduleSave(board);
		broadcast(board, { type: "config", config: activeConfig(board) });
		return void answer(res, 200, { config: activeConfig(board) });
	}
	thread.thinking = level;
	const child = board.children.get(thread.id);
	if (child?.stdin?.writable) {
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "set_thinking_level", level })}\n`);
	}
	update(board, thread);
	refreshOwned(board, thread);
	const home = thread.hidden ? homeCard(board, thread) : undefined;
	answer(res, 200, { card: home ? plainCardFor(home, board) : cardFor(thread, board) });
}

export async function onLayout(req, res, board) {
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

export async function onClose(req, res, board) {
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
	// Closing this card closes the thread card, not the child's life: a child lives while it has a card,
	// so one that still answers notes keeps running where those notes are read. The last card ends it.
	const kept = ownedCards(board, thread.id);
	if (kept.length) {
		thread.hidden = true;
		thread.closedAt = Date.now();
		broadcast(board, { type: "remove", id });
		refreshOwned(board, thread);
		nudgeClosed(board);
	} else {
		closeThread(board, thread);
		broadcast(board, { type: "remove", id });
	}
	scheduleSave(board);
	nudgeWelcome();
	answer(res, 200, { closed: id, kept: kept.length });
}

/**
 * Put a closed card back. The thread kept its session, its turns and its worktree while it was hidden,
 * so this draws the same card again rather than starting anything: the conversation resumes where it
 * was left, and the cards it owns stay where they are.
 */
export async function onReopen(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = String(body.cardId ?? "");
	const thread = board.threads.get(id);
	if (!thread) return void fail(res, 404, "no such card");
	if (!thread.hidden) return void fail(res, 409, "this card is already on the board");
	thread.hidden = false;
	delete thread.closedAt;
	// The card comes back where it was, with the turns it had, and every tab hears the new list.
	card(board, thread);
	nudgeClosed(board);
	answer(res, 200, { reopened: id });
}

export async function onStop(req, res, board) {
	// A card stops its own thread; no card stops everything, which is what the header button means.
	const body = (await readJson(req, res)) ?? {};
	const asked = body?.cardId ? threadForRuntime(board, field(body.cardId, 100)) : undefined;
	const running = asked
		? asked.status === "running"
			? [asked]
			: []
		: [...board.threads.values()].filter((thread) => thread.status === "running");
	if (!running.length) return void fail(res, 409, asked ? "this thread has no run in progress" : "no run in progress");
	for (const thread of running) {
		// A child still starting has no run to abort, so the request is kept for its first turn.
		thread.abortWanted = true;
		try {
			// Abort lets the child settle and report; the kill is only for a child that will not.
			board.children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`);
		} catch {
			// A child already gone has nothing to abort.
		}
	}
	answer(res, 200, { stopped: running.map((thread) => thread.id) });
}

/** Forget dead threads and their logs. Safe: nothing that can answer is touched. */
export async function onClean(req, res, board) {
	req.resume();
	const result = cleanBoard(board);
	resync(board);
	nudgeWelcome();
	answer(res, 200, result);
}

/** Start over in this workspace, keeping the board's settings. */
export async function onNew(req, res, board) {
	req.resume();
	clearBoard(board);
	resync(board);
	nudgeWelcome();
	answer(res, 200, { cleared: true });
}

/**
 * Change what the board is configured with. Only the switches live here: the model and the thinking
 * level keep their own routes, which already know how to validate against the catalog and how to tell
 * a running child.
 *
 * A body may carry any of the three, so one checkbox is one request and never has to repeat the rest.
 */
export async function onConfig(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const next = { ...(board.config ?? {}) };
	let changed = false;
	if (typeof body.dimOthers === "boolean") {
		next.dimOthers = body.dimOthers;
		changed = true;
	}
	// The built-in tools a new thread is not given, by the names pi itself uses. A name this pi does
	// not have is dropped rather than refused: the panel cannot offer one, and an old board file may
	// hold a tool a later pi stopped shipping.
	if (body.toolsOff !== undefined) {
		if (!Array.isArray(body.toolsOff)) return void fail(res, 400, "toolsOff must be a list of tool names");
		next.toolsOff = body.toolsOff.filter((name) => BUILTIN_TOOLS.includes(name));
		changed = true;
	}
	// The extensions a new thread does not load, by folder name. An unknown name is a mistake in the
	// request, so it is refused instead of quietly accepted as a no-op.
	if (body.extensionsOff !== undefined) {
		if (!Array.isArray(body.extensionsOff)) return void fail(res, 400, "extensionsOff must be a list of extension names");
		const known = new Set(CHILD_EXTENSIONS.map((one) => one.name));
		const unknown = body.extensionsOff.filter((name) => !known.has(name));
		if (unknown.length) return void fail(res, 400, `no such extension: ${unknown.join(", ")}`);
		next.extensionsOff = body.extensionsOff;
		changed = true;
	}
	if (!changed) return void fail(res, 400, "nothing to change: dimOthers, toolsOff or extensionsOff");
	board.config = next;
	scheduleSave(board);
	broadcast(board, { type: "config", config: activeConfig(board) });
	answer(res, 200, { config: activeConfig(board) });
}

/** Kill one thread's child. The thread stays, so its cards stay answerable. */
export async function onKill(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = threadForRuntime(board, field(body.cardId, 100));
	if (!thread) return void fail(res, 404, "no thread answers this card");
	if (!killChild(board, thread)) return void fail(res, 409, "this thread has no child running");
	answer(res, 200, { killed: thread.id });
}

/** The composer's file picker walks folders and answers with paths, never with file contents. */
export function onBrowse(url, res) {
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

export const token = (() => {
	const saved = readJsonFile(STATE_FILE, null);
	return typeof saved?.token === "string" && saved.token ? saved.token : randomToken();
})();

/**
 * The path a route is compared against. The client never writes `//` or a trailing slash, but a URL
 * typed by hand, pasted from a log or built by a proxy can, and an unfolded one matched nothing and
 * fell through to an answer that was neither the page nor a plain not-found. Root stays root.
 */
export function foldPath(pathname) {
	const folded = pathname.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
	return folded || "/";
}

/**
 * The request target as a URL, which `new URL(req.url, base)` cannot do on its own: `new URL("//state",
 * base)` reads `state` as a host, so a doubled slash turned into the root page or into an exception the
 * catch below answered with a 500. The path is folded before parsing, and the query is left alone — a
 * doubled slash can be deliberate in a folder path.
 */
export function requestUrl(target) {
	const raw = String(target || "/");
	if (!raw.startsWith("/")) return new URL(raw.startsWith("http") ? raw : `/${raw}`, "http://127.0.0.1");
	const cut = raw.indexOf("?");
	const path = cut === -1 ? raw : raw.slice(0, cut);
	const query = cut === -1 ? "" : raw.slice(cut);
	return new URL(`http://127.0.0.1${foldPath(path)}${query}`);
}

export const server = createServer((req, res) => {
	void (async () => {
		const url = requestUrl(req.url);
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
				closed: closedCards(board),
				activity: board.activity,
				meta: boardMeta(board),
				// Read before the snapshot goes out, so a tab that has just opened draws the strip at once
				// instead of waiting a tick for its first git event.
				git: refreshGit(board, true),
			});
			board.clients.add(res);
			watchGit(board);
			const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
			const forget = () => {
				clearInterval(keepAlive);
				board.clients.delete(res);
				unwatchGit(board);
			};
			req.on("close", forget);
			res.on("error", forget);
			return;
		}

		// ----- crossroads -----
		if (req.method === "GET" && url.pathname === "/workspaces") {
			answer(res, 200, { workspaces: workspaces.map(describeWorkspace), instance: INSTANCE });
			return;
		}
		// What every board opened from here is born with. The crossroads sets it; a board may then
		// change its own copy without touching the next workspace.
		if (req.method === "GET" && url.pathname === "/defaults") {
			answer(res, 200, { defaults: activeHomeDefaults(), levels: THINKING_LEVELS });
			return;
		}
		if (req.method === "POST" && url.pathname === "/defaults") {
			await onDefaults(req, res);
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
		// The row itself is the payload: a tool row keeps its arguments and its output, a reply keeps
		// the thinking that led to it, and the panel shows whichever fields it finds.
		if (req.method === "GET" && url.pathname.startsWith("/activity/")) {
			const board = boardFrom(url, res);
			if (!board) return;
			const id = decodeURIComponent(url.pathname.slice("/activity/".length));
			const row = board.activity.find((candidate) => candidate.id === id);
			if (!row) {
				fail(res, 404, "no detail kept for this row");
				return;
			}
			answer(res, 200, rowWithThought(row));
			return;
		}
		// The conversation behind a thread, rendered for reading: what the activity rail summarises and
		// what the card shows one answer of.
		if (req.method === "GET" && url.pathname.startsWith("/transcript/")) {
			const board = boardFrom(url, res);
			if (!board) return;
			const id = decodeURIComponent(url.pathname.slice("/transcript/".length));
			const thread = board.threads.get(id);
			if (!thread) return void fail(res, 404, "no such thread");
			const file = thread.sessionId ? sessionFile({ id: board.id }, thread.sessionId) : "";
			const entries = file ? transcriptOf(file) : null;
			if (!entries) return void fail(res, 404, "this thread has no session file yet");
			answer(res, 200, {
				threadId: thread.id,
				title: thread.title,
				status: thread.status,
				branch: thread.worktree?.branch ?? "",
				base: thread.worktree?.base ?? "",
				sessionId: thread.sessionId,
				entries,
			});
			return;
		}

		// ----- board -----
		// What the composer's pickers offer: every model this machine can run, the levels pi names, and
		// the scope pi cycles — pi's own `enabledModels`, which is where /scoped-models writes it. The
		// scope is read here rather than cached with the catalogue, so an edit made in a console pi lands
		// on the next open of the picker.
		if (req.method === "GET" && url.pathname === "/models") {
			const { models, levels } = await modelCatalog();
			const scope = readScope();
			const { scoped, problems } = resolveScope(scope, models);
			for (const pattern of problems) {
				if (saidScopeProblems.has(pattern)) continue;
				saidScopeProblems.add(pattern);
				console.error(`pi-studio: pi's scope pattern ${JSON.stringify(pattern)} matched no model here`);
			}
			answer(res, 200, { models, levels, scope, scoped, problems });
			return;
		}
		if (req.method === "GET" && url.pathname === "/tools") {
			// What the settings panel draws: pi's own four by name, and the extension folders this
			// machine has. Read once when the panel first opens, so installing an extension shows up
			// after a daemon restart rather than mid-session.
			answer(res, 200, {
				builtin: BUILTIN_TOOLS,
				extensions: CHILD_EXTENSIONS.map((one) => ({ name: one.name })),
				folder: extensionsDir(),
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/state") {
			const board = boardFrom(url, res);
			if (!board) return;
			answer(res, 200, {
				workspace: describeWorkspace({ id: board.id, folder: board.folder, name: board.name, openedAt: 0 }),
				threads: [...board.threads.values()].map((thread) => ({ ...thread, live: board.children.has(thread.id) })),
				cards: cardsFor(board),
				closed: closedCards(board),
				activity: board.activity,
				meta: boardMeta(board),
				// What the strip draws, read now rather than cached: a script asking gets the disk's answer.
				git: gitPicture(board),
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
				"/rename": onRename,
				"/answer": onAnswer,
				"/message": onMessage,
				"/layout": onLayout,
				"/close": onClose,
				"/reopen": onReopen,
				"/model": onModel,
				"/thinking": onThinking,
				"/kill": onKill,
				"/config": onConfig,
				"/clean": onClean,
				"/new": onNew,
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
				await onStop(req, res, board);
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

export function shutdown() {
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

export let port = 0;

/**
 * The port the last daemon printed, so a restart keeps the URL a tab is already on. A development
 * reload is the reason: a fresh port per restart would make every edit a new link. If something else
 * has taken it, fall back to any free port rather than refuse to start.
 */
export function lastPort() {
	const saved = readJsonFile(STATE_FILE, null);
	const held = Number(saved?.port);
	return Number.isInteger(held) && held > 0 && held < 65536 ? held : 0;
}

export function startListening(wanted) {
	server.listen(wanted, "127.0.0.1", onListening);
}

server.on("error", (error) => {
	if (error?.code === "EADDRINUSE" && port === 0 && lastPort() !== 0) {
		console.error(`pi-studio: port ${lastPort()} is taken, using any free port`);
		startListening(0);
		return;
	}
	console.error(`pi-studio: ${error?.stack ?? error}`);
	process.exit(1);
});

export function onListening() {
	port = server.address().port;
	writeJsonFile(STATE_FILE, { token, port, at: new Date().toISOString() });
	const url = `http://127.0.0.1:${port}/?token=${token}`;
	console.log(`pi-studio${INSTANCE ? ` [${INSTANCE}]` : ""} listening on ${url}`);
	// Which build is answering matters the moment a tab looks wrong, so it is said out loud.
	console.log(`build ${buildHash()}${INSTANCE ? `, state ${STATE_DIR}` : ""}`);
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
}

/**
 * Boots the daemon: the port it should try, and the one line a human needs to open the board.
 *
 * The entry calls this and nothing else, so importing this file never binds a socket.
 */
export function start() {
	startListening(Number(process.env.PI_STUDIO_PORT) || lastPort());
}

import { gitIn, repoOf, baseRef, mainRepoOf } from "./git/repo.ts";
export { gitIn, repoOf, baseRef, mainRepoOf };

import { readJson, fail, answer, serveStatic, send, readBody } from "./http.ts";
export { readJson, fail, answer, serveStatic, send, readBody };

import { MAX_BODY_BYTES, MAX_ROW_CHARS, MAX_NOTE_CHARS, MAX_SOURCE_CHARS, MAX_TITLE_CHARS, ASK_TIMEOUT_MS, BROWSE_LIMIT, CONTROL_CHARS } from "./limits.ts";
export { MAX_BODY_BYTES, MAX_ROW_CHARS, MAX_NOTE_CHARS, MAX_SOURCE_CHARS, MAX_TITLE_CHARS, ASK_TIMEOUT_MS, BROWSE_LIMIT, CONTROL_CHARS };

import { PROVIDER, MODEL, THINKING_LEVELS, CATALOG_TTL_MS, run, catalog, catalogAt, saidScopeProblems, modelCatalog, piSettingsFile, readScope, patternToRegExp, bestPartial, resolveScope, BUILTIN_TOOLS, TOOLS, CHILD_EXCLUDE, isTestFile, installedExtensions, CHILD_EXTENSIONS } from "./models.ts";
export { PROVIDER, MODEL, THINKING_LEVELS, CATALOG_TTL_MS, run, catalog, catalogAt, saidScopeProblems, modelCatalog, piSettingsFile, readScope, patternToRegExp, bestPartial, resolveScope, BUILTIN_TOOLS, TOOLS, CHILD_EXCLUDE, isTestFile, installedExtensions, CHILD_EXTENSIONS };

import { GIT_ROWS, GIT_TICK, refName, gitGraph, gitStatusOf, gitPicture, gitFingerprint, refreshGit, noteGit, watchGit, unwatchGit } from "./git/graph.ts";
export { GIT_ROWS, GIT_TICK, refName, gitGraph, gitStatusOf, gitPicture, gitFingerprint, refreshGit, noteGit, watchGit, unwatchGit };

import { workspaces, homeDefaults, saveWorkspaces, activeHomeDefaults, welcomeClients, rememberWorkspace, workspaceById, folderFacts, gitFacts, describeWorkspace, countSavedThreads, activeConfig, runtimeDefaults } from "./workspaces.ts";
export { workspaces, homeDefaults, saveWorkspaces, activeHomeDefaults, welcomeClients, rememberWorkspace, workspaceById, folderFacts, gitFacts, describeWorkspace, countSavedThreads, activeConfig, runtimeDefaults };

import { boards, boardFile, savedTurn, cleanRect, saveBoard, scheduleSave, flushBoard, restoredTurns, restoredThread, restoredPlainCard, boardFor, boardFrom, STATE_VERSION, MAX_ACTIVITY, MAX_THREADS, MAX_PLAIN_CARDS } from "./store.ts";
export { boards, boardFile, savedTurn, cleanRect, saveBoard, scheduleSave, flushBoard, restoredTurns, restoredThread, restoredPlainCard, boardFor, boardFrom, STATE_VERSION, MAX_ACTIVITY, MAX_THREADS, MAX_PLAIN_CARDS };

import { broadcast, resync, liveThreadIds, nudgeWelcome, card, update, updateCard, threadRef, addRow, patchRow, diskRow, closedCards } from "./bus.ts";
export { broadcast, resync, liveThreadIds, nudgeWelcome, card, update, updateCard, threadRef, addRow, patchRow, diskRow, closedCards };

import { cardFor, plainCardFor, cardsFor, boardMeta, cleanBoard, clearBoard, threadError } from "./cards.ts";
export { cardFor, plainCardFor, cardsFor, boardMeta, cleanBoard, clearBoard, threadError };
