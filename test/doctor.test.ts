/**
 * `pi-studio doctor`: the four parts this app leans on, what was found, and the fix for each gap.
 *
 * Every case here is staged in a throwaway folder under the OS temp directory and handed to the
 * doctor through the same environment the app reads at run time — PATH, HOME, PI_MANAGED_INSTALL_ROOT,
 * PI_STUDIO_GITGRAPH_DIR — so no test depends on what happens to be installed on this machine.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectReport, formatReport, runDoctor } from "../server/doctor.ts";
import { clearBundleCache } from "../server/git/gitgraph/vendor.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(root, "bin", "pi-studio");

/** Every folder a case stages, removed when the file finishes. */
const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-studio-doctor-${prefix}-`));
	scratch.push(dir);
	return dir;
}

/** A program on PATH that answers with one fixed line, whatever it is asked. */
function program(dir: string, name: string, line: string): void {
	const path = join(dir, name);
	writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(line)}\n`);
	chmodSync(path, 0o755);
}

/** A managed pi install shaped the way the app looks for it, with a cli the finder accepts. */
function managedPi(base: string): string {
	const installRoot = join(base, "pi", "agent", "install");
	const version = "9.9.9";
	const cli = join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	mkdirSync(dirname(cli), { recursive: true });
	writeFileSync(cli, "// the cli a thread is started with\n");
	writeFileSync(join(installRoot, "current-version"), `${version}\n`);
	return installRoot;
}

/** A copy of Git Graph Libre: the files the drawer serves, and nothing else. */
function extension(base: string): string {
	const dir = join(base, "extensions", "plohnensoftware.git-graph-libre-1.10.0");
	mkdirSync(join(dir, "media"), { recursive: true });
	mkdirSync(join(dir, "out"), { recursive: true });
	mkdirSync(join(dir, "l10n"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "git-graph-libre", version: "1.10.0", publisher: "PlohnenSoftware" }));
	for (const file of ["web.min.js", "startup.min.js", "diffTab.min.js"]) writeFileSync(join(dir, "out", file), "var stoodInForTheBundle = true;\n");
	for (const css of ["tokens", "base", "checkbox", "table", "commit-details", "refs", "toolbar", "settings", "dialogs", "dropdown"]) {
		writeFileSync(join(dir, "media", `${css}.css`), "body { color: #c9d1d9; }\n");
	}
	writeFileSync(join(dir, "l10n", "bundle.l10n.json"), "{}\n");
	return dir;
}

type Machine = { binDir: string; env: NodeJS.ProcessEnv; restore: () => void };

/**
 * A machine as the app would see it. PATH is replaced outright, so a real git or node on this
 * machine cannot answer for a staged one that is absent, and `node: false` stages none at all.
 */
function stage(parts: { node?: string | false; git?: boolean; pi?: boolean; graph?: boolean } = {}): Machine {
	const base = scratchDir("machine");
	const binDir = join(base, "bin");
	const home = join(base, "home");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(home, { recursive: true });
	if (parts.node !== false) program(binDir, "node", parts.node ?? "22.20.0");
	if (parts.git) program(binDir, "git", "git version 2.48.1");
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		PATH: binDir,
		PI_MANAGED_INSTALL_ROOT: join(base, "pi", "agent", "install"),
		PI_STUDIO_GITGRAPH_DIR: "",
	};
	if (parts.pi) env.PI_MANAGED_INSTALL_ROOT = managedPi(base);
	if (parts.graph) env.PI_STUDIO_GITGRAPH_DIR = extension(base);
	const saved = { ...process.env };
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, env);
	clearBundleCache();
	return {
		binDir,
		env,
		restore: () => {
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, saved);
			clearBundleCache();
		},
	};
}

/** Run the report with its own printing captured, so a test's output stays its assertions. */
function quietly(run: () => number): { status: number; text: string } {
	const saved = console.log;
	let text = "";
	console.log = (...args: unknown[]) => {
		text += `${args.join(" ")}\n`;
	};
	try {
		return { status: run(), text };
	} finally {
		console.log = saved;
	}
}

/** Run the launcher the way a shell does, with the staged environment, and keep its exit code. */
function runLauncher(env: NodeJS.ProcessEnv, args: string[] = []): Promise<{ status: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		execFile(process.execPath, [launcher, "doctor", ...args], { encoding: "utf8", env, timeout: 60_000 }, (error, stdout, stderr) => {
			const code = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
			resolvePromise({ status: error ? (typeof code === "number" ? code : 1) : 0, stdout, stderr });
		});
	});
}

