import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

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

/** Every field under one group, at any depth: a prompt group holds its fields one level down. */
function fieldsIn(group: any): any[] {
	return [...(group?.fields ?? []), ...(group?.groups ?? []).flatMap(fieldsIn)];
}

/** The prompt files that are on disk right now, which is what the page has to carry, read here so that a
 * new file is a new field and this test does not have to know how many there are. */
function promptFilesOnDisk() {
	const found: string[] = [];
	for (const folder of ["roles", "modes", "flows"]) {
		let files: string[] = [];
		try {
			files = readdirSync(join(repo, "prompts", folder)).filter((one) => one.endsWith(".md"));
		} catch {
			continue;
		}
		for (const file of files) found.push(`${folder}/${file}`);
	}
	return found.sort();
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

test("the document carries one field per prompt file on disk, whole", async () => {
	const document = await settingsDocument();
	const prompts = document.groups.find((group) => group.id === "prompts");
	assert.ok(prompts, "no prompts group in the document");
	const onDisk = promptFilesOnDisk();
	// Counted off the disk above rather than written down here, because the list is the point: a file
	// added to prompts/ is a field on the next read, and this test must not go red when it is not.
	assert.ok(onDisk.length > 0, "no prompt files on disk to check against");
	const fields = fieldsIn(prompts);
	assert.equal(fields.length, onDisk.length, `${fields.length} fields for ${onDisk.length} prompt files`);
	assert.deepEqual(fields.map((field) => field.label).sort(), onDisk.map((name) => name.split("/")[1]).sort());
	// One file, byte for byte: the textarea shows exactly what the daemon will read.
	const scout = fields.find((field) => field.label === "scout.md");
	assert.equal(scout.value, readFileSync(join(repo, "prompts", "roles", "scout.md"), "utf8"));
	assert.equal(scout.help, scout.value.split("\n").find((line: string) => line.trim()));
	assert.equal(scout.source, "/prompt?name=roles%2Fscout.md");
	assert.deepEqual(scout.write, { route: "/prompt", method: "POST", keys: { name: "roles/scout.md", text: "@value" } });
});

test("the prompt groups are roles, modes and flows, collapsed, after the settings", async () => {
	const document = await settingsDocument();
	assert.equal(document.groups[0].id, "new-boards");
	const prompts = document.groups[document.groups.length - 1];
	assert.equal(prompts.id, "prompts");
	// Collapsed, because ten whole files are not what a human came to the page for.
	assert.equal(prompts.collapsed, true);
	assert.deepEqual(prompts.groups?.map((group) => group.id), ["prompts-roles", "prompts-modes", "prompts-flows"]);
	assert.deepEqual(prompts.groups?.map((group) => group.label), ["Roles", "Modes", "Flows"]);
	// Each folder's files in name order, so the page does not reshuffle itself between reads.
	for (const group of prompts.groups ?? []) {
		const labels = (group.fields ?? []).map((field) => field.label);
		assert.deepEqual(labels, [...labels].sort(), `${group.label} is not in name order`);
	}
});

test("every prompt field says where it came from and where it is written", async () => {
	const document = await settingsDocument();
	const fields = fieldsIn(document.groups.find((group) => group.id === "prompts"));
	assert.equal(fields.length, promptFilesOnDisk().length);
	for (const field of fields) {
		assert.equal(field.type, "prompt", `${field.id} is a ${field.type}`);
		assert.equal(typeof field.value, "string");
		assert.ok(field.value.trim().length > 0, `${field.id} carries no text`);
		// The first non-empty line is the name a human recognises the file by.
		assert.ok(field.help.trim().length > 0, `${field.id} carries no help`);
		// A field with no `write` would be posted to /defaults, which knows nothing about prompts.
		assert.equal(field.write?.route, "/prompt", `${field.id} has no write route`);
		assert.equal(field.write?.method, "POST");
		assert.equal(field.write?.keys?.text, "@value");
		assert.match(field.write?.keys?.name ?? "", /^(roles|modes|flows)\/[a-z][a-z-]*\.md$/);
	}
});

test("a prompt file added to prompts/ is a field on the next read, with no code changed", async () => {
	// A real file in the repository, because that is what the page reads. Removed in the `finally`, so the
	// tree this test runs in is the tree it leaves behind.
	const path = join(repo, "prompts", "roles", "zz-probe.md");
	writeFileSync(path, "# zz probe\n\nTemporary, written by a test.\n");
	try {
		const document = await settingsDocument();
		const roles = document.groups.find((group) => group.id === "prompts")?.groups?.find((group) => group.id === "prompts-roles");
		const probe = fieldsIn(roles).find((field) => field.label === "zz-probe.md");
		assert.ok(probe, "the file on disk did not reach the document");
		assert.equal(probe.help, "# zz probe");
		assert.equal(probe.value, "# zz probe\n\nTemporary, written by a test.\n");
		assert.equal(probe.write?.keys?.name, "roles/zz-probe.md");
	} finally {
		rmSync(path, { force: true });
	}
});

after(() => {
	for (const gone of [stateHome, piHome, installed]) rmSync(gone, { recursive: true, force: true });
});
