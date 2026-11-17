/**
 * Project-local state preparation and the one-time legacy imports.
 *
 * Importing this module writes nothing: every function here is called explicitly by the daemon at
 * startup or when a folder is opened, so a test that only imports daemon code touches no real folder.
 * Nothing here deletes a link or follows a planted symlink to write outside the intended state.
 * Different global roots opening the same folder refer to the same project-local data; concurrent
 * writers are unsupported.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	GLOBAL_IMPORT_MARKER,
	HAS_EXPLICIT_STATE,
	LEGACY_STATE_DIR,
	STATE_DIR,
	isScratchFolder,
	legacyImportMarker,
	legacyStateRoot,
	projectRootFor,
	projectStateDir,
	writeJsonFile,
} from "./paths.ts";

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
 * The `.pi-studio` home of one opened folder, made and checked so nothing planted
 * there can redirect a write outside it. Throws a clear error when the state is unwritable or
 * unsafe: the caller must refuse to open an unsaved in-memory board rather than carry on.
 */
export function ensureProjectStateDir(folder: string): string {
	const resolved = resolve(folder);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		throw new Error(`workspace folder is missing: ${resolved} (state is per opened folder; a renamed or cloned repository is not remapped)`);
	}
	const root = projectStateDir(resolved);
	safeMkdir(root);
	safeMkdir(join(root, "sessions"));
	return root;
}

/**
 * What one copy did: the bytes landed, there was nothing to copy, or the copy failed. A failure has to be
 * told apart from the two ordinary answers, because only a pass in which nothing failed may be recorded
 * as complete.
 */
type CopyOutcome = "copied" | "skipped" | "failed";

/** Copy one regular file without ever overwriting the destination; originals are retained. */
function copyNoOverwrite(source: string, dest: string): CopyOutcome {
	try {
		if (lstatSync(source).isSymbolicLink()) return "skipped";
		if (!lstatSync(source).isFile()) return "skipped";
	} catch {
		return "skipped"; // No legacy file here is the ordinary case.
	}
	try {
		lstatSync(dest);
		return "skipped"; // Anything already there (file, link, directory) wins.
	} catch {
		// No destination yet, which is the ordinary case.
	}
	try {
		copyFileSync(source, dest, 0);
		return "copied";
	} catch {
		return "failed";
	}
}

/**
 * Whether this folder's one-time import has already run to completion, in this process or an earlier one.
 * A link or a directory standing where the marker belongs is not a record, so the import is retried.
 */
export function legacyImportComplete(workspace: { id: string; folder?: string }): boolean {
	const marker = legacyImportMarker(workspace);
	if (!marker) return false;
	try {
		return lstatSync(marker).isFile();
	} catch {
		return false;
	}
}

/**
 * Whether a save has to be refused because the folder it writes into is gone.
 *
 * A board, its sessions and its Git view state live inside the opened folder, so a debounced write after
 * the human deleted that folder would make it again, holding nothing but the file the save carried. State
 * with no folder of its own — the scratch row, and a caller that names only an id — is global and is
 * written as before.
 */
export function projectFolderGone(workspace: { id: string; folder?: string }): boolean {
	const folder = workspace.folder ? resolve(workspace.folder) : "";
	if (!folder || !projectRootFor(workspace)) return false;
	try {
		return !statSync(folder).isDirectory();
	} catch {
		return true;
	}
}

/** Forget which workspaces this process has imported, so a test can stand in for a fresh start. */
export function resetImportCacheForTests(): void {
	importedFor.clear();
}