test("a machine with all four parts is reported whole in one line, and answers zero", (t) => {
	const machine = stage({ git: true, pi: true, graph: true });
	t.after(machine.restore);
	const report = collectReport();
	assert.equal(report.ok, true, formatReport(report));
	assert.deepEqual(report.parts.map((part) => part.part), ["node", "git", "pi", "graph"]);
	assert.deepEqual(report.parts.map((part) => part.ok), [true, true, true, true]);
	for (const part of report.parts) assert.equal(part.fix, "", `a part that was found carries no fix: ${part.part}`);
	const text = formatReport(report);
	assert.match(text, /^pi-studio \d+\.\d+\.\d+ at /m, text);
	assert.match(text, /node 22\.20\.0/, text);
	assert.match(text, /git version 2\.48\.1/, text);
	assert.match(text, /pi at .*cli\.js/, text);
	assert.match(text, /Git Graph Libre 1\.10\.0/, text);
	assert.match(text, /everything this copy leans on is here/, text);
	assert.equal(quietly(() => runDoctor()).status, 0, "a whole machine answers zero");
});

test("a bare machine names every missing part and the command that installs it", (t) => {
	const machine = stage({ node: false });
	t.after(machine.restore);
	const report = collectReport();
	assert.equal(report.ok, false, "nothing is installed, so nothing can be whole");
	assert.deepEqual(report.parts.map((part) => part.ok), [false, false, false, false]);
	const text = formatReport(report);
	assert.match(text, /missing node/, text);
	assert.match(text, /fix: install an official Node 22\.18 or newer from https:\/\/nodejs\.org/, text);
	assert.match(text, /missing git/, text);
	assert.match(text, /fix: install git: .*dnf install git.*apt install git.*pacman -S git/, text);
	assert.match(text, /missing pi/, text);
	assert.match(text, /fix: install pi: curl -fsSL https:\/\/pi\.dev\/install\.sh/, text);
	assert.match(text, /missing graph/, text);
	assert.match(text, /PI_STUDIO_GITGRAPH_DIR/, "the drawing's fix names the variable that points at a copy");
	// Without a Node there is no app to start, and the closing line must not promise a board.
	assert.match(text, /cannot start until node is there/, text);
	assert.doesNotMatch(text, /the board still starts/, text);
	assert.equal(quietly(() => runDoctor()).status, 1, "a machine with gaps answers nonzero");
});

test("an old node is reported with what it found and what this copy needs", (t) => {
	const machine = stage({ node: "20.11.0", git: true, pi: true, graph: true });
	t.after(machine.restore);
	const report = collectReport();
	const node = report.parts.find((part) => part.part === "node");
	assert.ok(node);
	assert.equal(node.ok, false);
	assert.match(node.detail, /node 20\.11\.0 at .*bin\/node, and this copy needs/, node.detail);
	assert.match(node.fix, /22\.18 or newer/, node.fix);
	assert.equal(report.parts.find((part) => part.part === "git")?.ok, true, "one old part does not darken the others");
	assert.match(formatReport(report), /node is missing: the pi-studio command cannot start/, "the closing line names the part that stops the start");
});

test("a machine without the drawing is reported as a board that still starts", (t) => {
	const machine = stage({ git: true, pi: true });
	t.after(machine.restore);
	const report = collectReport();
	assert.equal(report.ok, false);
	assert.deepEqual(report.parts.filter((part) => !part.ok).map((part) => part.part), ["graph"]);
	assert.match(formatReport(report), /graph is missing: the board still starts/, "the graph is the one part the board runs without");
});

test("the launcher answers doctor, in text and in JSON, and its exit code carries the verdict", async (t) => {
	const whole = stage({ git: true, pi: true, graph: true });
	t.after(whole.restore);
	const happy = await runLauncher(whole.env);
	assert.equal(happy.status, 0, happy.stderr);
	assert.match(happy.stdout, /^pi-studio \d+\.\d+\.\d+ at /m, happy.stdout);
	assert.match(happy.stdout, /ok\s+git/, happy.stdout);

	const bare = stage({ node: false });
	t.after(bare.restore);
	const missing = await runLauncher(bare.env);
	assert.equal(missing.status, 1, "a gap is a nonzero exit, so a script can ask the same question");
	assert.match(missing.stdout, /missing node/, missing.stdout);

	const json = await runLauncher(bare.env, ["--json"]);
	const parsed = JSON.parse(json.stdout) as { ok: boolean; parts: Array<{ part: string; ok: boolean; fix: string }> };
	assert.equal(parsed.ok, false);
	assert.deepEqual(parsed.parts.map((part) => part.part), ["node", "git", "pi", "graph"]);
	assert.equal(parsed.parts.find((part) => part.part === "git")?.ok, false);
});
