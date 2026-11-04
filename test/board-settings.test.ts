import assert from "node:assert/strict";
import { test } from "node:test";

import { settingsDocument } from "../server/settings-document.ts";
import { PATH_NAMES, PROMPT_FOLDERS, promptFiles } from "../server/child/modes.ts";
import { CARD_AUDIENCE, CARD_LEVELS, CARD_VERBOSITY } from "../server/card-settings.ts";
import { CHILD_INTEGRATION } from "../server/integration.ts";
import { THINKING_LEVELS } from "../server/models.ts";

/**
 * The board's settings document is a view of what `activeConfig(board)` answers, so it is read here from
 * that shape of object: no daemon, no state folder, no child. The prompt leaves are the one thing read
 * off the disk, because a prompt file that exists is a leaf the panel has to offer, and counting them
 * from `promptFiles()` keeps this test from knowing how many there are.
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
	title: "this board",
	subtitle: "pi-studio · /home/stanke/projekty/pi-studio",
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

test("the document is five groups in the order the panel draws them", () => {
	assert.equal(document.version, 1);
	assert.equal(document.scope, "board");
	assert.equal(document.title, "this board");
	// A subtitle saying which board this is, so a tab on two of them can tell them apart.
	assert.equal(document.subtitle, "pi-studio · /home/stanke/projekty/pi-studio");
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
			["prompts", false, "files read when a run starts"],
		],
	);
	const contents = document.groups.find((group) => group.id === "cards")?.groups ?? [];
	assert.deepEqual(
		contents.map((group) => [group.id, group.label, group.open, group.help]),
		[["contents", "contents", false, "what may sit on a card"]],
	);
});

test("the tree holds fourteen setting leaves and each one is a control a human can change", () => {
	// Fourteen: five for the thread, two for the tools, six for the cards, one for the canvas.
	assert.deepEqual(
		settingLeaves.map((field) => field.id),
		[
			"model",
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
		],
	);
	assert.equal(settingLeaves.length, 14);
	assert.deepEqual(
		settingLeaves.map((field) => field.type),
		["combo", "select", "combo", "select", "select", "list", "list", "select", "select", "select", "select", "select", "select", "toggle"],
	);
	// A setting a later build dropped is not quietly back, and neither is a group nobody draws.
	const whole = JSON.stringify(document);
	for (const gone of ["timeoutSeconds", "per-board-overrides"]) assert.ok(!whole.includes(gone), `${gone} is back`);
});

test("every setting names its picker and the route a change goes back through", () => {
	for (const field of settingLeaves) {
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
	// `dim others` sits under the canvas, because the canvas is where it is drawn.
	const canvas = document.groups.find((group) => group.id === "canvas");
	assert.deepEqual((canvas?.fields ?? []).map((field) => field.id), ["dimOthers"]);
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
	for (const field of settingLeaves) {
		const keys = Object.keys(field.write.body);
		if (keys.length !== 1) continue;
		assert.equal(field.write.body[keys[0]], "@value", `${field.id} sends ${field.write.body[keys[0]]}`);
	}
	// The model is the only leaf that writes two keys, so it is the only one that needs the halves.
	assert.deepEqual(
		settingLeaves.filter((field) => Object.keys(field.write.body).length !== 1).map((field) => field.id),
		["model"],
	);
});

test("the prompts group is one subgroup per folder, one leaf per file, each posting to /prompt", () => {
	const prompts = document.groups.find((group) => group.id === "prompts");
	assert.ok(prompts);
	assert.deepEqual(
		(prompts.groups ?? []).map((group) => group.id),
		PROMPT_FOLDERS,
	);
	const seen: string[] = [];
	for (const folder of prompts.groups ?? []) {
		assert.ok((folder.fields ?? []).length > 0, `no prompt leaf in prompts/${folder.id}`);
		for (const leaf of folder.fields ?? []) {
			assert.equal(leaf.type, "prompt");
			// A prompt is a file, so the leaf names it and the editor writes it; it carries no value.
			assert.equal(leaf.value, "");
			assert.equal(leaf.pick, undefined, `${leaf.id} opens a picker`);
			const name = `${folder.id}/${leaf.id.slice(`prompt-${folder.id}-`.length)}.md`;
			assert.equal(leaf.file, name);
			assert.equal(leaf.label, leaf.file.slice(folder.id.length + 1));
			assert.ok(typeof leaf.help === "string" && leaf.help.length > 0, `${leaf.id} has no help`);
			assert.deepEqual(leaf.write, { route: "/prompt", body: { name, text: "@value" } });
			seen.push(leaf.file);
		}
	}
	// Whatever is in `prompts/` is a leaf, so a new file needs no change here.
	assert.deepEqual(
		seen.sort(),
		promptFiles()
			.map((one) => one.name)
			.sort(),
	);
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
		],
	);
});
