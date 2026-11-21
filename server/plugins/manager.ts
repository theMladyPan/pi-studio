/**
 * The plugins this daemon runs: the executables the human registered, started once, asked for work, and
 * closed when the daemon goes.
 *
 * A plugin is a program named in the daemon's own `plugins.json`, by the absolute path of an executable or
 * by the name of one this install ships, so the roster is a deliberate act on this machine and nothing a
 * board, a thread or a drop says is read here. The daemon starts the roster when it starts — from `start()` in `main.ts`, which is the one
 * callable that boots it — and never on import, so a test that only imports daemon code starts no
 * program and a plugin is never started by somebody opening a file.
 *
 * Failure is isolated per plugin. One that cannot be spawned, that never finishes its handshake or that
 * speaks another protocol version is written off with the reason kept in `problems()`, and the rest of
 * the roster starts and runs as if it were alone. Nothing here writes into a workspace or opens a board:
 * what a plugin may read and change it asks for, through the methods in `service.ts`.
 */
import { PluginFailure, startPlugin } from "./host.ts";
import { PLUGIN_UNAVAILABLE } from "./protocol.ts";
import { loadPluginRegistry } from "./registry.ts";
import type { PluginCall, PluginHost } from "./host.ts";
import type { PluginProblem, PluginRegistry, PluginVisual } from "./registry.ts";

/** One plugin as the daemon holds it. The seam a settings page or a status report reads. */
export type PluginRoster = {
	name: string;
	command: string;
	version: string;
	running: boolean;
	visual?: PluginVisual;
	shortcut?: string;
	/** Registered but not yet spawned: a lazy plugin that waits for its first panel request. */
	dormant?: boolean;
};

/** The start this process began with, so the roster can be read and started again without one. */
let lastOptions: PluginStartOptions | null = null;

export type PluginStartOptions = {
	/** The registration to read. A test names its own file; the daemon reads its own state folder. */
	file?: string;
	/** The plugins this install ships. A test names its own folder; the daemon reads the one it was installed in. */
	bundledDir?: string;
	/** Where a plugin's stderr and this daemon's own complaints go. */
	log?: (line: string) => void;
	/** What the daemon offers a plugin that calls it. */
	onRequest?: (call: PluginCall) => unknown | Promise<unknown>;
	handshakeTimeoutMs?: number;
	requestTimeoutMs?: number;
	closeTimeoutMs?: number;
};

