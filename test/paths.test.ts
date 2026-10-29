import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	BRIDGE,
	PUBLIC_DIR,
	REPO_DIR,
	buildHash,
	randomToken,
	readJsonFile,
	workspaceId,
	writeJsonFile,
} from "../server/paths.ts";

test("the repository root is found from inside server/", () => {
	assert.ok(existsSync(join(REPO_DIR, "package.json")), `no package.json under ${REPO_DIR}`);
	assert.equal(join(REPO_DIR, "public"), PUBLIC_DIR);
});

test("the two paths that point at real files exist", () => {
	// A wrong PUBLIC_DIR 404s every static route. A wrong BRIDGE is worse: `existsSync` turns false,
	// the `-e` flag disappears from a child's argv, and every thread silently loses the board tools.
	assert.ok(existsSync(join(PUBLIC_DIR, "index.html")), "no index.html in PUBLIC_DIR");
	assert.ok(existsSync(BRIDGE), "no bridge/child-bridge.mjs at BRIDGE");
});

test("the build hash resolves against the root, not against server/", () => {
	// "unknown" is what a path one directory too deep returns, and nothing else reports it.
	assert.match(buildHash(), /^([0-9a-f]{7}|unknown)$/);
	assert.notEqual(buildHash(), "unknown", "the checkout was not found from server/");
});

test("readJsonFile falls back on anything unreadable", () => {
	const missing = readJsonFile(join(tmpdir(), "pi-studio-no-such-file.json"), { ok: true });
	assert.deepEqual(missing, { ok: true });
});

test("a JSON file written whole reads back identical", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-paths-"));
	try {
		const file = join(folder, "nested", "board.json");
		const board = { version: 3, cards: [{ id: "a", text: "line one\nline two" }], nested: { deep: [1, 2, 3] } };
		writeJsonFile(file, board);
		assert.deepEqual(readJsonFile(file, null), board);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a folder keeps one id, and a token is 32 hex", () => {
	assert.equal(workspaceId("/a/folder"), workspaceId("/a/folder"));
	assert.notEqual(workspaceId("/a/folder"), workspaceId("/b/folder"));
	assert.match(workspaceId("/a/folder"), /^[0-9a-f]{12}$/);
	assert.match(randomToken(), /^[0-9a-f]{32}$/);
});
