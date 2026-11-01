import assert from "node:assert/strict";
import { test } from "node:test";

import { settingsDocument } from "../server/settings-document.ts";
import { PROMPT_FOLDERS, promptFiles } from "../server/child/modes.ts";
import { THINKING_LEVELS } from "../server/models.ts";

/**
 * The crossroads' settings document is a view of the defaults object the caller hands in, so it is read
 * here from a plain object: no daemon, no state folder, no child. The prompt leaves are the one thing
 * read off the disk, because a prompt file that exists is a leaf the panel has to offer, and counting
 * them from `promptFiles()` keeps this test from knowing how many there are.
 */

/** The defaults a human set on the crossroads: the choices this test asserts, and the rest at theirs. */
const defaults = {
	provider: "klotilda",
	model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
	thinking: "high",
	path: "simple",
	childIntegration: "cherry-pick",
	dimOthers: false,
	toolsOff: ["bash"],
	extensionsOff: [],
	cardsVerbosity: "quiet",
	cardsAudience: "designer",
	showCodeFragments: "none",
	showMathFormulas: "some",
	showCharts: "many",
	showReferences: "some",
};

/** The three lines only the route knows, which is why they are the caller's to write. */
const LINES = {
	title: "every new board",
	subtitle: "what every board is born with",
	foot: "a board keeps its own copy from the moment it is opened",
};

const document = settingsDocument({ scope: "defaults", values: defaults, ...LINES });

/** The same values through the board's scope, so the two trees can be compared leaf for leaf. */
const boardDocument = settingsDocument({ scope: "board", values: defaults, ...LINES });

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

/** A copy of the tree with the one thing the scopes are allowed to differ in taken out. */
function withoutWrites(groups: any[]): any[] {
	return groups.map((group) => ({
		...group,
		fields: (group.fields ?? []).map(({ write: _write, ...field }: any) => field),
		...(group.groups ? { groups: withoutWrites(group.groups) } : {}),
	}));
}

test("the defaults document is five groups in the order the panel draws them", () => {
	assert.equal(document.version, 1);
	assert.equal(document.scope, "defaults");
	assert.deepEqual([document.title, document.subtitle, document.foot], [LINES.title, LINES.subtitle, LINES.foot]);
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
	assert.deepEqual(
		(document.groups.find((group) => group.id === "cards")?.groups ?? []).map((group) => [group.id, group.label, group.open]),
		[["contents", "contents", false]],
	);
});

