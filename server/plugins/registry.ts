/**
 * The plugins this daemon trusts, read from its own state folder and from nowhere else.
 *
 * A plugin is a program the human named in `plugins.json` by the absolute path of an executable, so
 * registering one is a deliberate act on this machine and not something a workspace can do to whoever
 * opens it. Nothing a board, a thread or a drop says is read here.
 *
 * The file is read at startup and whenever a caller asks, never watched: a plugin that is added while
 * the daemon runs is picked up by the next read, and one that is broken is reported beside the ones
 * that work instead of failing the whole list.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { STATE_DIR, readJsonFile } from "../paths.ts";

/** Where the daemon's own registration lives: beside its token and its workspaces. */
export const PLUGINS_FILE = join(STATE_DIR, "plugins.json");

/** One executable the daemon starts: what it is called, and what to run. */
export type PluginEntry = {
	name: string;
	/** An absolute path to an executable. It is spawned directly, never through a shell. */
	command: string;
	args: string[];
};

/** One row of the file that is not a plugin the daemon can start, and why. */
export type PluginProblem = { name: string; problem: string };

/** Everything the file said: the plugins that can start, and the rows that cannot. */
export type PluginRegistry = { plugins: PluginEntry[]; problems: PluginProblem[] };

/**
 * The registration as it stands. A missing file is no plugins at all, which is the normal state of a
 * new daemon; a file that cannot be read or holds the wrong shape is one problem and no plugins.
 *
 * Unknown keys on a row are ignored: a row may carry what it likes, and the visual metadata a plugin
 * will show on the board is a later slice's to read.
 */
export function loadPluginRegistry(file: string = PLUGINS_FILE): PluginRegistry {
	if (!existsSync(file)) return { plugins: [], problems: [] };
	const document = readJsonFile<unknown>(file, undefined);
	if (document === undefined) return { plugins: [], problems: [{ name: "", problem: "the file could not be read as JSON" }] };
	const rows = typeof document === "object" && document !== null ? (document as { plugins?: unknown }).plugins : undefined;
	if (!Array.isArray(rows)) return { plugins: [], problems: [{ name: "", problem: 'the file must hold { "plugins": [ … ] }' }] };
	const plugins: PluginEntry[] = [];
	const problems: PluginProblem[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			problems.push({ name: "", problem: "one row is not an object" });
			continue;
		}
		const bag = row as Record<string, unknown>;
		const name = typeof bag.name === "string" ? bag.name.trim() : "";
		if (name === "") {
			problems.push({ name: "", problem: "one row has no name" });
			continue;
		}
		if (seen.has(name)) {
			problems.push({ name, problem: "the name is used twice" });
			continue;
		}
		seen.add(name);
		const command = bag.command;
		// A relative path would be resolved against whatever folder the daemon happens to be in, and a
		// bare name would be looked up on a PATH someone else may own. Both are refused here.
		if (typeof command !== "string" || !isAbsolute(command)) {
			problems.push({ name, problem: "command must be an absolute path to an executable" });
			continue;
		}
		const args = bag.args ?? [];
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
			problems.push({ name, problem: "args must be a list of strings" });
			continue;
		}
		if (!isExecutableFile(command)) {
			problems.push({ name, problem: `${command} is not an executable file` });
			continue;
		}
		plugins.push({ name, command, args: [...(args as string[])] });
	}
	return { plugins, problems };
}

function isExecutableFile(command: string): boolean {
	try {
		if (!statSync(command).isFile()) return false;
		accessSync(command, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
