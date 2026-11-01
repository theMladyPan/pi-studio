/**
 * This board's settings as one document: the tree the panel draws, the value each control holds, and
 * the one route a change goes back through.
 *
 * It is a tree rather than a list because a board's settings are not one kind of thing: the thread a
 * new child starts as, the tools it may touch, what a card may carry, the canvas, and the prompt files
 * a run reads. Nothing is stored here. `board.config` is where a choice lives and `activeConfig` is the
 * view of it every other reader already uses, so this is a document about that view.
 *
 * The types are this file's own. `settings.ts` draws the crossroads' defaults, which are a different
 * document with a different route; one shape for both would tie two pages to neither's needs.
 */
import { activeConfig } from "./workspaces.ts";
import { CARD_AUDIENCE, CARD_LEVELS, CARD_VERBOSITY } from "./card-settings.ts";
import { PATH_NAMES, PROMPT_FOLDERS, promptFiles } from "./child/modes.ts";
import { THINKING_LEVELS } from "./models.ts";

/**
 * The picker a leaf opens. A `select` says a value is one of a list, not what the list means; the panel
 * needs the name of the picker to open the right one, and the set of them is closed here.
 */
export type BoardPick = "model" | "thinking" | "path" | "tools" | "verbosity" | "audience" | "code" | "math" | "charts" | "refs";

/**
 * One control the panel draws. `type` is how it is painted and `pick` is the list behind it, if any.
 *
 * `write` is how a change goes back: the route, and a body written as a template. `@value` is the
 * control's value, `@head` and `@rest` are the two halves of `value.split(split)` taken at the first
 * occurrence only (`klotilda/deepseek-ai/…` is a provider and a model, and the model keeps its slash),
 * and anything else in the body is a literal. One client function can send every leaf because of that.
 */
export type BoardField = {
	id: string;
	label: string;
	type: "combo" | "select" | "toggle" | "list" | "prompt";
	value: string | boolean | string[];
	pick?: BoardPick;
	/** The ids a picker offers, where the daemon already knows them. */
	options?: string[];
	/** A route the picker reads its rows from instead: the model catalogue, this machine's tools. */
	source?: string;
	/** The character a composite value such as `provider/model` is split at, once, for `write.body`. */
	split?: string;
	/** The prompt file a `prompt` leaf edits, as `${folder}/${name}` relative to `prompts/`. A prompt is
	 * written by the prompt editor rather than by a body template, so such a leaf carries no `write`. */
	file?: string;
	help?: string;
	write?: { route: string; method?: "POST"; body: Record<string, string> };
};

/** A fold in the tree: fields, groups, or both, to any depth. */
export type BoardGroup = {
	id: string;
	label: string;
	/** Drawn unfolded the first time the panel opens. */
	open?: boolean;
	help?: string;
	fields?: BoardField[];
	groups?: BoardGroup[];
};

export type BoardSettingsDocument = {
	version: number;
	title: string;
	/** Where this board is: its name and the folder behind it. */
	subtitle: string;
	/** The one sentence under the panel about when a change lands. */
	foot: string;
	groups: BoardGroup[];
};

/** What this document reads from a board: the facts in its subtitle, and the choices in its tree. */
export type BoardSettingsSource = { name: string; folder: string; config?: unknown };

/** The fields `activeConfig` answers with, named here so the leaves below are checked against them. */
type BoardConfig = {
	provider: string;
	model: string;
	thinking?: string;
	path: string;
	dimOthers: boolean;
	toolsOff: string[];
	extensionsOff: string[];
	cardsVerbosity: string;
	cardsAudience: string;
	showCodeFragments: string;
	showMathFormulas: string;
	showCharts: string;
	showReferences: string;
};

/**
 * The four content switches of a card: the board's key, what a human calls it, and its picker.
 *
 * Each `id` stays the key it names rather than widening to every key of `BoardConfig`, because these
 * four are the ones `activeConfig` always answers with a level: `cardSettings` fills them in from
 * `CARD_DEFAULTS` where the board's file names none, so a leaf here always carries a defined value.
 */
const CARD_CONTENT = [
	{ id: "showCodeFragments", label: "code", pick: "code" },
	{ id: "showMathFormulas", label: "math", pick: "math" },
	{ id: "showCharts", label: "charts", pick: "charts" },
	{ id: "showReferences", label: "references", pick: "refs" },
] as const satisfies readonly { id: keyof BoardConfig & string; label: string; pick: BoardPick }[];

