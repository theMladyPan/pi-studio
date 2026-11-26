// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * What this machine can run: pi's model catalogue, the scope patterns that narrow the picker, the four
 * built-in tools and the extensions installed beside them.
 */
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { extensionsDir, piCli } from "./child/argv.ts";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";



export const PROVIDER = process.env.PI_STUDIO_PROVIDER ?? "klotilda";


export const MODEL = process.env.PI_STUDIO_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017";


/**
 * The model that names a thread and drafts a commit message, and the default the settings page starts
 * from. `PI_STUDIO_NAME_MODEL=""` turns naming off until a model is chosen on the settings page, and the
 * choice there wins over this. `openrouter/inception/mercury-3:nitro` named this until OpenRouter withdrew
 * it; the flash model replaces it, asked with thinking off, which names in 1.2-1.5s.
 */
export const NAME_MODEL = process.env.PI_STUDIO_NAME_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash-1017";


// Pi names seven levels and clamps whatever is chosen to what the model offers.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];


/**
 * How long a good read is kept before pi is asked again. `pi --list-models` answers in well under a
 * second, so the cadence costs nothing and a healthy read keeps answering for ten minutes.
 */
export const CATALOG_TTL_MS = 10 * 60_000;


/**
 * How long a model stays in the answer after pi last named it, even when a read omits it. OpenRouter
 * retires models rarely, and a model a board has been spawning stays spawnable through reads that
 * lost it, so one bad read cannot refuse every spawn for six hours. Six hours of being unnamed is
 * the one way a model leaves the answer.
 */
export const CATALOG_MEMORY_MS = 6 * 60 * 60_000;


export const run = promisify(execFile);


/**
 * Read once from pi, kept for a while: the picker must work before any thread has a child.
 *
 * `trouble` is why the last read of pi's table came back useless, and it lives beside the models rather
 * than inside them: a read that failed says nothing about what this machine has, and the picker has to
 * be able to say so instead of showing a shorter list as if it were the truth.
 */
export let catalog = null;


export let catalogAt = 0;


/**
 * What pi has listed within the retention window, keyed `${provider}/${model}` to when it was last
 * seen. The catalogue is answered from this memory rather than from the latest read alone: a model a
 * board could spawn this morning stays spawnable for six hours even when a read omits it, so one read
 * that lost a model cannot refuse every spawn for it. A read that this memory distrusts (a failure, or
 * a table more than a fifth smaller) leaves `seenAt` alone, and a model that is not seen for six hours
 * leaves the answer, which is the one way it is ever dropped.
 */
export const catalogSeen = new Map();


/**
 * How long a failed read is trusted before pi is asked again. A whole memory window of a table that
 * came back short is what a single failed read would cost, and the human has no way to tell that from
 * a machine that lost its credentials.
 */
export const CATALOG_RETRY_MS = 30_000;


/** Scope patterns already reported on stderr, so a stale pattern is not shouted once per picker open. */
export const saidScopeProblems = new Set();



/**
 * The models this machine can actually run. `pi --list-models` prints a table for humans, so the
 * columns are split on the runs of spaces that separate them, and the trailing yes/no columns say
 * whether a model thinks and takes images.
 */
export async function modelCatalog() {
	if (catalog && Date.now() - catalogAt < (catalog.trouble ? CATALOG_RETRY_MS : CATALOG_TTL_MS)) return catalog;
	const cli = piCli();
	let table = "";
	let trouble = "";
	try {
		const result = await run(cli.command, [...cli.args, "--list-models"], { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 });
		table = String(result.stdout ?? "");
	} catch (error) {
		// A pi that exits badly has still printed part of its table, and that part is not the answer to
		// "what can this machine run": a table cut short loses whole providers, which reads as models that
		// disappeared and as scope patterns that match nothing. So the models already known are kept, and
		// the reason is carried to the picker instead of being spent on a shorter list.
		table = String(error.stdout ?? "");
		trouble = lastLine(String(error.stderr ?? "")) || `pi could not list its models (${error.code ?? (error.killed ? "took too long" : "no answer")})`;
	}
	const models = [];
	for (const line of table.split("\n").slice(1)) {
		const cells = line.trim().split(/\s{2,}/);
		if (cells.length < 3) continue;
		const [provider, model, context, maxOut, thinking, images] = cells;
		models.push({
			provider,
			model,
			context: context ?? "",
			maxOut: maxOut ?? "",
			thinking: thinking !== "no",
			images: images === "yes",
		});
	}
	// A table that came back clean but much smaller than the one already known is a short read, not a
	// smaller machine. Pi trims the list it prints to the shortlist the key may use, and a slow or
	// partial answer from OpenRouter shrinks the table while the process still exits cleanly — which
	// used to become the truth for the whole memory window and refuse spawns for models still there.
	// A read of more than a fifth smaller is distrusted the way a failed read is: the known models stay,
	// the reason reaches the picker, and pi is asked again after thirty seconds.
	if (!trouble && catalog && catalog.models.length > 0 && models.length * 5 < catalog.models.length * 4) {
		trouble = `pi listed ${models.length} models after ${catalog.models.length}, which reads as a short table, so the known list is kept`;
	}
	// A machine with no credentials still has a board, so an empty table is answered with the levels and
	// no models rather than with an error. The empty answer is kept too: otherwise every open of the
	// picker would spawn pi again. A failed — or distrusted — read is kept for a shorter while, so the
	// next open asks pi again rather than showing the same hole for the whole memory window.
	if (trouble && catalog) {
		// Refusal does not update what was seen, but the six-hour window still runs underneath: rows that
		// have gone unnamed since before the refusal age out here too, so a list that really did shrink
		// lands a little at a time until a read clears four fifths of what is left.
		catalog = { ...catalog, models: remembered(Date.now()), trouble };
		catalogAt = Date.now();
		return catalog;
	}
	// A read the memory can trust: what it names is seen now, and what it omits stays for the rest of
	// its six hours. A row spoken of again is spoken of from this read, and one that goes unspoken for
	// the whole window leaves the answer.
	const now = Date.now();
	for (const one of models) catalogSeen.set(`${one.provider}\u0000${one.model}`, { row: one, seenAt: now });
	catalog = { models: remembered(now), levels: THINKING_LEVELS, trouble };
	catalogAt = now;
	return catalog;
}


