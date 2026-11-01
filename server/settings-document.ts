/**
 * One settings document in two scopes: the tree a settings page draws, the value each control holds, and
 * the one route a change goes back through.
 *
 * There used to be a document per page — the crossroads' defaults in `settings.defaults.json` with a
 * builder beside it, and this board's in `board-settings.ts` — and the two drifted apart, because the
 * page a human edits is the same page twice: the argv a new thread starts with, the tools it may touch,
 * what a card may carry, the canvas, and the prompt files a run reads. So the tree is built once, and a
 * scope says only where a leaf's value comes from and which route it goes back to.
 *
 * Nothing is stored here. `workspaces.json#defaults` holds the crossroads' choices and `board.config`
 * holds a board's, so this is a view of whichever object the caller hands in as `values`.
 */
import { CARD_AUDIENCE, CARD_DEFAULTS, CARD_LEVELS, CARD_VERBOSITY } from "./card-settings.ts";
import { PATH_NAMES, PROMPT_FOLDERS, promptFiles } from "./child/modes.ts";
import { CHILD_INTEGRATION, INTEGRATION_DEFAULT } from "./integration.ts";
import { THINKING_LEVELS } from "./models.ts";

/**
 * The picker a leaf opens. A `select` says a value is one of a list, not what the list means, so the panel
 * needs the name of the picker to open the right one, and the set of them is closed here. `options` is for
 * a control whose rows arrive with the document; a leaf that names a `source` reads them from that route.
 */
export type SettingsPick =
	| "model"
	| "thinking"
	| "path"
	| "tools"
	| "verbosity"
	| "audience"
	| "code"
	| "math"
	| "charts"
	| "refs"
	| "childIntegration"
	| "options";

/**
 * One control the panel draws. `value` is a string, a switch, the names a list has off, or `""` for a
 * prompt, which is a file rather than a value.
 *
 * `write` is how a change goes back: the route, and a body written as a template. `@value` is the
 * control's value, `@head` and `@rest` are the two halves of `String(value).split(split)` taken at the
 * first occurrence only (`klotilda/deepseek-ai/…` is a provider and a model, and the model keeps its
 * slash), and any other string in the body is a literal. One client function sends every leaf because of
 * that.
 */
export type SettingsField = {
	id: string;
	label: string;
	type: "combo" | "select" | "toggle" | "list" | "prompt";
	value: string | boolean | string[];
	pick?: SettingsPick;
	/** The ids a picker offers, where the daemon already knows them. */
	options?: string[];
	/** A route the field reads from instead: the model catalogue, this machine's tools, a prompt's file. */
	source?: string;
	/**
	 * Which of the route's lists a `list` leaf keeps names out of. `/tools` answers pi's own tools and the
	 * installed extension folders side by side, so a leaf has to say which of the two it is; without it the
	 * client would have to read the key its `write.body` fills and guess.
	 */
	from?: "builtin" | "extensions";
	/** The character a composite value such as `provider/model` is split at, once, for `write.body`. */
	split?: string;
	/** The prompt file a `prompt` leaf edits, as `${folder}/${name}` relative to `prompts/`. */
	file?: string;
	help?: string;
	placeholder?: string;
	write?: { route: string; method?: "POST"; body: Record<string, string> };
};

/** A fold in the tree: fields, groups, or both, to any depth. */
export type SettingsGroup = {
	id: string;
	label: string;
	/** Drawn unfolded the first time the panel opens. */
	open?: boolean;
	help?: string;
	fields?: SettingsField[];
	groups?: SettingsGroup[];
};

/**
 * What a scope is: the defaults every new board is born with, or the settings of one board. The two
 * documents answer with the same version, so a page never has to guess which shape it was given.
 */
export type SettingsDocument = {
	version: number;
	scope: "defaults" | "board";
	title: string;
	/** One line saying which document this is: the folder behind a board, or what a default is for. */
	subtitle: string;
	/** The one sentence under the panel about when a change lands. */
	foot: string;
	groups: SettingsGroup[];
};

/**
 * The leaves' current values, as both scopes already hold them: `activeHomeDefaults()` for the crossroads
 * and `activeConfig(board)` for a board. Every key is optional, because a control with nothing in it is a
 * control that lies; where a scope leaves one out, the builder names the default.
 */
type SettingsValues = Partial<{
	provider: string;
	model: string;
	thinking: string;
	path: string;
	childIntegration: string;
	dimOthers: boolean;
	toolsOff: string[];
	extensionsOff: string[];
	cardsVerbosity: string;
	cardsAudience: string;
	showCodeFragments: string;
	showMathFormulas: string;
	showCharts: string;
	showReferences: string;
}>;

/** What a caller knows and the document has to say: which scope, which values, and the three lines. */
type SettingsInput = {
	scope: "defaults" | "board";
	values: SettingsValues;
	title: string;
	subtitle: string;
	foot: string;
};

