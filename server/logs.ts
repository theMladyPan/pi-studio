/**
 * The daemon's own log: one buffer every source writes into, and one stream the drawer reads it from.
 *
 * Before this, a line the daemon had something to say about went to the terminal it was started from —
 * a systemd journal, a `npm run server` in some window — and a human watching the board could not see
 * the git command that failed, the Docker call that refused, or the provider error behind a stopped run
 * without going to that terminal. So every one of those sources writes here instead, and the board's
 * logs drawer (right edge, `l`) shows the last five thousand lines of it.
 *
 * Three rules keep it a log rather than a second board. A line is a *message* and at most 8 KiB of it,
 * because a stack trace is a line and a gigabyte of output is not. A secret is redacted where it is
 * written, never where it is read, because the buffer stays in memory for the life of the daemon and
 * one reader forgetting the rule would be enough. And the ring never grows: the oldest line leaves when
 * the buffer is full, so a daemon that has been up for a month costs what one that just started costs.
 */

/** How bad a line is, worst first. `warning` is written so, and `warn` read from a child is the same. */
export type LogLevel = "error" | "warning" | "info" | "debug";

/** What a source may say about the command behind a line: the five fields the drawer draws as a grid. */
export type LogMeta = {
	cmd?: string;
	cwd?: string;
	exit?: number | string;
	dur?: number | string;
	[key: string]: unknown;
};

/** One line, as it is written and as it travels: numbered, stamped, redacted, capped. */
export type LogEntry = {
	id: number;
	ts: string;
	level: LogLevel;
	source: string;
	message: string;
	meta?: LogMeta;
};

/** How many lines the ring holds. */
export const LOG_CAPACITY = 5000;

/** How much of one message is kept. A stack trace fits; a runaway print does not. */
export const LOG_MESSAGE_MAX = 8192;

/** What one source is. It is the column the drawer shows, so it stays short and made of one word. */
const SOURCE_MAX = 80;

/** How bad a line is, worst first: the order a filter keeps. */
const RANK: Record<LogLevel, number> = { error: 0, warning: 1, info: 2, debug: 3 };

/**
 * The three choices the drawer's filter offers, and the worst level each one keeps. `error` is the
 * `err+warn` choice: a warning is the same kind of news as an error, and a human chasing a failure
 * wants both. The client restates this table because it filters what it already holds; the two are one
 * rule, and this one is what the test pins.
 */
const FILTER_RANK: Record<string, number> = { error: 1, info: 2, debug: 3 };

/** Whether a line of `level` passes `filter`, one of the drawer's three choices. */
export function levelPasses(filter: string, level: LogLevel): boolean {
	return RANK[level] <= (FILTER_RANK[String(filter ?? "")] ?? FILTER_RANK.info);
}

/** The levels in the order a filter offers them, worst first. */
export const LOG_LEVELS: readonly LogLevel[] = ["error", "warning", "info", "debug"];

/** A name a caller wrote, as a level: `warn` is `warning`, and anything unknown is `info`. */
export function levelOf(name: unknown): LogLevel {
	const word = String(name ?? "").trim().toLowerCase();
	if (word === "error" || word === "err") return "error";
	if (word === "warning" || word === "warn") return "warning";
	if (word === "debug") return "debug";
	return "info";
}

// ---------- redaction ----------
/**
 * The shapes a secret wears in a line this daemon writes: a value beside a name that says it is one
 * (`SWAN_API_KEY=…`, `OPENROUTER_API_KEY: …`, `password=…`), a bearer token after the word, and the two
 * headers a provider refusal quotes back. The value is replaced and the rest of the line is kept, so a
 * redacted line still says which key, which header and which endpoint were the problem.
 */
