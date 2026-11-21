import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * One sentence of help beside git's own words: the prompt asks for one sentence
 * with worked examples, the gate keeps the first sentence only, and a failed or
 * empty call answers nothing rather than a second dialog. No `pi` runs here.
 */
const explain = await import("../server/git/gitgraph/explain.ts");

test("the prompt carries the failure and asks for one sentence", () => {
	const prompt = explain.explainPrompt("mergeBranch", "CONFLICT (content): Merge conflict in f.txt\nAutomatic merge failed");
	assert.match(prompt, /exactly one sentence/);
	assert.match(prompt, /mergeBranch/);
	assert.match(prompt, /CONFLICT/);
	assert.match(prompt, /ok:/);
	assert.match(prompt, /not ok:/);
});

test("the first sentence is kept, and a greeting is refused", () => {
	assert.equal(
		explain.plausibleHelp("Both branches changed f.txt, so resolve it, stage it and commit.\nSecond sentence follows."),
		"Both branches changed f.txt, so resolve it, stage it and commit.",
	);
	assert.equal(explain.plausibleHelp('"Hi — how can I help?"'), "");
	assert.equal(explain.plausibleHelp("```\nMain has no upstream, so push with -u origin main.\n```"), "Main has no upstream, so push with -u origin main.");
});

test("the page carries a git failure on the thrown error, not on a stray name", () => {
	// `npm run check` only parses the client, so a bare name in host.js would pass
	// the gate and break every failed action in the browser. This is the guard.
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const host = readFileSync(join(root, "public/client/gitgraph/host.js"), "utf8");
	assert.ok(!/^\s*errno\./m.test(host), "host.js must not write to errno");
	assert.match(host, /failed\.gitDetails = message/);
	const dom = readFileSync(join(root, "public/client/gitgraph/dom.js"), "utf8");
	assert.match(dom, /error\?\.gitDetails/);
});

test("empty failure text answers no helper, through the message switch", async () => {
	const dispatch = await import("../server/git/gitgraph/dispatch.ts");
	const { scratchRepo } = await import("../test-support/git.ts");
	const { realpathSync } = await import("node:fs");
	const { rmSync } = await import("node:fs");
	const folder = realpathSync(scratchRepo());
	try {
		const board = { id: "w-explain", folder, trees: [], threads: new Map(), children: new Map() };
		const replies = await dispatch.respond(board, { command: "explainGitError", details: "  ", forCommand: "mergeBranch" });
		assert.equal(replies.length, 1);
		assert.equal((replies[0] as Record<string, unknown>).explanation, null, "no text means no call, and the shape still answers");
	} finally { rmSync(folder, { recursive: true, force: true }); }
});

test("one call is made, alone, and a failure answers nothing", async () => {
	let calls = 0;
	const helped = await explain.explainGitError("CONFLICT (content): Merge conflict in f.txt", "mergeBranch", {
		model: "github-copilot/gemini-4-argon",
		folder: process.cwd(),
		run: async (_cli: unknown, _folder: unknown, prompt: unknown, model: unknown) => {
			calls += 1;
			assert.equal(model, "github-copilot/gemini-4-argon");
			assert.match(String(prompt), /CONFLICT/);
			return "Both sides changed f.txt, so resolve it, stage it and commit.\n";
		},
	});
	assert.equal(helped, "Both sides changed f.txt, so resolve it, stage it and commit.");
	assert.equal(calls, 1, "an explanation is one call, never a retry");

	const failed = await explain.explainGitError("CONFLICT (content): Merge conflict in f.txt", "mergeBranch", {
		model: "github-copilot/gemini-4-argon",
		folder: process.cwd(),
		run: async () => { throw new Error("pi has no answer"); },
	});
	assert.equal(failed, null, "a model that fails leaves git's words alone");

	const empty = await explain.explainGitError("   ", "mergeBranch", {
		model: "github-copilot/gemini-4-argon",
		folder: process.cwd(),
		run: async () => { calls += 1; return "unused"; },
	});
	assert.equal(empty, null);
	assert.equal(calls, 1, "no failure text means no call");

	const off = await explain.explainGitError("CONFLICT (content): Merge conflict in f.txt", "mergeBranch", {
		model: "",
		folder: process.cwd(),
		run: async () => { calls += 1; return "unused"; },
	});
	assert.equal(off, null, "an empty helper model turns help off");
	assert.equal(calls, 1);
});
