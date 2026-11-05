// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * `!command` in a composer: the shell, run where this thread works, written onto the board as a note.
 *
 * A console pi runs a `!` line and puts what it printed in front of the model with the next prompt. A board
 * has no prompt to prepend to, so the two halves of it are made out of what is already here: the output
 * becomes a card the board draws at once, and the composer names that card on the next message. A named card
 * is quoted into the prompt ahead of the human's own words by `cardPreamble` in `./message.ts`, which is
 * the prepend — so no message is rewritten and nothing is quoted twice.
 *
 * The route is the human's alone. It is deliberately not in `THREAD_ROUTES`, because a shell is the one thing
 * an agent must not reach through the board: a thread that could name a command here would have a bash tool
 * that no `toolsOff` switch can take away, and a prompt injection would have somewhere to go.
 */
import { answer, fail, readJson } from "../../http.ts";
import { MAX_TITLE_CHARS, SHELL_OUTPUT_CHARS, SHELL_TIMEOUT_MS } from "../../limits.ts";
import { anchorOf } from "./thread.ts";
import { makeRoom, threadForRuntime } from "./lifecycle.ts";
import { broadcast } from "../../bus.ts";
import { plainCardFor } from "../../cards.ts";
import { scheduleSave } from "../../store.ts";
import { workdirOf } from "../../worktrees/make.ts";
import { commandShell, killGroup, trackShell, untrackShell } from "../../command-shell.ts";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";



/**
 * How long the command may run. The constant is the policy; this reads it, and `PI_STUDIO_SHELL_TIMEOUT_MS`
 * shortens it so the checks can watch a command outlive its limit without sitting a minute for it.
 */
function shellTimeout() {
	const wanted = Number(process.env.PI_STUDIO_SHELL_TIMEOUT_MS);
	return Number.isFinite(wanted) && wanted > 0 ? wanted : SHELL_TIMEOUT_MS;
}



/** A limit said back as something a reader can compare with a stopwatch: `60s`, `250ms`. */
function saidAsTime(ms) {
	return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`;
}



/**
 * The command, what it printed, and whether one of the two ceilings ended it first.
 *
 * The line goes to a shell with `-c` — a pipe, an `&&`, a glob — because the human typed a line and not an
 * argv, and that shell is the one their terminal runs (`commandShell`), not `/bin/sh` under `shell: true`.
 * `stdin` is ignored rather than piped: a closed stdin gives a command that reads one an end of file,
 * where a pipe nobody writes to would leave `cat` waiting out the whole timeout. Both streams go into one
 * buffer in the order they arrived, the way a terminal shows them.
 */
function runShell(board, command, cwd, timeoutMs) {
	return new Promise((done) => {
		let output = "";
		let cut = false;
		let timedOut = false;
		let settled = false;
		const shell = commandShell();
		const child = spawn(shell, ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		// Named on the board while it runs, so emptying that board can take it. A command nobody can stop is a
		// command that writes its file back into a folder the human just emptied.
		trackShell(board.id, child);
		// The streams stay read after the ceiling is reached: a pipe nobody drains stops a command by filling
		// up, which is a different thing from the command running out of output. What comes past the ceiling
		// is counted by nothing and kept by nobody.
		const take = (chunk) => {
			const text = String(chunk);
			if (cut || !text) return;
			const room = SHELL_OUTPUT_CHARS - output.length;
			if (room <= 0) {
				cut = true;
				return;
			}
			output += text.slice(0, room);
			if (text.length > room) cut = true;
		};
		const finish = (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			untrackShell(board.id, child);
			// The marker is in the output itself, so the card and the composer's answer say the same thing and
			// neither of them presents half a listing as a whole one.
			done({
				output: cut ? `${output}\n\n[cut: the output stopped at ${SHELL_OUTPUT_CHARS} characters]\n` : output,
				exitCode,
				timedOut,
				truncated: cut,
			});
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child);
		}, timeoutMs);
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		// A command that could not start at all has no output of its own, so what went wrong stands in for it.
		child.on("error", (error) => {
			if (!output) output = `${error.message}\n`;
			finish(null);
		});
		// `close` rather than `exit`: by then the streams are drained, so a last line written on the way out is
		// on the card instead of arriving after the answer did.
		child.on("close", (code) => finish(code ?? null));
	});
}



/**
 * What the command did, as a note: a card the board already draws, and one a message can already name. The
 * output is one fenced block so a listing keeps its columns, and the fence is longer than anything the output
 * closed with, so output that contains backticks cannot end the block and leave the rest as prose.
 */
function markdownFor(command, run) {
	const body = run.output.replace(/\n+$/, "") || "(no output)";
	const fence = body.includes("```") ? "~~~~" : "```";
	const said = run.timedOut
		? `stopped at the ${saidAsTime(run.timeoutMs)} limit`
		: run.exitCode === null
			? "the command did not start"
			: run.exitCode === 0
				? ""
				: `exit ${run.exitCode}`;
	return `${fence}sh\n$ ${command}\n${body}\n${fence}\n${said ? `\n${said}\n` : ""}`;
}



/**
 * The card itself: `onNote`'s shape, without a key, because nothing repeats here — each command the human runs
 * is its own card, and the newest one is the one the next message names.
 */
function writeNote(board, command, run, thread) {
	makeRoom(board);
	const note = {
		id: randomUUID(),
		type: "note",
		title: `!${command}`.replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS),
		markdown: markdownFor(command, run),
		at: Date.now(),
		// The card cascades under the thread the command was typed in, the way a note that thread wrote does.
		// A thread that answers for a card is read through the cards it owns, so that one gets the cascade and
		// no ownership: the card the agent's answers are drawn on must not become whichever command ran last.
		...(thread ? { threadRoot: anchorOf(board, thread.id) } : {}),
		...(thread && !thread.hidden ? { ownerThread: thread.id } : {}),
	};
	board.cards.set(note.id, note);
	broadcast(board, { type: "card", card: plainCardFor(note, board) });
	scheduleSave(board);
	return note;
}



export async function onShell(req, res, board) {
	const body = await readJson(req, res);
	if (!body) return;
	// The command is taken as typed and never shortened: a line cut to fit a ceiling would run something other
	// than what is on screen. What the ceilings bound is how much it may say and how long it may say it.
	const command = typeof body.command === "string" ? body.command.trim() : "";
	if (!command) return void fail(res, 400, "empty command");
	// Where the words are. A thread works in its own tree, so that is where a relative path means the file the
	// human is looking at on the card; a thread with no tree of its own answers from the board's folder. No tree
	// is made here — `ensureWorktree` would cut one to run an `ls`, and a command is not work.
	const thread = threadForRuntime(board, body.cardId);
	const folder = thread ? workdirOf(board, thread) : board.folder;
	const timeoutMs = shellTimeout();
	const run = await runShell(board, command, folder, timeoutMs);
	const note = writeNote(board, command, { ...run, timeoutMs }, thread);
	// A command that exited non-zero is not a refusal: the human typed it and it ran, so the answer is a 200
	// carrying what happened. The field says `exit 2` in its own hint from this body, where a 500 would read as
	// a daemon that broke rather than a command that failed.
	answer(res, 200, {
		cardId: note.id,
		command,
		// As it is on the card: the output is never trimmed here, because the leading space of an indented
		// listing is part of what the command printed.
		output: run.output,
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		truncated: run.truncated,
	});
}
