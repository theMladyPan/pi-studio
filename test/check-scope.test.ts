import assert from "node:assert/strict";
import { test } from "node:test";
import { adviceFor, classifyFiles, shouldForceFull } from "../bin/check-scope.mjs";

/**
 * Check scope: paths only, never contents. The classifier may only advise;
 * the hash cache (bin/test-cache.mjs) stays the correctness kernel. These
 * tests pin the three tiers and the one meaning of "forced".
 */

test("empty diff is empty", () => {
	assert.equal(classifyFiles([]).tier, "empty");
});

test("pure style and docs are trivial", () => {
	assert.equal(classifyFiles(["public/board.css", "docs/releasing.md", "CHANGELOG.md"]).tier, "trivial");
});

test("a label inside a client script is not trivial", () => {
	// Tests assert on client source as text, so a path guess at "just a
	// label" would be a bug entry point. Scripts count as core logic.
	assert.equal(classifyFiles(["public/client/board.js"]).tier, "core");
	assert.equal(classifyFiles(["server/kontainer/actions.ts"]).tier, "core");
	assert.equal(classifyFiles(["bin/check.mjs"]).tier, "core");
});

test("mixed or test-only diffs are middle, never core, never trivial", () => {
	assert.equal(classifyFiles(["test/new.test.ts"]).tier, "middle");
	assert.equal(classifyFiles(["public/board.css", "test/new.test.ts"]).tier, "middle");
});

test("any core file makes the whole diff core", () => {
	assert.equal(classifyFiles(["public/board.css", "server.ts"]).tier, "core");
});

test("main always owes full, work branches never do", () => {
	assert.match(adviceFor("main", "trivial"), /--full/);
	assert.match(adviceFor("fix/anything-8b5f0bea", "core"), /never force full on a work branch/);
	assert.match(adviceFor("dev", "core"), /justified/);
	assert.match(adviceFor("dev", "trivial"), /never force full/);
	assert.match(adviceFor("dev", "middle"), /say why/);
});

test("only --full, or the back-compat alias, forces a whole run", () => {
	assert.equal(shouldForceFull({ fullFlag: true, env: {} }), true);
	assert.equal(shouldForceFull({ fullFlag: false, env: { PI_STUDIO_NO_CACHE: "1" } }), true);
	assert.equal(shouldForceFull({ fullFlag: false, env: {} }), false);
	assert.equal(shouldForceFull({ fullFlag: false, env: { PI_STUDIO_NO_CACHE: "0" } }), false);
});
