// Asks a daemon that is already running to restart every registered plugin, from the registration as
// it stands on disk. The daemon left its token and port in its state folder when it started, so this
// reads them there and asks on loopback; it writes nothing and starts nothing itself.
import { STATE_FILE, readJsonFile } from "../server/paths.ts";

export async function reloadPlugins() {
	const saved = readJsonFile(STATE_FILE, null);
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
