import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeTree } from "../test-support/temp.ts";

/**
 * What the picker is told this machine can run.
 *
 * The catalogue is one `pi --list-models` and a human table, so the read is the fragile part: pi can
 * exit badly with half a table on stdout, and it can also exit cleanly with a table a fifth smaller,
 * and neither is a smaller machine. A stub `pi` at the path the daemon looks for one lets a read fail
 * or arrive short between two good ones, which is the case this file is about — a read that came back
 * short used to answer the picker with a shorter list, and every scope pattern pi holds then read as
 * "matched no model here".
 */

/** A `pi` that lists whatever `say.json` beside it holds: the rows, and how the process ends. */
const STUB_PI = String.raw`
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const say = JSON.parse(readFileSync(join(__dirname, "say.json"), "utf8"));
const cells = (row) => [row[0].padEnd(say.width), row[1].padEnd(20), row[2] ?? "1M", row[3] ?? "128K", row[4] ?? "yes", row[5] ?? "yes"].join("  ");
process.stdout.write(["provider".padEnd(say.width), "model".padEnd(20), "context", "max-out", "thinking", "images"].join("  ") + "\n");
for (const row of say.rows) process.stdout.write(cells(row) + "\n");
if (say.stderr) process.stderr.write(say.stderr);
process.exit(say.code ?? 0);
`;

/** Write that stub where the daemon's `piCli()` finds it, and hand back the file the next read obeys. */
function stubPi() {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-model-stub-"));
	const version = "0.0.0-test";
	const bundle = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
	mkdirSync(bundle, { recursive: true });
	writeFileSync(join(root, "current-version"), `${version}\n`);
	writeFileSync(join(bundle, "package.json"), `${JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "commonjs" })}\n`);
	writeFileSync(join(bundle, "cli.js"), STUB_PI);
	return { root, sayFile: join(bundle, "say.json") };
}

/** What the next read of pi's table answers. A row is `[provider, model]` at its simplest. */
function say(file: string, rows: string[][], extra: { code?: number; stderr?: string } = {}) {
	const width = Math.max(8, ...rows.map((cells) => cells[0].length));
	writeFileSync(file, JSON.stringify({ rows, width, ...extra }));
}

/** The catalogue as this file reads it: the pair a picker draws a row from, and why a read failed. */
type Catalog = { models: { provider: string; model: string }[]; levels: string[]; trouble: string };

const named = (models: { provider: string; model: string }[]) => models.map((one) => `${one.provider}/${one.model}`);

