/**
 * Kontainer actions: container lifecycle over the Engine API, compose / build /
 * pull / push / login through the runtime CLI (`execFile`, never a shell), and
 * the safe terminal commands the drawer opens in its terminal.
 */
import { execFile, spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { discoverRuntimes, requestJson, resolveRuntime } from "./socket.ts";
import type { Runtime } from "./socket.ts";
import { asRecord, asString } from "./topology.ts";

export interface KontainerBoardLike {
	folder: string;
}

export interface ActionResult {
	ok: boolean;
	output?: string;
	error?: string;
	[key: string]: unknown;
}

export const ID_RE = /^[a-zA-Z0-9_.-]{1,128}$/;
const IMAGE_ID_RE = /^[a-zA-Z0-9_.\-:@]{1,256}$/;
const IMAGE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/;
const TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/;

export function isValidId(value: unknown): boolean {
	return typeof value === "string" && ID_RE.test(value);
}

export function isValidImageId(value: unknown): boolean {
	return typeof value === "string" && IMAGE_ID_RE.test(value);
}

export function isValidImageRef(value: unknown): boolean {
	return typeof value === "string" && value.length <= 256 && IMAGE_REF_RE.test(value) && !value.startsWith("-") && !value.includes("..");
}

export function isValidTag(value: unknown): boolean {
	return typeof value === "string" && value.length <= 256 && TAG_RE.test(value) && !value.startsWith("-") && !value.includes("..");
}

/** Resolve `candidate` against the workspace folder; null when it escapes it. */
export function resolveInsideFolder(folder: string, candidate: string): string | null {
	if (!folder || !candidate) return null;
	const base = resolve(folder);
	const target = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
	const rel = relative(base, target);
	if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) return null;
	return target;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ExecCommandOptions {
	cli?: string;
	folder?: string;
}

/** The safe shell command the terminal drawer runs for `exec.cmd` actions. */
export function buildExecCommand(body: Record<string, unknown>, opts: ExecCommandOptions = {}): ActionResult {
	const cli = opts.cli ?? "docker";
	const mode = asString(body.mode);
	if (mode === "exec" || mode === "logs") {
		const id = body.id;
		if (!isValidId(id)) return { ok: false, error: "a valid container id is required" };
		const short = (id as string).slice(0, 12);
		const command = mode === "exec" ? `${cli} exec -it ${short} sh` : `${cli} logs -f --tail 100 ${short}`;
		return { ok: true, command };
	}
	if (mode === "compose-logs") {
		const composeFile = typeof body.composeFile === "string" ? body.composeFile : "";
		if (composeFile) {
			const inside = opts.folder ? resolveInsideFolder(opts.folder, composeFile) : null;
			if (!inside) return { ok: false, error: "compose file must be inside the workspace folder" };
			return { ok: true, command: `${cli} compose -f ${shellQuote(inside)} logs -f` };
		}
		return { ok: true, command: `${cli} compose logs -f` };
	}
	return { ok: false, error: `unknown exec mode: ${mode || "(none)"}` };
}

// ---------- CLI execution ----------

export interface RunResult {
	code: number;
	output: string;
}

export type Runner = (cli: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;

export function execFileRunner(cli: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		execFile(cli, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const output = [stdout, stderr].filter((part) => part && part.length > 0).join("");
			if (error) {
				const exit = asRecord(error as unknown);
				const code = typeof exit.code === "number" ? exit.code : 1;
				resolvePromise({ code, output: output || error.message });
			} else {
				resolvePromise({ code: 0, output });
			}
		});
	});
}

/** `login` with the password on stdin only — never in argv, never in logs. */
function loginRunner(cli: string, args: string[], password: string, cwd: string, timeoutMs: number): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(cli, args, { cwd, timeout: timeoutMs });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		child.on("error", (error) => resolvePromise({ code: 1, output: output || error.message }));
		child.on("close", (code) => resolvePromise({ code: code ?? 1, output }));
		child.stdin.on("error", () => {});
		child.stdin.end(password);
	});
}

function cliResult(result: RunResult): ActionResult {
	if (result.code === 0) return { ok: true, output: result.output };
	return { ok: false, output: result.output, error: result.output.trim() || `command exited with code ${result.code}` };
}

// ---------- dispatch ----------

export interface HandleActionOptions {
	runtimes?: Runtime[];
	run?: Runner;
	/** Test seam: login runner override. */
	login?: (cli: string, args: string[], password: string, cwd: string, timeoutMs: number) => Promise<RunResult>;
}

const LIFECYCLE: Record<string, { method: string; suffix: string }> = {
	start: { method: "POST", suffix: "/start" },
	stop: { method: "POST", suffix: "/stop" },
	restart: { method: "POST", suffix: "/restart" },
	kill: { method: "POST", suffix: "/kill" },
	remove: { method: "DELETE", suffix: "" },
};