/** The rows pi has named within the memory window: every pair whose last naming is inside six hours. */
function remembered(now) {
	for (const [key, entry] of catalogSeen) {
		if (now - entry.seenAt > CATALOG_MEMORY_MS) catalogSeen.delete(key);
	}
	return [...catalogSeen.values()].map((entry) => entry.row);
}



/** The last line of what a program said, which is where a CLI puts the reason it stopped. */
function lastLine(text) {
	const lines = String(text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines[lines.length - 1]?.slice(0, 200) ?? "";
}



/**
 * Where pi keeps the settings that `/scoped-models` writes: the agent directory, which
 * `PI_CODING_AGENT_DIR` can move out of `~/.pi/agent`. Only that file is read. A project
 * `.pi/settings.json` can override `enabledModels` for one folder, and a board opened on such a
 * folder would then show a wider list than its children cycle.
 */
export function piSettingsFile() {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
}



/**
 * The models pi itself offers while cycling: `enabledModels` from the settings file, in the order it
 * was written. Read on every call rather than kept beside the catalogue, because the human edits this
 * in a console pi while the daemon runs and the picker has to show the edit without a restart. No
 * file, no key, or a file caught mid-write all mean no scope, which is every model, as before.
 */
export function readScope() {
	let held;
	try {
		held = JSON.parse(readFileSync(piSettingsFile(), "utf8"));
	} catch {
		return [];
	}
	const patterns = held?.enabledModels;
	if (!Array.isArray(patterns)) return [];
	return patterns.filter((one) => typeof one === "string" && one.trim()).map((one) => one.trim().slice(0, 120));
}



/** `*` and `?` mean what they mean to pi; every other character of a pattern is literal. */
export function patternToRegExp(pattern) {
	const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${body}$`, "i");
}



/**
 * The one model a partial pattern names, chosen the way pi chooses: an alias id beats a dated one, and
 * the later id beats the earlier, so `sonnet` means `claude-sonnet-4-5` rather than the snapshot with a
 * date on it. A catalogue order decides nothing.
 */
export function bestPartial(matches) {
	const aliases = matches.filter((one) => one.model.endsWith("-latest") || !/-\d{8}$/.test(one.model));
	return [...(aliases.length ? aliases : matches)].sort((left, right) => right.model.localeCompare(left.model))[0];
}



/**
 * Pi's scope patterns resolved against the catalogue the daemon already has, in the order pi wrote
 * them. Pi matches these with minimatch plus a fuzzy match on model names; the catalogue read from
 * `--list-models` carries names for no model, so the fuzzy half is the one thing this cannot do. A
 * pattern that matches nothing is reported rather than dropped: a scope quietly smaller than pi's is
 * a picker that hides models for no stated reason.
 */
export function resolveScope(patterns, models) {
	const scoped = [];
	const problems = [];
	const seen = new Set();
	const add = (one) => {
		const key = `${one.provider}\u0000${one.model}`;
		if (seen.has(key)) return;
		seen.add(key);
		scoped.push(one);
	};
	for (const pattern of patterns) {
		// `model:high` scopes a model at one thinking level in pi. The level is not this picker's business,
		// so it is cut away and the model is offered like any other.
		const cut = pattern.lastIndexOf(":");
		const base = cut > 0 && THINKING_LEVELS.includes(pattern.slice(cut + 1)) ? pattern.slice(0, cut) : pattern;
		const needle = base.toLowerCase();
		// `provider/id` is the whole pattern when that provider has the model: pi prefers the named provider
		// over the same id on another one, and so does this, or an OpenRouter row spelled `google/x` would
		// ride along with the Google one.
		const exact = models.filter((one) => `${one.provider}/${one.model}`.toLowerCase() === needle);
		if (exact.length) {
			for (const one of exact) add(one);
			continue;
		}
		// A bare id resolves on every provider that offers it, which is what pi does when a pattern is
		// ambiguous between providers.
		const bare = models.filter((one) => one.model.toLowerCase() === needle);
		if (bare.length) {
			for (const one of bare) add(one);
			continue;
		}
		if (/[*?[]/.test(base)) {
			const glob = patternToRegExp(base);
			const matched = models.filter((one) => glob.test(`${one.provider}/${one.model}`) || glob.test(one.model));
			if (!matched.length) problems.push(pattern);
			for (const one of matched) add(one);
			continue;
		}
		// What is left is a piece of an id. Pi answers that with one model, not with every model the piece
		// appears in, so a scope cannot widen unnoticed by a pattern meant to name a single model.
		const partial = models.filter((one) => one.model.toLowerCase().includes(needle));
		if (!partial.length) {
			problems.push(pattern);
			continue;
		}
		const best = bestPartial(partial);
		// The same id on several providers is the one tie pi keeps.
		for (const one of partial.filter((candidate) => candidate.model === best.model)) add(one);
	}
	return { scoped, problems };
}



/**
 * A board's configuration: what a new thread starts with, and which behaviours are on. Kept per board
 * because two workspaces want different models, and because a feature like dimming is a taste about
 * one workspace's canvas, not a global setting.
 * @typedef {object} BoardConfig
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [thinking]
 * @property {boolean} [dimOthers] dim the cards of every other thread while one is selected
 */

/**
 * pi's own default tool selection, which is what a thread starts with. The board may leave some of
 * them out of a new thread, and names them with the very names pi uses.
 */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write"];


/**
 * Left to itself a thread has the same tools as a pi started in a terminal: the built-in four plus
 * whatever is installed here. `PI_STUDIO_TOOLS` narrows that to a named allowlist instead.
 */
export const TOOLS = process.env.PI_STUDIO_TOOLS ?? "";


/**
 * Extensions a thread may load: everything installed on this machine, less the two that cannot come
 * along at all.
 *
 *   dashboard        it is the old board, it registers the same tool names as the bridge, and it
 *                    would open a board server and rewrite its state file once per running thread
 *   ytrack           it answers through a 2FA gateway, which is a console pi with a human at the
 *                    keyboard, not a thread working on its own
 *
 * `browser-screenshot` used to be left out with them and is now loaded. It runs a headless chromium
 * on a throwaway profile in a temp folder, not the human's own browser, so a thread may drive a page
 * and read the picture the tool writes. Anything else a board does not want in a thread is the
 * panel's business: the two lists there subtract extensions and built-in tools per board, by the
 * names pi itself uses.
 *
 * `-ne` keeps discovery off so the list is this one, plainly; `-e` still loads what it names.
 * `PI_STUDIO_CHILD_EXCLUDE` changes the exclusions, `PI_STUDIO_CHILD_EXTENSIONS` names an exact list.
 */
export const CHILD_EXCLUDE = new Set(
	(process.env.PI_STUDIO_CHILD_EXCLUDE ?? "dashboard,ytrack")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean),
);



/**
 * A test script in the extensions folder is not an extension: it exports no factory, so pi refuses to
 * load it and the thread dies before it can answer. Shipped extensions are never named like this.
 */
export function isTestFile(name) {
	return /^test[-.]/.test(name) || /\.test\./.test(name) || /\.spec\./.test(name);
}



/**
 * Every extension this machine has installed, minus the exclusions above, as a name the panel can
 * show and the path pi loads. The name is the folder, or the file without its extension.
 */
export function installedExtensions() {
	const named = process.env.PI_STUDIO_CHILD_EXTENSIONS;
	if (named) {
		return named
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean)
			.map((name) => ({
				name: basename(name).replace(/\.(ts|mts|js|mjs)$/, "") || name,
				path: name.includes("/") ? name : join(extensionsDir(), name, "index.ts"),
			}))
			.filter((one) => existsSync(one.path));
	}
	const dir = extensionsDir();
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found = [];
	for (const entry of entries) {
		const bare = entry.name.replace(/\.(ts|mts|js|mjs)$/, "");
		if (entry.name.startsWith(".") || CHILD_EXCLUDE.has(entry.name) || CHILD_EXCLUDE.has(bare)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			const entryPoint = ["index.ts", "index.js", "index.mjs"]
				.map((name) => join(full, name))
				.find((path) => existsSync(path));
			if (entryPoint) found.push({ name: entry.name, path: entryPoint });
		} else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !isTestFile(entry.name)) {
			found.push({ name: bare, path: full });
		}
	}
	return found;
}



export const CHILD_EXTENSIONS = installedExtensions();
