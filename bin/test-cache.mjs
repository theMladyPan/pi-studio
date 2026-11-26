#!/usr/bin/env node
/**
 * Hash based test caching for the check gate.
 *
 * Two layers, both keyed by content hashes rather than by git state:
 *
 *   whole  — one key over every file a test could touch. A hit replays the
 *            previous exit code and skips the suite entirely. This is the
 *            no-change case: the LLM rerunning `npm run check` on the same
 *            tree, a retry after a network hiccup, a second look by the
 *            human. A hit costs about 20 ms of hashing against ~27 s of
 *            tests.
 *   per file — one key per test file over that file plus its transitive
 *            relative imports (plus test-support/, package files, and the
 *            Node and git versions). A miss reruns only the files whose
 *            closure changed. Editing one server module invalidates only the
 *            test files that import it, not all 72.
 *
 * Entries store only the exit code, never captured output. Replaying a log
 * would show stale timings and ids; replaying a verdict is what the gate
 * needs. Both passes and failures are cached, so a rerun on a known broken
 * tree is also instant. A flaky failure can therefore freeze — the
 * escape hatch is `node bin/check.mjs --full` (whole suite; for main merges)
 * or deleting `.cache/`. `PI_STUDIO_NO_CACHE=1` stays as an alias for --full.
 *
 * Safety rules:
 *   - an unresolvable relative import makes that file uncacheable (it
 *     always runs), never silently dropped;
 *   - cache errors are fail-open: a damaged cache runs the tests;
 *   - `npm run test` stays uncached. Only the gate uses this.
 *
 *   node bin/test-cache.mjs                 # print the whole key and per-file keys
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepo = dirname(here);

/** `PI_STUDIO_NO_CACHE=1` (alias for --full) or `PI_STUDIO_TEST_CACHE=off` forces a full run. */
export function cacheEnabled(env = process.env) {
	return env.PI_STUDIO_NO_CACHE !== "1" && env.PI_STUDIO_TEST_CACHE !== "off";
}

/** Where entries live. Inside the repo by default, overridable for tests and shared caches. */
export function cacheDir(repo = defaultRepo, env = process.env) {
	return env.PI_STUDIO_TEST_CACHE_DIR || join(repo, ".cache/test");
}

let gitVersionMemo = null;
function gitVersion() {
	if (gitVersionMemo !== null) return gitVersionMemo;
	try {
		gitVersionMemo = execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		gitVersionMemo = "no-git";
	}
	return gitVersionMemo;
}

function sha(hash, content) {
	hash.update(content);
	hash.update("\0");
	return hash;
}

/** Hash a sorted set of repo-relative files: path and content per file. */
export function hashFiles(repo, files) {
	const hash = createHash("sha256");
	for (const file of [...new Set(files)].sort()) {
		hash.update(file);
		hash.update("\0");
		sha(hash, readFileSync(join(repo, file)));
	}
	hash.update(`node:${process.version}`);
	hash.update("\0");
	hash.update(`git:${gitVersion()}`);
	return hash.digest("hex");
}

function walk(dir, repo) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...walk(full, repo));
		else found.push(relative(repo, full));
	}
	return found;
}

/** Every file a test result could depend on, as repo-relative paths. */
export function wholeInputFiles(repo) {
	const files = [];
	for (const dir of ["server", "public", "test", "test-support", "bin"]) {
		const full = join(repo, dir);
		if (existsSync(full)) files.push(...walk(full, repo));
	}
	for (const file of ["server.ts", "package.json", "package-lock.json", "tsconfig.node.json"]) {
		if (existsSync(join(repo, file))) files.push(file);
	}
	return files.sort();
}

/** The whole-suite key. One entry covers the entire tree. */
export function wholeKey(repo) {
	return hashFiles(repo, wholeInputFiles(repo));
}

/** Test files the gate runs, as repo-relative paths. */
export function listTestFiles(repo) {
	const dir = join(repo, "test");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".test.ts"))
		.sort()
		.map((name) => `test/${name}`);
}

/**
 * Every relative module specifier on a line, the same three shapes the import
 * check reads. A false positive (a path mentioned in prose) only costs a
 * rerun; a false negative would be a false green, so prose is read too.
 */
const reference = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

function references(file) {
	const found = [];
	readFileSync(file, "utf8")
		.split("\n")
		.forEach((line) => {
			for (const match of line.matchAll(reference)) {
				const specifier = match[1] ?? match[2] ?? match[3];
				if (specifier.startsWith(".")) found.push(specifier);
			}
		});
	return found;
}

/**
 * The transitive closure of relative imports for one file, as repo-relative
 * paths including the file itself. Null when any specifier does not resolve
 * to a file inside the repo — the caller must run that file always.
 */
export function importClosure(repo, start) {
	const seen = new Set();
	const stack = [resolve(repo, start)];
	while (stack.length > 0) {
		const file = stack.pop();
		const rel = relative(repo, file);
		if (rel.startsWith("..") || rel === "") return null;
		if (seen.has(rel)) continue;
		if (!existsSync(file)) return null;
		seen.add(rel);
		for (const specifier of references(file)) {
			const next = resolve(dirname(file), specifier);
			if (!existsSync(next)) return null;
			stack.push(next);
		}
	}
	return [...seen].sort();
}

/** Files hashed into every per-file key, whatever the closure. */
function sharedFiles(repo) {
	const files = [];
	const support = join(repo, "test-support");
	if (existsSync(support)) files.push(...walk(support, repo));
	for (const file of ["package.json", "package-lock.json", "tsconfig.node.json"]) {
		if (existsSync(join(repo, file))) files.push(file);
	}
	return files.sort();
}

/**
 * The per-file key for one test file, or null when it cannot be keyed safely.
 * Editing a file outside the closure does not change the key, so the entry
 * survives edits to unrelated modules.
 */
export function perFileKey(repo, testFile) {
	const closure = importClosure(repo, testFile);
	if (closure === null) return null;
	return hashFiles(repo, [...closure, ...sharedFiles(repo)]);
}

/** Read a cache entry. Anything unreadable is a miss, never an error. */
export function readCache(dir, key) {
	try {
		const raw = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8"));
		if (typeof raw.exitCode !== "number") return null;
		return raw;
	} catch {
		return null;
	}
}

/** Write a cache entry atomically, so a crash cannot leave a partial one. */
export function writeCache(dir, key, exitCode) {
	try {
		mkdirSync(dir, { recursive: true });
		const tmp = join(dir, `${key}.${process.pid}.tmp`);
		writeFileSync(tmp, JSON.stringify({ exitCode }) + "\n");
		renameSync(tmp, join(dir, `${key}.json`));
	} catch {
		// A cache that cannot be written must not fail the gate.
	}
}

export function clearCache(dir) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Nothing to clear.
	}
}

/** Direct run: print the keys the gate would use. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const repo = defaultRepo;
	console.log(`whole ${wholeKey(repo)}`);
	for (const file of listTestFiles(repo)) console.log(`file  ${file} ${perFileKey(repo, file) ?? "uncacheable"}`);
}
