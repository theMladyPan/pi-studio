// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The crossroads: the workspaces that exist, the defaults a new one starts with, and the folder and file
 * pickers.
 */
import { answer, fail, readJson } from "../http.ts";
import { CONTROL_CHARS, MAX_EDITOR_CHARS } from "../limits.ts";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { activeHomeDefaults, describeWorkspace, homeDefaults, rememberWorkspace, setHomeDefaults } from "../workspaces.ts";
import { boardFor } from "../store.ts";
import { nudgeWelcome } from "../bus.ts";
import { cardFor } from "../cards.ts";
import { BUILTIN_TOOLS, CHILD_EXTENSIONS, THINKING_LEVELS, modelCatalog } from "../models.ts";
import { CARD_AUDIENCE, CARD_LEVELS, CARD_SHOWS, CARD_VERBOSITY } from "../card-settings.ts";
import { CHILD_INTEGRATION } from "../integration.ts";
import { PATH_NAMES } from "../child/modes.ts";
import { settingsDocument } from "../settings-document.ts";
import { spawn } from "node:child_process";



// ---------- routes: the crossroads -----------------------------------------

export async function onOpenWorkspace(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	let folder = typeof body.folder === "string" ? body.folder.trim() : "";
	if (folder.startsWith("~/")) folder = join(homedir(), folder.slice(2));
	if (!folder) return void fail(res, 400, "a folder is required");
	const absolute = resolve(folder);
	if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
		// A typo fails here rather than creating a tree somewhere the human did not look.
		return void fail(res, 404, `no such folder: ${absolute}`);
	}
	const workspace = rememberWorkspace(absolute);
	const board = boardFor(workspace);
	nudgeWelcome();
	answer(res, 200, { workspace: describeWorkspace(workspace), board: { id: board.id }, cards: [...board.threads.values()].map(cardFor) });
}



/**
 * The crossroads' defaults. A model has to exist on this machine, because a default that cannot run is
 * a board that cannot start a thread.
 */
export async function onDefaults(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	const next = { ...homeDefaults };
	if (typeof body.dimOthers === "boolean") next.dimOthers = body.dimOthers;
	if (typeof body.thinking === "string") {
		if (!THINKING_LEVELS.includes(body.thinking)) return void fail(res, 400, `a level is one of ${THINKING_LEVELS.join(", ")}`);
		next.thinking = body.thinking;
	}
	// The six card settings a new board is born with, checked the way the board's own route checks them:
	// an id no list names is a mistake, not a preference.
	if (body.cardsVerbosity !== undefined) {
		if (!CARD_VERBOSITY.includes(body.cardsVerbosity))
			return void fail(res, 400, `a verbosity is one of ${CARD_VERBOSITY.join(", ")}`);
		next.cardsVerbosity = body.cardsVerbosity;
	}
	if (body.cardsAudience !== undefined) {
		if (!CARD_AUDIENCE.includes(body.cardsAudience)) return void fail(res, 400, `an audience is one of ${CARD_AUDIENCE.join(", ")}`);
		next.cardsAudience = body.cardsAudience;
	}
	for (const key of CARD_SHOWS) {
		if (body[key] === undefined) continue;
		if (!CARD_LEVELS.includes(body[key])) return void fail(res, 400, `${key} is one of ${CARD_LEVELS.join(", ")}`);
		next[key] = body[key];
	}
	// The built-in tools a new board's threads are not given, by the names pi itself uses. A name this pi
	// does not have is dropped rather than refused, exactly as the board's own `/config` drops it.
	if (body.toolsOff !== undefined) {
		if (!Array.isArray(body.toolsOff)) return void fail(res, 400, "toolsOff must be a list of tool names");
		next.toolsOff = body.toolsOff.filter((name) => BUILTIN_TOOLS.includes(name));
	}
	// The extensions a new board's threads do not load, by folder name. An unknown name is a mistake in the
	// request, so it is refused instead of quietly accepted as a no-op.
	if (body.extensionsOff !== undefined) {
		if (!Array.isArray(body.extensionsOff)) return void fail(res, 400, "extensionsOff must be a list of extension names");
		const known = new Set(CHILD_EXTENSIONS.map((one) => one.name));
		const unknown = body.extensionsOff.filter((name) => !known.has(name));
		if (unknown.length) return void fail(res, 400, `no such extension: ${unknown.join(", ")}`);
		next.extensionsOff = body.extensionsOff;
	}
	// The flow a new board's boss starts on.
	if (body.path !== undefined) {
		if (!PATH_NAMES.includes(body.path)) return void fail(res, 400, `a path is one of ${PATH_NAMES.join(", ")}`);
		next.path = body.path;
	}
	// How a new board brings a child's work back onto its own branch, checked the way its own route checks it.
	if (body.childIntegration !== undefined) {
		if (!CHILD_INTEGRATION.includes(body.childIntegration))
			return void fail(res, 400, `a child's work comes back by one of ${CHILD_INTEGRATION.join(", ")}`);
		next.childIntegration = body.childIntegration;
	}
	// The program a code card's file opens in: one program found on PATH or the path to the binary, spawned
	// as `editor file`. An argument list in the value is the mistake this refuses, because `code --wait`
	// would be spawned as a file of that name; a path may hold a space only where it is a file that exists,
	// which is what the file dialog hands back. Empty clears it.
	if (body.editor !== undefined) {
		if (typeof body.editor !== "string") return void fail(res, 400, "an editor is a program name or the path to one");
		const editor = body.editor.trim();
		if (CONTROL_CHARS.test(editor)) return void fail(res, 400, "an editor is a program name or the path to one");
		if (editor.length > MAX_EDITOR_CHARS) return void fail(res, 400, `an editor is at most ${MAX_EDITOR_CHARS} characters`);
		if (/\s/.test(editor) && !(editor.includes("/") && existsSync(editor)))
			return void fail(res, 400, "an editor is one program, not a command line with arguments");
		next.editor = editor;
	}
	if (typeof body.provider === "string" && typeof body.model === "string") {
		const { models } = await modelCatalog();
		if (!models.some((one) => one.provider === body.provider && one.model === body.model)) {
			return void fail(res, 409, "this machine cannot run that model");
		}
		next.provider = body.provider;
		next.model = body.model;
	}
	setHomeDefaults(next);
	answer(res, 200, { defaults: activeHomeDefaults() });
}