export async function handleAction(board: KontainerBoardLike, rawBody: unknown, opts: HandleActionOptions = {}): Promise<ActionResult> {
	const body = asRecord(rawBody);
	const action = asString(body.action);
	if (!action) return { ok: false, error: "an action is required" };
	const folder = board.folder ?? "";

	if (action === "exec.cmd") {
		const runtimes = opts.runtimes ?? discoverRuntimes();
		const runtime = resolveRuntime(runtimes, typeof body.runtime === "string" ? body.runtime : null);
		return buildExecCommand(body, { cli: runtime?.cli ?? "docker", folder });
	}

	const runtimes = opts.runtimes ?? discoverRuntimes();
	const runtime = resolveRuntime(runtimes, typeof body.runtime === "string" ? body.runtime : null);
	if (!runtime) return { ok: false, error: "no Docker or Podman socket found" };
	const run = opts.run ?? execFileRunner;
	const cli = runtime.cli;

	if (action in LIFECYCLE) {
		const id = body.id;
		if (!isValidId(id)) return { ok: false, error: "a valid container id is required" };
		const spec = LIFECYCLE[action];
		try {
			const payload = await requestJson(runtime, `/containers/${encodeURIComponent(id as string)}${spec.suffix}`, { method: spec.method });
			return { ok: true, output: typeof payload === "string" ? payload : payload === null ? "" : JSON.stringify(payload) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	if (action === "recreate") {
		const id = body.id;
		if (!isValidId(id)) return { ok: false, error: "a valid container id is required" };
		let labels: Record<string, unknown>;
		try {
			const inspected = asRecord(await requestJson(runtime, `/containers/${encodeURIComponent(id as string)}/json`));
			labels = asRecord(asRecord(inspected.Config).Labels);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		const workingDir = asString(labels["com.docker.compose.project.working_dir"]);
		const service = asString(labels["com.docker.compose.service"]);
		if (!workingDir || !service) {
			return { ok: false, error: "this container was not started by compose, so it cannot be recreated" };
		}
		return cliResult(await run(cli, ["compose", "up", "-d", "--no-deps", "--force-recreate", service], { cwd: workingDir, timeoutMs: 120_000 }));
	}

	if (action === "compose.up" || action === "compose.restart" || action === "compose.down") {
		const args: string[] = ["compose"];
		const composeFile = typeof body.file === "string" ? body.file : typeof body.composeFile === "string" ? body.composeFile : "";
		if (composeFile) {
			const inside = resolveInsideFolder(folder, composeFile);
			if (!inside) return { ok: false, error: "compose file must be inside the workspace folder" };
			args.push("-f", inside);
		}
		const verb = action === "compose.up" ? "up" : action === "compose.restart" ? "restart" : "down";
		args.push(verb);
		if (verb === "up") args.push("-d");
		if (!folder) return { ok: false, error: "this workspace has no folder" };
		return cliResult(await run(cli, args, { cwd: folder, timeoutMs: 120_000 }));
	}

	if (action === "build") {
		const tag = body.tag;
		if (!isValidTag(tag)) return { ok: false, error: "a valid image tag is required" };
		const args: string[] = ["build"];
		const dockerfile = typeof body.dockerfile === "string" ? body.dockerfile : "";
		if (dockerfile) {
			const inside = resolveInsideFolder(folder, dockerfile);
			if (!inside) return { ok: false, error: "dockerfile must be inside the workspace folder" };
			args.push("-f", inside);
		}
		if (body.noCache === true) args.push("--no-cache");
		args.push("-t", tag as string, ".");
		if (!folder) return { ok: false, error: "this workspace has no folder" };
		return cliResult(await run(cli, args, { cwd: folder, timeoutMs: 120_000 }));
	}

	if (action === "image.pull" || action === "image.push") {
		const image = body.image;
		if (!isValidImageRef(image)) return { ok: false, error: "a valid image reference is required" };
		const verb = action === "image.pull" ? "pull" : "push";
		return cliResult(await run(cli, [verb, image as string], { cwd: folder || "/", timeoutMs: 120_000 }));
	}

	if (action === "image.search") {
		const term = asString(body.term);
		if (!term) return { ok: false, error: "a search term is required" };
		try {
			const results = await requestJson(runtime, `/images/search?term=${encodeURIComponent(term)}&limit=20`);
			return { ok: true, results };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	if (action === "image.remove") {
		const id = body.id;
		if (!isValidImageId(id)) return { ok: false, error: "a valid image id is required" };
		const query = body.force === true ? "?force=1" : "";
		try {
			const payload = await requestJson(runtime, `/images/${encodeURIComponent(id as string)}${query}`, { method: "DELETE" });
			return { ok: true, output: payload === null ? "" : JSON.stringify(payload) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	if (action === "registry.login") {
		const username = asString(body.username);
		const password = asString(body.password);
		if (!username || username.startsWith("-")) return { ok: false, error: "a username is required" };
		if (!password) return { ok: false, error: "a password is required" };
		const server = asString(body.server);
		if (server && (server.startsWith("-") || server.includes(" "))) return { ok: false, error: "invalid registry server" };
		const args: string[] = ["login"];
		if (server) args.push(server);
		args.push("-u", username, "--password-stdin");
		const login = opts.login ?? loginRunner;
		const result = await login(cli, args, password, folder || "/", 30_000);
		if (result.code === 0) return { ok: true, output: result.output };
		return { ok: false, output: result.output, error: result.output.trim() || "login failed" };
	}

	if (action === "prune") {
		const target = asString(body.target);
		const targets: string[] = target === "all" ? ["images", "containers", "volumes"] : [target];
		if (!["images", "containers", "volumes", "all"].includes(target)) {
			return { ok: false, error: 'target must be "images", "containers", "volumes" or "all"' };
		}
		let reclaimedBytes = 0;
		const parts: string[] = [];
		try {
			for (const name of targets) {
				const payload = asRecord(await requestJson(runtime, `/${name}/prune`, { method: "POST", body: "{}" }));
				const space = payload.SpaceReclaimed;
				if (typeof space === "number") reclaimedBytes += space;
				parts.push(`${name}: ${JSON.stringify(payload)}`);
			}
		} catch (error) {
			return { ok: false, reclaimedBytes, error: error instanceof Error ? error.message : String(error) };
		}
		return { ok: true, reclaimedBytes, output: parts.join("\n") };
	}

	return { ok: false, error: `unknown action: ${action}` };
}
