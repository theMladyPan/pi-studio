// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The crossroads: the workspaces that exist, the defaults a new one starts with, and the folder picker.
 */
import { answer, fail, readJson } from "../http.ts";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { activeHomeDefaults, describeWorkspace, homeDefaults, rememberWorkspace, setHomeDefaults } from "../workspaces.ts";
import { boardFor } from "../store.ts";
import { nudgeWelcome } from "../bus.ts";
import { cardFor } from "../cards.ts";
import { THINKING_LEVELS, modelCatalog } from "../models.ts";
import { CARD_AUDIENCE, CARD_LEVELS, CARD_SHOWS, CARD_VERBOSITY } from "../card-settings.ts";
import { CHILD_INTEGRATION } from "../integration.ts";
import { settingsDocument } from "../settings.ts";
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
	// How a new board brings a child's work back onto its own branch, checked the way its own route checks it.
	if (body.childIntegration !== undefined) {
		if (!CHILD_INTEGRATION.includes(body.childIntegration))
			return void fail(res, 400, `a child's work comes back by one of ${CHILD_INTEGRATION.join(", ")}`);
		next.childIntegration = body.childIntegration;
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
 * The settings page's whole content: the same defaults as GET /defaults, with this machine's catalogue
 * and pi's levels filled in, so the page needs no second request to draw a picker.
 */
export async function onSettingsDefaults(res) {
	answer(res, 200, await settingsDocument());
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
	let out = "";
	child.stdout.on("data", (chunk) => {
		out += String(chunk);
	});
	child.on("error", () => fail(res, 501, "no folder dialog on this machine"));
	child.on("close", (code) => {
		const folder = out.trim().split("\n")[0];
		// Cancelling a dialog is a decision, not a failure.
		if (code !== 0 || !folder) return void answer(res, 200, { cancelled: true });
		answer(res, 200, { folder });
	});
}