/**
 * The one-time, copy-only import of one workspace's legacy global files into its project home:
 * its board, its whole session transcripts, and its Git-view state. Session files are copied
 * whole because pi appends to them; nothing is truncated or rewritten, so ids, history, worktree
 * links and session headers are preserved. The legacy originals stay where they are.
 *
 * Runs once per workspace, recorded on disk in `<folder>/.pi-studio/legacy-import.json` and written only
 * after every copy this pass had to make has landed. That record is what keeps a later start from copying
 * the legacy originals a second time: they are kept where they are for good, so a transcript the human
 * retired from the new home would otherwise come back at every boot. Deleting the whole `.pi-studio`
 * folder erases the record with the rest of the new state, which is the recovery: the next open copies the
 * legacy files again. A marker that cannot be written is no marker, so the next open simply retries.
 *
 * The source is the legacy home for this instance: the old ~/.pi location for the default instance, or the
 * explicit root itself for a `--state` instance, so a test or custom root never imports the real user's data.
 */
export function importLegacyProjectState(workspace: { id: string; folder?: string }): void {
	const folder = workspace.folder ? resolve(workspace.folder) : "";
	if (!folder || !workspace.id || importedFor.has(workspace.id)) return;
	if (isScratchFolder(folder) || !existsSync(folder)) return;
	const root = ensureProjectStateDir(folder);
	const marker = legacyImportMarker(workspace);
	if (legacyImportComplete(workspace)) {
		importedFor.add(workspace.id);
		return;
	}
	// For the default instance the legacy home is the old ~/.pi location. For an explicit root the
	// legacy home is that root itself: importing it never reaches the real user's data, because the
	// source stays inside the root the human (or test) named.
	const legacy = legacyStateRoot();
	let failed = false;
	if (existsSync(legacy)) {
		failed = copyNoOverwrite(join(legacy, "boards", `${workspace.id}.json`), join(root, "board.json")) === "failed";
		failed = copyNoOverwrite(join(legacy, "gitgraph", `${workspace.id}.json`), join(root, "gitgraph.json")) === "failed" || failed;
		const legacySessions = join(legacy, "sessions", workspace.id);
		try {
			for (const entry of readdirSync(legacySessions, { withFileTypes: true })) {
				if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
				failed = copyNoOverwrite(join(legacySessions, entry.name), join(root, "sessions", entry.name)) === "failed" || failed;
			}
		} catch {
			// No legacy sessions for this workspace is the ordinary case.
		}
	}
	// Only a pass in which nothing failed is remembered, on disk and in this process: marking before the
	// copy would make a refused path (an unsafe link, a read-only folder) unretryable after the human fixes it.
	if (failed) return;
	writeJsonFile(marker, { importedAt: Date.now() });
	importedFor.add(workspace.id);
}

/**
 * The one-time, copy-only import of the legacy global records (token, browser sessions, recent
 * folders and defaults) into the XDG state home. Never overwrites an existing new file and never
 * removes the originals. Answers whether anything was copied, so the caller can reload what it
 * loaded before the copy. No-op for an explicit state root.
 *
 * The pass is recorded in `legacy-import.json` in the new state home, once nothing has failed: the token
 * lives in `daemon.json`, and without that record a human who reset the token by deleting the new file
 * would have the old one copied back from the legacy home at the next start. A marker that cannot be
 * written is no marker, so the next start retries; every copy already made is then skipped as present.
 */
export function migrateLegacyGlobalState(): boolean {
	if (HAS_EXPLICIT_STATE) return false;
	if (resolve(STATE_DIR) === resolve(LEGACY_STATE_DIR)) return false;
	if (!existsSync(LEGACY_STATE_DIR)) return false;
	safeGlobalDir();
	if (existsSync(GLOBAL_IMPORT_MARKER)) return false;
	let copied = false;
	let failed = false;
	for (const name of ["daemon.json", "workspaces.json", "sessions.json"]) {
		const outcome = copyNoOverwrite(join(LEGACY_STATE_DIR, name), join(STATE_DIR, name));
		copied = outcome === "copied" || copied;
		failed = outcome === "failed" || failed;
	}
	if (failed) return copied;
	writeJsonFile(GLOBAL_IMPORT_MARKER, { importedAt: Date.now() });
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
