// The master password: set, change and remove the unlock credential.
//
// The daemon keeps only the scrypt hash in `auth.json` beside the token (mode 0600, through the
// same atomic writer the install uses) and re-reads it on every attempt, so a password written
// here takes effect without a daemon restart. Nothing is printed back: the hash would not unlock
// anything, and the password is worth saving in a vault, not in a transcript.
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fail, stateDirOf, writeJsonAtomic } from "./runtime.mjs";

/** The cost the daemon verifies with. Kept beside them here so the CLI writes what the daemon reads. */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
export const MAX_PASSWORD_CHARS = 1024;

export function authFileOf(flags = {}) {
	return join(stateDirOf(flags), "auth.json");
}

/** One sealed record for the daemon: parameters, salt, hash, and nothing that could unlock bare. */
export function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 64, { ...SCRYPT_PARAMS, maxmem: 64 * 1024 * 1024 });
	return { v: 1, algo: "scrypt", ...SCRYPT_PARAMS, salt: salt.toString("hex"), hash: hash.toString("hex"), createdAt: new Date().toISOString() };
}

/**
 * One hidden line from the terminal: echo off, Enter ends it, SIGINT restores the terminal and
 * stops. A prompt that cannot hide an answer is refused, so the password is never typed in plain
 * sight over the shoulder or into a log.
 */
function askHidden(question) {
	return new Promise((resolvePromise, reject) => {
		const input = process.stdin;
		if (!input.isTTY) {
			reject(new Error("pi-studio: no terminal to type the password on; run this on the machine itself"));
			return;
		}
		const output = process.stdout;
		let value = "";
		let settled = false;
		const restore = () => {
			try {
				input.setRawMode(false);
			} catch {
				// Already restored, or no longer a TTY: nothing left to put back.
			}
			input.pause();
			output.write("\n");
		};
		const finish = (error, done) => {
			if (settled) return;
			// A second listener the caller added must not keep this prompt's listeners around.
			input.removeListener("data", onData);
			process.removeListener("SIGINT", onSignal);
			settled = true;
			restore();
			if (error) reject(error);
			else resolvePromise(done);
		};
		const onSignal = () => finish(new Error("pi-studio: cancelled; nothing was changed"));
		const onData = (chunk) => {
			const text = String(chunk);
			if (text === "\x03") return finish(new Error("pi-studio: cancelled; nothing was changed"));
			if (text === "\r" || text === "\n") return finish(null, value);
			if (text === "\x7f" || text === "\x08") {
				value = value.slice(0, -1);
				return;
			}
			if (!text.startsWith("\x1b")) value += text;
		};
		process.once("SIGINT", onSignal);
		input.on("data", onData);
		input.setRawMode(true);
		input.resume();
		output.write(question);
	});
}

/** Set (or change) the master password. `ask` is the injection point tests hand their own asker. */
export async function setPassword({ flags = {}, ask = askHidden, out = console.log }) {
	const first = await ask("New master password: ");
	const again = await ask("Type it again: ");
	if (!first) fail("the password is empty; nothing was changed");
	if (first.length > MAX_PASSWORD_CHARS) fail(`the password is longer than ${MAX_PASSWORD_CHARS} characters; nothing was changed`);
	if (first !== again) fail("the two entries differ; nothing was changed");
	const file = authFileOf(flags);
	const existed = existsSync(file);
	writeJsonAtomic(file, hashPassword(first));
	out(`pi-studio: master password set (${file})`);
	out("pi-studio: save it in your password manager; the daemon never needs it again and is never shown it");
	if (existed) out("pi-studio: browsers already signed in stay signed in; restart the daemon to log them out");
	return { file };
}

/** Remove the master password. Browsers already signed in stay signed in until the daemon restarts. */
export function removePassword({ flags = {}, out = console.log }) {
	const file = authFileOf(flags);
	const existed = existsSync(file);
	rmSync(file, { force: true });
	out(`pi-studio: master password ${existed ? "removed" : "was not set"} (${file})`);
	if (existed) out("pi-studio: browsers already signed in stay signed in; restart the daemon to log them out, and open the link pi printed until you set a new one");
	return { removed: existed, file };
}