/**
 * The four content switches of a card: the board's key, what a human calls it, and its picker.
 *
 * Each `id` stays the key it names rather than widening to every key of `SettingsValues`, because these
 * four are the ones both scopes always answer with a level, and `CARD_DEFAULTS` names what stands in
 * where one is missing, so a leaf here always carries a defined value.
 */
const CARD_CONTENT = [
	{ id: "showCodeFragments", label: "code", pick: "code" },
	{ id: "showMathFormulas", label: "math", pick: "math" },
	{ id: "showCharts", label: "charts", pick: "charts" },
	{ id: "showReferences", label: "references", pick: "refs" },
] as const satisfies readonly { id: keyof SettingsValues & string; label: string; pick: SettingsPick }[];

/**
 * Where a change goes back. This and the route names it reads are the whole difference between the
 * scopes: the crossroads answers every leaf on `/defaults`, while a board keeps `/model` and `/thinking`
 * for the two choices a live child can be told about, and sends the rest to `/config`.
 */
function routeFor(scope: SettingsInput["scope"], id: string): string {
	if (scope === "defaults") return "/defaults";
	if (id === "model") return "/model";
	if (id === "thinking") return "/thinking";
	return "/config";
}

/**
 * The body a leaf sends, keyed the way the route it goes to reads it. The thinking leaf is the one place
 * a key follows the route rather than the setting: a board's `/thinking` reads `level`, and `/defaults`
 * reads `thinking`.
 */
function writeFor(scope: SettingsInput["scope"], id: string): { route: string; body: Record<string, string> } {
	const route = routeFor(scope, id);
	if (id === "model") return { route, body: { provider: "@head", model: "@rest" } };
	if (id === "thinking") return { route, body: scope === "board" ? { level: "@value" } : { thinking: "@value" } };
	return { route, body: { [id]: "@value" } };
}

/**
 * The prompt files, one subgroup per folder and one leaf per file. Read per call, because a prompt a
 * human added is a prompt the panel has to offer; the file's first line is the help, so a leaf says what
 * it is without the editor being opened.
 */
function promptGroups(): SettingsGroup[] {
	const files = promptFiles();
	return PROMPT_FOLDERS.map((folder) => ({
		id: folder,
		label: folder,
		fields: files
			.filter((one) => one.folder === folder)
			.map((one): SettingsField => {
				const file = `${folder}/${one.file}`;
				return {
					id: `prompt-${folder}-${one.file.replace(/\.md$/, "")}`,
					label: one.file,
					type: "prompt",
					// A prompt is a file rather than a value: the page reads it from `/prompt` and writes it back.
					value: "",
					file,
					source: `/prompt?name=${encodeURIComponent(file)}`,
					help: one.firstLine,
					write: { route: "/prompt", body: { name: file, text: "@value" } },
				};
			}),
	}));
}

/**
 * The document a settings page renders, for the scope it was asked about. Read fresh on every call,
 * because the prompt leaves are whatever is in `prompts/` right now and the values are the object the
 * caller just read; a cached copy would answer yesterday's tree.
 */
export function settingsDocument({ scope, values, title, subtitle, foot }: SettingsInput): SettingsDocument {
	const write = (id: string) => writeFor(scope, id);
	return {
		version: 1,
		scope,
		title,
		subtitle,
		foot,
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
						value: `${values.provider ?? ""}/${values.model ?? ""}`,
						write: write("model"),
					},
					{
						id: "thinking",
						label: "thinking",
						type: "select",
						pick: "thinking",
						options: THINKING_LEVELS,
						// No level is stored until one is chosen, and that is pi's own default, which reads as off.
						value: values.thinking ?? "off",
						write: write("thinking"),
					},
					{
						id: "path",
						label: "boss flow",
						type: "select",
						pick: "path",
						options: PATH_NAMES,
						value: values.path ?? "auto",
						write: write("path"),
					},
					{
						id: "childIntegration",
						label: "a child's work comes back by",
						type: "select",
						pick: "childIntegration",
						options: [...CHILD_INTEGRATION],
						value: values.childIntegration ?? INTEGRATION_DEFAULT,
						write: write("childIntegration"),
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
						from: "builtin",
						value: values.toolsOff ?? [],
						write: write("toolsOff"),
					},
					{
						id: "extensionsOff",
						label: "extensions",
						type: "list",
						pick: "tools",
						source: "/tools",
						from: "extensions",
						value: values.extensionsOff ?? [],
						write: write("extensionsOff"),
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
						value: values.cardsVerbosity ?? CARD_DEFAULTS.cardsVerbosity,
						write: write("cardsVerbosity"),
					},
					{
						id: "cardsAudience",
						label: "written for",
						type: "select",
						pick: "audience",
						options: CARD_AUDIENCE,
						value: values.cardsAudience ?? CARD_DEFAULTS.cardsAudience,
						write: write("cardsAudience"),
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
							value: values[one.id] ?? CARD_DEFAULTS[one.id],
							write: write(one.id),
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
						value: values.dimOthers !== false,
						write: write("dimOthers"),
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
