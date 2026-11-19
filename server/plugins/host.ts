/**
 * One plugin process: spawned directly, spoken to over its own pipes, and shut down when it is done.
 *
 * A plugin is a trusted executable on this machine, spawned with no shell in between, so nothing in a
 * name or an argument can become another command. It speaks the line protocol in `protocol.ts`: the
 * host asks it for work, it asks the host for work, and both ends answer what the other called.
 *
 * Three failures a daemon cannot afford are answered here. A plugin that never answers a request is
 * given a deadline and then written off. A plugin that floods its output meets two limits: a frame over
 * a megabyte is dropped, and a write the plugin is not reading waits for the pipe rather than growing a
 * queue in this process. A plugin that dies takes its pending calls with it: each one is rejected with
 * what happened instead of waiting out its own clock.
 *
 * What a plugin may see is decided by `pluginEnv`. The environment is an allowlist, so the daemon's own
 * token and URL never reach it. That is a guard against leaking credentials by accident, not a
 * sandbox: the plugin runs as the same user and can read the state folder it likes.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import {
	FrameReader,
	INITIALIZE,
	INTERNAL_ERROR,
	MAX_FRAME_BYTES,
	METHOD_NOT_FOUND,
	PLUGIN_UNAVAILABLE,
	PROTOCOL_VERSION,
	SHUTDOWN,
	encodeFrame,
	errorFrame,
	notificationFrame,
	parseMessage,
	requestFrame,
	resultFrame,
} from "./protocol.ts";
import type { PluginId, PluginWire } from "./protocol.ts";
import type { PluginEntry } from "./registry.ts";

// ---------- what a plugin is told ----------

/**
 * The variables a plugin inherits: what a program needs to run and to find its own files, and nothing
 * else. Everything the daemon holds for itself — `PI_STUDIO_TOKEN`, `PI_STUDIO_URL`, the variables a
 * browser session lives in — is left out, so a plugin cannot act as the daemon by accident.
 */
const INHERITED = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
];

/** The environment one plugin is started with, built from the daemon's own by allowlist. */
export function pluginEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of INHERITED) {
		const value = source[name];
		if (typeof value === "string") env[name] = value;
	}
	return env;
}

// ---------- what a caller holds ----------

/** What a plugin said about itself when it was asked to initialize. */
export type PluginInfo = { name: string; version: string };

/** One call a plugin makes of the host. Which plugin is calling is the host's to say, not the plugin's. */
export type PluginCall = {
	plugin: string;
	method: string;
	params: unknown;
};

export type PluginHostOptions = {
	/** Where a plugin's stderr and the host's own complaints go. A test says nothing. */
	log?: (line: string) => void;
	/** How long the plugin has to answer `initialize`. */
	handshakeTimeoutMs?: number;
	/** How long any later request may take, unless the caller names its own. */
	requestTimeoutMs?: number;
	/** How long a plugin has to exit after its input is closed, before it is killed. */
	closeTimeoutMs?: number;
	/**
	 * What the daemon offers a plugin that calls it. A method it does not answer is refused with
	 * `METHOD_NOT_FOUND`, and one that throws is refused with the message it threw.
	 */
	onRequest?: (call: PluginCall) => unknown | Promise<unknown>;
};

/** How a plugin process ended. */
export type PluginExit = { code: number | null; signal: NodeJS.Signals | null };

/** One running plugin, as the daemon holds it. */
export type PluginHost = {
	readonly entry: PluginEntry;
	/** What the plugin called itself, read from its `initialize` answer. */
	readonly info: PluginInfo;
	/** Whether the process is still there to be spoken to. */
	running: () => boolean;
	/** Ask the plugin for something. Rejects when it refuses, dies, or runs past its deadline. */
	request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
	/** Tell the plugin something, with nothing wanted back. */
	notify: (method: string, params?: unknown) => void;
	/** The tail of what the plugin last wrote on stderr, for a diagnosis a caller can read. */
	diagnostics: () => string;
	/** Close the plugin's input, give it a moment, then kill it. Calling it twice is harmless. */
	close: () => Promise<void>;
	/** Settles once the process is gone, however it went. */
	readonly exited: Promise<PluginExit>;
};

/** How long a plugin has to answer `initialize` before the host gives up on it. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** How long one request may take, and how long a plugin has to exit, unless a caller says otherwise. */
export const REQUEST_TIMEOUT_MS = 30_000;
export const CLOSE_TIMEOUT_MS = 2_000;

/** How much of a plugin's stderr is kept for a diagnosis. */
const MAX_STDERR_BYTES = 8 * 1024;

/** A plugin that refused a call, died, or was never started. `code` is the JSON-RPC one it carried. */
export class PluginFailure extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "PluginFailure";
		this.code = code;
	}
}

