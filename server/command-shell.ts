/**
 * The one shell a `!` line runs under, answered once for everything that needs it.
 *
 * A `!` line is a line the human typed in their own terminal, so the shell meant by it is the one their
 * terminal runs: `SHELL`, as login and terminal emulators set it. `process.env.SHELL` is only a claim on a
 * path, though, and a stale entry there is ordinary — a shell that was uninstalled, a profile that named a
 * relative path — so the claim is believed only if it is an absolute path to a file with the execute bit on.
 *
 * The two questioners must agree or the board lies: the executor in `./routes/board/shell.ts` runs the line
 * with this shell, and the listing in `./routes/board/content.ts` offers the names this shell knows, so a
 * suggestion is one the line can actually run and a builtin the line can run is never hidden.
 */
import { accessSync, constants, statSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

/**
 * Resolved on the first ask and kept: the answer cannot change while the daemon runs, because the
 * environment it is read from does not, and a Tab must not pay for a `stat` per keystroke.
 */
let resolved = "";

/** A candidate worth running: an absolute path to a file with the execute bit on. Anything else is "". */
function runnable(candidate: string | undefined): string {
	if (!candidate || !candidate.startsWith("/")) return "";
	try {
		if (!statSync(candidate).isFile()) return "";
		accessSync(candidate, constants.X_OK);
		return candidate;
	} catch {
		return "";
	}
}

/**
 * The shell a `!` line runs under: the human's own if it is really there, else bash, else the one shell
 * POSIX guarantees. `/bin/sh` is not checked because there is nothing left to fall back to, and a shell
 * that cannot start is already a road both callers answer without crashing.
 */
export function commandShell(): string {
	if (resolved) return resolved;
	resolved = runnable(process.env.SHELL) || runnable("/bin/bash") || "/bin/sh";
	return resolved;
}


// ---------- the groups a `!` line has running right now ----------------------

/**
 * A command is spawned detached, so its pid is its own process group's, and one signal takes the whole line:
 * `sh -c "sleep 600 & wait"` leaves a sleeper behind when only the shell is signalled. The direct kill is the
 * fallback for the moment before that group exists.
 */
export function killGroup(child: ChildProcess): void {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone, which is what this wanted.
		}
	}
}



/** Live groups, by board: what is running under a `!` line right now. */
const groups = new Map<string, Set<ChildProcess>>();

/** A command that has started. Emptying a board has to be able to take it: a command still running when the
 * human throws the board away writes its file back into the folder after the delete and its note onto a
 * board that was just emptied. */
export function trackShell(boardId: string, child: ChildProcess): void {
	const held = groups.get(boardId) ?? new Set();
	held.add(child);
	groups.set(boardId, held);
}



/** A command that has ended, however it ended. */
export function untrackShell(boardId: string, child: ChildProcess): void {
	const held = groups.get(boardId);
	if (!held) return;
	held.delete(child);
	if (!held.size) groups.delete(boardId);
}



/** Every group this board is running, killed. Nothing waits here: the child's own `close` is what settles a run. */
export function stopShells(boardId: string): number {
	const held = groups.get(boardId);
	if (!held) return 0;
	let killed = 0;
	for (const child of held) {
		killGroup(child);
		killed += 1;
	}
	held.clear();
	groups.delete(boardId);
	return killed;
}