test("the two scopes build one tree: the same five groups, the same thirteen leaves, the same words", () => {
	assert.equal(boardDocument.version, document.version);
	assert.deepEqual(withoutWrites(boardDocument.groups), withoutWrites(document.groups));
	// Thirteen setting leaves: four for the thread, two for the tools, six for the cards, one for the canvas.
	assert.deepEqual(
		settingLeaves.map((field) => field.id),
		[
			"model",
			"thinking",
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
	assert.equal(settingLeaves.length, 13);
	assert.deepEqual(
		settingLeaves.map((field) => field.label),
		[
			"model",
			"thinking",
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
	// A setting a later build dropped is not quietly back, and neither is a group nobody draws.
	const whole = JSON.stringify([document, boardDocument]);
	for (const gone of ["timeoutSeconds", "per-board-overrides"]) assert.ok(!whole.includes(gone), `${gone} is back`);
});

test("every setting leaf of the defaults writes to /defaults, and nothing else", () => {
	for (const field of settingLeaves) {
		assert.ok(field.write, `${field.id} has no write`);
		assert.equal(field.write.route, "/defaults", `${field.id} writes to ${field.write.route}`);
		// A toggle is flipped where it stands, so it names no picker; everything else opens a list.
		if (field.type === "toggle") continue;
		assert.ok(
			["model", "thinking", "path", "childIntegration", "tools", "verbosity", "audience", "code", "math", "charts", "refs"].includes(
				field.pick,
			),
			`${field.id} opens no picker`,
		);
	}
	// A list leaf reads its rows from a route rather than being handed them here.
	assert.equal(byId.model.source, "/models");
	assert.equal(byId.toolsOff.source, "/tools");
	assert.equal(byId.extensionsOff.source, "/tools");
});

test("the model leaf splits at the first slash, and one key carries the value everywhere else", () => {
	assert.equal(byId.model.split, "/");
	assert.equal(byId.model.value, "klotilda/deepseek-ai/DeepSeek-V4.1-Flash-1017");
	// A model id holds slashes of its own, so a split over every one of them would leave `@rest` a tail.
	const [head, ...rest] = String(byId.model.value).split(byId.model.split);
	assert.equal(head, "klotilda");
	assert.equal(rest.join("/"), "deepseek-ai/DeepSeek-V4.1-Flash-1017");
	assert.deepEqual(byId.model.write.body, { provider: "@head", model: "@rest" });
	// `/defaults` reads `thinking`, which is the key the defaults object holds.
	assert.deepEqual(byId.thinking.write.body, { thinking: "@value" });
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

test("the board's document differs from the defaults' in the route a change goes back through", () => {
	const boardById = Object.fromEntries(leavesOf(boardDocument.groups).map((field) => [field.id, field]));
	assert.equal(boardDocument.scope, "board");
	// Two leaves keep a route of their own on a board, because a live child can be told about them.
	assert.equal(boardById.model.write.route, "/model");
	assert.equal(boardById.thinking.write.route, "/thinking");
	// A board's `/thinking` reads `level`; the value is the same one, under the key its route reads.
	assert.deepEqual(boardById.thinking.write.body, { level: "@value" });
	for (const field of settingLeaves.filter((one) => one.id !== "model" && one.id !== "thinking")) {
		assert.equal(boardById[field.id].write.route, "/config", `${field.id} writes to ${boardById[field.id].write.route}`);
		assert.deepEqual(boardById[field.id].write.body, field.write.body, `${field.id} changed its body with its route`);
	}
});

test("the prompts group is one subgroup per folder, one leaf per file, and one route back", () => {
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
			// A prompt is a file, so the leaf carries the path and the first line rather than the text.
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

test("every leaf carries a value, and the defaults object the caller passed is where they come from", () => {
	for (const leaf of leavesOf(document.groups)) assert.notEqual(leaf.value, undefined, `${leaf.id} has no value`);
	assert.equal(byId.model.value, `${defaults.provider}/${defaults.model}`);
	assert.equal(byId.thinking.value, "high");
	assert.equal(byId.path.value, "simple");
	assert.equal(byId.childIntegration.value, "cherry-pick");
	assert.equal(byId.dimOthers.value, false);
	assert.deepEqual(byId.toolsOff.value, ["bash"]);
	assert.deepEqual(byId.extensionsOff.value, []);
	assert.equal(byId.cardsVerbosity.value, "quiet");
	assert.equal(byId.cardsAudience.value, "designer");
	assert.equal(byId.showCodeFragments.value, "none");
	assert.equal(byId.showCharts.value, "many");
	// The lists are the daemon's own, not a copy written out here.
	assert.deepEqual(byId.thinking.options, THINKING_LEVELS);
	// `dim others` sits under the canvas in both documents, because the canvas is where it is drawn.
	for (const one of [document, boardDocument]) {
		const canvas = one.groups.find((group) => group.id === "canvas");
		assert.deepEqual((canvas?.fields ?? []).map((field) => field.id), ["dimOthers"]);
	}
});

test("a value nobody chose reads as the default rather than as an empty control", () => {
	// The crossroads' own object before anybody has chosen anything: every key it omits still has an answer.
	const fresh = settingsDocument({ scope: "defaults", values: {}, ...LINES });
	const freshById = Object.fromEntries(leavesOf(fresh.groups).map((field) => [field.id, field]));
	assert.equal(freshById.thinking.value, "off");
	assert.equal(freshById.path.value, "auto");
	assert.equal(freshById.childIntegration.value, "merge");
	assert.equal(freshById.dimOthers.value, true);
	assert.deepEqual(freshById.toolsOff.value, []);
	assert.deepEqual(freshById.extensionsOff.value, []);
	assert.equal(freshById.cardsVerbosity.value, "normal");
	assert.equal(freshById.cardsAudience.value, "programmer");
	assert.equal(freshById.showCodeFragments.value, "some");
});
