/**
 * What a real daemon sees when it starts this example plugin.
 *
 * The daemon's own `PluginHost` spawns the built binary and speaks the line protocol to it, and a
 * stand-in answers the four methods a daemon answers. Nothing here touches a board, a state folder or a
 * browser: the pipe, the handshake, the subscription and the one card are the whole subject.
 *
 *   cargo build --release
 *   node --test examples/plugins/scratch-card/check/against-host.mjs
 *
 * `SCRATCH_CARD_BIN` names a binary built somewhere else, which is what a target folder outside the
 * checkout needs.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startPlugin } from "../../../../server/plugins/host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.env.SCRATCH_CARD_BIN ?? join(here, "..", "target", "release", "pi-studio-scratch-card");

const SCRATCH = "workspace-scratch";
const quiet = () => {};

/** One run that ended, as the daemon announces it. */
function settled(workspace, id) {
	return {
		type: "thread.settled",
		workspace,
		at: Date.now(),
		thread: { id, title: "do the thing", status: "done", answered: true },
	};
}

/** A daemon's four methods, and every call the plugin makes of them. */
function daemon() {
	const calls = [];
	const answer = (call) => {
		calls.push(call);
		if (call.method === "events.subscribe") return { types: call.params.types };
		if (call.method === "workspace.list") {
			return {
				workspaces: [
					{ id: "workspace-a-project", name: "a project", folder: "/tmp/a-project", missing: false, scratch: false },
					{ id: SCRATCH, name: "scratch", folder: "/tmp/scratch", missing: false, scratch: true },
				],
			};
		}
		if (call.method === "cards.note") return { cardId: `card-${calls.length}`, card: {} };
		throw Object.assign(new Error(`${call.method} is not a method this daemon answers`), { code: -32601 });
	};
	return { calls, answer, notes: () => calls.filter((call) => call.method === "cards.note") };
}

/** Wait for what the plugin does next, rather than for a duration. */
async function until(what, seen, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (seen()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`the plugin never did this: ${what}`);
}

async function started() {
	const server = daemon();
	const host = await startPlugin({ name: "scratch-card", command: binary, args: [] }, { log: quiet, onRequest: server.answer });
	return { host, ...server };
}

test("a daemon starts the plugin, and it asks for the events and the workspaces", async () => {
	assert.ok(existsSync(binary), `no plugin binary at ${binary}; run cargo build --release in the example first`);
	const { host, calls } = await started();
	try {
		assert.equal(host.info.name, "scratch-card", "the name the plugin gave in its handshake");
		assert.match(host.info.version, /^\d+\.\d+\.\d+$/, "and the version it carries");
		await until("asked for the workspaces", () => calls.some((call) => call.method === "workspace.list"));
		assert.deepEqual(calls.find((call) => call.method === "events.subscribe")?.params, { types: ["thread.settled"] });
	} finally {
		await host.close();
	}
});

test("a settled thread on the scratch board leaves one note, and one on any other board leaves none", async () => {
	const { host, calls, notes } = await started();
	try {
		await until("asked for the workspaces", () => calls.some((call) => call.method === "workspace.list"));
		host.notify("event", settled("workspace-a-project", "thread-on-a-project"));
		host.notify("event", settled(SCRATCH, "thread-on-scratch"));
		await until("wrote a card", () => notes().length > 0);
		// A card for the project thread would have come from the same two lines, so give it the time.
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(notes().length, 1, "one card, for the scratch board only");
		assert.equal(notes()[0].params.workspace, SCRATCH);
		assert.equal(notes()[0].params.key, "scratch-card:thread-on-scratch", "the thread's id keys the card");
		assert.match(notes()[0].params.markdown, /do the thing/);
	} finally {
		await host.close();
	}
});

test("the plugin exits when the daemon closes it", async () => {
	const { host, calls } = await started();
	await until("asked for the workspaces", () => calls.some((call) => call.method === "workspace.list"));
	await host.close();
	const exit = await host.exited;
	assert.equal(host.running(), false);
	assert.equal(exit.code, 0, "a plugin told to shut down stops tidily rather than being killed");
});
