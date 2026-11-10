import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_DROPPED_FILES, MAX_DROP_BYTES } from "../server/limits.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/** One daemon on a state folder of its own, started the way a human starts it. */
async function boot(state: string) {
	const child = spawn(process.execPath, [join(repo, "server.ts"), "--no-open"], {
		cwd: repo,
		env: { ...process.env, PI_STUDIO_STATE: state, PI_STUDIO_PORT: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const noise: string[] = [];
	child.stderr.on("data", (chunk) => noise.push(String(chunk)));
	const url = await new Promise<string>((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(() => reject(new Error(`no listening line in 20s: ${noise.join("")}`)), 20_000);
		child.stdout.on("data", (chunk) => {
			seen += String(chunk);
			const match = seen.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/);
			if (!match) return;
			clearTimeout(timer);
			resolve(match[1]);
		});
		child.on("exit", (code) => reject(new Error(`the daemon exited with ${code}: ${noise.join("").slice(-400)}`)));
	});
	const parsed = new URL(url);
	return { child, noise, base: parsed.origin, token: parsed.searchParams.get("token") ?? "" };
}

type Daemon = Awaited<ReturnType<typeof boot>>;

const post = async (daemon: Daemon, path: string, body: unknown) => {
	const res = await fetch(`${daemon.base}${path}?token=${daemon.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.text() };
};

/** A dropped file arrives as the daemon reads it: the bytes in the body, the name in the query. */
const drop = async (daemon: Daemon, board: string, name: string, bytes: Buffer, token = daemon.token) => {
	const res = await fetch(`${daemon.base}/drop?token=${token}&workspace=${board}&name=${encodeURIComponent(name)}`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: bytes,
	});
	return { status: res.status, body: await res.text() };
};

/** A daemon, a workspace of its own, and the board the two make. Everything under it is thrown away after. */
async function studio() {
	const state = mkdtempSync(join(tmpdir(), "pi-studio-drop-state-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-drop-folder-"));
	const daemon = await boot(state);
	const board = JSON.parse((await post(daemon, "/workspace", { folder })).body).board;
	return { state, folder, daemon, board, done: () => {
		daemon.child.kill();
		for (const gone of [state, folder]) rmSync(gone, { recursive: true, force: true });
	} };
}

test("a dropped file is copied to the daemon's temp folder and its own path comes back", async () => {
	const { state, folder, daemon, board, done } = await studio();
	try {
		const kept = await drop(daemon, board.id, "note.txt", Buffer.from("hello from a drop\n"));
		assert.equal(kept.status, 200, kept.body);
		const answer = JSON.parse(kept.body);
		assert.equal(answer.name, "note.txt");
		assert.equal(readFileSync(answer.path, "utf8"), "hello from a drop\n");
		// A copy of the daemon's own, never inside the workspace: a drop is not a change to the human's tree.
		assert.equal(answer.path.startsWith(join(state, "drops")), true);
		assert.equal(existsSync(join(folder, "note.txt")), false);

		// One name twice is two files, so the message never names a copy the agent was already shown.
		const again = JSON.parse((await drop(daemon, board.id, "note.txt", Buffer.from("second\n"))).body);
		assert.notEqual(again.path, answer.path);
		assert.equal(readFileSync(again.path, "utf8"), "second\n");
		assert.equal(readFileSync(answer.path, "utf8"), "hello from a drop\n");

		// A deck or a spreadsheet is a zip: the bytes come back as they went, NULs and all, because the
		// body is kept as bytes rather than decoded into text.
		const deck = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x00, 0x7f, 0x80]);
		const zipped = JSON.parse((await drop(daemon, board.id, "deck.pptx", deck)).body);
		assert.equal(zipped.name, "deck.pptx");
		assert.deepEqual(readFileSync(zipped.path), deck);
	} finally {
		done();
	}
});

test("a dropped file is taken as a name and nothing else", async () => {
	const { state, daemon, board, done } = await studio();
	try {
		const kept = await drop(daemon, board.id, "../../../etc/passwd", Buffer.from("not passwd\n"));
		assert.equal(kept.status, 200, kept.body);
		const answer = JSON.parse(kept.body);
		// The folders in the name are spent on the name itself: the copy lands in the board's own folder,
		// and the name it keeps is the last part of what was asked for.
		assert.equal(answer.name, "passwd");
		assert.equal(answer.path.includes(".."), false);
		assert.equal(answer.path.startsWith(join(state, "drops")), true);
		assert.equal(readFileSync(answer.path, "utf8"), "not passwd\n");

		// A body with nothing in it is not a file, and one past the ceiling is refused rather than kept.
		assert.equal((await drop(daemon, board.id, "empty.txt", Buffer.alloc(0))).status, 400);
		const tooBig = await drop(daemon, board.id, "big.bin", Buffer.alloc(MAX_DROP_BYTES + 1));
		assert.equal(tooBig.status, 413);
		assert.match(tooBig.body, /at most/);
	} finally {
		done();
	}
});

test("the board keeps the newest drops and lets the oldest go", async () => {
	const { daemon, board, done } = await studio();
	try {
		let newest = "";
		for (let n = 0; n <= MAX_DROPPED_FILES; n += 1) {
			const kept = JSON.parse((await drop(daemon, board.id, `drop-${n}.txt`, Buffer.from(`${n}\n`))).body);
			newest = kept.path;
		}
		const dir = dirname(newest);
		const files = readdirSync(dir);
		assert.equal(files.length, MAX_DROPPED_FILES);
		// The drop that was just made is still readable; the first one is the one that went.
		assert.equal(readFileSync(newest, "utf8"), `${MAX_DROPPED_FILES}\n`);
		assert.equal(files.includes("drop-0.txt"), false);
	} finally {
		done();
	}
});
