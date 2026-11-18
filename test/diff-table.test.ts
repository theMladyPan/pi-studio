import assert from "node:assert/strict";
import { test } from "node:test";
// The page carries no types, so the module is read through a cast, the way the drawer tests read theirs.
const { diffHunkStart, diffKindOf } = (await import(new URL("../public/client/diff-table.js", import.meta.url).href)) as {
	diffKindOf: (line: string) => string;
	diffHunkStart: (line: string) => { old: number; next: number } | null;
};

/**
 * The shared diff table's decisions, without a browser: which kind of line each line is, and
 * where a hunk starts each side. The table itself is drawn by the pages that import it.
 */

test("a diff line is named by its first character", () => {
	assert.equal(diffKindOf("@@ -1,2 +1,3 @@"), "hunk");
	assert.equal(diffKindOf("+++ b/file.txt"), "meta");
	assert.equal(diffKindOf("--- a/file.txt"), "meta");
	assert.equal(diffKindOf("diff --git a/file.txt b/file.txt"), "meta");
	assert.equal(diffKindOf("new file mode 100644"), "meta");
	assert.equal(diffKindOf("\\ No newline at end of file"), "meta");
	assert.equal(diffKindOf("+added"), "added");
	assert.equal(diffKindOf("-removed"), "removed");
	assert.equal(diffKindOf(" context"), "");
});

test("a hunk header starts both sides where it says it does", () => {
	assert.deepEqual(diffHunkStart("@@ -10,4 +12,5 @@ func"), { old: 10, next: 12 });
	assert.deepEqual(diffHunkStart("@@ -1 +1 @@"), { old: 1, next: 1 });
	assert.equal(diffHunkStart("not a hunk"), null);
});
