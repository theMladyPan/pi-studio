/**
 * `pi-studio add <git-url>`: clone a plugin's repository into the plugins folder, build it when it
 * is Rust, and leave it for settings to offer — nothing is registered, so enable stays the human's
 * click. Adding one already installed pulls and rebuilds instead, and never touches the registration
 * beside it.
 *
 * The install is the whole checkout, `.git` and source included, because updating later is a pull
 * and a rebuild — a folder trimmed to its binary could never be updated by its author.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateDirOf } from "./runtime.mjs";

/** Run one program to completion. When streamed, its output is the human's; otherwise it is kept. */
function run(command, args, cwd, stream) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, shell: false, stdio: stream ? "inherit" : ["ignore", "pipe", "pipe"] });
		let stderr = "";
		if (!stream) {
			child.stdout?.on("data", () => {});
			child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
		}
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`)),
		);
	});
}

/** The folder a repository installs into: its own name, as the manifest is the source of the name. */
export function pluginNameOf(url) {
	const name = String(url ?? "")
		.trim()
		.replace(/\/+$/, "")
		.split("/")
		.pop()
		?.replace(/\.git$/i, "");
	if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
		throw new Error(`a plugin url ends in its name: ${JSON.stringify(url)}`);
	}
	return name;
}

/**
 * Build a cloned plugin. A Rust plugin is built here; any other plugin is expected to carry its
 * executable in the repository it publishes, and is refused here when it carries neither a build it
 * knows nor the executable its manifest names.
 */
async function build(target, stream) {
	if (existsSync(join(target, "Cargo.toml"))) {
		await run("cargo", ["build", "--release"], target, stream);
		return;
	}
	const manifest = JSON.parse(readFileSync(join(target, "plugin.json"), "utf8"));
	const named = typeof manifest.command === "string" ? manifest.command : undefined;
	const exe = named ?? "";
	if (exe === "") throw new Error("no Cargo.toml to build, and plugin.json names no command");
	try {
		accessSync(join(target, exe), constants.X_OK);
	} catch {
		throw new Error(`the plugin carries no built ${exe}: I know how to build a Rust plugin (Cargo.toml), and nothing else`);
	}
}

/** Install or update one plugin from its repository. Answers with the name and whether it updated. */
export async function addPlugin(url, options = {}) {
	const flags = options.flags ?? {};
	const stream = options.stream ?? false;
	const pluginsDir = join(stateDirOf(flags), "plugins");
	const name = pluginNameOf(url);
	const target = join(pluginsDir, name);
	if (existsSync(join(target, ".git"))) {
		await run("git", ["pull", "--ff-only"], target, stream);
		await build(target, stream);
		return { name, updated: true, dir: target };
	}
	if (existsSync(target)) {
		throw new Error(`${target} already exists and is not a checkout; remove it first, or copy the plugin in by hand`);
	}
	await run("git", ["clone", "--depth", "1", url, target], undefined, stream);
	try {
		if (!existsSync(join(target, "plugin.json"))) {
			throw new Error("that repository is not a plugin: it carries no plugin.json");
		}
		await build(target, stream);
	} catch (error) {
		rmSync(target, { recursive: true, force: true });
		throw error;
	}
	return { name, updated: false, dir: target };
}
