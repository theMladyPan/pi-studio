// Asks a daemon that is already running to restart every registered plugin, from the registration as
// it stands on disk. The daemon left its token and port in its state folder when it started, so this
// reads them there and asks on loopback; it writes nothing and starts nothing itself.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDirOf } from "./runtime.mjs";

// The daemon's state file, beside its token and port. Resolved through the launcher's own state-dir
// rule rather than the server's paths, so this module works in a staged tree too, where the server
// only exists compiled.
const STATE_FILE = join(stateDirOf({}), "daemon.json");

function readJsonFile(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

export async function reloadPlugins() {
	const saved = existsSync(STATE_FILE) ? readJsonFile(STATE_FILE) : null;
	if (!saved || typeof saved !== "object" || !saved.token || !saved.port) {
		throw new Error("pi-studio: no daemon has run — start one and try again");
	}
	let response;
	try {
		response = await fetch(`http://127.0.0.1:${saved.port}/plugins/reload?token=${saved.token}`, { method: "POST" });
	} catch {
		throw new Error("pi-studio: the daemon is not answering — start it first");
	}
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const problems = (body?.problems || []).map((one) => (one.name ? `${one.name}: ` : "") + one.problem);
		throw new Error(`pi-studio: the daemon refused the reload${problems.length ? ` — ${problems.join("; ")}` : ""}`);
	}
	if (!Array.isArray(body?.roster)) throw new Error("pi-studio: the daemon answered without a roster — nothing was reloaded");
	return { roster: body.roster, problems: body.problems ?? [] };
}
