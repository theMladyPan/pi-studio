// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The command line a thread's `pi` is started with: the CLI, the extension folders, and the flags that
 * carry the board's tools and its narrowed tool list.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { boardPrompt } from "./prompts.ts";
import { ceiling } from "./describe.ts";
import { BUILTIN_TOOLS, CHILD_EXTENSIONS, TOOLS } from "../models.ts";
import { workdirOf } from "../worktrees/make.ts";
import { sessionCwd, sessionDir } from "../session.ts";
import { sameFolder } from "../worktrees/retire.ts";
import { BRIDGE } from "../paths.ts";
import { ROLE_THINKING, ROLE_TOOLS_OFF, roleSystemPrompt } from "./roles.ts";
import { MODE_TOOLS_OFF, modeSystemPrompt } from "./modes.ts";



// ---------- the child ------------------------------------------------------

/**
 * The CLI a child needs, found where the doctor finds it too (see `pi-cli.ts`): the code that
 * answers that question lives on its own so both ask the same one.
 */
export { extensionsDir, installRoot, piCli } from "./pi-cli.ts";



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
	// Tools a role may not use join the ones the board already leaves out, once each. A mode narrows the
	// same list: a planner, a boss and a discuss thread read and spawn or check, and none edits the tree it
	// is judging.
	const toolsOff = [
		...new Set([...toolsOffFor(board), ...(ROLE_TOOLS_OFF[thread.role] ?? []), ...(MODE_TOOLS_OFF[thread.mode] ?? [])]),
	];
	// A role brings a thinking level; what the human chose on the card wins over it.
	const thinking = thread.thinking ?? ROLE_THINKING[thread.role];
	return [
		"--mode",
		"rpc",
		"--session-dir",
		sessionDir(board),
		...session,
		"-ne",
		// `-ne` stops discovery, and an explicit `-e` still loads: that is how a thread gets its verbs
		// and the research tools, without anything else coming along. A spawned child is not given the
		// bridge at all: it draws nothing, so the tools it would register are the ones the guard refuses.
		...(existsSync(BRIDGE) && !thread.parentThread ? ["-e", BRIDGE] : []),
		...extensionsFor(board).flatMap((path) => ["-e", path]),
		// No allowlist unless one was asked for: a thread gets the tools a console pi gets.
		...(TOOLS ? ["--tools", TOOLS] : []),
		// What the board itself leaves out, by pi's own tool names, and what a role may not use: a scout
		// or a reviewer reads and runs checks, and never edits the tree it is judging.
		...(toolsOff.length ? ["--exclude-tools", toolsOff.join(",")] : []),
		"--append-system-prompt",
		[roleSystemPrompt(thread.role), modeSystemPrompt(thread.mode, thread.path), boardPrompt(board, thread)]
			.filter(Boolean)
			.join("\n\n"),
		"--provider",
		thread.provider,
		"--model",
		thread.model,
		...(thinking ? ["--thinking", thinking] : []),
	];
}
