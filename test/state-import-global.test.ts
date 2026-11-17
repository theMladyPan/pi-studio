import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The one-time import of the global records answers only for a state home of its own: a `--state` instance
 * never imports. So this file runs with a throwaway HOME and no explicit root, which is the only way to see
 * that import, and sets both before any daemon code is loaded — the same reason the other state tests are
 * files of their own. Everything written here lands under `tmpdir()`.
 */
const home = mkdtempSync(join(tmpdir(), "pi-studio-global-import-home-"));
process.env.HOME = home;
delete process.env.PI_STUDIO_STATE;
delete process.env.XDG_STATE_HOME;

const paths = await import("../server/paths.ts");
const storage = await import("../server/state-storage.ts");

test("the global import runs in the throwaway home and nowhere else", () => {
	assert.equal(paths.HAS_EXPLICIT_STATE, false);
	assert.equal(paths.STATE_DIR, join(home, ".local", "state", "pi-studio"));
	assert.equal(paths.LEGACY_STATE_DIR, join(home, ".pi", "agent", "state", "pi-studio"));
});

test("a global record deleted after a completed import is not copied back from the legacy home", () => {
	try {
		mkdirSync(paths.LEGACY_STATE_DIR, { recursive: true });
		const token = "0123456789abcdef0123456789abcdef";
		writeFileSync(join(paths.LEGACY_STATE_DIR, "daemon.json"), JSON.stringify({ token }));
		const imported = join(paths.STATE_DIR, "daemon.json");

		assert.equal(storage.migrateLegacyGlobalState(), true, "the first pass copied nothing");
		assert.equal(readFileSync(imported, "utf8"), JSON.stringify({ token }), "the legacy record was not copied");
		assert.equal(existsSync(paths.GLOBAL_IMPORT_MARKER), true, "the completed import was not recorded on disk");

		// The human resets the token by deleting the new record; the legacy original stays where it is.
		unlinkSync(imported);
		assert.equal(storage.migrateLegacyGlobalState(), false, "a later start imported again");
		assert.equal(existsSync(imported), false, "the reset record was copied back from the legacy home");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
