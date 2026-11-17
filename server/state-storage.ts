/**
 * Project-local state preparation, the one-time legacy import, and the state-profile lock.
 *
 * Importing this module writes nothing: every function here is called explicitly by the daemon at
 * startup or when a folder is opened, so a test that only imports daemon code touches no real folder.
 * Nothing here deletes a link or follows a planted symlink to write outside the intended state.
 */
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { HAS_EXPLICIT_STATE, LEGACY_STATE_DIR, STATE_DIR, isScratchFolder, projectStateDir } from "./paths.ts";

const importedFor = new Set<string>();

/** Make one directory, refusing a symlink or non-directory standing at its path. */
function safeMkdir(dir: string): void {
	try {
		const held = lstatSync(dir);
		if (held.isSymbolicLink()) throw new Error(`project state path is a symlink: ${dir}`);
		if (!held.isDirectory()) throw new Error(`project state path is not a directory: ${dir}`);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		throw new Error(`project state directory could not be made: ${dir}: ${(error as Error).message}`);
	}
}

/**
 * The `.pi-studio/<namespace>` home of one opened folder, made and checked so nothing planted
 * there can redirect a write outside it. Throws a clear error when the state is unwritable or
 * unsafe: the caller must refuse to open an unsaved in-memory board rather than carry on.
 */
export function ensureProjectStateDir(folder: string, workspaceId?: string): string {
	const resolved = resolve(folder);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		throw new Error(`workspace folder is missing: ${resolved} (state is per opened folder; a renamed or cloned repository is not remapped)`);
	}
	const root = projectStateDir(resolved);
	safeMkdir(join(resolved, ".pi-studio"));
	safeMkdir(root);
	for (const sub of ["boards", "gitgraph", "sessions"]) safeMkdir(join(root, sub));
	if (workspaceId) safeMkdir(join(root, "sessions", workspaceId));
	return root;
}

/** Copy one regular file without ever overwriting the destination; originals are retained. */
function copyNoOverwrite(source: string, dest: string): boolean {
	try {
		if (lstatSync(source).isSymbolicLink()) return false;
		if (!lstatSync(source).isFile()) return false;
	} catch {
		return false;
	}
	try {
		lstatSync(dest);
		return false; // Anything already there (file, link, directory) wins.
	} catch {
		// No destination yet, which is the ordinary case.
	}
	try {
		copyFileSync(source, dest, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The one-time, copy-only import of one workspace's legacy global files into its project home:
 * its board, its whole session transcripts, and its Git-view state. Session files are copied
 * whole because pi appends to them; nothing is truncated or rewritten, so ids, history, worktree
 * links and session headers are preserved. The legacy originals stay where they are.
 *
 * Runs once per workspace per process. The source is the legacy home for this instance: the old
 * ~/.pi location for the default instance, or the explicit root itself for a `--state` instance,
 * so a test or custom root never imports the real user's data.
 */
export function importLegacyProjectState(workspace: { id: string; folder?: string }): void {
	const folder = workspace.folder ? resolve(workspace.folder) : "";
	if (!folder || !workspace.id || importedFor.has(workspace.id)) return;
	if (isScratchFolder(folder) || !existsSync(folder)) return;
	importedFor.add(workspace.id);
	const root = ensureProjectStateDir(folder, workspace.id);
	// For the default instance the legacy home is the old ~/.pi location. For an explicit root the
	// legacy home is that root itself: importing it never reaches the real user's data, because the
	// source stays inside the root the human (or test) named.
	const legacy = HAS_EXPLICIT_STATE ? STATE_DIR : LEGACY_STATE_DIR;
	if (!existsSync(legacy)) return;
	copyNoOverwrite(join(legacy, "boards", `${workspace.id}.json`), join(root, "boards", `${workspace.id}.json`));
	copyNoOverwrite(join(legacy, "gitgraph", `${workspace.id}.json`), join(root, "gitgraph", `${workspace.id}.json`));
	const legacySessions = join(legacy, "sessions", workspace.id);
	try {
		for (const entry of readdirSync(legacySessions, { withFileTypes: true })) {
			if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
			copyNoOverwrite(join(legacySessions, entry.name), join(root, "sessions", workspace.id, entry.name));
		}
	} catch {
		// No legacy sessions for this workspace is the ordinary case.
	}
}

/**
 * The one-time, copy-only import of the legacy global records (token, browser sessions, recent
 * folders and defaults) into the XDG state home. Never overwrites an existing new file and never
 * removes the originals. Answers whether anything was copied, so the caller can reload what it
 * loaded before the copy. No-op for an explicit state root.
 */
export function migrateLegacyGlobalState(): boolean {
	if (HAS_EXPLICIT_STATE) return false;
	if (resolve(STATE_DIR) === resolve(LEGACY_STATE_DIR)) return false;
	if (!existsSync(LEGACY_STATE_DIR)) return false;
	safeGlobalDir();
	let copied = false;
	for (const name of ["daemon.json", "workspaces.json", "sessions.json"]) {
		copied = copyNoOverwrite(join(LEGACY_STATE_DIR, name), join(STATE_DIR, name)) || copied;
	}
	return copied;
}

/** The global state home, made and checked the way a project home is. */
function safeGlobalDir(): void {
	try {
		const held = lstatSync(STATE_DIR);
		if (held.isSymbolicLink() || !held.isDirectory()) throw new Error(`state folder is not a directory: ${STATE_DIR}`);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

let lockFd = -1;

/**
 * Hold this state profile so a second daemon writing the same global records is refused with a
 * clear error instead of last-writer-wins. A lock left by a dead process is taken over.
 */
export function acquireStateProfileLock(): void {
	safeGlobalDir();
	const lockFile = join(STATE_DIR, "daemon.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			lockFd = openSync(lockFile, "wx", 0o600);
			writeSync(lockFd, `${process.pid}\n`);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let holder = 0;
		try {
			holder = Number(readFileSync(lockFile, "utf8").trim());
		} catch {
			holder = 0;
		}
		if (holder && holder !== process.pid && pidAlive(holder)) {
			throw new Error(`another pi-studio daemon already writes state profile ${STATE_DIR} (pid ${holder})`);
		}
		try {
			unlinkSync(lockFile);
		} catch {
			throw new Error(`could not take over the stale state lock at ${lockFile}`);
		}
	}
	throw new Error(`could not acquire the state profile lock at ${lockFile}`);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Release the profile lock held by `acquireStateProfileLock`, if this process holds it. */
export function releaseStateProfileLock(): void {
	if (lockFd === -1) return;
	try {
		closeSync(lockFd);
	} catch {
		// Already closed.
	}
	lockFd = -1;
	try {
		if (Number(readFileSync(join(STATE_DIR, "daemon.lock"), "utf8").trim()) === process.pid) unlinkSync(join(STATE_DIR, "daemon.lock"));
	} catch {
		// Nothing to release.
	}
}