type Pending = { method: string; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

// ---------- starting one ----------

/**
 * Start one plugin and bring it as far as a finished handshake, which is the point at which it may be
 * asked for work. A plugin that cannot start, says another protocol version, or dies on the way up
 * rejects here and leaves no process behind.
 */
export async function startPlugin(entry: PluginEntry, options: PluginHostOptions = {}): Promise<PluginHost> {
	const log = options.log ?? ((line: string) => process.stderr.write(line));
	const reader = new FrameReader();
	const pending = new Map<string, Pending>();
	const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	let child: ChildProcess | null = null;
	let running = false;
	let closed = false;
	let info: PluginInfo = { name: entry.name, version: "" };
	let stderrTail = "";
	let nextId = 0;
	let settleExit: (exit: PluginExit) => void = () => {};
	const exited = new Promise<PluginExit>((resolve) => {
		settleExit = resolve;
	});

	const host: PluginHost = {
		entry,
		get info() {
			return info;
		},
		running: () => running,
		request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => {
			if (!running) return Promise.reject(new PluginFailure(PLUGIN_UNAVAILABLE, `${entry.name} is not running`));
			return call(method, params, timeoutMs ?? requestTimeoutMs) as Promise<T>;
		},
		notify: (method, params) => {
			if (!running) return;
			void write(encodeFrame(notificationFrame(method, params))).catch(() => {});
		},
		diagnostics: () => stderrTail,
		close,
		exited,
	};

	child = spawn(entry.command, entry.args, {
		// Its own folder, so a plugin that writes beside itself finds itself, and nothing here is the
		// workspace a human happens to have open.
		cwd: dirname(entry.command),
		// Never a shell: an argument stays an argument.
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: pluginEnv(),
	});

	child.stdout?.on("data", (chunk: Buffer) => read(chunk));
	child.stderr?.on("data", (chunk: Buffer) => diagnose(String(chunk)));
	// A stream that errors after the process is gone has nothing left to say, and an unhandled 'error'
	// here would take the daemon down over output it was already told to drop.
	child.stdout?.on("error", () => {});
	child.stderr?.on("error", () => {});
	child.stdin?.on("error", (error: Error) => {
		// A plugin that died between two calls turns the next write into EPIPE, which is a plugin that
		// is gone rather than a daemon that crashed.
		diagnose(`${entry.name}: stdin failed: ${error.message}\n`);
	});
	child.on("error", (error: Error) => fail(`could not start ${entry.name}: ${error.message}`));
	child.on("close", (code: number | null, signal: NodeJS.Signals | null) => gone({ code, signal }));

	try {
		const answer = await call(INITIALIZE, { protocolVersion: PROTOCOL_VERSION, plugin: entry.name, client: { name: "pi-studio" } }, options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
		const said = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
		if (said.protocolVersion !== PROTOCOL_VERSION) {
			throw new PluginFailure(PLUGIN_UNAVAILABLE, `${entry.name} speaks protocol ${String(said.protocolVersion)}; this daemon speaks ${PROTOCOL_VERSION}`);
		}
		info = {
			name: typeof said.name === "string" && said.name !== "" ? said.name : entry.name,
			version: typeof said.version === "string" ? said.version : "",
		};
		running = true;
	} catch (error) {
		await close();
		throw error;
	}
	return host;

	// ---------- the pipes ----------

	/** One chunk of the plugin's output: the frames it completed, and the ones too large to keep. */
	function read(chunk: Buffer): void {
		const { frames, dropped } = reader.push(chunk);
		if (dropped > 0) diagnose(`${entry.name}: dropped ${dropped} frame(s) over the ${MAX_FRAME_BYTES} byte limit\n`);
		for (const line of frames) dispatch(line);
	}

	/** A plugin's stderr is diagnostics, never protocol: it is logged and its tail kept for the caller. */
	function diagnose(text: string): void {
		stderrTail = `${stderrTail}${text}`.slice(-MAX_STDERR_BYTES);
		log(`[plugin:${entry.name}] ${text}`);
	}

	/**
	 * Write one frame to the plugin. A pipe that takes the whole frame is the ordinary case; one that
	 * does not is a plugin falling behind, and this call waits for the drain instead of buffering the
	 * daemon's heap for it.
	 */
	async function write(text: string): Promise<void> {
		const stdin = child?.stdin;
		if (!stdin || stdin.destroyed || closed) throw new PluginFailure(PLUGIN_UNAVAILABLE, `${entry.name} is not running`);
		if (stdin.write(text)) return;
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				clearTimeout(timer);
				stdin.off("drain", finish);
				stdin.off("error", failed);
			};
			const failed = (error: Error) => {
				finish();
				reject(new PluginFailure(PLUGIN_UNAVAILABLE, `${entry.name} stopped reading its input: ${error.message}`));
			};
			const timer = setTimeout(failed, requestTimeoutMs, new Error("it never drained"));
			timer.unref?.();
			stdin.on("drain", finish);
			stdin.on("error", failed);
		});
	}

	// ---------- calling ----------

	/** Send one call and wait for the answer with its id, or for the deadline, or for the plugin to go. */
	function call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		const id = (nextId += 1);
		const key = String(id);
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(key);
				reject(new PluginFailure(PLUGIN_UNAVAILABLE, `${entry.name} did not answer ${method} within ${timeoutMs} ms`));
			}, timeoutMs);
			timer.unref?.();
			pending.set(key, { method, resolve, reject, timer });
			try {
				void write(encodeFrame(requestFrame(id, method, params))).catch((error: Error) => {
					forget(key);
					reject(error);
				});
			} catch (error) {
				forget(key);
				reject(error as Error);
			}
		});
	}

	function forget(key: string): void {
		const waiting = pending.get(key);
		if (!waiting) return;
		clearTimeout(waiting.timer);
		pending.delete(key);
	}

	/** Every call still waiting is answered with the same reason, because none of them will be now. */
	function settle(error: PluginFailure): void {
		for (const [key, waiting] of pending) {
			clearTimeout(waiting.timer);
			pending.delete(key);
			waiting.reject(error);
		}
	}

	// ---------- what the plugin says ----------

	function dispatch(line: string): void {
		const message = parseMessage(line);
		if (message.kind === "response") {
			const key = String(message.id);
			const waiting = pending.get(key);
			// An answer to a call this host has already given up on is worth nothing.
			if (!waiting) return;
			forget(key);
			if ("error" in message) waiting.reject(new PluginFailure(message.error.code, `${entry.name} refused ${waiting.method}: ${message.error.message}`));
			else waiting.resolve(message.result);
			return;
		}
		if (message.kind === "request") {
			void answer(message.id, message.method, message.params);
			return;
		}
		if (message.kind === "invalid") {
			send(errorFrame(message.id, message.error));
			return;
		}
		// A notification has no answer to give in this slice: nothing the host does is worth an event yet.
		diagnose(`${entry.name} said ${message.method} without a call to answer\n`);
	}

	/** One call the plugin made, answered with what the daemon offered or with why it offered nothing. */
	async function answer(id: PluginId, method: string, params: unknown): Promise<void> {
		const onRequest = options.onRequest;
		if (!onRequest) {
			send(errorFrame(id, { code: METHOD_NOT_FOUND, message: `${method} is not a method this daemon answers` }));
			return;
		}
		try {
			send(resultFrame(id, await onRequest({ plugin: entry.name, method, params })));
		} catch (error) {
			send(errorFrame(id, { code: INTERNAL_ERROR, message: (error as Error).message }));
		}
	}

	/** A frame sent on behalf of the plugin's own call. A frame that cannot go is a plugin already gone. */
	function send(frame: PluginWire): void {
		try {
			void write(encodeFrame(frame)).catch((error: Error) => diagnose(`${entry.name}: ${error.message}\n`));
		} catch (error) {
			diagnose(`${entry.name}: ${(error as Error).message}\n`);
		}
	}

	// ---------- going away ----------

	/** The process is gone: nothing is left to answer, and every waiting call is told why. */
	function gone(exit: PluginExit): void {
		running = false;
		closed = true;
		settle(new PluginFailure(PLUGIN_UNAVAILABLE, `${entry.name} exited (${exit.signal ?? exit.code})`));
		settleExit(exit);
	}

	/** The process could not be spoken to at all, which is the same end as one that died. */
	function fail(reason: string): void {
		running = false;
		diagnose(`${reason}\n`);
		settle(new PluginFailure(PLUGIN_UNAVAILABLE, reason));
		// A process that never started has no exit event to wait for.
		if (child?.pid === undefined) {
			closed = true;
			settleExit({ code: null, signal: null });
		}
	}

	/**
	 * Ask the plugin to stop, then end its input, then give it a moment, then kill it. The order matters:
	 * a plugin that has something to finish gets the notice first, and one that does not is not left
	 * running because it chose to ignore its input.
	 */
	async function close(): Promise<void> {
		if (closed) {
			await exited;
			return;
		}
		closed = true;
		running = false;
		settle(new PluginFailure(PLUGIN_UNAVAILABLE, `${entry.name} was closed`));
		const started = child;
		if (!started) return;
		if (started.exitCode === null && started.signalCode === null) {
			try {
				started.stdin?.write(encodeFrame(notificationFrame(SHUTDOWN)));
			} catch {
				// Already gone, which is what this wanted.
			}
			started.stdin?.end();
			const grace = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
			if (await wait(grace)) return;
			// A plugin that does not read its input does not read SIGTERM either; the close event still
			// arrives, so a caller learns the process is gone.
			started.kill("SIGKILL");
			await wait(Math.min(grace, 1_000));
		}
	}

	/** Whether the process is gone within `ms`. The timer is not unref'd: a daemon closing a plugin waits for it. */
	function wait(ms: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), ms);
			void exited.then(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}
}
