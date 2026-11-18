import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The helper model is one studio-wide choice that both quick jobs read at call time: naming a thread
 * and drafting a commit message. This proves the resolution — a saved pair wins, and with no pair the
 * daemon's own naming model stands — and that the drafting call is handed the chosen pair, not a
 * hardcoded one.
 */

// The state folder is resolved once, when the modules below load, so it is set first.
const state = mkdtempSync(join(tmpdir(), "pi-studio-helper-state-"));
process.env.PI_STUDIO_STATE = state;

const { helperModel, reloadWorkspaces, activeHomeDefaults } = await import("../server/workspaces.ts");
const { NAME_MODEL } = await import("../server/models.ts");
const { sourceControlMessage } = await import("../server/git/source-control.ts");
const { scratchRepo } = await import("../test-support/git.ts");

const git = (folder: string, ...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Write the workspaces file the daemon reloads its defaults from, the way `/defaults` would. */
function writeDefaults(defaults: Record<string, unknown>) {
	writeFileSync(join(state, "workspaces.json"), JSON.stringify({ version: 1, workspaces: [], defaults }));
	reloadWorkspaces();
}

test("the chosen pair is the helper model, and no pair means the daemon's own", () => {
	writeDefaults({ helperProvider: "github-copilot", helperModel: "gemini-4-argon" });
	assert.equal(helperModel(), "github-copilot/gemini-4-argon");
	assert.equal(activeHomeDefaults().helperProvider, "github-copilot");
	assert.equal(activeHomeDefaults().helperModel, "gemini-4-argon");

	writeDefaults({});
	assert.equal(helperModel(), NAME_MODEL);
});

test("a commit draft is asked of the chosen pair", async () => {
	writeDefaults({ helperProvider: "github-copilot", helperModel: "gemini-4-argon" });
	const repo = scratchRepo();
	try {
		writeFileSync(join(repo, "note.txt"), "hello\n");
		git(repo, "add", "note.txt");
		let asked: string | undefined;
		const drafted = await sourceControlMessage(repo, {
			run: async (_cli: unknown, _folder: unknown, _prompt: unknown, model: unknown) => {
				asked = model as string;
				return "feat(note): add a note\n";
			},
		});
		assert.equal(drafted.ok, true, drafted.ok ? "" : drafted.error);
		assert.equal(asked, "github-copilot/gemini-4-argon");
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});
