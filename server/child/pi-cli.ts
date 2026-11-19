/**
 * Where the `pi` a thread runs is found: the script this process already runs pi from, then the
 * managed install, then the `pi` binary on PATH.
 *
 * It sits in a file of its own, holding nothing but the lookup, so `pi-studio doctor` can ask the
 * same question without importing the server: the answer the doctor reports and the command a
 * thread is started with have to be the same one.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Where pi keeps the install this app drives. */
export function installRoot() {
	return process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
}

/** The extensions folder that sits beside the managed install, which a child is started with. */
export function extensionsDir() {
	return join(dirname(installRoot()), "extensions");
}

export type PiCli = { command: string; args: string[] };

export function piCli(): PiCli {
	const script = process.argv[1];
	if (script && existsSync(script) && (basename(script) === "pi" || script.includes("pi-coding-agent"))) {
		return { command: process.execPath, args: [script] };
	}
	const root = installRoot();
	try {
		const version = readFileSync(join(root, "current-version"), "utf8").trim();
		const cli = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		if (version && existsSync(cli)) return { command: process.execPath, args: [cli] };
	} catch {
		// No managed install here; PATH is the last resort.
	}
	return { command: "pi", args: [] };
}