const SECRETS: readonly [RegExp, string][] = [
	// `SOMETHING_API_KEY=abc`, `GITHUB_TOKEN: ghp_x`, `SSH_KEY = "…"` — with or without quotes.
	[/\b([A-Za-z0-9_]*(?:API_KEY|_TOKEN|_KEY|PASSWORD|SECRET))\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;"']+)/gi, "$1$2***"],
	// `Authorization: Bearer abc.def` and a bare `Bearer abc.def`.
	[/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***"],
	// `password=hunter2`, in a url, a command line or a form body.
	[/\b(pass(?:word|wd|phrase)?)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, "$1$2***"],
	// The headers a refusal echoes: `x-api-key: sk-…`, `Authorization: sk-…`.
	[/\b(x-api-key|api-key|authorization)\s*:\s*(?!Bearer \*\*\*)[^\s,;\n]+/gi, "$1: ***"],
];

/** One line with every secret in it masked. Applied on the way in, so nothing downstream has to remember. */
export function redact(text: string): string {
	let out = String(text ?? "");
	for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
	return out;
}

// ---------- the ring ----------
let nextId = 1;
const ring: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

/** Everything kept, oldest first, as a copy: a reader that sorts or splices it cannot reach the ring. */
export function snapshot(): LogEntry[] {
	return ring.slice();
}

/**
 * Write one line. Level, source and message are the three every source has; `meta` is what a command
 * behind the line can add. Nothing here throws: a log that can fail its caller is a log nobody writes.
 */
export function log(level: LogLevel | string, source: string, message: string, meta?: LogMeta): LogEntry {
	const name = String(source ?? "").trim() || "daemon";
	const text = redact(String(message ?? "")).slice(0, LOG_MESSAGE_MAX);
	const entry: LogEntry = {
		id: nextId++,
		ts: new Date().toISOString(),
		level: levelOf(level),
		source: redact(name).slice(0, SOURCE_MAX),
		message: text,
	};
	if (meta && typeof meta === "object") {
		const kept: LogMeta = {};
		for (const [key, value] of Object.entries(meta)) {
			if (value === undefined || value === null || value === "") continue;
			kept[key] = typeof value === "string" ? redact(value).slice(0, LOG_MESSAGE_MAX) : value;
		}
		if (Object.keys(kept).length > 0) entry.meta = kept;
	}
	ring.push(entry);
	if (ring.length > LOG_CAPACITY) ring.splice(0, ring.length - LOG_CAPACITY);
	for (const listener of listeners) {
		try {
			listener(entry);
		} catch {
			// A stream that broke is its own reader's business: it unsubscribes on close.
		}
	}
	return entry;
}

/** Follow the log as it grows. Answers the way to stop, which every stream calls when it closes. */
export function subscribe(listener: (entry: LogEntry) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

// ---------- the daemon's own stdout and stderr ----------
/** What a chunk of output may add: a runaway print is cut rather than buffered whole. */
const TAP_CHUNK_MAX = 64 * 1024;

let tapped = false;

/**
 * Write everything the daemon prints into the log as well, and keep printing it where it always went.
 *
 * A tap and not a replacement: the terminal a daemon was started from, and the journal a service writes
 * to, are how a machine is debugged when the board itself will not answer, so both stay. Every line is
 * written to the real stream first, and the log's own writes never go through the streams at all, so a
 * line cannot echo itself back in.
 *
 * Called once, by `start()`, so a test that imports the daemon's modules captures nothing.
 */
export function tapDaemon(): void {
	if (tapped) return;
	tapped = true;
	const out = process.stdout.write.bind(process.stdout);
	const err = process.stderr.write.bind(process.stderr);
	const tap = (write: typeof process.stdout.write, level: LogLevel) =>
		((chunk: unknown, encoding?: unknown, done?: unknown) => {
			const text = String(chunk ?? "");
			for (const line of text.split("\n")) {
				if (line.trim()) log(level, "daemon", line.slice(0, TAP_CHUNK_MAX));
			}
			return write(chunk as string, encoding as BufferEncoding, done as () => void);
		}) as typeof process.stdout.write;
	process.stdout.write = tap(out, "info");
	process.stderr.write = tap(err, "error");
}

/**
 * The lines the plugin manager hands back, as the drawer's own source. The manager writes one sentence
 * per plugin and names it in the sentence, so the name is read out of that rather than guessed at here.
 */
export function logPluginLine(line: string): void {
	const text = String(line ?? "").trim();
	if (!text) return;
	const named = /^pi-studio: plugin (\S+) /.exec(text);
	log(/did not start|is not usable/.test(text) ? "error" : "info", named ? `plugin:${named[1]}` : "plugin", text);
}

/**
 * A failed child of this thread, in the drawer's own source: `child:<thread>`. The tail a thread keeps
 * for its card is one line; this is the whole reason the child gave.
 */
export function logChild(threadId: string, message: string, level: LogLevel = "debug", meta?: LogMeta): void {
	log(level, `child:${String(threadId ?? "").slice(0, 24) || "unknown"}`, message, meta);
}
