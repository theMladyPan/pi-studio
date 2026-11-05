/**
 * The browser's way in: the daemon's token, and the sessions a browser trades it for.
 *
 * The link pi prints carries the token once. The daemon answers it with a cookie and a redirect that
 * drops the token from the address bar, so it stays out of history and proxy logs. Only a hash of each
 * session id is kept, in `sessions.json` beside the token, so a copy of that file signs nobody in.
 * `owner` is a prefix of the token's hash: a daemon started with another token finds sessions that
 * belong to the old one and drops them, which is how editing `daemon.json` revokes every browser.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { STATE_DIR, STATE_FILE, randomToken, readJsonFile, writeJsonFile } from "./paths.ts";

const LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSIONS = 32;
const SESSIONS_FILE = join(STATE_DIR, "sessions.json");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export const token: string = (() => {
	const saved = readJsonFile<any>(STATE_FILE, null);
	return typeof saved?.token === "string" && saved.token ? saved.token : randomToken();
})();

/** Cookies are not isolated by port, so two daemons on one host would share a name without the token's hash in it. */
const COOKIE = `pi-studio-${sha(token).slice(0, 8)}`;
const owner = sha(token).slice(0, 16);

/** sha256(session id) to the moment it ends, in milliseconds. Insertion order is age, so the first key is the oldest. */
const sessions = new Map<string, number>();

function save() {
	writeJsonFile(SESSIONS_FILE, { owner, sessions: Object.fromEntries(sessions) });
}

/** Forget what has ended. Nothing here writes: the next `save()` carries the result. */
function prune() {
	for (const [key, ends] of sessions) if (ends <= Date.now()) sessions.delete(key);
}

{
	const saved = readJsonFile<any>(SESSIONS_FILE, null);
	const kept = saved?.owner === owner && saved.sessions && typeof saved.sessions === "object" ? saved.sessions : {};
	for (const [key, ends] of Object.entries(kept)) if (typeof ends === "number") sessions.set(key, ends);
	// Loading writes nothing. What is spent or belongs to another token is dropped from memory here, and the
	// file follows on the next create or logout: a test that only imports the daemon would otherwise prune
	// the human's own state folder the moment it ran.
	prune();
}

/** A new session's id, to be set as a cookie. Never expires early and is never extended. */
export function createSession(): string {
	prune();
	const id = randomToken();
	sessions.set(sha(id), Date.now() + LIFETIME_SECONDS * 1000);
	while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
	save();
	return id;
}

function idIn(cookieHeader: string | undefined): string {
	for (const part of String(cookieHeader ?? "").split(";")) {
		const cut = part.indexOf("=");
		if (cut !== -1 && part.slice(0, cut).trim() === COOKIE) return part.slice(cut + 1).trim();
	}
	return "";
}

/** Whether the cookie header carries a session that is still running. */
export function hasSession(cookieHeader: string | undefined): boolean {
	const key = sha(idIn(cookieHeader));
	const ends = sessions.get(key);
	if (ends === undefined) return false;
	if (ends > Date.now()) return true;
	sessions.delete(key);
	return false;
}

/** Ends the session the cookie header names, if any. */
export function endSession(cookieHeader: string | undefined): void {
	if (sessions.delete(sha(idIn(cookieHeader)))) save();
}

/**
 * The Set-Cookie value for a session, or for its removal when `id` is empty. `Secure` rides only on a
 * request a TLS proxy said it carried: the daemon speaks plain http itself, and a browser drops a
 * Secure cookie from a plain http page without a word.
 */
export function sessionCookie(id: string, forwardedProto: string | undefined): string {
	const secure = forwardedProto === "https" ? "; Secure" : "";
	return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${id ? LIFETIME_SECONDS : 0}${secure}`;
}
