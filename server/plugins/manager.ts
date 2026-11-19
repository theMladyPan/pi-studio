/**
 * The plugins this daemon runs: the executables the human registered, started once, asked for work, and
 * closed when the daemon goes.
 *
 * A plugin is a program named in the daemon's own `plugins.json` by the absolute path of an executable,
 * so the roster is a deliberate act on this machine and nothing a board, a thread or a drop says is read
 * here. The daemon starts the roster when it starts — from `start()` in `main.ts`, which is the one
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
import { loadPluginRegistry, PLUGINS_FILE } from "./registry.ts";
import type { PluginCall, PluginHost } from "./host.ts";
import type { PluginProblem, PluginRegistry } from "./registry.ts";

/** One plugin as the daemon holds it. The seam a settings page or a status report reads. */
export type PluginRoster = { name: string; command: string; version: string; running: boolean };

export type PluginStartOptions = {
	/** The registration to read. A test names its own file; the daemon reads its own state folder. */
	file?: string;
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
	await stopPlugins();
	const registry: PluginRegistry = loadPluginRegistry(options.file ?? PLUGINS_FILE);
	const log = options.log ?? ((line: string) => process.stderr.write(line));
	const problems: PluginProblem[] = [...registry.problems];
	for (const problem of registry.problems) log(`pi-studio: plugin ${problem.name || "(unnamed)"} is not usable: ${problem.problem}\n`);
	const hosts = new Map<string, PluginHost>();

	await Promise.all(
		registry.plugins.map(async (entry) => {
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
		request: <T = unknown>(plugin: string, method: string, params?: unknown, timeoutMs?: number) => {
			const host = hosts.get(plugin);
			if (!host) return Promise.reject(new PluginFailure(PLUGIN_UNAVAILABLE, `${plugin} is not a plugin this daemon runs`));
			return host.request<T>(method, params, timeoutMs);
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
			})),
		problems: () => [...problems],
		close: async () => {
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
 * Close every plugin this process runs, whatever state it is in. It is what a stopped daemon does on the
 * way out, and what a test does in `after` so no fixture outlives the run that started it.
 */
export async function stopPlugins(): Promise<void> {
	const manager = current;
	current = null;
	if (manager) await manager.close().catch(() => {});
}
