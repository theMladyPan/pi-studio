/**
 * `pi-studio doctor`: what this copy needs to be whole, what was found on this machine, and the fix
 * for each part that is not there.
 *
 * Three parts sit outside this app, and each one goes dark on its own when it is missing: the Node
 * that runs the app, git for every repository feature, and the pi that every thread is started with.
 * They were checked in three places — the installer's warnings, the page that needed them, and the
 * browser console — and none of them was the place a human looks after installing. This is that
 * place: one list, the same wording for the installer and for the command, and the exact command
 * that closes each gap.
 *
 * It answers with a report rather than printing as it goes, because both callers want it: the
 * launcher prints it, and the installer prints the very same report after it writes the copy.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { piCli } from "./child/pi-cli.ts";
import { programOnPath, REPO_DIR } from "./paths.ts";

/** One part of the machine this app leans on, and what to do when it is not there. */
export type DoctorPart = {
	/** The name the report prints, one word: `node`, `git`, `pi`. */
	part: string;
	ok: boolean;
	/** What was found, in one line, in words a human reads once. */
	detail: string;
	/** The fix, ready to paste, when `ok` is false. Empty when nothing is missing. */
	fix: string;
};

export type DoctorReport = {
	ok: boolean;
	version: string;
	/** The folder this copy runs from, so a human can tell two installs apart. */
	root: string;
	parts: DoctorPart[];
};

/** The commands that put git on the three distributions a Linux desktop is usually running. */
const GIT_FIX = "install git: sudo dnf install git (Fedora), sudo apt install git (Ubuntu), sudo pacman -S git (Arch)";
const PI_FIX = "install pi: curl -fsSL https://pi.dev/install.sh | sh (or npm install -g --ignore-scripts @earendil-works/pi-coding-agent)";
const NODE_FIX = (minimum: string) => `install an official Node ${minimum} or newer from https://nodejs.org and make sure that build is first on PATH`;

/** A path as a human writes it: the home folder shortened to `~`, everything else left as it is. */
function short(path: string): string {
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Where `pi-studio` itself came from, for the report's first line: the app's own package version. */
function appVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8")) as { version?: unknown; engines?: { node?: unknown } };
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

/** The Node range this release declares, kept as the text the package holds so the report repeats it. */
function nodeRequirement(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8")) as { engines?: { node?: unknown } };
		const declared = pkg.engines?.node;
		return typeof declared === "string" ? declared : "";
	} catch {
		return "";
	}
}

/** The version a range like `>=22.18` asks for, as the `22.18` a sentence can carry. */
function namedVersion(range: string): string {
	const match = /(\d+\.\d+)/.exec(range);
	return match ? match[1] : "22.18";
}

/** The first `major.minor` a range like `>=22.18` or `^22.18.0` names, or [] when it names none. */
function minimumOf(range: string): number[] {
	const match = /(\d+)\.(\d+)/.exec(range);
	return match ? [Number(match[1]), Number(match[2])] : [];
}

/** Whether `version` (the running Node) is at least the `minimum` the release asks for. */
function atLeast(version: string, minimum: number[]): boolean {
	const parts = version.split(".").map((piece) => Number(piece));
	if (minimum.length === 0) return true;
	if (!Number.isFinite(parts[0])) return false;
	if (parts[0] !== minimum[0]) return (parts[0] ?? 0) > minimum[0];
	return (parts[1] ?? 0) >= (minimum[1] ?? 0);
}

/** The version a `node` on PATH answers for, or "" when it cannot be asked or is not there. */
function nodeOnPath(): { path: string; version: string } {
	const found = programOnPath("node");
	if (!found) return { path: "", version: "" };
	const answer = spawnSync(found, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 10_000 });
	const version = answer.status === 0 ? answer.stdout.trim() : "";
	return { path: found, version };
}

/** The version `git` on PATH answers for, or "" when it is missing or refuses to answer. */
function gitOnPath(): { path: string; version: string } {
	const found = programOnPath("git");
	if (!found) return { path: "", version: "" };
	const answer = spawnSync(found, ["--version"], { encoding: "utf8", timeout: 10_000 });
	const version = answer.status === 0 ? answer.stdout.trim() : "";
	return { path: found, version };
}

