/**
 * The browser's way in: the daemon's token, and the sessions a browser trades it for.
 *
 * The link pi prints carries the token once. The daemon answers it with a cookie and a redirect that
 * drops the token from the address bar, so it stays out of history and proxy logs. Only a hash of each
 * session id is kept, in `sessions.json` beside the token, so a copy of that file signs nobody in.
 * `owner` is a prefix of the token's hash: a daemon started with another token finds sessions that
 * belong to the old one and drops them, which is how editing `daemon.json` revokes every browser.
 */
import { createHash, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { join } from "node:path";
import { UNLOCK_FAILURES_BEFORE_LOCK, UNLOCK_LOCK_BASE_MS, UNLOCK_LOCK_CAP_MS } from "./limits.ts";
import { STATE_DIR, STATE_FILE, randomToken, readJsonFile, writeJsonFile } from "./paths.ts";

export const AUTH_FILE = join(STATE_DIR, "auth.json");

const LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSIONS = 32;
const SESSIONS_FILE = join(STATE_DIR, "sessions.json");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export let token: string = (() => {
	const saved = readJsonFile<any>(STATE_FILE, null);
	return typeof saved?.token === "string" && saved.token ? saved.token : randomToken();
})();

/** Cookies are not isolated by port, so two daemons on one host would share a name without the token's hash in it. */
let COOKIE = `pi-studio-${sha(token).slice(0, 8)}`;
let owner = sha(token).slice(0, 16);

/** sha256(session id) to the moment it ends, in milliseconds. Insertion order is age, so the first key is the oldest. */
const sessions = new Map<string, number>();

function save() {
	writeJsonFile(SESSIONS_FILE, { owner, sessions: Object.fromEntries(sessions) });
}

/** Forget what has ended. Nothing here writes: the next `save()` carries the result. */
function prune() {
	for (const [key, ends] of sessions) if (ends <= Date.now()) sessions.delete(key);
}

function loadSessions() {
	sessions.clear();
	const saved = readJsonFile<any>(SESSIONS_FILE, null);
	const kept = saved?.owner === owner && saved.sessions && typeof saved.sessions === "object" ? saved.sessions : {};
	for (const [key, ends] of Object.entries(kept)) if (typeof ends === "number") sessions.set(key, ends);
	// Loading writes nothing. What is spent or belongs to another token is dropped from memory here, and the
	// file follows on the next create or logout: a test that only imports the daemon would otherwise prune
	// the human's own state folder the moment it ran.
	prune();
}

loadSessions();

/**
 * Re-read token and browser sessions from disk. Called after the one-time legacy import copies them
 * into the XDG home at startup, so the token in memory is the imported one.
 */
export function reloadLoginState(): void {
	const saved = readJsonFile<any>(STATE_FILE, null);
	if (typeof saved?.token === "string" && saved.token) token = saved.token;
	COOKIE = `pi-studio-${sha(token).slice(0, 8)}`;
	owner = sha(token).slice(0, 16);
	loadSessions();
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
	// A proxy writes the protocol in its own spelling, `HTTPS` as readily as `https`, and a chain of hops
	// as `https, http` with the one nearest the browser first. The first item, in lowercase, is the word
	// that says how this request was carried.
	const carried = String(forwardedProto ?? "").split(",")[0].trim().toLowerCase();
	const secure = carried === "https" ? "; Secure" : "";
	return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${id ? LIFETIME_SECONDS : 0}${secure}`;
}

// ---------- master password ------------------------------------------------

/**
 * The password file the CLI writes and this module reads on every `/unlock` attempt, so a password
 * set while the daemon runs takes effect without a restart. Only a salted scrypt hash is stored:
 * reading the file yields nothing that unlocks, and the cost parameters ride in the record so a
 * later cost bump never strands an old hash. The printed token link still works as break-glass.
 */
type AuthRecord = { n: number; r: number; p: number; salt: string; hash: string };

function authRecord(): AuthRecord | null {
	const saved = readJsonFile<any>(AUTH_FILE, null);
	if (!saved || typeof saved !== "object" || saved.algo !== "scrypt") return null;
	// The bounds matter beyond tidiness: these numbers go straight into the hasher, so anything
	// beyond what the CLI ever writes is treated as no password at all rather than fed in.
	const { N, r, p, salt, hash } = saved as { N?: unknown; r?: unknown; p?: unknown; salt?: unknown; hash?: unknown };
	if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
	const n = N as number;
	const rr = r as number;
	const pp = p as number;
	// scrypt needs N a power of two; the CLI writes 16384/8/1, and anything grander than these
	// ceilings is not a hash this app meant to verify against.
	if (n < 2 || n > 2 ** 20 || (n & (n - 1)) !== 0 || rr < 1 || rr > 32 || pp < 1 || pp > 16) return null;
	if (typeof salt !== "string" || !/^[0-9a-f]{32}$/.test(salt) || typeof hash !== "string" || !/^[0-9a-f]{128}$/.test(hash)) return null;
	return { n, r: rr, p: pp, salt, hash };
}

/** Whether a master password is set, so the form, the lockout answers and the 403 hint agree. */
export function passwordIsSet(): boolean {
	return authRecord() !== null;
}

const scryptAsync = (password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> =>
	new Promise((resolvePromise, reject) => scrypt(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolvePromise(key))));
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

let unlockFailures = 0;
let lockedUntilMs = 0;
let seenHash: string | null = null;
/** One hash at a time: a burst of concurrent attempts is answered 429 without hashing, so nobody can farm CPU while the lockout counts. */
let verifying = false;

/** Seconds the lock still has to run, for the `Retry-After` on a 429. */
export function unlockLockSecondsLeft(): number {
	// A racing retry that was turned away mid-hash is told to wait a second, never zero.
	return Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 1000));
}

/** One verdict per `/unlock` attempt: whether this candidate unlocks, is wrong, is locked out, or nothing is set at all. */
export async function verifyMasterPassword(candidate: string): Promise<"ok" | "wrong" | "locked" | "unset"> {
	const record = authRecord();
	if (!record) return "unset";
	// A password changed while the daemon runs resets the lockout against the old hash.
	if (record.hash !== seenHash) {
		seenHash = record.hash;
		unlockFailures = 0;
		lockedUntilMs = 0;
	}
	if (lockedUntilMs > Date.now() || verifying) return "locked";
	verifying = true;
	try {
		const derived = (await scryptAsync(candidate, Buffer.from(record.salt, "hex"), 64, {
			N: record.n,
			r: record.r,
			p: record.p,
			maxmem: SCRYPT_MAXMEM,
		})) as Buffer;
		const expected = Buffer.from(record.hash, "hex");
		const ok = expected.length === derived.length && timingSafeEqual(derived, expected);
		if (ok) {
			unlockFailures = 0;
			lockedUntilMs = 0;
			return "ok";
		}
		unlockFailures += 1;
		if (unlockFailures >= UNLOCK_FAILURES_BEFORE_LOCK) {
			const span = Math.min(UNLOCK_LOCK_BASE_MS * 2 ** Math.max(0, unlockFailures - UNLOCK_FAILURES_BEFORE_LOCK), UNLOCK_LOCK_CAP_MS);
			lockedUntilMs = Date.now() + span;
		}
		return "wrong";
	} finally {
		verifying = false;
	}
}
