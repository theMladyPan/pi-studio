/**
 * The terminal behind the bottom drawer: one real shell per board, in a pty, fed over a WebSocket.
 *
 * A pty needs a native module (`node-pty`) or a helper that already makes one. This daemon ships
 * with no dependencies of its own, so the shell runs under `script(1)` — util-linux on this
 * machine — which hands the shell a `/dev/pts` as its stdout and is the whole pty for our
 * purposes: colours, job control and full-screen programs behave as they do in a terminal.
 *
 * Two limits come with that helper and both are priced into the design. The pty size is fixed at
 * spawn: `script` copies it from its own stdin once and a pipe has none, so the shell is started
 * only after the drawer sends its first size, and a later resize of the window does not resize
 * the pty (plain commands do not care; full-screen programs keep the birth size). And the session
 * outlives a closed drawer: rolling the drawer up detaches the browser, never the shell, so a
 * `sleep 600` or an editor is still running on the next roll down. The session ends when the
 * shell exits, when the board is emptied, or when the daemon stops.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { commandShell, killGroup } from "./command-shell.ts";

/** The pty size the drawer asks for, in character cells. */
export type TerminalSize = { cols: number; rows: number };

/** What the daemon tells a browser tab: output to draw, or the shell's end. */
export type TerminalEvent =
	| { type: "output"; data: string }
	| { type: "exit"; code: number | null }
	| { type: "error"; data: string };

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

/** How much output a reattached tab replays: enough to read the last screenfuls, not a log. */
const SCROLLBACK_CHARS = 200_000;

/** The bounds a size is clamped to, so a wild number cannot widen a pty without limit. */
const MAX_CELLS = 1000;

type Listener = (event: TerminalEvent) => void;

type Session = {
	child: ChildProcess;
	/** The workspace folder the shell works in. */
	folder: string;
	/** Everything the shell said, kept drained so a detached shell never blocks on a full pipe. */
	scrollback: string;
	listeners: Set<Listener>;
	/** The size the pty was born with, once the shell is spawned. */
	spawned: TerminalSize | null;
	dead: boolean;
};

/** Live sessions, by workspace id: one shell per board, shared by every tab that attaches. */
const sessions = new Map<string, Session>();

/** A size a browser may ask for, made safe: integers within bounds, or the default. */
export function terminalSize(size: Partial<TerminalSize> | undefined): TerminalSize {
	const cols = Math.floor(Number(size?.cols));
	const rows = Math.floor(Number(size?.rows));
	return {
		cols: Number.isFinite(cols) && cols > 0 && cols <= MAX_CELLS ? cols : DEFAULT_SIZE.cols,
		rows: Number.isFinite(rows) && rows > 0 && rows <= MAX_CELLS ? rows : DEFAULT_SIZE.rows,
	};
}

/** One shell, born in the folder at the size the drawer measured. */
function spawnSession(folder: string, size: TerminalSize): Session {
	const shell = commandShell();
	// The size is written into the pty with `stty` before the shell starts, because `script` has
	// no flag for it and a pipe stdin carries no size to copy. The shell path is the daemon's own
	// choice (`commandShell`), quoted so a space in it is one word, not two.
	const inner = `stty rows ${size.rows} cols ${size.cols}; exec '${shell.replace(/'/g, `'\\''`)}'`;
	const child = spawn("script", ["-qec", inner, "/dev/null"], {
		cwd: folder,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, TERM: "xterm-256color" },
	});
	const session: Session = { child, folder, scrollback: "", listeners: new Set(), spawned: size, dead: false };
	child.stdout?.on("data", (chunk) => {
		const text = String(chunk);
		session.scrollback = (session.scrollback + text).slice(-SCROLLBACK_CHARS);
		for (const listener of session.listeners) listener({ type: "output", data: text });
	});
	// stderr of `script` carries its own notices, not the shell's; the shell's stderr arrives on
	// the pty and is stdout here. Draining this one keeps a missing helper from blocking instead.
	child.stderr?.on("data", () => {});
	child.on("error", (error) => {
		// A missing `script` is the ordinary shape of this failure, and the drawer says so rather
		// than sitting silent.
		const message = `the terminal helper could not start: ${error.message}`;
		for (const listener of session.listeners) listener({ type: "error", data: message });
		finish(session, null);
	});
	child.on("exit", (code) => finish(session, code));
	return session;
}

/** A session is over: its listeners hear it once, and the next attach starts a new shell. */
function finish(session: Session, code: number | null) {
	if (session.dead) return;
	session.dead = true;
	for (const [id, held] of sessions) if (held === session) sessions.delete(id);
	for (const listener of session.listeners) listener({ type: "exit", code });
	session.listeners.clear();
}

/** The handle one attached tab writes and detaches through. */
export type TerminalHandle = {
	write: (data: string) => void;
	/** The size the pty is born with; arrives before the shell starts, so the first one counts. */
	resize: (size: TerminalSize) => void;
	detach: () => void;
};

/**
 * Attach one tab to its board's shell, starting the shell if none is running.
 *
 * The shell starts on the first message that needs it — a size or an input — so it is born at the
 * size the drawer measured rather than the default. A tab that attaches to a running shell hears
 * its scrollback first, the way a reopened terminal shows the last screen.
 */
export function attachTerminal(workspaceId: string, folder: string, listener: Listener): TerminalHandle {
	let session = sessions.get(workspaceId);
	if (session?.dead) session = undefined;
	const ensure = (size: TerminalSize): Session => {
		if (!session || session.dead) {
			session = spawnSession(folder, size);
			sessions.set(workspaceId, session);
		}
		// Every road that starts the shell also attaches this tab to it: the first message is
		// a size, and a tab that never heard the output would sit in an empty terminal.
		if (!detached) session.listeners.add(listener);
		return session;
	};
	if (session) {
		session.listeners.add(listener);
		if (session.scrollback) listener({ type: "output", data: session.scrollback });
	}
	let detached = false;
	return {
		write: (data) => {
			if (detached || !data) return;
			const held = ensure(DEFAULT_SIZE);
			held.child.stdin?.write(data);
		},
		resize: (size) => {
			if (detached) return;
			const wanted = terminalSize(size);
			// Before the shell exists the size is its birth size. After it, the pty keeps the size
			// it was born with — `script` takes no other — so this only records the want.
			if (!session || session.dead) ensure(wanted);
		},
		detach: () => {
			detached = true;
			session?.listeners.delete(listener);
		},
	};
}

/** A board emptied: its shell is part of what is thrown away, so it goes with it. */
export function stopTerminal(workspaceId: string): void {
	const session = sessions.get(workspaceId);
	if (!session) return;
	sessions.delete(workspaceId);
	session.dead = true;
	session.listeners.clear();
	killGroup(session.child);
}

/** The daemon is going: no shell outlives it. */
export function stopAllTerminals(): void {
	for (const workspaceId of [...sessions.keys()]) stopTerminal(workspaceId);
}
