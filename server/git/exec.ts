/**
 * One git process, run once, with the three failures an editor cannot afford left out: a prompt nobody
 * can answer, output nobody bounded, and a hang nobody timed out.
 *
 * Everything git-graph asks git goes through here, because besides the module that already reads a
 * repository (`server/git/repo.ts`) there is now a whole webview whose every
 * click is a git command. A command that waits for a password holds its caller for as long as the human
 * leaves the tab open; one that prints a gigabyte fills the daemon's heap; a rebase on a folder that is
 * not a repository must answer "no" rather than throw. So the three are answered in the one place that
 * spawns, and the caller gets a result it can read instead of a promise that can reject.
 */
// ---------- environment ----------
import { spawn } from "node:child_process";
import { log } from "../logs.ts";

/** What a command may do: reads nothing, writes to the checkout, or talks to a remote. */
export type GitExecKind = "read" | "write" | "network";

/** Everything a caller may say about one command. `kind` is the only thing it must say. */
export type GitExecOptions = {
	kind: GitExecKind;
	/** How much stdout is worth keeping; everything past it is dropped and the run reported as cut. */
	maxBytes?: number;
	/** How long the command may take before it is killed, overriding the kind's own limit. */
	timeoutMs?: number;
	/** A tab closed under a running command, so the work behind it goes with it. */
	signal?: AbortSignal;
	/** Extra variables for this one command, merged over the inherited environment. */
	env?: Record<string, string>;
};

/** What one command said and whether it may be trusted: a cut or killed run never is. */
export type GitExecResult = {
	ok: boolean;
	code: number | null;
	stdout: Buffer;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
};

/** What `gitText` answers: the same run, already decoded, because every read caller wants a string. */
export type GitTextResult = {
	ok: boolean;
	text: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
};

// ---------- limits ----------

/**
 * How long each kind of command may take. A log is read while a human waits, a rebase writes to a
 * checkout and may open an editor, and a fetch waits on a network nobody can promise anything about.
 */
const DEFAULT_TIMEOUTS: Record<GitExecKind, number> = { read: 10_000, write: 30_000, network: 120_000 };

/** A graph of a large repository is a few megabytes; a bundle printed by mistake is not. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Stderr is read for its first line, so a runaway one is capped well below the stdout budget. */
const MAX_STDERR_BYTES = 1024 * 1024;

// ---------- environment ----------

/**
 * The environment every command runs in. Inherited, then pinned at the four things that make git safe
 * to run from a daemon: no terminal prompt, no pager, no ssh password prompt, and no optional locks,
 * so a read cannot take a lock a writer waits on. `GIT_SSH_COMMAND` is left alone when the human set
 * one, because their key, agent and config are the ones the command has to use.
 */
function environmentFor(kind: GitExecKind, extra?: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_PAGER = "cat";
	env.SSH_ASKPASS_REQUIRE = "never";
	env.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes";
	if (kind === "read") env.GIT_OPTIONAL_LOCKS = "0";
	else delete env.GIT_OPTIONAL_LOCKS;
	return extra ? { ...env, ...extra } : env;
}

// ---------- running ----------

/**
 * Run one git command in `cwd` and answer what it said. Never rejects: a git that is not installed, a
 * folder that is gone, a command that hangs and one that prints too much all answer `ok: false` with a
 * reason, because every caller is a route that has a reply to send either way.
 */
export function runGit(cwd: string, args: readonly string[], options: GitExecOptions): Promise<GitExecResult> {
	const command = ["git", ...args].join(" ");
	const startedAt = Date.now();
	return new Promise((resolve) => {
		const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUTS[options.kind];
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;

		const answer = (ok: boolean, code: number | null, stderrText: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			options.signal?.removeEventListener("abort", onAbort);
			// The command, where it ran and what came of it, in the drawer's own line: a git that refused
			// is otherwise only visible to whoever started the daemon. A run that printed to stderr and
			// still succeeded is a warning, because that is usually the interesting one.
			const said = stderrText.trim().split("\n")[0]?.slice(0, 300) ?? "";
			const answered = [decode(stdout, stdoutBytes).trimEnd(), stderrText.trimEnd()].filter((part) => part.trim());
			log(ok ? (said ? "warning" : "info") : "error", "git", `${command}${said ? ` · ${said}` : ""}`, {
				cmd: command,
				cwd,
				exit: code ?? (timedOut ? "timed out" : "no code"),
				dur: Date.now() - startedAt,
			}, answered.length ? answered.join("\n") : undefined);
			resolve({ ok, code, stdout: Buffer.concat(stdout, stdoutBytes), stderr: stderrText.trim(), timedOut, truncated });
		};

		const child = spawn("git", ["-c", "core.quotepath=false", "-c", "color.ui=false", ...args], {
			cwd,
			env: environmentFor(options.kind, options.env),
			stdio: ["ignore", "pipe", "pipe"],
			// A process group of its own, so a kill reaches what git started: an alias, a hook or a
			// credential helper holds the pipes git handed it, and a git killed on its own would leave
			// the answer waiting for the child it spawned.
			detached: true,
		});

		// `SIGKILL` rather than a polite signal: a git waiting on a password or a network peer does not
		// read `SIGTERM` until the thing it waits on answers. The 'close' event still arrives, so the
		// caller learns what had been printed before the end.
		const kill = () => {
			if (settled) return;
			const pid = child.pid;
			try {
				if (pid !== undefined) process.kill(-pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		// An aborted run is reported the same way as a timed out one: both mean the answer was cut short
		// before git could give it, and no caller may use what arrived.
		const onAbort = () => {
			timedOut = true;
			kill();
		};

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		timeoutTimer.unref();

		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => {
			const room = maxBytes - stdoutBytes;
			if (room <= 0) {
				truncated = true;
				kill();
				return;
			}
			stdout.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
			stdoutBytes += Math.min(chunk.length, room);
			if (chunk.length > room) {
				truncated = true;
				kill();
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const room = MAX_STDERR_BYTES - stderrBytes;
			if (room <= 0) return;
			stderr.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
			stderrBytes += Math.min(chunk.length, room);
		});
		// A stream that errors after the kill has nothing left to say, and an unhandled 'error' here
		// would take the daemon down over output it was already told to drop.
		child.stdout?.on("error", () => {});
		child.stderr?.on("error", () => {});

		// A git that is not installed, or a folder that has gone, reports itself here rather than by
		// throwing: the route that asked has a reply to send either way.
		child.on("error", (error: Error) => {
			answer(false, null, error.message);
		});

		child.on("close", (code: number | null) => {
			answer(code === 0 && !timedOut && !truncated, code, decode(stderr, stderrBytes));
		});
	});
}

/** Decode the collected bytes once, so a multi-byte character split across two chunks still reads. */
function decode(chunks: Buffer[], size: number): string {
	return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * The same run, as text. Every read caller wants the first line of stdout, so decoding happens here
 * rather than in a dozen call sites that would each have to remember the encoding.
 */
export async function gitText(cwd: string, args: readonly string[], options?: Partial<GitExecOptions>): Promise<GitTextResult> {
	const result = await runGit(cwd, args, { kind: "read", ...options });
	return {
		ok: result.ok,
		text: result.stdout.toString("utf8"),
		stderr: result.stderr,
		timedOut: result.timedOut,
		truncated: result.truncated,
	};
}