/**
 * The prompt files, one subgroup per folder and one leaf per file. Read per call, because a prompt a
 * human added is a prompt the panel has to offer; the file's first line is the help, so a leaf says
 * what it is without the editor being opened.
 */
function promptGroups(): BoardGroup[] {
	const files = promptFiles();
	return PROMPT_FOLDERS.map((folder) => ({
		id: folder,
		label: folder,
		fields: files
			.filter((one) => one.folder === folder)
			.map((one) => ({
				id: `prompt-${folder}-${one.file.replace(/\.md$/, "")}`,
				label: one.file,
				type: "prompt" as const,
				value: "",
				file: `${folder}/${one.file}`,
				help: one.firstLine,
			})),
	}));
}

/** This board's settings as the panel draws them. */
export function boardSettingsDocument(board: BoardSettingsSource): BoardSettingsDocument {
	const config = activeConfig(board) as BoardConfig;
	return {
		version: 1,
		title: "this board",
		subtitle: `${board.name} · ${board.folder}`,
		foot: "new threads only · a run in flight is untouched",
		groups: [
			{
				id: "thread",
				label: "thread",
				open: true,
				help: "the argv a new child starts with",
				fields: [
					{
						id: "model",
						label: "model",
						type: "combo",
						pick: "model",
						source: "/models",
						split: "/",
						value: `${config.provider}/${config.model}`,
						write: { route: "/model", body: { provider: "@head", model: "@rest" } },
					},
					{
						id: "thinking",
						label: "thinking",
						type: "select",
						pick: "thinking",
						options: THINKING_LEVELS,
						// No level is stored until one is chosen, and that is pi's own default, which reads as off.
						value: config.thinking ?? "off",
						write: { route: "/thinking", body: { level: "@value" } },
					},
					{
						id: "path",
						label: "boss flow",
						type: "select",
						pick: "path",
						options: PATH_NAMES,
						value: config.path ?? "auto",
						write: { route: "/config", body: { path: "@value" } },
					},
				],
			},
			{
				id: "tools",
				label: "tools",
				open: true,
				help: "what a new child may touch",
				fields: [
					{
						id: "toolsOff",
						label: "built-in",
						type: "list",
						pick: "tools",
						source: "/tools",
						value: config.toolsOff ?? [],
						write: { route: "/config", body: { toolsOff: "@value" } },
					},
					{
						id: "extensionsOff",
						label: "extensions",
						type: "list",
						pick: "tools",
						source: "/tools",
						value: config.extensionsOff ?? [],
						write: { route: "/config", body: { extensionsOff: "@value" } },
					},
				],
			},
			{
				id: "cards",
				label: "cards",
				open: false,
				help: "cardsBlock(config) → the prompt",
				fields: [
					{
						id: "cardsVerbosity",
						label: "how often",
						type: "select",
						pick: "verbosity",
						options: CARD_VERBOSITY,
						value: config.cardsVerbosity,
						write: { route: "/config", body: { cardsVerbosity: "@value" } },
					},
					{
						id: "cardsAudience",
						label: "written for",
						type: "select",
						pick: "audience",
						options: CARD_AUDIENCE,
						value: config.cardsAudience,
						write: { route: "/config", body: { cardsAudience: "@value" } },
					},
				],
				groups: [
					{
						id: "contents",
						label: "contents",
						open: false,
						help: "what may sit on a card",
						fields: CARD_CONTENT.map((one) => ({
							id: one.id,
							label: one.label,
							type: "select" as const,
							pick: one.pick,
							options: CARD_LEVELS,
							value: config[one.id],
							write: { route: "/config", body: { [one.id]: "@value" } },
						})),
					},
				],
			},
			{
				id: "canvas",
				label: "canvas",
				open: false,
				help: "painted by the browser",
				fields: [
					{
						id: "dimOthers",
						label: "dim others",
						type: "toggle",
						value: config.dimOthers !== false,
						write: { route: "/config", body: { dimOthers: "@value" } },
					},
				],
			},
			{
				id: "prompts",
				label: "prompts",
				open: false,
				help: "files read when a run starts",
				groups: promptGroups(),
			},
		],
	};
}
