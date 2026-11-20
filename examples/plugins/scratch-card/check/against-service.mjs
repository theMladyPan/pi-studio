/**
 * The example plugin, started the way the daemon starts one.
 *
 * This goes through the whole daemon side below HTTP: the registration file is read, the plugin is
 * spawned, the daemon's own service answers its calls, a run is announced on the real settle seam, and
 * the note it writes lands on the scratch board. The state folder is a throwaway one, so no board the
 * human has open is read or written.
 *
 *   cargo build --release
 *   node --test examples/plugins/scratch-card/check/against-service.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pi-studio-scratch-card-"));
// Set before a daemon module is imported: the state folder is resolved once, at import.
const state = join(root, "state");
process.env.PI_STUDIO_STATE = state;

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.env.SCRATCH_CARD_BIN ?? join(here, "..", "target", "release", "pi-studio-scratch-card");

const { startPlugins, stopPlugins } = await import("../../../../server/plugins/manager.ts");
const { createPluginService } = await import("../../../../server/plugins/service.ts");
const { threadSettled } = await import("../../../../server/bus.ts");
const { ensureScratch, rememberWorkspace } = await import("../../../../server/workspaces.ts");

after(async () => {
	await stopPlugins();
	rmSync(root, { recursive: true, force: true });
});

const quiet = () => {};

/** Wait for what the plugin does next, rather than for a duration. */
async function until(what, seen, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await seen()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`the plugin never did this: ${what}`);
}

test("a run that ends on the scratch board leaves one note there, and a project board is untouched", async () => {
	assert.ok(existsSync(binary), `no plugin binary at ${binary}; run cargo build --release in the example first`);
	// Registering the plugin is the human's deliberate act, and this is the file they write.
	mkdirSync(state, { recursive: true });
	writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: [{ name: "scratch-card", command: binary, args: [] }] }));

	const service = createPluginService();
	const asked = [];
	const manager = await startPlugins({
		log: quiet,
		onRequest: (call) => {
			asked.push(call.method);
			return service.handle(call);
		},
	});
	try {
		assert.deepEqual(manager.problems(), [], "the registration named a plugin the daemon can start");
		assert.deepEqual(
			manager.roster().map((plugin) => [plugin.name, plugin.running]),
			[["scratch-card", true]],
		);
		await until("asked which workspaces exist", () => asked.includes("workspace.list"));
		// The answer to that call is on its way to the plugin; give it the moment it needs to read it.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const scratch = ensureScratch();
		const projectFolder = join(root, "a-project");
		mkdirSync(projectFolder, { recursive: true });
		const project = rememberWorkspace(projectFolder);

		threadSettled({ id: project.id }, { id: "thread-on-a-project", title: "do the other thing", status: "done" }, { status: "answered" });
		threadSettled({ id: scratch.id }, { id: "thread-on-scratch", title: "do the thing", status: "done" }, { status: "answered" });

		const read = (workspace) => service.handle({ plugin: "a-check", method: "workspace.read", params: { workspace } });
		await until("wrote its note", async () => {
			const board = await read(scratch.id);
			return board.cards.some((card) => card.key === "scratch-card:thread-on-scratch");
		});

		const notes = (await read(scratch.id)).cards.filter((card) => card.type === "note");
		assert.equal(notes.length, 1, "one note, revised in place rather than stacked");
		assert.match(notes[0].markdown, /do the thing/);

		const untouched = await read(project.id);
		assert.deepEqual(untouched.cards, [], "a thread on another board earns nothing");
		assert.equal(existsSync(join(projectFolder, ".pi-studio")), false, "and that board is not even opened");
	} finally {
		await manager.close();
	}
});