/**
 * The Node a shell would start pi-studio with. It is asked of PATH rather than of this process,
 * because the launcher's own shebang looks up `node` there: a machine can run this report on a good
 * Node while the next `pi-studio` would start on a distribution build that is too old.
 */
function nodePart(): DoctorPart {
	const requirement = nodeRequirement();
	const minimum = minimumOf(requirement);
	const found = nodeOnPath();
	if (!found.path) {
		return { part: "node", ok: false, detail: "no node on PATH, so the pi-studio command cannot start", fix: NODE_FIX(namedVersion(requirement)) };
	}
	if (!found.version) {
		return { part: "node", ok: false, detail: `${short(found.path)} did not answer for its version`, fix: NODE_FIX(namedVersion(requirement)) };
	}
	if (!atLeast(found.version, minimum)) {
		return {
			part: "node",
			ok: false,
			detail: `node ${found.version} at ${short(found.path)}, and this copy needs ${requirement || "an official build"}`,
			fix: NODE_FIX(namedVersion(requirement)),
		};
	}
	return { part: "node", ok: true, detail: `node ${found.version} at ${short(found.path)}`, fix: "" };
}

function gitPart(): DoctorPart {
	const found = gitOnPath();
	if (!found.path) return { part: "git", ok: false, detail: "no git on PATH, so no repository feature works", fix: GIT_FIX };
	if (!found.version) return { part: "git", ok: false, detail: `${short(found.path)} did not answer for its version`, fix: GIT_FIX };
	return { part: "git", ok: true, detail: found.version, fix: "" };
}

/**
 * The `pi` a thread would be started with, found the way the child's own command line finds it. The
 * managed install wins over PATH, so a machine with pi installed by its own installer is reported by
 * where pi really is instead of by what a shell happens to find first.
 */
function piPart(): DoctorPart {
	const cli = piCli();
	if (cli.command === process.execPath && cli.args.length > 0) {
		return { part: "pi", ok: true, detail: `pi at ${short(cli.args[0])}`, fix: "" };
	}
	const found = programOnPath("pi");
	if (!found) {
		return { part: "pi", ok: false, detail: "no pi install for this app to start, so no thread can run", fix: PI_FIX };
	}
	return { part: "pi", ok: true, detail: `pi at ${short(found)}`, fix: "" };
}

/** Every part, in the order the report prints them: what starts the app, then what it uses. */
export function collectReport(): DoctorReport {
	const parts = [nodePart(), gitPart(), piPart()];
	return { ok: parts.every((part) => part.ok), version: appVersion(), root: REPO_DIR, parts };
}

/**
 * The report as a human reads it: one line per part, its fix underneath when there is one, and a last
 * line that says whether anything needs doing. The missing parts are counted rather than described
 * twice, so the closing line stays one sentence however many are dark.
 */
export function formatReport(report: DoctorReport): string {
	const lines = [`pi-studio ${report.version} at ${short(report.root)}`];
	for (const part of report.parts) {
		lines.push(`  ${part.ok ? "ok     " : "missing"} ${part.part.padEnd(5)} ${part.detail}`);
		if (!part.ok && part.fix) lines.push(`          fix: ${part.fix}`);
	}
	const missing = report.parts.filter((part) => !part.ok).map((part) => part.part);
	if (missing.length === 0) {
		lines.push("everything this copy leans on is here; run pi-studio to start");
	} else {
		const counted = `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing`;
		// Without a Node there is no app to start, so the closing line must not promise a board.
		const consequence = report.parts.some((part) => part.part === "node" && !part.ok)
			? "the pi-studio command cannot start until node is there"
			: "the board still starts, and the parts above stay dark until they are installed";
		lines.push(`${counted}: ${consequence}`);
	}
	return lines.join("\n");
}

/**
 * Print the report, and answer whether everything is there. The launcher turns that answer into its
 * exit code, so a script can ask "is this machine whole?" without reading the English above it.
 */
export function runDoctor(flags: { json?: unknown } = {}): number {
	const report = collectReport();
	console.log(flags.json ? JSON.stringify(report, null, 2) : formatReport(report));
	return report.ok ? 0 : 1;
}
