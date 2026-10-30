/**
 * The settings page as a document: the template that sits beside this file, with this machine's model
 * catalogue and the values the daemon actually holds written into it.
 *
 * The page draws whatever groups and fields it is given, so a new setting is a line in the template and
 * nothing here. Nothing is stored here either: `workspaces.json#defaults` is the one place a choice
 * lives, and this is a view of it.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile } from "./paths.ts";
import { activeHomeDefaults } from "./workspaces.ts";
import { THINKING_LEVELS, modelCatalog, readScope, resolveScope } from "./models.ts";
import { PROMPT_FOLDERS, promptFiles } from "./child/modes.ts";

/**
 * One control the page draws. `store` is the mapping a write back to POST /defaults needs when the
 * stored key is not the field's own id: `model` is two keys of the defaults written as `provider/model`.
 * `write` is the general form of it for a field that has a route of its own: where to send the value, by
 * which method, and under which keys, with `@value` standing for the control's value.
 */
export type SettingsField = {
	id: string;
	label: string;
	type: "combo" | "select" | "toggle" | "text" | "number" | "prompt";
	value: unknown;
	store?: { split?: string; keys: string[] };
	write?: { route: string; method?: string; keys?: Record<string, string> };
	source?: string;
	options?: string[];
	levels?: string[];
	help?: string;
	placeholder?: string;
	disabled?: boolean;
};

/** A fold in the tree: `groups`, `fields`, or both, to any depth. */
export type SettingsGroup = {
	id: string;
	label: string;
	help?: string;
	status?: string;
	collapsed?: boolean;
	groups?: SettingsGroup[];
	fields?: SettingsField[];
};

export type SettingsDocument = {
	version: number;
	title: string;
	help?: string;
	groups: SettingsGroup[];
};

/** Structure, labels, help and placeholder values. Every live list and every choice is filled in below. */
const TEMPLATE_FILE = join(dirname(fileURLToPath(import.meta.url)), "settings.defaults.json");
const template = readJsonFile<SettingsDocument | null>(TEMPLATE_FILE, null);

/** One row of the catalogue, as much of it as the picker needs. */
type CatalogModel = { provider: string; model: string };

/**
 * The models the combo offers: pi's own scope first, in the order pi wrote it, which is the order the
 * board's picker shows. A machine with no scope offers the whole catalogue in the order pi printed it.
 *
 * The model this daemon already holds is appended when the scope does not name it: `/scoped-models`
 * narrows the scope whenever a human edits it, and a picker that has forgotten the choice it is showing
 * cannot show it. A model this machine cannot run is never added, whatever the defaults say.
 */
function modelOptions(scoped: CatalogModel[], models: CatalogModel[], chosen: string) {
	const named = (scoped.length ? scoped : models).map((one) => `${one.provider}/${one.model}`);
	const options = [...new Set(named)];
	const runnable = models.some((one) => `${one.provider}/${one.model}` === chosen);
	if (runnable && chosen && !options.includes(chosen)) options.push(chosen);
	return options;
}

/** What a field stands for right now: the chosen default when there is one, else the template's own. */
function valueOf(field: SettingsField, values: Record<string, unknown>) {
	const keys = field.store?.keys;
	if (Array.isArray(keys)) {
		const parts = keys.map((key) => values[key]);
		// A default that is missing half of a stored pair is not a value: `undefined/model` is worse than
		// the placeholder the template already carries.
		if (parts.length && parts.every((one) => one !== undefined && one !== null && one !== "")) {
			return parts.join(field.store?.split ?? "/");
		}
		return field.value;
	}
	// `thinking` is absent from the defaults until somebody picks a level, and pi's own default stands
	// in for it until then.
	return Object.hasOwn(values, field.id) ? values[field.id] : field.value;
}

function hydrate(group: SettingsGroup, values: Record<string, unknown>, catalogue: { scoped: CatalogModel[]; models: CatalogModel[] }) {
	for (const field of group.fields ?? []) {
		field.value = valueOf(field, values);
		// A field whose `source` is a live list takes that list rather than a copy of one: a catalogue
		// written down in the template would be wrong the day a model is added. The value is read first,
		// because the picker keeps the model this daemon holds even when the scope no longer names it.
		if (field.source === "/models") field.options = modelOptions(catalogue.scoped, catalogue.models, String(field.value ?? ""));
		if (field.source === "/defaults#levels") field.levels = [...THINKING_LEVELS];
	}
	for (const child of group.groups ?? []) hydrate(child, values, catalogue);
}

/**
 * The prompts as one more top-level group: a sub-group per folder, a field per file, built from what is on
 * disk when the document is read. A file dropped into `prompts/roles/` is on the page with no code in
 * between, which is the point of reading the folders here rather than in the template.
 */
function promptGroups(): SettingsGroup {
	const files = promptFiles();
	return {
		id: "prompts",
		label: "Prompts",
		help: "The files in prompts/, whole. A thread reads one when it starts; a save here reaches the next thread, never one already running.",
		collapsed: true,
		groups: PROMPT_FOLDERS.map((folder) => ({
			id: `prompts-${folder}`,
			label: folder.charAt(0).toUpperCase() + folder.slice(1),
			fields: files
				.filter((one) => one.folder === folder)
				.map((one): SettingsField => ({
					id: `prompt-${folder}-${one.file.replace(/\.md$/, "")}`,
					label: one.file,
					type: "prompt",
					// The whole file, verbatim: the textarea has to show exactly what the daemon will read.
					value: one.text,
					help: one.firstLine,
					source: `/prompt?name=${encodeURIComponent(one.name)}`,
					// A prompt is a file, so it is written when a human presses save: `@value` is the textarea.
					write: { route: "/prompt", method: "POST", keys: { name: one.name, text: "@value" } },
				})),
		})),
	};
}

/**
 * The document the settings page renders. Read fresh on every call, because the catalogue is read by pi
 * and the values are written by the page itself; a cached copy would answer yesterday's choice.
 */
export async function settingsDocument(): Promise<SettingsDocument> {
	// A missing template is a broken install, and an empty page would say so in the least useful way.
	if (!template) throw new Error(`pi-studio: no readable settings template at ${TEMPLATE_FILE}`);
	// `modelCatalog` lives in a file that is not typed yet, so what it answers is named here rather than
	// read from its `null` initialiser.
	const { models } = (await modelCatalog()) as unknown as { models: CatalogModel[] };
	const catalogue = { scoped: resolveScope(readScope(), models).scoped, models };
	const values = activeHomeDefaults() as Record<string, unknown>;
	const document = structuredClone(template);
	for (const group of document.groups) hydrate(group, values, catalogue);
	// The prompts are not in the template: they are whatever is in `prompts/` right now.
	document.groups.push(promptGroups());
	return document;
}