test("a failed read of pi's table keeps the models already known, and says why", async (t) => {
	const stub = stubPi();
	// The clock is the daemon's own: a good catalogue is kept for ten minutes, which a test cannot wait.
	t.mock.timers.enable({ apis: ["Date"] });
	process.env.PI_MANAGED_INSTALL_ROOT = stub.root;
	// Imported after the stub is in place: the module reads the install root when a read runs.
	const { modelCatalog } = await import("../server/models.ts");
	try {
		say(stub.sayFile, [
			["deepseek", "deepseek-flash"],
			["github-copilot", "gemini-4-argon"],
		]);
		const first = (await modelCatalog()) as unknown as Catalog;
		assert.deepEqual(named(first.models), ["deepseek/deepseek-flash", "github-copilot/gemini-4-argon"]);
		assert.ok(!first.trouble, "a good read was reported as trouble");

		// pi dies after printing one row: a table cut short, not a machine that lost a provider.
		say(stub.sayFile, [["deepseek", "deepseek-flash"]], { code: 1, stderr: "Error: could not load models.json\n" });
		t.mock.timers.tick(11 * 60_000);
		const failed = (await modelCatalog()) as unknown as Catalog;
		assert.deepEqual(
			named(failed.models),
			["deepseek/deepseek-flash", "github-copilot/gemini-4-argon"],
			"a failed read threw away the models the daemon already knew",
		);
		assert.match(failed.trouble, /could not load models\.json/, "the picker was not told why the read failed");

		// A failed read is asked again on the next open, rather than kept for the ten minutes a good one is.
		// The good read answers from memory: it adds what it names and keeps what it omits, rather than
		// spending the answer on the rows pi happened to print this time.
		say(stub.sayFile, [["klotilda", "deepseek-ai/DeepSeek-V4.1-Flash-1017"], ["deepseek", "deepseek-flash"]]);
		t.mock.timers.tick(31_000);
		const healed = (await modelCatalog()) as unknown as Catalog;
		assert.deepEqual(named(healed.models), [
			"deepseek/deepseek-flash",
			"github-copilot/gemini-4-argon",
			"klotilda/deepseek-ai/DeepSeek-V4.1-Flash-1017",
		]);
		assert.ok(!healed.trouble, "a good read after a bad one still reported trouble");

		// A clean read the memory cannot trust: a table more than a fifth smaller than the one known is
		// a short read, not a smaller machine. It keeps the known list, says so, and is asked again after
		// thirty seconds rather than becoming the truth for the whole memory window.
		const bigger = [
			["deepseek", "deepseek-flash"],
			["github-copilot", "gemini-4-argon"],
			...Array.from({ length: 8 }, (_, i) => ["openrouter", `a${i}`]),
		] as string[][];
		say(stub.sayFile, bigger);
		t.mock.timers.tick(11 * 60_000);
		const grown = (await modelCatalog()) as unknown as Catalog;
		assert.equal(grown.models.length, 11, "a good read did not grow the memory");
		assert.ok(!grown.trouble, "a larger read was reported as trouble");
		say(stub.sayFile, [["openrouter", "a0"]]);
		t.mock.timers.tick(11 * 60_000);
		const short = (await modelCatalog()) as unknown as Catalog;
		assert.equal(short.models.length, 11, "a short read spent the answer on its own table");
		assert.match(short.trouble, /short table/, "the picker was not told a short table came back");

		// The answer after the short one: a read that omits one model is trusted, and the omitted one
		// stays for the rest of its six hours, because OpenRouter retires models rarely.
		say(stub.sayFile, bigger.slice(0, 9));
		t.mock.timers.tick(31_000);
		const kept = (await modelCatalog()) as unknown as Catalog;
		assert.equal(kept.models.length, 11, "a model a read omitted left the answer at once");
		assert.ok(named(kept.models).includes("openrouter/a7"), "the omitted model is not named");
		assert.ok(!kept.trouble, "a good read after a short one still reported trouble");

		// Six hours unnamed is the one way a model leaves: another healthy read omits a row, and the rows
		// that have gone unspoken for the whole window go with it.
		say(stub.sayFile, bigger.slice(0, 9));
		t.mock.timers.tick(6 * 60 * 60_000 + 60_000);
		const faded = (await modelCatalog()) as unknown as Catalog;
		assert.equal(faded.models.length, 9, "a model unnamed for six hours stayed in the answer");
		assert.ok(!named(faded.models).includes("openrouter/a7"), "the faded model is still named");
		assert.ok(!faded.trouble, "a good read after a quiet one still reported trouble");

		// A read smaller by just over a fifth keeps being refused, and every refusal is retried after
		// thirty seconds — but the window still runs underneath a refusal, so a list that really did
		// shrink empties entry by entry until the same read clears four fifths of what is left.
		say(stub.sayFile, bigger.slice(0, 7));
		t.mock.timers.tick(11 * 60_000);
		const refused = (await modelCatalog()) as unknown as Catalog;
		assert.equal(refused.models.length, 9, "a refused read spent the answer on the rows it had");
		assert.match(refused.trouble, /short table/, "the picker was not told a short table came back");
		t.mock.timers.tick(6 * 60 * 60_000 + 60_000);
		const fadedOut = (await modelCatalog()) as unknown as Catalog;
		assert.equal(fadedOut.models.length, 0, "rows unnamed for six hours stayed through refusal");
		assert.match(fadedOut.trouble, /short table/, "the emptied answer lost its reason");
		t.mock.timers.tick(31_000);
		const landed = (await modelCatalog()) as unknown as Catalog;
		assert.deepEqual(named(landed.models), [
			"deepseek/deepseek-flash",
			"github-copilot/gemini-4-argon",
			"openrouter/a0",
			"openrouter/a1",
			"openrouter/a2",
			"openrouter/a3",
			"openrouter/a4",
		]);
		assert.ok(!landed.trouble, "a read the shrunk list cleared still reported trouble");
	} finally {
		delete process.env.PI_MANAGED_INSTALL_ROOT;
		await removeTree(stub.root);
	}
});

test("a machine with no pi at all answers with the levels, no models, and the reason", () => {
	// A separate process, because this case is the first read the module ever makes: a catalogue kept
	// from an earlier read in this same test file would answer instead.
	const script = `
		const { modelCatalog } = await import(${JSON.stringify(new URL("../server/models.ts", import.meta.url).href)});
		process.stdout.write(JSON.stringify(await modelCatalog()));
	`;
	const printed = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8",
		env: { ...process.env, PI_MANAGED_INSTALL_ROOT: join(tmpdir(), "pi-studio-no-install-here"), PATH: "/nonexistent" },
	});
	const catalog = JSON.parse(printed) as Catalog;
	assert.deepEqual(catalog.models, []);
	assert.ok(Array.isArray(catalog.levels) && catalog.levels.length > 0, "no thinking levels came back");
	assert.notEqual(catalog.trouble, "", "an unreadable pi was reported as a machine with no models");
});

test("a scope pattern resolves against the catalogue, and one with no model is reported", async () => {
	const { resolveScope } = await import("../server/models.ts");
	const models = [
		{ provider: "github-copilot", model: "gemini-4-argon" },
		{ provider: "klotilda", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" },
	];
	const { scoped, problems } = resolveScope(
		["github-copilot/gemini-4-argon", "openrouter/z-ai/glm-5.3", "klotilda/deepseek-ai/DeepSeek-V4.1-Flash-1017:high"],
		models,
	);
	assert.deepEqual(named(scoped), ["github-copilot/gemini-4-argon", "klotilda/deepseek-ai/DeepSeek-V4.1-Flash-1017"]);
	assert.deepEqual(problems, ["openrouter/z-ai/glm-5.3"]);
});
