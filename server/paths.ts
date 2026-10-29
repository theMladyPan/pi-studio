/**
 * Where everything lives, resolved once.
 *
 * These constants used to sit at the top of the one file, where `import.meta.url` was the repository
 * root. Inside `server/` that is one directory too deep, and two of the three failures are silent: a
 * wrong `PUBLIC_DIR` 404s every static route, a wrong `BRIDGE` drops the extension from a child's argv
 * so no thread can reach the board it belongs to, and a checkout nobody can find still answers
 * "unknown" for the build. So all of them are derived from one root, and a test asserts the two that
 * point at real files exist.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: this file is one directory inside it. */
export const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const PUBLIC_DIR = join(REPO_DIR, "public");
/** The extension a child loads so a thread can draw on the board it belongs to. */
export const BRIDGE = join(REPO_DIR, "bridge", "child-bridge.mjs");

/** The folder a normal daemon uses; `INSTANCE` is empty only for this one. */
function homeStateDir() {
	return join(homedir(), ".pi", "agent", "state", "pi-studio");
}

function stateFromArgs() {
	const args = process.argv.slice(2);
	for (const [index, arg] of args.entries()) {
		if (arg === "--state") return args[index + 1] ?? "";
		if (arg.startsWith("--state=")) return arg.slice("--state=".length);
	}
	return "";
}

/**
 * Everything durable lives beside pi's own state under a folder named after the app: the token, the
 * workspaces the human has opened, one board file per workspace, and the pi sessions behind its
 * threads.
 *
 * `PI_STUDIO_STATE` or `--state <folder>` moves all of it, so a second daemon can be booted against
 * its own folder while the real one keeps running. Without that, the only way to see a change work
 * was somebody's own board, which is a hope rather than a check.
 */
const stateArg = stateFromArgs() || process.env.PI_STUDIO_STATE || "";
// A `~` reaches node unexpanded when nobody goes through a shell, and `.agents/…` should be relative to
// the folder the daemon was started in, which is what `resolve` already does.
export const STATE_DIR = resolve(stateArg.startsWith("~/") ? join(homedir(), stateArg.slice(2)) : stateArg || homeStateDir());
/**
 * What this daemon calls itself when its folder is not the usual one. Two instances with the same
 * boards in two tabs are indistinguishable, and the tab title is the only place that can say which.
 */
export const INSTANCE = STATE_DIR === homeStateDir() ? "" : basename(STATE_DIR);
export const STATE_FILE = join(STATE_DIR, "daemon.json");
export const WORKSPACES_FILE = join(STATE_DIR, "workspaces.json");

/** The schema the board and workspace files are written with. */
export const STATE_VERSION = 1;

/** One board file per workspace, named by the folder's identity rather than by its path. */
export function boardFile(workspace: { id: string }) {
	return join(STATE_DIR, "boards", `${workspace.id}.json`);
}

/** Read a JSON file, or the fallback when it is missing, unreadable or not JSON at all. */
export function readJsonFile<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Write a JSON file whole, so a crash mid-write cannot leave half a board behind. */
export function writeJsonFile(file: string, data: unknown): void {
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		console.error(`pi-studio: could not write ${file}: ${(error as Error).message}`);
	}
}

/**
 * The commit this copy of the app was started from, or "unknown" outside a checkout.
 *
 * A clone keeps `.git` as a directory, a worktree keeps it as a pointer file to one, and the refs the
 * pointer's HEAD names live a level further out again through `commondir`. Reading only the first shape
 * answers "unknown" from every worktree, which is where changes to this app are made.
 */
export function buildHash(): string {
	try {
		const dotgit = join(REPO_DIR, ".git");
		const pointer = statSync(dotgit).isFile() ? readFileSync(dotgit, "utf8").trim() : "";
		const gitDir = pointer.startsWith("gitdir: ") ? resolve(REPO_DIR, pointer.slice("gitdir: ".length).trim()) : dotgit;
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		if (!head.startsWith("ref: ")) return head.slice(0, 7);
		const named = head.slice("ref: ".length).trim();
		const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
		const ref = existsSync(join(gitDir, named)) ? join(gitDir, named) : join(common, named);
		return readFileSync(ref, "utf8").trim().slice(0, 7);
	} catch {
		return "unknown";
	}
}

export function randomToken() {
	return createHash("sha256").update(`${process.pid}-${Date.now()}-${Math.random()}`).digest("hex").slice(0, 32);
}

/** A folder keeps its identity across restarts, which is what makes "continue" mean continue. */
export function workspaceId(folder: string) {
	return createHash("sha256").update(folder).digest("hex").slice(0, 12);
}
