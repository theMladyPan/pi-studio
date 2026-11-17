/**
 * The release-notes guard the release workflow calls: only a dated [version] changelog
 * section with a real calendar date, non-empty notes, and no thread watermarks is publishable.
 *
 * Every case below runs the helper the workflow runs (`bin/release-notes.mjs`), never a copy of
 * its logic, so a rule the helper adds or drops shows up here at once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractReleaseNotes } from "../bin/release-notes.mjs";

const VERSION = "9.9.9";
const notes = (heading: string, body = "- feat: something shipped") =>
	`# Changelog\n\n## [Unreleased]\n\n- fix: still unreleased [t-41d1564a]\n\n${heading}\n\n${body}\n\n## [0.1.0] - 2025-01-15\n\n- feat: an older release [t-99975a78]\n`;

test("a dated section with a real date passes, and an older section's watermark does not count", () => {
	const extracted = extractReleaseNotes(notes(`## [${VERSION}] - 2025-03-04`), VERSION);
	assert.equal(extracted, "- feat: something shipped\n");
});

test("a valid leap day passes", () => {
	assert.equal(extractReleaseNotes(notes(`## [${VERSION}] - 2024-02-29`), VERSION), "- feat: something shipped\n");
});

test("an impossible calendar date is refused, including February 29 in a common year", () => {
	for (const date of ["2025-02-29", "2025-02-31", "2025-04-31", "2025-13-01", "2025-00-10", "2025-01-00"]) {
		assert.throws(() => extractReleaseNotes(notes(`## [${VERSION}] - ${date}`), VERSION), /not a real calendar date/, date);
	}
});

test("a WIP or missing date is refused as undated, not silently skipped", () => {
	for (const heading of [`## [${VERSION}] - WIP`, `## [${VERSION}]`, `## [${VERSION}] - 2025-3-4`, `## [${VERSION}] - `]) {
		assert.throws(() => extractReleaseNotes(notes(heading), VERSION), /no dated notes|not dated/, heading);
	}
});

test("no section for the version at all is refused", () => {
	assert.throws(() => extractReleaseNotes(notes(`## [0.2.0] - 2025-03-04`), VERSION), /no dated notes/);
});

test("a section that holds no notes is refused", () => {
	assert.throws(() => extractReleaseNotes(notes(`## [${VERSION}] - 2025-03-04`, "  \n\n"), VERSION), /no notes/);
});

test("thread watermarks in the new notes are refused", () => {
	assert.throws(
		() => extractReleaseNotes(notes(`## [${VERSION}] - 2025-03-04`, "- feat: something shipped [t-41d1564a]"), VERSION),
		/thread watermarks/,
	);
});
