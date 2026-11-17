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
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: this file is one directory inside it. */
export const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const PUBLIC_DIR = join(REPO_DIR, "public");
/** The extension a child loads so a thread can draw on the board it belongs to. */
export const BRIDGE = join(REPO_DIR, "bridge", "child-bridge.mjs");

/** The folder a normal daemon used before global records moved to XDG state. Kept only as a copy-only import source. */
function legacyStateDir() {
	return join(homedir(), ".pi", "agent", "state", "pi-studio");
}

export const LEGACY_STATE_DIR = legacyStateDir();

/** Global records by default live under XDG state, not beside pi's own state. */
function defaultGlobalStateDir() {
	const xdg = process.env.XDG_STATE_HOME ?? "";
	return xdg && isAbsolute(xdg) ? join(xdg, "pi-studio") : join(homedir(), ".local", "state", "pi-studio");
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
 * Global records live in `STATE_DIR`: the token, browser sessions, recent folders and defaults.
 * Per-folder boards, sessions and Git-view state live under each opened folder's own `.pi-studio`
 * directory instead (see `projectStateDir`).
 *
 * `PI_STUDIO_STATE` or `--state <folder>` moves the global records only, so a second daemon can be
 * booted against its own folder while the real one keeps running. Different global roots opening the
 * same folder deliberately refer to the same project-local data; concurrent writers are unsupported.
 */
const stateArg = stateFromArgs() || process.env.PI_STUDIO_STATE || "";
export const HAS_EXPLICIT_STATE = Boolean(stateArg);
// A `~` reaches node unexpanded when nobody goes through a shell, and `.agents/…` should be relative to
// the folder the daemon was started in, which is what `resolve` already does.
export const STATE_DIR = resolve(stateArg.startsWith("~/") ? join(homedir(), stateArg.slice(2)) : stateArg || defaultGlobalStateDir());
/**
 * What this daemon calls itself when its folder is not the usual one. Two instances with the same
 * boards in two tabs are indistinguishable, and the tab title is the only place that can say which.
 */
export const INSTANCE = HAS_EXPLICIT_STATE ? basename(STATE_DIR) : "";
export const STATE_FILE = join(STATE_DIR, "daemon.json");
export const WORKSPACES_FILE = join(STATE_DIR, "workspaces.json");

/**
 * The scratch folder: the one workspace that is always on the crossroads and holds nothing worth keeping.
 *
 * The studio's own sits in the machine's temp folder, so a reboot does the cleaning, and it keeps a fixed
 * path because a workspace's identity *is* its path: a name that changed per boot would open a new board
 * each time while the old files stayed on disk. A daemon with a state folder of its own — a development
 * instance, a test — keeps its scratch beside that state instead, because a folder in the temp area named
 * after a state folder that has been deleted is litter nobody can name the owner of.
 */
export const SCRATCH_DIR = INSTANCE ? join(STATE_DIR, "scratch") : join(tmpdir(), "pi-studio-scratch");


/**
 * Whether a folder is this daemon's scratch folder. Asked by the worktree maker, so a thread there works in
 * the folder itself: a scratch folder inside a repository — a state folder a human put in a checkout — would
 * otherwise get a branch and a tree under that project, and the scripts written in it would outlive the empty
 * press. The real path is compared when both ends can be read, because `/tmp` is a symlink on some machines.
 */
export function isScratchFolder(folder: string): boolean {
	if (!folder) return false;
	if (resolve(folder) === resolve(SCRATCH_DIR)) return true;
	try {
		return realpathSync(folder) === realpathSync(SCRATCH_DIR);
	} catch {
		return false;
	}
}

/** The schema the board and workspace files are written with. */
export const STATE_VERSION = 1;

/** The board of one opened folder, which owns its `.pi-studio` directory; the legacy global layout is the fallback for the scratch folder and callers that name only an id. */
export function boardFile(workspace: { id: string; folder?: string }) {
	const root = projectRootFor(workspace);
	return root ? join(root, "board.json") : join(STATE_DIR, "boards", `${workspace.id}.json`);
}

/** Persisted Git Graph view state and code reviews for one workspace, beside its board. */
export function gitgraphStateFile(workspace: { id: string; folder?: string }) {
	const root = projectRootFor(workspace);
	return root ? join(root, "gitgraph.json") : join(STATE_DIR, "gitgraph", `${workspace.id}.json`);
}

/**
 * The legacy global home for this instance: the old `~/.pi` location for the default instance, or the
 * explicit root itself for a `--state` instance, so an import never reaches the real user's data. Read-only
 * fallback for the crossroads until a folder is first opened and its state is imported.
 */
export function legacyStateRoot() {
	return HAS_EXPLICIT_STATE ? STATE_DIR : LEGACY_STATE_DIR;
}

/**
 * The marker that records a completed one-time import of the legacy global records into this state home,
 * so a later start does not copy a record the human has since deleted back from the old home.
 */
export const GLOBAL_IMPORT_MARKER = join(STATE_DIR, "legacy-import.json");

/** The board file in the legacy global layout, read until the first open imports it. */
export function legacyBoardFile(workspace: { id: string }) {
	return join(legacyStateRoot(), "boards", `${workspace.id}.json`);
}

/** The sessions folder in the legacy global layout, read until the first open imports it. */
export function legacySessionDir(workspace: { id: string }) {
	return join(legacyStateRoot(), "sessions", workspace.id);
}

/**
 * Where one opened folder's own state lives: `<folder>/.pi-studio`, directly holding `board.json`,
 * `gitgraph.json` and `sessions/`. State is per opened folder, while worktrees keep the existing
 * repo-root `.agents` behaviour. No automatic remapping is done for renamed or cloned repositories:
 * a workspace whose folder no longer exists is reported stale (see `describeWorkspace`), never
 * silently repointed. Different global roots opening the same folder refer to this same directory;
 * concurrent writers are unsupported.
 */
export function projectStateDir(folder: string) {
	return join(resolve(folder), ".pi-studio");
}

/**
 * The project root for a workspace, or "" when it has no project-local home: the scratch folder
 * (whose state stays temporary and global) and callers that name only an id. Production callers
 * pass the workspace or board, which carries its folder; `flushState` reaches the same file
 * through the workspace it cached on first load.
 */
export function projectRootFor(workspace: { id: string; folder?: string }): string {
	const folder = workspace.folder ? resolve(workspace.folder) : "";
	if (!folder || isScratchPath(folder)) return "";
	return projectStateDir(folder);
}

/**
 * The marker that records a completed one-time import for one opened folder, beside its board and its Git
 * state. Written only after every copy has landed, and read by every later start of the daemon; see
 * `importLegacyProjectState`.
 */
export function legacyImportMarker(workspace: { id: string; folder?: string }): string {
	const root = projectRootFor(workspace);
	return root ? join(root, "legacy-import.json") : "";
}

/** Whether a folder is the scratch folder, by path; the scratch row keeps global, temporary state. */
function isScratchPath(folder: string): boolean {
	if (!folder) return false;
	if (resolve(folder) === resolve(SCRATCH_DIR)) return true;
	try {
		return realpathSync(folder) === realpathSync(SCRATCH_DIR);
	} catch {
		return false;
	}
}

/**
 * Where a file dropped onto a message field waits for the agent to read it.
 *
 * A drop is temporary. The bytes came from the human's own disk and the copy exists only so the message
 * can name a path, so it sits in the machine's temp folder where a reboot clears it — and a daemon with a
 * state folder of its own keeps its drops beside that state, the way its scratch row does.
 */
export const DROP_DIR = INSTANCE ? join(STATE_DIR, "drops") : join(tmpdir(), "pi-studio-drops");

/** One folder per board inside it, so two boards never explain away each other's files. */
export function droppedDir(boardId: string) {
	return join(DROP_DIR, String(boardId ?? "").replace(/[^0-9a-z]/gi, "") || "board");
}

/** Read a JSON file, or the fallback when it is missing, unreadable or not JSON at all. */
export function readJsonFile<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/**
 * Write a file whole through a temporary this call alone owns, so a crash mid-write cannot leave half a
 * file behind.
 *
 * The temporary's name comes from the process id plus a fresh random tail, and it is created exclusively:
 * anything already sitting at that name — a file, or a symlink someone planted — makes the open fail
 * instead of being followed or taken over. The rename then carries that temporary over the file in one
 * move. A failed write cleans up only the temporary this call created, never one it found. This narrows
 * the window; it does not make two concurrent writers of the same file safe.
 */
export function writeFileThroughTemp(file: string, text: string, mode?: number): void {
	const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let created = false;
	try {
		const handle = openSync(temporary, "wx", mode);
		created = true;
		try {
			writeFileSync(handle, text);
		} finally {
			closeSync(handle);
		}
		renameSync(temporary, file);
	} catch (error) {
		if (created) {
			try {
				unlinkSync(temporary);
			} catch {
				// The temporary is already gone, which is what a failed rename leaves behind.
			}
		}
		throw error;
	}
}

/** Write a JSON file whole, so a crash mid-write cannot leave half a board behind. Answers whether it landed. */
export function writeJsonFile(file: string, data: unknown): boolean {
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileThroughTemp(file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
		return true;
	} catch (error) {
		console.error(`pi-studio: could not write ${file}: ${(error as Error).message}`);
		return false;
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
	return randomBytes(16).toString("hex");
}

/**
 * Where a program name lands on this machine's search path, or "" while no entry holds it. The rule is the
 * one the `!` completion walks by: a real file, and executable; a link counts as what it resolves to.
 */
export function programOnPath(name: string): string {
	if (!name) return "";
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const full = join(dir, name);
		try {
			if (!statSync(full).isFile()) continue;
			accessSync(full, constants.X_OK);
		} catch {
			continue;
		}
		return full;
	}
	return "";
}

/** A folder keeps its identity across restarts, which is what makes "continue" mean continue. */
export function workspaceId(folder: string) {
	return createHash("sha256").update(folder).digest("hex").slice(0, 12);
}
