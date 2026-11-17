#!/usr/bin/env node
/**
 * One job: pull the release notes for one version out of CHANGELOG.md, or refuse.
 *
 *   node bin/release-notes.mjs <version> [changelog] [out]   # defaults: CHANGELOG.md, release/release-notes.md
 *
 * The section counts only when its heading is `## [<version>] - YYYY-MM-DD` with a date that
 * exists on the calendar (February 29 only in a leap year), holds at least one non-blank line,
 * and carries no thread watermark (`[t-xxxxxxxx]`). A heading for the version with any other
 * date text, and an impossible date, are refusals, not misses: either one means somebody wrote
 * the section and then did not date it. Older sections are never read, so their watermarks and
 * their dates cannot affect this version. The release workflow calls this and nothing else;
 * `extractReleaseNotes` below is the whole guard, and the unit test imports it directly.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATED_HEADING = /^## \[([^\]]+)\] - (\d{4})-(\d{2})-(\d{2})\s*$/;
const NEXT_SECTION = /^## \[/;
const WATERMARK = /\[t-[0-9a-f]{8}\]/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function leap(year) {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** February 31 and friends are not dates; a format check alone would let them through. */
export function isRealCalendarDate(year, month, day) {
	if (month < 1 || month > 12 || day < 1) return false;
	const days = month === 2 && leap(year) ? 29 : MONTH_DAYS[month - 1];
	return day <= days;
}

/**
 * The notes for `version` out of `changelog`, without the heading and without the blank
 * lines that pad it; throws with the reason when the version is not ready to publish.
 */
export function extractReleaseNotes(changelog, version) {
	const lines = changelog.split("\n");
	let bodyStart = -1;
	for (let i = 0; i < lines.length; i += 1) {
		const dated = lines[i].match(DATED_HEADING);
		if (dated && dated[1] === version) {
			const [, , year, month, day] = dated;
			if (!isRealCalendarDate(Number(year), Number(month), Number(day))) {
				throw new Error(`CHANGELOG.md section for ${version} is not a real calendar date (${year}-${month}-${day})`);
			}
			bodyStart = i + 1;
			break;
		}
	}
	// A version heading whose date is missing, WIP, or not YYYY-MM-DD matches nothing above,
	// so it lands here as undated rather than being quietly skipped.
	if (bodyStart < 0) throw new Error(`CHANGELOG.md holds no dated notes for ${version} (## [${version}] - YYYY-MM-DD)`);
	let bodyEnd = lines.length;
	for (let i = bodyStart; i < lines.length; i += 1) {
		if (NEXT_SECTION.test(lines[i])) {
			bodyEnd = i;
			break;
		}
	}
	const body = lines.slice(bodyStart, bodyEnd).join("\n").trim();
	if (!body) throw new Error(`CHANGELOG.md section for ${version} holds no notes`);
	if (WATERMARK.test(body)) {
		throw new Error(`the notes for ${version} still carry thread watermarks; prepare the release section without them`);
	}
	return `${body}\n`;
}

function main() {
	const [version, changelogPath = "CHANGELOG.md", outPath = "release/release-notes.md"] = process.argv.slice(2);
	if (!version) throw new Error("usage: node bin/release-notes.mjs <version> [changelog] [out]");
	const notes = extractReleaseNotes(readFileSync(resolve(changelogPath), "utf8"), version);
	mkdirSync(dirname(resolve(outPath)), { recursive: true });
	writeFileSync(resolve(outPath), notes);
	console.log(`pi-studio: release notes for ${version} -> ${outPath}`);
}

try {
	if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
} catch (error) {
	console.error(`::error::${error.message}`);
	process.exit(1);
}
