/**
 * The terminal behind the bottom drawer: one real shell per board, in a pty, fed over a WebSocket.
 *
 * A pty needs a native module (`node-pty`) or a helper that already makes one. This daemon ships
 * with no dependencies of its own, so the shell runs under a helper this machine already has —
 * `script(1)` from util-linux, or `socat` — which hands the shell a `/dev/pts` as its stdout and is
 * the whole pty for our purposes: colours, job control and full-screen programs behave as they do in
 * a terminal. A machine with neither is told what to install instead of being left on an empty
 * screen, and the drawer stays up to say it.
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
import { programOnPath } from "./paths.ts";

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

/**
 * The pty makers this daemon can run a shell in, best first. Each hands the shell a real `/dev/pts`,
 * which is the whole of what the drawer needs, and each is asked for its absolute path before a
 * spawn, so a machine with neither is known without waiting for a failed process.
 */
type PtyHelper = {
	/** The name the drawer and this file call it. */
	name: string;
	/** The program to run. */
	command: string;
	/** The words that run `shell` in a pty of `size`, with the shell's path already quoted for it. */
	argv: (shell: string, size: TerminalSize) => string[];
};

const HELPERS: PtyHelper[] = [
	{
		// util-linux `script(1)` has no flag for the size of the pty it makes, so `stty` writes it in
		// before the shell starts.
		name: "script",
		command: "script",
		argv: (shell, size) => ["-qec", `stty rows ${size.rows} cols ${size.cols}; exec '${shell.replace(/'/g, `'\\''`)}'`, "/dev/null"],
	},
	{
		// `socat` takes the size as an option of its own. Its command is one quoted word, so a shell path
		// with a space in it stays one word; one with a quote in it is the `script` helper's job. `ctty`
		// matters: without it the pty is only the shell's stdio, not its controlling terminal, so ^C is
		// echoed by the line discipline but no SIGINT reaches the foreground command.
		name: "socat",
		command: "socat",
		argv: (shell, size) => ["-", `SYSTEM:'exec "${shell}"',pty,setsid,ctty,sigint,sane,tiocswinsz=${size.cols}:${size.rows}`],
	},
];

/** What a board is told when this machine can make no pty at all: the reason, and the way out of it. */
const NO_HELPER =
	"no terminal helper on this machine, so no shell can start: install util-linux (sudo dnf install util-linux, sudo apt install util-linux, or sudo pacman -S util-linux) or socat";

/** The pty maker this machine has, or null. Asked of PATH once per shell, so a helper installed while
 * the daemon runs is found by the next board that starts one. */
function helperHere(): { helper: PtyHelper; path: string } | null {
	for (const helper of HELPERS) {
		const path = programOnPath(helper.command);
		if (path) return { helper, path };
	}
	return null;
}

type Listener = (event: TerminalEvent) => void;

type Session = {
	/** The helper running the shell, or null when this machine has none to run. */
	child: ChildProcess | null;
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
	const found = helperHere();
	const session: Session = { child: null, folder, scrollback: "", listeners: new Set(), spawned: size, dead: false };
	if (!found) {
		// Nothing here can make a pty, so the tab is told why rather than left on an empty screen. The
		// answer goes out a turn later, because the tab attaches to the session this returns; the session
		// is spent either way, so the next roll up asks this machine again.
		session.dead = true;
		setTimeout(() => {
			for (const listener of session.listeners) listener({ type: "error", data: NO_HELPER });
			session.listeners.clear();
			for (const [id, held] of sessions) if (held === session) sessions.delete(id);
		}, 0);
		return session;
	}
	// The shell path is the daemon's own choice (`commandShell`), and each helper quotes it its own way.
	const child = spawn(found.path, found.helper.argv(commandShell(), size), {
		cwd: folder,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, TERM: "xterm-256color" },
	});
	session.child = child;
	child.stdout?.on("data", (chunk) => {
		const text = String(chunk);
		session.scrollback = (session.scrollback + text).slice(-SCROLLBACK_CHARS);
		for (const listener of session.listeners) listener({ type: "output", data: text });
	});
	// The helper's stderr carries its own notices, not the shell's; the shell's stderr arrives on the
	// pty and is stdout here. Draining this one keeps a noisy helper from blocking instead.
	child.stderr?.on("data", () => {});
	child.on("error", (error) => {
		// A helper that is there but refuses to start is the ordinary shape of this failure, and the
		// drawer says so rather than sitting silent.
		const message = `the ${found.helper.name} terminal helper could not start: ${error.message}`;
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
	// A session this handle already saw end — the shell exited, or the board was emptied —
	// never revives under it. The next roll up is a new socket, and that one starts fresh.
	const refused = () => Boolean(session && session.dead);
	const ensure = (size: TerminalSize): Session => {
		if (!session) {
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
			if (detached || refused() || !data) return;
			const held = ensure(DEFAULT_SIZE);
			held.child?.stdin?.write(data);
		},
		resize: (size) => {
			if (detached || refused()) return;
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
	// The tabs still attached hear the shell end, so a drawer left open over an emptied board
	// says so instead of sitting on a prompt that is never coming.
	for (const listener of session.listeners) listener({ type: "exit", code: null });
	session.listeners.clear();
	if (session.child) killGroup(session.child);
}

/** The daemon is going: no shell outlives it. */
export function stopAllTerminals(): void {
	for (const workspaceId of [...sessions.keys()]) stopTerminal(workspaceId);
}
