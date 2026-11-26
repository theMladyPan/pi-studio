#!/usr/bin/env node
/**
 * Check scope: a risk read of what changed, so nobody forces a full suite where it is not owed.
 *
 * Two different jobs, kept strictly apart:
 *
 *   scope — the classifier below. It reads file paths only, never file
 *           contents. It answers "what kind of change is this" (trivial,
 *           middle, core) so the gate can print advice. Its only power is
 *           to suggest. It never widens or narrows the test list. A label
 *           edit inside a client script is called middle or core on purpose:
 *           tests assert on script source as text, so a pure-path guess that
 *           called it trivial could stand up a bug entry point. The firewall
 *           is this: cache keys stay content hashes (bin/test-cache.mjs);
 *           this module only moves the needle on advice.
 *
 *   cache — the hash cache. It decides which tests actually rerun. It is
 *           unchanged and remains the correctness kernel. A misclassified
 *           diff only prints different advice; it cannot skip a test whose
 *           import closure changed.
 *
 * Tiers:
 *   trivial — docs and pure style. Every file is markdown, a doc/prompts/
 *             site page, or a `.css` style sheet. A color or label inside a
 *             `.css` file lands here; the same words inside a script do not.
 *   core    — a daemon, client, tooling or shared file changed
 *             (server/**, bin/**, public/client/**, test-support/**,
 *             bridge/**, server.ts, package files, tsconfig, install.sh).
 *   middle  — anything else: mixed or ambiguous diffs, test-only edits,
 *             unknown paths. The call belongs to whoever reads the diff.
 *
 *   node bin/check-scope.mjs   # print the scope of the current tree
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FULL_BRANCHES = ["main"];

/** Pure path classifier. `files` are repo-relative paths. No file is read. */
export function classifyFiles(files) {
	const list = [...new Set(files.filter((f) => typeof f === "string" && f.length > 0))];
	if (list.length === 0) return { tier: "empty", reasons: ["no files"], files: list };
	const core = list.filter(isCorePath);
	if (core.length > 0) {
		return { tier: "core", reasons: [`core logic: ${core.slice(0, 3).join(", ")}`], files: list };
	}
	if (list.every(isTrivialPath)) return { tier: "trivial", reasons: ["docs/style only"], files: list };
	return { tier: "middle", reasons: [`ambiguous: ${list.slice(0, 3).join(", ")}`], files: list };
}

function isTrivialPath(file) {
	if (file.endsWith(".md")) return true;
	if (/^docs\//.test(file) || /^prompts\//.test(file) || /^site\//.test(file)) return true;
	if (file.endsWith(".css")) return true;
	if (/^public\/.*\.(svg|png|ico|woff2?)$/.test(file)) return true;
	return false;
}

function isCorePath(file) {
	if (
		/^(server|bin|public\/client|test-support|bridge|examples)\//.test(file) ||
		file === "server.ts" ||
		file === "install.sh" ||
		/^(package\.json|package-lock\.json|tsconfig.*\.json)$/.test(file)
	) {
		return true;
	}
	return false;
}

/** The current branch, or "" when detached. Never throws. */
export function currentBranch(repo) {
	try {
		return execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/**
 * Files changed versus the branch this tree is heading toward, plus anything
 * uncommitted in the working tree. The hash cache hashes working-tree
 * content, so uncommitted edits belong in scope too. Throws when git fails;
 * the caller degrades to "scope unavailable" rather than guessing.
 */
export function changedFiles(repo) {
	const branch = currentBranch(repo);
	const candidates = ["dev", "origin/dev", "main", "origin/main"].filter((c) => c !== branch);
	let base = null;
	for (const candidate of candidates) {
		try {
			execFileSync("git", ["rev-parse", "--verify", candidate], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
			const mb = execFileSync("git", ["merge-base", "HEAD", candidate], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			if (mb) {
				base = mb;
				break;
			}
		} catch {
			// Try the next candidate.
		}
	}
	const files = new Set();
	const add = (out) => String(out).split("\n").forEach((l) => l.trim() && files.add(l));
	if (base) add(execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
	try {
		add(execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
	} catch {
		// No HEAD yet; committed-vs-base output above is what we have.
	}
	try {
		add(execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
	} catch {
		// Untracked scan failing only loses scope detail, not test runs.
	}
	return [...files].sort();
}

/** One-line gate advice for a branch and tier. Pure, so it stays testable. */
export function adviceFor(branch, tier) {
	const onFull = FULL_BRANCHES.includes(branch);
	if (tier === "empty") return "no change versus base; a cached replay already is the check";
	if (onFull) return `branch ${branch} always pays the full suite: rerun the test stage with --full`;
	if (branch === "dev") {
		if (tier === "core") return "core logic changed: a full run before merging into dev is justified";
		if (tier === "trivial") return "docs/style only: incremental cache is the whole check, never force full";
		return "middle risk: read the diff; force full only for a serious core change and say why";
	}
	return "never force full on a work branch; the incremental cache is the check";
}

/**
 * Totally fail-open scope read for the gate. Scope may only advise; any
 * failure is reported as unavailable and the hash cache still decides.
 */
export function scopeSummary(repo) {
	try {
		const branch = currentBranch(repo);
		const files = changedFiles(repo);
		const { tier, reasons } = classifyFiles(files);
		const where = branch || "(detached)";
		return `[scope] branch=${where} tier=${tier} (${files.length} files) — ${reasons.join("; ")}; ${adviceFor(branch, tier)}`;
	} catch {
		return "[scope] unavailable — incremental cache decides";
	}
}

/**
 * Whether the test stage must run whole. `--full` is the documented path for
 * main merges. `PI_STUDIO_NO_CACHE=1` stays as an alias for back-compat and
 * shares this one predicate, so the gate has exactly one meaning of full.
 */
export function shouldForceFull({ fullFlag = false, env = process.env } = {}) {
	return fullFlag === true || env.PI_STUDIO_NO_CACHE === "1";
}

/** Direct run: print the scope of this tree. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	console.log(scopeSummary(process.cwd()));
}
