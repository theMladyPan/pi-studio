/**
 * What the browser may name, checked before git is asked about it.
 *
 * Every value that reaches this module came from a webview, which means it came from a page. The page
 * is ours, but the only reason a value is safe is that this module said so: a branch name is pasted
 * into git's argv, a file path is resolved on disk, and a URL is written into `.git/config`. So each
 * checker answers for one shape of value, in the same words as git's own ref rules, and each answers a
 * value or a reason rather than throwing, because the caller's job is to reply to a page.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

// ---------- what a check answers ----------

/** The shape of an answer: what was accepted, or why it was not. */
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A path inside the repository that really resolves inside it, or the reason it is not. */
export type Contained = { ok: true; fullPath: string } | { ok: false; error: string };

// ---------- the words git knows ----------

/** The three ways `git reset` can move a branch. */
export const RESET_MODES = ["soft", "mixed", "hard"] as const;
/** The two config scopes a user detail may be written to; `system` needs a root password nobody has. */
export const CONFIG_LOCATIONS = ["local", "global"] as const;
/** The three ways a branch may be pushed, where "" is the plain push. */
export const PUSH_MODES = ["", "force", "force-with-lease"] as const;
/** The three commit orders the graph can be drawn in, as `git log` names them. */
export const COMMIT_ORDERS = ["date", "author-date", "topo"] as const;
/** The two tags git can make: annotated, which carries a message and a signer, and lightweight. */
export const TAG_TYPES = [0, 1] as const;

/** Whether a value is one of the words a list holds. */
export function isOneOf<T extends string | number>(allowed: readonly T[], value: unknown): value is T {
	return allowed.some((entry) => entry === value);
}

// ---------- the characters none of them may carry ----------

const CONTROL = /[\u0000-\u001f\u007f]/;

/** True when two strings share no character, which is the question the rejections below really ask. */
function hasAny(text: string, forbidden: string): boolean {
	for (const character of forbidden) {
		if (text.includes(character)) return true;
	}
	return false;
}

// ---------- commits ----------

/**
 * A commit id, or the `*` the graph draws for uncommitted changes. Nothing shorter than four hex
 * characters, because `git` would read a two-letter string as an option or a ref; nothing longer than
 * the 64 a SHA-256 repository uses.
 */
export function isHash(value: unknown, allowUncommitted = false): value is string {
	if (typeof value !== "string") return false;
	if (allowUncommitted && value === "*") return true;
	return /^[0-9a-f]{4,64}$/i.test(value);
}

// ---------- refs ----------

/**
 * A branch, tag or remote-tracking name, checked by the rules `git check-ref-format` applies, because
 * the name is about to be one argv word: `--upload-pack=…` as a branch name would be an option, and
 * `feat..main` is a revision range that would answer about two commits instead of one.
 *
 * `HEAD` and `stash@{0}` pass the character rules but mean something other than a name, so they are
 * left to the two checkers that follow rather than being hidden refusals here.
 */
export function isRefName(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
	if (CONTROL.test(value)) return false;
	if (hasAny(value, " ~^:?*[\\")) return false;
	if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
	if (value.includes("..") || value.includes("@{")) return false;
	if (value.includes("//")) return false;
	if (value.endsWith(".") || value.endsWith(".lock")) return false;
	if (value === "@") return false;
	// A segment starting with a dot is git's own refusal: `.git` and `.lock` are directories git keeps
	// for itself, and a ref named after one of them would point at nothing.
	return value.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

/** `stash@{2}` and nothing else: the selector is a revision, so it may only be spelled the one way. */
export function isStashSelector(value: unknown): value is string {
	return typeof value === "string" && /^stash@\{\d+}$/.test(value);
}

/**
 * Anything that names a revision git can resolve: a commit id, the uncommitted marker, a stash, a
 * branch, a tag, or `HEAD`. The revision itself is never trusted to be safe — git resolves it — so the
 * check is only that no word here can be read as an option or a range.
 */
export function isRevision(value: unknown, allowUncommitted = false): value is string {
	if (isHash(value, allowUncommitted)) return true;
	if (isStashSelector(value)) return true;
	if (value === "HEAD" || value === "@") return true;
	return isRefName(value);
}

// ---------- remotes ----------

/** A remote's name: one word git accepts in `git remote add`, without the ref syntax a branch may carry. */
export function isRemoteName(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
	if (!/^[A-Za-z0-9._-]+$/.test(value)) return false;
	if (value.startsWith("-") || value.includes("..")) return false;
	return value !== "." && value !== "..";
}

/**
 * A URL as `git remote add` and `git remote set-url` take it. It is written into `.git/config`, and it
 * is never fetched from here, so the only dangers are the ones that start with a dash (git would read
 * it as an option) and the ones that inject an environment assignment or a new config line.
 */
export function isRemoteUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
	if (CONTROL.test(value)) return false;
	return !value.startsWith("-");
}

