/**
 * `pi-studio add <git-url>`: a repository becomes a folder in the plugins folder and nothing more.
 *
 * The fixture is a real git repository made here, with a plugin.json and a script as its executable,
 * so the install and its update are the real commands against a real remote — no cargo, no network.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";

const { addPlugin, pluginNameOf } = await import("../bin/plugin-add.mjs");

const root = mkdtempSync(join(tmpdir(), "pi-studio-plugin-add-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** What pi-studio is handed, as a flag: the state folder to install under. */
const flags = { state: root };

const git = (dir: string, args: string[]) => execFileSync("git", [`-C`, dir, ...args], { stdio: "ignore" });

/** A plugin repository: plugin.json, its panel, and a script as the executable. */
function sourceRepo(name: string) {
	// The folder is the repository's name, as a cloned repository's name is, so the install takes it.
	const dir = join(root, "src", name);
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q"]);
	writeFileSync(
		join(dir, "plugin.json"),
		JSON.stringify({
			name,
			version: "1.0.0",
			protocol: 1,
			command: name,
			visual: { title: name, entry: "panel.html", files: ["panel.html"] },
		}),
	);
	writeFileSync(join(dir, "panel.html"), "<!doctype html><title>panel</title>\n");
	writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n");
	chmodSync(join(dir, name), 0o755);
	git(dir, ["add", "-A"]);
	git(dir, ["-c", "user.email=agent@local", "-c", "user.name=agent", "commit", "-q", "-m", "first"]);
	return dir;
}

test("a url's last segment is the name it installs under", () => {
	assert.equal(pluginNameOf("https://github.com/theMladyPan/bughound.git"), "bughound");
	assert.equal(pluginNameOf("git@github.com:theMladyPan/bughound.git"), "bughound");
	assert.equal(pluginNameOf("https://example.com/a/b//"), "b");
	assert.throws(() => pluginNameOf("https://example.com/"), /a plugin url/);
	assert.throws(() => pluginNameOf("https://example.com/a/b_c"), /a plugin url/);
});

test("add clones a plugin repository into the plugins folder, and registers nothing", async () => {
	const source = sourceRepo("tokenizer");
	const { name, updated, dir } = await addPlugin(source, { flags });
	assert.equal(name, "tokenizer");
	assert.equal(updated, false);
	assert.equal(existsSync(join(dir, "plugin.json")), true);
	assert.equal(existsSync(join(dir, "tokenizer")), true);
	assert.equal(statSync(join(dir, ".git")).isDirectory(), true, "the whole checkout stays, for updates");
	assert.equal(existsSync(join(root, "plugins.json")), false, "nothing is registered by an install");
});

test("adding one already installed pulls and rebuilds, and keeps what it had", async () => {
	const source = sourceRepo("poller");
	await addPlugin(source, { flags });
	const target = join(root, "plugins", "poller");
	writeFileSync(join(source, "panel.html"), "<!doctype html><title>second</title>\n");
	git(source, ["add", "-A"]);
	git(source, ["-c", "user.email=agent@local", "-c", "user.name=agent", "commit", "-q", "-m", "second"]);
	const again = await addPlugin(source, { flags });
	assert.equal(again.updated, true);
	assert.match(readPanel(target), /second/);
	function readPanel(dir: string) {
		return execFileSync("cat", [join(dir, "panel.html")], { encoding: "utf8" });
	}
});

test("a folder that is not a checkout is refused, and a repository that is not a plugin is unwound", async () => {
	const taken = join(root, "plugins", "taken");
	mkdirSync(taken, { recursive: true });
	const source = sourceRepo("taken");
	await assert.rejects(addPlugin(source, { flags }), /already exists and is not a checkout/);

	const bare = join(root, "src", "plain");
	mkdirSync(bare, { recursive: true });
	git(bare, ["init", "-q"]);
	writeFileSync(join(bare, "README.md"), "# nothing\n");
	git(bare, ["add", "-A"]);
	git(bare, ["-c", "user.email=agent@local", "-c", "user.name=agent", "commit", "-q", "-m", "first"]);
	await assert.rejects(addPlugin(bare, { flags }), /not a plugin/);
	assert.equal(existsSync(join(root, "plugins", "plain")), false, "the failed clone is gone again");
});
