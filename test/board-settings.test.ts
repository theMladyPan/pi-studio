import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { boardSettingsValues, settingsDocument } from "../server/settings-document.ts";
import { PATH_NAMES, PROMPT_FOLDERS } from "../server/child/modes.ts";
import { CARD_AUDIENCE, CARD_LEVELS, CARD_VERBOSITY } from "../server/card-settings.ts";
import { CHILD_INTEGRATION } from "../server/integration.ts";
import { NAME_MODEL, THINKING_LEVELS } from "../server/models.ts";

/**
 * The board's settings document is a view of what `activeConfig(board)` answers, so it is read here from
 * that shape of object: no daemon, no state folder, no child, and nothing read off the disk — the two
 * prompt leaves a board offers are named rather than listed, because a workspace carries two files and
 * not a folder of them.
 */

/** The model this board answers with: the id holds a slash of its own, which is what `split` is about. */
const CHOSEN = { provider: "klotilda", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" };

/** What `activeConfig` says about a board somebody has set up already, with the rest at their defaults. */
const config = {
	...CHOSEN,
	thinking: "high",
	path: "simple",
	childIntegration: "merge",
	dimOthers: false,
	toolsOff: ["bash"],
	extensionsOff: [],
	// Two of the six card settings changed, so a default leaking into every leaf would show.
	cardsVerbosity: "verbose",
	cardsAudience: "programmer",
	showCodeFragments: "some",
	showMathFormulas: "some",
	showCharts: "many",
	showReferences: "some",
};

const document = settingsDocument({
	scope: "board",
	values: config,
	title: "Board specific settings",
	subtitle: "",
	foot: "new threads only · a run in flight is untouched",
});

/** Every leaf of the tree, at any depth, which is how the panel finds the controls it draws. */
function leavesOf(groups: any[]): any[] {
	const found: any[] = [];
	const walk = (group: any) => {
		for (const field of group.fields ?? []) found.push(field);
		for (const child of group.groups ?? []) walk(child);
	};
	for (const group of groups) walk(group);
	return found;
}

/** The leaves that are a setting, in tree order: what the prompts group holds is a file, not a value. */
const settingLeaves = leavesOf(document.groups.filter((group) => group.id !== "prompts"));

const byId = Object.fromEntries(leavesOf(document.groups).map((field) => [field.id, field]));

/**
 * The leaves a change goes back through. The overview map is the one with no route: it is a session's
 * choice in the browser, so the page answers for it rather than the board.
 */
const writtenLeaves = settingLeaves.filter((field) => field.id !== "overviewMap");

test("the document is five groups in the order the panel draws them", () => {
	assert.equal(document.version, 1);
	assert.equal(document.scope, "board");
	assert.equal(document.title, "Board specific settings");
	// No subtitle: the panel is headed "Board specific settings" and names no board or folder.
	assert.equal(document.subtitle, "");
	assert.equal(document.foot, "new threads only · a run in flight is untouched");
	assert.deepEqual(
		document.groups.map((group) => group.id),
		["thread", "tools", "cards", "canvas", "prompts"],
	);
	// Folded or not, and what the group is for, travels with it: the panel has no copy of these words.
	assert.deepEqual(
		document.groups.map((group) => [group.label, group.open, group.help]),
		[
			["thread", true, "the argv a new child starts with"],
			["tools", true, "what a new child may touch"],
			["cards", false, "cardsBlock(config) → the prompt"],
			["canvas", false, "painted by the browser"],
			["prompts", false, "the two files this workspace may carry"],
		],
	);
	const contents = document.groups.find((group) => group.id === "cards")?.groups ?? [];
	assert.deepEqual(
		contents.map((group) => [group.id, group.label, group.open, group.help]),
		[["contents", "contents", false, "what may sit on a card"]],
	);
});

test("the tree holds sixteen setting leaves and each one is a control a human can change", () => {
	// Sixteen: six for the thread, two for the tools, six for the cards, two for the canvas.
	assert.deepEqual(
		settingLeaves.map((field) => field.id),
		[
			"model",
			"helperModel",
			"thinking",
			"editor",
			"path",
			"childIntegration",
			"toolsOff",
			"extensionsOff",
			"cardsVerbosity",
			"cardsAudience",
			"showCodeFragments",
			"showMathFormulas",
			"showCharts",
			"showReferences",
			"dimOthers",
			"overviewMap",
		],
	);
	assert.equal(settingLeaves.length, 16);
	assert.deepEqual(
		settingLeaves.map((field) => field.type),
		["combo", "combo", "select", "combo", "select", "select", "list", "list", "select", "select", "select", "select", "select", "select", "toggle", "toggle"],
	);
	// A setting a later build dropped is not quietly back, and neither is a group nobody draws.
	const whole = JSON.stringify(document);
	for (const gone of ["timeoutSeconds", "per-board-overrides"]) assert.ok(!whole.includes(gone), `${gone} is back`);
});

test("every setting names its picker and the route a change goes back through", () => {
	// The overview map is the one leaf with no route, because the map is a session's choice in the browser
	// rather than a value a board keeps: the page answers for it. Every other leaf says where it writes.
	assert.equal(writtenLeaves.length, settingLeaves.length - 1);
	assert.equal(byId.overviewMap.write, undefined);
	for (const field of writtenLeaves) {
		assert.ok(field.write, `${field.id} has no write`);
		// The editor is studio-wide, so a board's page writes it to the crossroads' defaults with the rest.
		assert.ok(["/model", "/thinking", "/defaults", "/config"].includes(field.write.route), `${field.id} writes to ${field.write.route}`);
		// A toggle is flipped where it stands, so it names no picker; everything else opens a list, except
		// the editor, which is typed and filled in from the machine's own file dialog (`browse`).
		if (field.type === "toggle" || field.browse) continue;
		assert.ok(
			["model", "thinking", "path", "childIntegration", "tools", "verbosity", "audience", "code", "math", "charts", "refs"].includes(
				field.pick,
			),
			`${field.id} opens no picker`,
		);
	}
	// A list leaf reads its rows from a route rather than being handed them here.
	assert.equal(byId.toolsOff.source, "/tools");
	assert.equal(byId.extensionsOff.source, "/tools");
	assert.equal(byId.model.source, "/models");
	assert.equal(byId.helperModel.source, "/models");
	assert.deepEqual(byId.helperModel.write.body, { helperProvider: "@head", helperModel: "@rest" });
	assert.equal(byId.helperModel.write.route, "/defaults", "the helper model is studio-wide, like the editor");
	// `dim others` and the overview map sit under the canvas, because the canvas is where they are drawn.
	const canvas = document.groups.find((group) => group.id === "canvas");
	assert.deepEqual((canvas?.fields ?? []).map((field) => field.id), ["dimOthers", "overviewMap"]);
	// The map is the browser's own switch, drawn as the same row as the setting beside it, so its title is
	// the one place on the page that says which key turns it.
	assert.match(String(byId.overviewMap.help), /\(m\)$/);
});

test("a one-key body carries the control's value, and the model leaf splits at the first slash", () => {
	assert.equal(byId.model.split, "/");
	assert.equal(byId.model.value, "klotilda/deepseek-ai/DeepSeek-V4.1-Flash-1017");
	// A model id holds slashes of its own, so a split over every one of them would leave `@rest` a tail.
	const [head, ...rest] = String(byId.model.value).split(byId.model.split);
	assert.equal(head, "klotilda");
	assert.equal(rest.join("/"), "deepseek-ai/DeepSeek-V4.1-Flash-1017");
	assert.deepEqual(byId.model.write.body, { provider: "@head", model: "@rest" });
	// A board's `/thinking` reads `level`, which is the key its own route takes.
	assert.deepEqual(byId.thinking.write.body, { level: "@value" });
	for (const field of writtenLeaves) {
		const keys = Object.keys(field.write.body);
		if (keys.length !== 1) continue;
		assert.equal(field.write.body[keys[0]], "@value", `${field.id} sends ${field.write.body[keys[0]]}`);
	}
	// The two model leaves are the only leaves that write two keys, so they are the only ones that need the halves.
	assert.deepEqual(
		writtenLeaves.filter((field) => Object.keys(field.write.body).length !== 1).map((field) => field.id),
		["model", "helperModel"],
	);
});

test("the prompts group is this workspace's two files, each read from its own route and saved by its own press", () => {
	const prompts = document.groups.find((group) => group.id === "prompts");
	assert.ok(prompts);
	// Two leaves in the group itself: a workspace carries one pair of files, so there is no folder to fold.
	assert.deepEqual(prompts.groups ?? [], []);
	const leaves = prompts.fields ?? [];
	// The studio's file first, then the project's: the one the studio reads, then the one pi reads.
	assert.deepEqual(
		leaves.map((leaf) => leaf.label),
		["STUDIO.md", "AGENTS.md"],
	);
	for (const leaf of leaves) {
		// A whole text, so the box holds the file and nothing is filled in from the board's config.
		assert.equal(leaf.type, "prose");
		assert.equal(leaf.value, "");
		assert.equal(leaf.file, undefined, `${leaf.id} names a file under prompts/`);
		assert.ok(typeof leaf.help === "string" && leaf.help.length > 0, `${leaf.id} has no help`);
		assert.equal(leaf.source, `/workspace-prompt?name=${leaf.label}`);
		assert.deepEqual(leaf.write, { route: "/workspace-prompt", body: { name: leaf.label, text: "@value" } });
	}
	// The studio's prompt files are one copy for every board, so this page does not offer them at all.
	const shown = JSON.stringify(document.groups);
	for (const folder of PROMPT_FOLDERS) assert.ok(!shown.includes(`prompt-${folder}-`), `prompts/${folder} is on the board's page`);
});

test("every leaf carries a value, and the board's own choices are the ones the panel shows", () => {
	for (const leaf of leavesOf(document.groups)) assert.notEqual(leaf.value, undefined, `${leaf.id} has no value`);
	assert.equal(byId.thinking.value, "high");
	assert.equal(byId.path.value, "simple");
	// A board file from before the choice existed reads as the default, so this leaf is never empty.
	assert.equal(byId.childIntegration.value, "merge");
	assert.equal(byId.dimOthers.value, false);
	assert.deepEqual(byId.toolsOff.value, ["bash"]);
	assert.deepEqual(byId.extensionsOff.value, []);
	assert.equal(byId.cardsVerbosity.value, "verbose");
	assert.equal(byId.showCharts.value, "many");
	// A setting nobody chose reads as its default rather than as an empty control.
	assert.equal(byId.cardsAudience.value, "programmer");
	assert.equal(byId.showMathFormulas.value, "some");
	// The lists are the daemon's own, not a copy written out here.
	assert.deepEqual(byId.thinking.options, THINKING_LEVELS);
	assert.deepEqual(byId.path.options, PATH_NAMES);
	assert.deepEqual(byId.childIntegration.options, CHILD_INTEGRATION);
	assert.deepEqual(byId.cardsVerbosity.options, CARD_VERBOSITY);
	assert.deepEqual(byId.cardsAudience.options, CARD_AUDIENCE);
	for (const id of ["showCodeFragments", "showMathFormulas", "showCharts", "showReferences"]) {
		assert.deepEqual(byId[id].options, CARD_LEVELS, `${id} does not offer the three levels`);
	}
	// The label is the UI text a human reads, and the id is what a write sends.
	assert.deepEqual(
		settingLeaves.map((field) => field.label),
		[
			"model",
			"helper model",
			"thinking",
			"text editor",
			"boss flow",
			"a child's work comes back by",
			"built-in",
			"extensions",
			"how often",
			"written for",
			"code",
			"math",
			"charts",
			"references",
			"dim others",
			"overview map",
		],
	);
});

test("the text editor leaf reads the studio's value, because a board keeps no copy of it", () => {
	/** The board's page with the editor the crossroads holds, which is where the one program is kept. */
	const editorOf = (studio: { editor?: string }) =>
		Object.fromEntries(
			leavesOf(
				settingsDocument({
					scope: "board",
					values: boardSettingsValues(config, studio),
					title: "Board specific settings",
					subtitle: "",
					foot: "new threads only · a run in flight is untouched",
				}).groups,
			).map((field) => [field.id, field]),
		).editor.value;
	/** The same page, read for the helper model's value. */
	const helperOf = (studio: { helperProvider?: string; helperModel?: string }) =>
		Object.fromEntries(
			leavesOf(
				settingsDocument({
					scope: "board",
					values: boardSettingsValues(config, studio),
					title: "Board specific settings",
					subtitle: "",
					foot: "new threads only · a run in flight is untouched",
				}).groups,
			).map((field) => [field.id, field]),
		).helperModel.value;
	// The board's own config says nothing about the editor or the helper model, so the values it draws are the studio's own.
	assert.equal(editorOf({ editor: "/usr/bin/code" }), "/usr/bin/code");
	// Nobody has chosen one yet: an empty control with a placeholder is how that reads, on both pages.
	assert.equal(editorOf({}), "");
	const [nameProvider, ...nameRest] = NAME_MODEL.split("/");
	assert.equal(helperOf({ helperProvider: "github-copilot", helperModel: "gemini-4-argon" }), "github-copilot/gemini-4-argon");
	assert.equal(helperOf({}), `${nameProvider}/${nameRest.join("/")}`);
});

/**
 * Plugins live on the crossroads settings page, not on any board: the board panel carries the hotkeys
 * and the footnote only, so a reintroduction of the editor there would be a second registration page.
 */
test("plugins are handled on the crossroads settings page, and the board settings keep only hotkeys and the foot", () => {
	const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
	const settings = html.slice(html.indexOf('id="boardConfig"'), html.indexOf('id="promptEditor"'));
	assert.ok(!settings.includes('id="cfgPlugins"'), "the board settings hold no plugins section");
	assert.ok(!settings.includes('id="pluginRows"'), "the board settings hold no plugin rows");
	assert.ok(settings.includes('id="cfgShortcuts"'), "the hotkeys section stays on the board");
	assert.ok(settings.indexOf('id="cfgShortcuts"') < settings.indexOf('id="cfgFoot"'), "the footnote sits below the hotkeys");
	const welcome = readFileSync(new URL("../public/welcome.html", import.meta.url), "utf8");
	assert.ok(welcome.includes('id="cfgPlugins"'), "the crossroads settings hold the plugins section");
	assert.ok(welcome.includes('id="pluginRows"'), "the crossroads settings hold the plugin rows");
	const board = readFileSync(new URL("../public/client/board.js", import.meta.url), "utf8");
	assert.ok(!board.includes("/plugins/registry"), "the board client no longer edits the plugin registration");
	// The hotkeys map is repainted when the tree renders: the plugin doors list asynchronously, after
	// the load-time paint ran with an empty map, and the old plugin loader was that repaint.
	const renderTree = board.slice(board.indexOf("function renderTree"), board.indexOf("function renderGroup"));
	assert.ok(renderTree.includes("paintShortcuts()"), "rendering the settings repaints the hotkeys map");
	const welcomeJs = readFileSync(new URL("../public/welcome.js", import.meta.url), "utf8");
	assert.ok(welcomeJs.includes("await loadPluginSettings()"), "a save on the crossroads re-reads the registration, so the offered folders stay");
});