/**
 * The crossroads' settings as one document: the same values as GET /defaults, as the tree a page draws.
 * A board keeps its own copy from the moment it is opened, which is what the foot says.
 */
export async function onSettingsDefaults(res) {
	answer(
		res,
		200,
		settingsDocument({
			scope: "defaults",
			values: activeHomeDefaults(),
			title: "every new board",
			subtitle: "what every board is born with",
			foot: "a board keeps its own copy from the moment it is opened",
		}),
	);
}



/**
 * One answer per dialog. A program that is not installed answers on `error` and then again on `close` with a
 * non-zero code, and a second `writeHead` on an ended response throws `ERR_HTTP_HEADERS_SENT`, which nothing
 * catches: one press would take the daemon, and every board and child with it, down.
 */
function answeredOnce(res) {
	let answered = false;
	return (say) => {
		if (answered) return;
		answered = true;
		say();
	};
}



/** A real folder dialog, because a browser cannot be told an absolute path any other way. */
export function onPickFolder(res) {
	let child;
	try {
		child = spawn("zenity", ["--file-selection", "--directory", "--title=Open a workspace"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return void fail(res, 501, "no folder dialog on this machine");
	}
	const once = answeredOnce(res);
	let out = "";
	child.stdout.on("data", (chunk) => {
		out += String(chunk);
	});
	child.on("error", () => once(() => fail(res, 501, "no folder dialog on this machine")));
	child.on("close", (code) => {
		const folder = out.trim().split("\n")[0];
		// Cancelling a dialog is a decision, not a failure.
		if (code !== 0 || !folder) return once(() => answer(res, 200, { cancelled: true }));
		once(() => answer(res, 200, { folder }));
	});
}



/** The same dialog, opened on a file: the path to a program is the one thing a human cannot type twice. */
export function onPickFile(res) {
	let child;
	try {
		child = spawn("zenity", ["--file-selection", "--title=Choose a text editor"], { stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return void fail(res, 501, "no file dialog on this machine");
	}
	const once = answeredOnce(res);
	let out = "";
	child.stdout.on("data", (chunk) => {
		out += String(chunk);
	});
	child.on("error", () => once(() => fail(res, 501, "no file dialog on this machine")));
	child.on("close", (code) => {
		const file = out.trim().split("\n")[0];
		// Cancelling a dialog is a decision, not a failure.
		if (code !== 0 || !file) return once(() => answer(res, 200, { cancelled: true }));
		once(() => answer(res, 200, { file }));
	});
}