/** A config key that only names a setting: `user.name` is one, `user.name\n[core]` is two. */
export function isConfigKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 255 && /^[a-zA-Z0-9.-]+$/.test(value);
}

// ---------- paths inside a repository ----------

/** A Windows drive prefix, which is absolute on the platform this refuses to be talked into. */
const DRIVE = /^[A-Za-z]:/;

/**
 * A path inside the repository, as git prints one: POSIX separators, no drive letter, and no segment
 * that walks upwards. `\` is refused rather than converted, because git never prints one as a
 * separator and on Windows it is one — a path carrying it means two different folders depending on
 * which side reads it.
 */
export function repoPath(rel: unknown): Checked<string> {
	if (typeof rel !== "string") return { ok: false, error: "a path must be a string" };
	if (rel.length === 0) return { ok: false, error: "a path cannot be empty" };
	if (rel.length > 4096) return { ok: false, error: "a path cannot be longer than 4096 characters" };
	if (rel.includes("\u0000")) return { ok: false, error: "a path cannot contain a NUL byte" };
	if (CONTROL.test(rel)) return { ok: false, error: "a path cannot contain control characters" };
	if (rel.includes("\\")) return { ok: false, error: "a path must use forward slashes" };
	if (rel.startsWith("/") || DRIVE.test(rel)) return { ok: false, error: "a path must be relative to the repository" };
	const segments = rel.split("/");
	for (const segment of segments) {
		if (segment === "") return { ok: false, error: "a path cannot contain an empty segment" };
		if (segment === "." || segment === "..") return { ok: false, error: "a path cannot walk outside the repository" };
	}
	return { ok: true, value: segments.join("/") };
}

/**
 * The real file a relative path names, and the proof that it is inside the repository.
 *
 * `repoPath` alone cannot see a symlink: a link the checkout holds, pointing at `../../etc/passwd`, is
 * a perfectly relative path until the kernel follows it. Resolving both ends and comparing them is the
 * only check that answers for the file git would actually read.
 */
export function containedReal(repoRoot: string, relPath: unknown): Contained {
	const rel = repoPath(relPath);
	if (!rel.ok) return rel;
	let realRoot: string;
	let resolved: string;
	try {
		realRoot = realpathSync(repoRoot);
	} catch {
		return { ok: false, error: `the repository folder cannot be read: ${repoRoot}` };
	}
	try {
		resolved = realpathSync(join(repoRoot, rel.value));
	} catch {
		return { ok: false, error: `the file is not there: ${rel.value}` };
	}
	const inside = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
	if (!resolved.startsWith(inside)) return { ok: false, error: `the file is outside the repository: ${rel.value}` };
	return { ok: true, fullPath: resolved };
}

// ---------- absolute locations ----------

/**
 * A repository as the daemon names it: the absolute, real path `rev-parse --show-toplevel` answered
 * with. It is read from the workspace, never from a page, but it is still the folder git is run in, so
 * a page that could name a relative one could make that relative to a different place each time.
 */
export function isRepoRoot(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
	if (CONTROL.test(value)) return false;
	return isAbsolute(value);
}