/** The plugins that are running, and the rows that are not. */
export type PluginManager = {
	/** Ask one plugin for something. Rejects when it is not running, refuses, or runs past its deadline. */
	request: <T = unknown>(plugin: string, method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
	/** Tell one plugin something, with nothing wanted back. False when there is no such plugin to tell. */
	notify: (plugin: string, method: string, params?: unknown) => boolean;
	/** The roster as it stands, with what each plugin called itself. */
	roster: () => PluginRoster[];
	/** Every row that did not become a running plugin, and why. */
	problems: () => PluginProblem[];
	/** Close every plugin, and wait for them to go. Calling it twice is harmless. */
	close: () => Promise<void>;
};

/** The manager this process runs, once the daemon has started one. */
let current: PluginManager | null = null;

/** The manager a caller may ask for, or null before the daemon started or after it closed them. */
export function pluginManager(): PluginManager | null {
	return current;
}

/** Tell one plugin something. False when no plugin of that name is running here. */
export function notifyPlugin(plugin: string, method: string, params?: unknown): boolean {
	return current?.notify(plugin, method, params) ?? false;
}

/**
 * Start every plugin the registration names, and hand back the manager that holds them.
 *
 * The roster is read first and then started, all at once rather than one after another, so a slow plugin
 * does not delay the next. Each start is its own, and one that fails is a line in the log and a row in
 * `problems()`: the plugin that failed is nowhere in the roster and the others are asked for work as
 * usual. A manager already running is closed first, so there is never more than one of each plugin.
 */
export async function startPlugins(options: PluginStartOptions = {}): Promise<PluginManager> {
	lastOptions = options;
	await stopPlugins();
	const registry: PluginRegistry = loadPluginRegistry(options.file, options.bundledDir);
	const log = options.log ?? ((line: string) => process.stderr.write(line));
	const problems: PluginProblem[] = [...registry.problems];
	for (const problem of registry.problems) log(`pi-studio: plugin ${problem.name || "(unnamed)"} is not usable: ${problem.problem}\n`);
	const hosts = new Map<string, PluginHost>();
	/** A lazy plugin registered but not yet started: its name until its first request spawns it. */
	const dormant = new Set<string>();
	/** A dormant plugin mid-spawn, so two first requests start it once. */
	const starting = new Map<string, Promise<PluginHost>>();

	/** Spawn a dormant plugin on its first request, and hand back its host. */
	async function ensureStarted(name: string): Promise<PluginHost> {
		const host = hosts.get(name);
		if (host && !dormant.has(name)) return host;
		if (!host) throw new PluginFailure(PLUGIN_UNAVAILABLE, `${name} is not a plugin this daemon runs`);
		const ongoing = starting.get(name);
		if (ongoing) return ongoing;
		const entry = hosts.get(name)?.entry;
		if (!entry) throw new PluginFailure(PLUGIN_UNAVAILABLE, `${name} is not a plugin this daemon runs`);
		const spawn = (async () => {
			try {
				const host = await startPlugin(entry, {
					log,
					onRequest: options.onRequest,
					...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
					...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
					...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
				});
				dormant.delete(name);
				hosts.set(name, host);
				return host;
			} catch (error) {
				// A lazy plugin that will not start is one problem until the next reload, never a
				// process per click.
				dormant.delete(name);
				hosts.delete(name);
				const problem = (error as Error).message;
				problems.push({ name, problem });
				log(`pi-studio: plugin ${name} did not start: ${problem}\n`);
				throw error;
			} finally {
				starting.delete(name);
			}
		})();
		starting.set(name, spawn);
		return spawn;
	}

	await Promise.all(
		registry.plugins.map(async (entry) => {
			// A lazy plugin is registered but not spawned: its door opens, and the first request
			// starts the process. The stub keeps the roster honest without spending a child.
			if (entry.start === "lazy") {
				dormant.add(entry.name);
				hosts.set(entry.name, {
					entry,
					info: { name: entry.name, version: entry.version ?? "" },
					running: () => false,
					request: () => Promise.reject(new PluginFailure(PLUGIN_UNAVAILABLE, `${entry.name} starts on its first panel request`)),
					notify: () => {},
					diagnostics: () => "",
					close: async () => {},
					exited: new Promise(() => {}),
				});
				return;
			}
			try {
				const host = await startPlugin(entry, {
					log,
					onRequest: options.onRequest,
					...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
					...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
					...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
				});
				hosts.set(entry.name, host);
			} catch (error) {
				// One plugin that will not run is that plugin's own failure, never the daemon's.
				const problem = (error as Error).message;
				problems.push({ name: entry.name, problem });
				log(`pi-studio: plugin ${entry.name} did not start: ${problem}\n`);
			}
		}),
	);

	const manager: PluginManager = {
		request: async <T = unknown>(plugin: string, method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
			const host = hosts.get(plugin);
			if (!host) return Promise.reject(new PluginFailure(PLUGIN_UNAVAILABLE, `${plugin} is not a plugin this daemon runs`));
			const live = dormant.has(plugin) ? await ensureStarted(plugin) : host;
			return live.request<T>(method, params, timeoutMs);
		},
		notify: (plugin, method, params) => {
			const host = hosts.get(plugin);
			if (!host || !host.running()) return false;
			host.notify(method, params);
			return true;
		},
		roster: () =>
			[...hosts.values()].map((host) => ({
				name: host.entry.name,
				command: host.entry.command,
				version: host.info.version,
				running: host.running(),
				// The panel this plugin declared, so the board can offer its door without reading the
				// registration a second time and disagreeing with what was actually started.
				...(host.entry.visual ? { visual: host.entry.visual } : {}),
				...(host.entry.shortcut ? { shortcut: host.entry.shortcut } : {}),
				...(dormant.has(host.entry.name) ? { dormant: true } : {}),
			})),
		problems: () => [...problems],
		close: async () => {
			// A first-request spawn still in flight is awaited, so its host lands here and is closed
			// rather than leaking across the reload or the shutdown that is waiting on this close.
			await Promise.allSettled([...starting.values()]);
			// Every plugin is asked at once, and one that will not go is not a reason to keep the others.
			await Promise.all([...hosts.values()].map((host) => host.close().catch(() => {})));
			hosts.clear();
			if (current === manager) current = null;
		},
	};
	current = manager;
	return manager;
}

/**
 * Read the registration again and start everything it names, closing what is running first. It is what
 * the settings page does after writing it, so a row added or removed takes effect without a daemon
 * restart, under the same start the daemon began with.
 */
export async function reloadPlugins(): Promise<PluginManager> {
	return startPlugins(lastOptions ?? {});
}

/**
 * Close every plugin this process runs, whatever state it is in. It is what a stopped daemon does on the
 * way out, and what a test does in `after` so no fixture outlives the run that started it.
 */
export async function stopPlugins(): Promise<void> {
	const manager = current;
	current = null;
	if (manager) await manager.close().catch(() => {});
}
