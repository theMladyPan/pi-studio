import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * The settings document is a view of what the daemon holds, so both halves of it are set up before it is
 * read: the state folder the defaults come from, and a `pi` that answers `--list-models` with a catalogue
 * this test knows. A real machine's catalogue would make the assertions say what this machine has.
 *
 * `paths.ts` resolves the state folder once, at import, and so does `workspaces.ts` with the defaults.
 * That is why nothing under `server/` is imported statically here: the folder is chosen first.
 */
const stateHome = mkdtempSync(join(tmpdir(), "pi-studio-settings-"));
const piHome = mkdtempSync(join(tmpdir(), "pi-studio-settings-pi-"));
const installed = mkdtempSync(join(tmpdir(), "pi-studio-settings-install-"));

/** A `pi` that is not pi: a catalogue of two models, and nothing else. It never watches stdin. */
const CATALOGUE = [
	"provider  model  context  maxOut  thinking  images",
	"klotilda  deepseek-ai/DeepSeek-V4.1-Flash-1017  128000  8000  yes  no",
	"openrouter  z-ai/glm-5.3  200000  32000  yes  yes",
];
const stubRoot = `${installed}/install`;
const cliDir = join(stubRoot, "releases", "0.0.0-test", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
mkdirSync(cliDir, { recursive: true });
writeFileSync(join(stubRoot, "current-version"), "0.0.0-test\n");
writeFileSync(join(installed, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
writeFileSync(
	join(stubRoot, "releases", "0.0.0-test", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
	`${JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "commonjs" })}\n`,
);
writeFileSync(join(cliDir, "cli.js"), `process.stdout.write(${JSON.stringify(CATALOGUE.join("\n"))} + "\\n");\n`);

// A choice somebody made on another daemon, which has to arrive in the document unchanged.
const seeded = { provider: "klotilda", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", thinking: "high", dimOthers: false };
writeFileSync(join(stateHome, "workspaces.json"), JSON.stringify({ version: 1, workspaces: [], defaults: seeded }, null, 2));
process.env.PI_STUDIO_STATE = stateHome;
// pi's scope, which decides the order of the picker. The file is written by one test, so it starts absent.
process.env.PI_CODING_AGENT_DIR = piHome;
process.env.PI_MANAGED_INSTALL_ROOT = stubRoot;

const { settingsDocument } = await import("../server/settings.ts");
const { setHomeDefaults } = await import("../server/workspaces.ts");

/** The leaves of the whole tree, which is how the page finds the controls it draws. */
function leavesOf(document: { groups?: any[] }) {
	const found: any[] = [];
	const walk = (group: any) => {
		for (const field of group.fields ?? []) found.push(field);
		for (const child of group.groups ?? []) walk(child);
	};
	for (const group of document.groups ?? []) walk(group);
	return found;
}

function depthOf(document: { groups?: any[] }) {
	let depth = 0;
	const walk = (group: any, level: number) => {
		depth = Math.max(depth, level);
		for (const child of group.groups ?? []) walk(child, level + 1);
	};
	for (const group of document.groups ?? []) walk(group, 1);
	return depth;
}

test("the document carries a version, a title and the three settings", async () => {
	const document = await settingsDocument();
	assert.equal(document.version, 1);
	assert.equal(typeof document.title, "string");
	const leaves = leavesOf(document);
	const byId = Object.fromEntries(leaves.map((field) => [field.id, field]));
	// The page draws a control per leaf, so a setting missing here is a setting nobody can change.
	for (const id of ["model", "thinking", "dimOthers"]) assert.ok(byId[id], `no ${id} field`);
	assert.equal(byId.model.type, "combo");
	assert.equal(byId.thinking.type, "select");
	assert.equal(byId.dimOthers.type, "toggle");
	// Groups nest, and the page's collapsing is per path, so the depth is part of the shape.
	assert.ok(depthOf(document) >= 3, `the tree is only ${depthOf(document)} deep`);
});

test("the catalogue and the levels are the daemon's, not a copy written in the template", async () => {
	const document = await settingsDocument();
	const byId = Object.fromEntries(leavesOf(document).map((field) => [field.id, field]));
	// This machine's `pi` names these two, so these two and nothing else: a model the machine cannot run
	// cannot arrive in the picker from a list kept in the template.
	assert.deepEqual(byId.model.options, ["klotilda/deepseek-ai/DeepSeek-V4.1-Flash-1017", "openrouter/z-ai/glm-5.3"]);
	assert.deepEqual(byId.thinking.levels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("a scope pi wrote puts its models first, and adds none that are not in the catalogue", async () => {
	// `/scoped-models` writes this file while the daemon runs, so it is read per request rather than kept.
	writeFileSync(join(piHome, "settings.json"), JSON.stringify({ enabledModels: ["openrouter/z-ai/glm-5.3", "nobody/nothing"] }));
	const document = await settingsDocument();
	const model = leavesOf(document).find((field) => field.id === "model");
	// The scope comes first. The default this daemon holds is a model the machine can run, so it stays in
	// the list behind the scope: a picker that cannot show the value it is displaying is a lying picker.
	assert.deepEqual(model.options, ["openrouter/z-ai/glm-5.3", `${seeded.provider}/${seeded.model}`]);
	// A pattern that names nothing adds nothing, and neither does a model the machine cannot run.
	assert.ok(!model.options.includes("nobody/nothing"));
});

test("a chosen model the scope no longer names is still offered, spelled whole", async () => {
	// The scope narrowed since the choice was made, which `/scoped-models` does whenever a human edits it.
	writeFileSync(join(piHome, "settings.json"), JSON.stringify({ enabledModels: ["openrouter/*"] }));
	const document = await settingsDocument();
	const model = leavesOf(document).find((field) => field.id === "model");
	assert.equal(model.options[0], "openrouter/z-ai/glm-5.3");
	assert.ok(model.options.includes(`${seeded.provider}/${seeded.model}`), `chosen model dropped: ${model.options.join(", ")}`);
	assert.equal(model.value, `${seeded.provider}/${seeded.model}`);
});

test("a chosen model this machine cannot run is not added to the picker", async () => {
	setHomeDefaults({ ...seeded, provider: "nobody", model: "no-such-model" });
	const document = await settingsDocument();
	const model = leavesOf(document).find((field) => field.id === "model");
	assert.ok(!model.options.includes("nobody/no-such-model"), `unrunnable model offered: ${model.options.join(", ")}`);
	// The value is still the whole choice, so the box says what the daemon would try to run.
	assert.equal(model.value, "nobody/no-such-model");
	setHomeDefaults(seeded);
});

test("a choice already on disk is the value the document shows", async () => {
	const document = await settingsDocument();
	const byId = Object.fromEntries(leavesOf(document).map((field) => [field.id, field]));
	// `model` is two keys of the defaults shown as one, which is what its `store` mapping is for.
	assert.equal(byId.model.value, `${seeded.provider}/${seeded.model}`);
	assert.equal(byId.thinking.value, "high");
	assert.equal(byId.dimOthers.value, false);
});

test("a level saved through the setter is the level the document reads next", async () => {
	setHomeDefaults({ ...seeded, thinking: "low" });
	const document = await settingsDocument();
	const thinking = leavesOf(document).find((field) => field.id === "thinking");
	// The document is built per call, so a cached answer would still say "high" here and on the page.
	assert.equal(thinking.value, "low");
	// One store of the truth: the choice reached the file the daemon reloads from, and nothing else was written.
	const saved = JSON.parse(readFileSync(join(stateHome, "workspaces.json"), "utf8"));
	assert.deepEqual(saved.defaults, { ...seeded, thinking: "low" });
});

after(() => {
	for (const gone of [stateHome, piHome, installed]) rmSync(gone, { recursive: true, force: true });
});
