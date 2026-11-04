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
