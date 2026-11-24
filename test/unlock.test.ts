import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { authFileOf, hashPassword, removePassword, setPassword } from "../bin/auth.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PASSWORD = "correct horse battery staple";

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-studio-unlock-${prefix}-`));
	scratch.push(dir);
	return dir;
}

/** The same record the CLI writes, built by the test's own hand so the verifier is not tested against itself. */
function writeRecord(stateDir: string, password: string = PASSWORD): void {
	const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
	const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
	writeFileSync(join(stateDir, "auth.json"), JSON.stringify({ v: 1, algo: "scrypt", N: 16384, r: 8, p: 1, salt: salt.toString("hex"), hash: hash.toString("hex"), createdAt: new Date().toISOString() }), "utf8");
}

/** One daemon on its own state folder, started the way a human starts it, waiting for the listening line. */
function bootDaemon(stateDir: string) {
	const child = spawn(process.execPath, [join(root, "server.ts"), "--no-open"], {
		cwd: root,
		env: { ...process.env, PI_STUDIO_STATE: stateDir, PI_STUDIO_PORT: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const noise: string[] = [];
	child.stderr.on("data", (chunk: Buffer) => noise.push(String(chunk)));
	const ready = new Promise<string>((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(() => reject(new Error(`the daemon did not listen: ${noise.join("")}`)), 20_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			seen += String(chunk);
			const found = /listening on (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(seen);
			if (!found) return;
			clearTimeout(timer);
			resolve(new URL(found[1]).origin);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`the daemon exited with ${code}: ${noise.join("")}`));
		});
	});
	return { child, ready };
}

// The daemon resolves its state folder at import and this file is one process, so the three
// verify cases share the one state folder the module was loaded with, in order.
const verifyStateDir = scratchDir("verify");
process.env.PI_STUDIO_STATE = verifyStateDir;
const login = await import("../server/login.ts");
const { passwordIsSet, unlockLockSecondsLeft, verifyMasterPassword } = login;

test("verify: no password set answers unset", async () => {
	assert.equal(passwordIsSet(), false);
	assert.equal(await verifyMasterPassword(PASSWORD), "unset");
});

test("verify: ok, wrong, and the lockout after five wrong tries", async () => {
	writeRecord(verifyStateDir);
	assert.equal(passwordIsSet(), true);
	assert.equal(await verifyMasterPassword("a wrong one"), "wrong");
	assert.equal(await verifyMasterPassword(PASSWORD), "ok");
	for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(await verifyMasterPassword("a wrong one"), "wrong", "a wrong one must not change the streak before five");
	assert.equal(await verifyMasterPassword("a wrong one"), "wrong");
	assert.equal(await verifyMasterPassword(PASSWORD), "locked", "the fifth wrong try locks even the right password");
	assert.ok(unlockLockSecondsLeft() > 0, "the lock still has seconds left");
});

test("verify: a changed password resets the lockout; concurrent attempts are not hashed", async () => {
	writeRecord(verifyStateDir, "a brand new password");
	assert.equal(await verifyMasterPassword("a brand new password"), "ok", "a new hash clears the lockout against the old one");
	const pair = await Promise.all([verifyMasterPassword("a wrong one"), verifyMasterPassword("a wrong one")]);
	// The pair raced one hash: one verdict is a miss, the other is turned away without hashing.
	assert.ok(pair.includes("locked"), `one of the pair must be turned away unhashed: ${pair}`);
});

test("the CLI writes a hash-only record and removes it; mismatched entries write nothing", async () => {
	const stateDir = scratchDir("cli");
	const asked: string[] = [];
	const scripted = async (question: string): Promise<string> => {
		asked.push(question);
		return asked.length === 1 ? PASSWORD : PASSWORD;
	};
	const lines: string[] = [];
	await setPassword({ flags: { state: stateDir }, ask: scripted, out: (line: string) => lines.push(line) });
	const file = authFileOf({ state: stateDir });
	assert.equal(file, join(stateDir, "auth.json"));
	const saved = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(saved.algo, "scrypt");
	assert.match(saved.hash, /^[0-9a-f]{128}$/);
	assert.ok(!JSON.stringify(saved).includes(PASSWORD), "the password itself is never stored");
	const record = hashPassword(PASSWORD);
	assert.match(record.hash, /^[0-9a-f]{128}$/);
	assert.ok(record.hash !== saved.hash, "a fresh salt per record");
	// Login state never sees the password: the hash must be verifiable by the daemon's own cost work.
	const expected = scryptSync(PASSWORD, Buffer.from(saved.salt, "hex"), 64, { N: saved.N, r: saved.r, p: saved.p, maxmem: 64 * 1024 * 1024 }).toString("hex");
	assert.equal(saved.hash, expected);

	const repeated = async (): Promise<string> => "a different one";
	await setPassword({ flags: { state: scratchDir("repeated") }, ask: repeated, out: () => {} });
	const talkative = async (question: string): Promise<string> => (question.includes("again") ? "other" : PASSWORD);
	await assert.rejects(setPassword({ flags: { state: scratchDir("mismatch2") }, ask: talkative, out: () => {} }), /two entries differ/);
	assert.ok(lines.every((line) => !line.includes(PASSWORD)), "the password never reaches the terminal");

	const removed = removePassword({ flags: { state: stateDir }, out: () => {} });
	assert.equal(removed.removed, true);
	assert.ok(!existsSync(file));
	assert.equal(removePassword({ flags: { state: stateDir }, out: () => {} }).removed, false);
});

test("over HTTP: the right password mints the session cookie; wrong, cross-origin and unset are refused in turn", async () => {
	const stateDir = scratchDir("http");
	writeRecord(stateDir);
	const daemon = bootDaemon(stateDir);
	const base = await daemon.ready;
	try {
		// Browsers carry an Origin on every POST; Node's fetch does not, so the daemon answers 403 to
		// a POST without one — the same demand it makes of every cookie POST already. Send the Origin
		// the way a browser would.
		const sameOrigin = { "Content-Type": "application/json", Origin: base };
		const form = await fetch(`${base}/unlock`);
		assert.equal(form.status, 200);
		assert.match(await form.text(), /Master password/);

		const refused = await fetch(`${base}/workspaces`);
		assert.equal(refused.status, 403);
		assert.equal(refused.headers.get("x-pi-studio-unlock"), "1", "a refusal that offers the unlock page says so");

		const wrong = await fetch(`${base}/unlock`, { method: "POST", headers: sameOrigin, body: JSON.stringify({ password: "nope" }) });
		assert.equal(wrong.status, 401);
		assert.equal(wrong.headers.get("set-cookie"), null);

		const cross = await fetch(`${base}/unlock`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://elsewhere.example" }, body: JSON.stringify({ password: PASSWORD }) });
		assert.equal(cross.status, 403, "a third-party site cannot try passwords or slam the lockout");

		const right = await fetch(`${base}/unlock`, { method: "POST", headers: sameOrigin, body: JSON.stringify({ password: PASSWORD }) });
		assert.equal(right.status, 200);
		const cookie = right.headers.get("set-cookie") ?? "";
		assert.match(cookie, /pi-studio-[0-9a-f]{8}=/, cookie);
		assert.match(cookie, /HttpOnly/, cookie);
		const inside = await fetch(`${base}/workspaces`, { headers: { Cookie: cookie.split(";")[0] } });
		assert.equal(inside.status, 200, "the minted cookie passes the caller gate like the printed link did");
	} finally {
		daemon.child.kill("SIGTERM");
	}

	const bareState = scratchDir("http-empty");
	const bare = bootDaemon(bareState);
	const bareBase = await bare.ready;
	try {
		const page = await fetch(`${bareBase}/unlock`);
		assert.match(await page.text(), /No master password is set/);
		const unset = await fetch(`${bareBase}/unlock`, { method: "POST", headers: { "Content-Type": "application/json", Origin: bareBase }, body: JSON.stringify({ password: PASSWORD }) });
		assert.equal(unset.status, 404);
		const noOffer = await fetch(`${bareBase}/workspaces`);
		assert.equal(noOffer.status, 403);
		assert.equal(noOffer.headers.get("x-pi-studio-unlock"), null, "with no password set, a refusal keeps today's behaviour exactly");
	} finally {
		bare.child.kill("SIGTERM");
	}
});
