import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cacheEnabled, importClosure, perFileKey, readCache, wholeKey, writeCache } from "../bin/test-cache.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Hash test caching: keys are content hashes, so an edit inside the closure
 * changes the key and an edit outside it does not. The fixture repo mirrors
 * this repo's shape — server/, test/, test-support/ — without touching it.
 */

const base = mkdtempSync(join(tmpdir(), "pi-studio-test-cache-"));
after(() => rmSync(base, { recursive: true, force: true }));

function fixture(name: string): string {
	const dir = join(base, name);
	mkdirSync(join(dir, "server"), { recursive: true });
	mkdirSync(join(dir, "test"), { recursive: true });
	mkdirSync(join(dir, "test-support"), { recursive: true });
	// Specifiers stay split in this source: a whole relative import here would
	// read as this test's own import, and the closure would chase the fixture.
	writeFileSync(join(dir, "server", "a.ts"), `import { b } from "${"./"}b.ts";\nexport const a = b + 1;\n`);
	writeFileSync(join(dir, "server", "b.ts"), `export const b = 1;\n`);
	writeFileSync(join(dir, "server", "unrelated.ts"), `export const u = 1;\n`);
	writeFileSync(join(dir, "test", "x.test.ts"), `import { a } from "${"../"}server/a.ts";\nconsole.log(a);\n`);
	writeFileSync(join(dir, "test-support", "git.ts"), `export const g = 1;\n`);
	writeFileSync(join(dir, "package.json"), `{"name":"fixture"}\n`);
	return dir;
}

test("the import closure follows relative imports to their files", () => {
	const dir = fixture("closure");
	assert.deepEqual(importClosure(dir, "test/x.test.ts"), ["server/a.ts", "server/b.ts", "test/x.test.ts"]);
});

test("a specifier that resolves nowhere makes the file uncacheable", () => {
	const dir = fixture("broken");
	writeFileSync(join(dir, "test", "x.test.ts"), `import "${"../"}server/missing.ts";\n`);
	assert.equal(importClosure(dir, "test/x.test.ts"), null);
	assert.equal(perFileKey(dir, "test/x.test.ts"), null);
});

test("a per-file key changes when a file in the closure changes", () => {
	const dir = fixture("dep-change");
	const before = perFileKey(dir, "test/x.test.ts")!;
	writeFileSync(join(dir, "server", "b.ts"), `export const b = 2;\n`);
	const after = perFileKey(dir, "test/x.test.ts")!;
	assert.notEqual(before, after);
});

test("a per-file key survives an edit outside the closure", () => {
	const dir = fixture("outside");
	const before = perFileKey(dir, "test/x.test.ts")!;
	writeFileSync(join(dir, "server", "unrelated.ts"), `export const u = 2;\n`);
	assert.equal(perFileKey(dir, "test/x.test.ts"), before);
});

test("the whole key changes when any covered file changes", () => {
	const dir = fixture("whole");
	const before = wholeKey(dir);
	writeFileSync(join(dir, "server", "unrelated.ts"), `export const u = 2;\n`);
	assert.notEqual(wholeKey(dir), before);
});

test("cache entries round-trip, and unreadable entries are misses", () => {
	const dir = join(base, "cache");
	writeCache(dir, "abc", 1);
	assert.deepEqual(readCache(dir, "abc"), { exitCode: 1 });
	assert.equal(readCache(dir, "missing"), null);
	writeFileSync(join(dir, "bad.json"), "not json");
	assert.equal(readCache(dir, "bad"), null);
});

test("the cache is on by default and off on request", () => {
	assert.equal(cacheEnabled({}), true);
	assert.equal(cacheEnabled({ PI_STUDIO_NO_CACHE: "1" }), false);
	assert.equal(cacheEnabled({ PI_STUDIO_TEST_CACHE: "off" }), false);
});

test("the real repo hashes stably and quickly", () => {
	const start = Date.now();
	const key = wholeKey(root);
	const millis = Date.now() - start;
	assert.match(key, /^[0-9a-f]{64}$/);
	assert.equal(wholeKey(root), key, "the key is a pure function of file content");
	assert.ok(millis < 5_000, `hashing the whole tree took ${millis}ms, expected well under a second`);
	const raw = readFileSync(join(root, "package.json"), "utf8");
	assert.ok(raw.includes("pi-studio"));
});
