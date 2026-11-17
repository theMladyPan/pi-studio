/**
 * The release archive and the shell bootstrap that installs it.
 *
 * `npm run package` is driven into a temporary folder, then the generated `install.sh` is run the
 * way a user runs it — through `curl … | sh` against a loopback release fixture — and the
 * installed copy is asked for its version, updated and uninstalled. Every root here is a throwaway
 * under the OS temp folder: no real install, no real state, no GitHub.
 *
 * Children are spawned asynchronously, because the release fixture answers on this same event
 * loop; `spawnSync` would deadlock the download it waits for. Every child, download and fixture
 * teardown is bounded.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const template = join(root, "install.sh");
const packager = join(root, "bin", "package-release.mjs");
/** Every child operation is bounded, so a build, a download or a fixture that never answers fails. */
const CHILD_TIMEOUT_MS = 120_000;

type ChildResult = { status: number; stdout: string; stderr: string };

function run(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<ChildResult> {
	return new Promise((resolvePromise) => {
		execFile(
			file,
			args,
			{
				encoding: "utf8",
				cwd: options.cwd ?? root,
				env: options.env ?? process.env,
				timeout: CHILD_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: 64 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				const failed = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
				const status = failed ? (typeof failed.code === "number" ? failed.code : 1) : 0;
				const note = failed?.killed ? `${stderr}\n[test] child killed after ${CHILD_TIMEOUT_MS}ms\n` : stderr;
				resolvePromise({ status, stdout, stderr: note });
			},
		);
	});
}

/** Listing a local archive cannot touch the fixture, so a bounded synchronous call is safe here. */
function tarLines(archive: string, verbose: boolean): string[] {
	const result = execFileSync("tar", [verbose ? "-tvzf" : "-tzf", archive], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
	return result.split("\n").filter(Boolean);
}

type Packaged = { out: string; version: string; archiveName: string; archive: Buffer; checksum: string; installer: string };

let packaged: Packaged;

before(async () => {
	const out = mkdtempSync(join(tmpdir(), "pi-studio-package-out-"));
	const built = await run(process.execPath, [packager, "--out", out]);
	assert.equal(built.status, 0, built.stderr || built.stdout);
	const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
	const archiveName = `pi-studio-${version}.tar.gz`;
	packaged = {
		out,
		version,
		archiveName,
		archive: readFileSync(join(out, archiveName)),
		checksum: readFileSync(join(out, `${archiveName}.sha256`), "utf8"),
		installer: readFileSync(join(out, "install.sh"), "utf8"),
	};
});

after(() => {
	if (packaged) rmSync(packaged.out, { recursive: true, force: true });
});

type Served = { installScript: string; archive: Buffer; checksum: string; release: unknown; assets: Record<string, Buffer> };
type Fixture = { baseUrl: string; apiUrl: string; serve: (next: Partial<Served>) => void; close: () => Promise<void> };

async function startFixture(t: { after: (fn: () => Promise<void> | void) => void }): Promise<Fixture> {
	const served: Served = {
		installScript: packaged.installer,
		archive: packaged.archive,
		checksum: packaged.checksum,
		release: null,
		assets: {},
	};
	const sockets = new Set<Socket>();
	const server = createServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/install.sh") {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end(served.installScript);
			return;
		}
		if (url.pathname === `/v${packaged.version}/${packaged.archiveName}`) {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(served.archive);
			return;
		}
		if (url.pathname === `/v${packaged.version}/${packaged.archiveName}.sha256`) {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end(served.checksum);
			return;
		}
		const asset = url.pathname.startsWith("/assets/") ? served.assets[url.pathname.slice("/assets/".length)] : undefined;
		if (asset) {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(asset);
			return;
		}
		if (url.pathname === "/api/theMladyPan/pi-studio/releases/latest") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(served.release));
			return;
		}
		res.writeHead(404);
		res.end("not found");
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const fixture: Fixture = {
		baseUrl: `http://127.0.0.1:${port}`,
		apiUrl: `http://127.0.0.1:${port}/api`,
		serve(next) {
			Object.assign(served, next);
		},
		close() {
			return new Promise<void>((resolvePromise, reject) => {
				const fallback = setTimeout(() => {
					for (const socket of sockets) socket.destroy();
				}, 5_000);
				fallback.unref();
				server.close((error) => {
					clearTimeout(fallback);
					for (const socket of sockets) socket.destroy();
					sockets.clear();
					if (error) reject(error);
					else resolvePromise();
				});
				server.closeIdleConnections();
			});
		},
	};
	t.after(() => fixture.close());
	return fixture;
}

function tempRoots(t: { after: (fn: () => void) => void }) {
	const base = mkdtempSync(join(tmpdir(), "pi-studio-bootstrap-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const roots = {
		base,
		home: join(base, "home"),
		installRoot: join(base, "install"),
		binDir: join(base, "bin"),
		stateDir: join(base, "state"),
		tmp: join(base, "tmp"),
	};
	for (const dir of [roots.home, roots.stateDir, roots.tmp]) mkdirSync(dir, { recursive: true });
	return roots;
}

function envFor(roots: ReturnType<typeof tempRoots>, fixture: Fixture, extra: Record<string, string> = {}) {
	return {
		...process.env,
		HOME: roots.home,
		TMPDIR: roots.tmp,
		XDG_DATA_HOME: "",
		XDG_STATE_HOME: "",
		PI_STUDIO_INSTALL_ROOT: roots.installRoot,
		PI_STUDIO_BIN_DIR: roots.binDir,
		PI_STUDIO_STATE: roots.stateDir,
		PI_STUDIO_RELEASE_BASE_URL: fixture.baseUrl,
		...extra,
	};
}

function installScript() {
	return join(packaged.out, "install.sh");
}

function runInstaller(
	roots: ReturnType<typeof tempRoots>,
	fixture: Fixture,
	args: string[] = [],
	extra: Record<string, string> = {},
): Promise<ChildResult> {
	return run("sh", [installScript(), ...args], { env: envFor(roots, fixture, extra) });
}

function installedVersion(roots: ReturnType<typeof tempRoots>): string {
	const meta = JSON.parse(readFileSync(join(roots.installRoot, "install.json"), "utf8"));
	const entry = meta.versions.find((one: { dir: string }) => one.dir === meta.currentVersionDir);
	return entry.version;
}

/** An official archive of another version, built the way a release is, to update onto. */
function officialArchive(version: string, t: { after: (fn: () => void) => void }) {
	const dir = mkdtempSync(join(tmpdir(), `pi-studio-official-${version}-`));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const folder = `pi-studio-${version}`;
	const tree = join(dir, folder);
	mkdirSync(tree, { recursive: true });
	execFileSync("tar", ["-xzf", join(packaged.out, packaged.archiveName), "-C", tree, "--strip-components=1"], { timeout: CHILD_TIMEOUT_MS });
	const pkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
	pkg.version = version;
	writeFileSync(join(tree, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
	const commit = "b".repeat(40);
	writeFileSync(
		join(tree, "build.json"),
		`${JSON.stringify({ name: "pi-studio", version, commit, commitShort: commit.slice(0, 7), tag: `v${version}`, official: true, custom: false, dirty: false, source: "source-build" }, null, 2)}\n`,
	);
	const archiveName = `${folder}.tar.gz`;
	const archivePath = join(dir, archiveName);
	execFileSync("tar", ["-czf", archivePath, "-C", dir, folder], { timeout: CHILD_TIMEOUT_MS });
	const bytes = readFileSync(archivePath);
	const sha = createHash("sha256").update(bytes).digest("hex");
	return { version, commit, archiveName, bytes, sha, checksumName: `${archiveName}.sha256` };
}

test("package writes the tarball, its checksum and the pinned installer under the names the updater downloads", () => {
	const { version, archiveName, archive, checksum } = packaged;
	assert.equal(checksum, `${createHash("sha256").update(archive).digest("hex")}  ${archiveName}\n`, "checksum names its own archive");

	// Exactly one top-level folder, which the manager strips on extraction.
	const names = tarLines(join(packaged.out, archiveName), false);
	assert.ok(names.length > 20, "the archive holds the whole staged tree");
	for (const name of names) assert.ok(name.startsWith(`pi-studio-${version}/`), `entry outside the single top folder: ${name}`);
	const required = [
		"server.js",
		"public/index.html",
		"bridge/child-bridge.mjs",
		"prompts/modes/boss.md",
		"docs/boss-and-subagents.md",
		"bin/pi-studio",
		"bin/runtime.mjs",
		"bin/manage.mjs",
		"package.json",
		"build.json",
	];
	for (const file of required) assert.ok(names.includes(`pi-studio-${version}/${file}`), `archive is missing ${file}`);
	assert.ok(!names.includes(`pi-studio-${version}/bin/install.mjs`), "the source-only install entry stays out");

	// No Node binary, no dependency tree, no TypeScript, no tests.
	for (const name of names) {
		assert.ok(!/(^|\/)node_modules(\/|$)/.test(name), `archive carries node_modules: ${name}`);
		assert.ok(!/(^|\/)(node|node\.exe)$/.test(name), `archive carries a Node binary: ${name}`);
		assert.ok(!name.endsWith(".ts"), `archive carries TypeScript: ${name}`);
	}
	const launcherLine = tarLines(join(packaged.out, archiveName), true).find((line) => line.endsWith(`pi-studio-${version}/bin/pi-studio`));
	assert.ok(launcherLine, "the launcher is in the archive");
	assert.match(launcherLine, /^-rwx/, `the archived launcher is executable: ${launcherLine}`);

	// The installer is the template with its version filled in, and it is runnable as it is.
	const { installer } = packaged;
	assert.ok(!installer.includes("@@"), "no version token survives packaging");
	assert.match(installer, new RegExp(`^PI_STUDIO_VERSION='${version.replaceAll(".", "\\.")}'$`, "m"));
	assert.ok(installer.includes(`archive_name="pi-studio-$PI_STUDIO_VERSION.tar.gz"`), "the installer names its own archive");
	assert.match(installer, /^#!\/bin\/sh\n/, "the installer is a POSIX sh script");
	assert.ok(readFileSync(template, "utf8").includes("@@PI_STUDIO_VERSION@@"), "the repository copy stays a template");
});

test("the raw template refuses before it reads a version or downloads anything", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	const refused = await run("sh", [template], { env: envFor(roots, fixture) });
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /unexpanded installer template/);
	assert.match(refused.stderr, /releases\/latest\/download\/install\.sh/);
	assert.ok(!existsSync(roots.installRoot), "nothing was installed");
	assert.ok(!existsSync(join(roots.binDir, "pi-studio")), "no launcher was written");
});

test("curl … | sh installs the pinned release, which then answers --version and leaves state alone", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	writeFileSync(join(roots.stateDir, "board.json"), "{}\n");
	writeFileSync(join(roots.stateDir, "keep.txt"), "user data stays\n");

	// The documented pipeline: the installer arrives on stdin, as it does from the latest release URL.
	const piped = await run("sh", ["-c", 'curl -fsSL "$1" | sh', "sh", `${fixture.baseUrl}/install.sh`], {
		env: envFor(roots, fixture),
	});
	assert.equal(piped.status, 0, piped.stderr || piped.stdout);
	assert.match(piped.stdout, new RegExp(`done: pi-studio ${packaged.version.replaceAll(".", "\\.")} is installed`));
	assert.match(piped.stdout, /is not on PATH/, "a missing local bin folder is reported, never added for you");

	assert.equal(installedVersion(roots), packaged.version);
	const versionDir = join(roots.installRoot, "versions", JSON.parse(readFileSync(join(roots.installRoot, "install.json"), "utf8")).currentVersionDir);
	assert.ok(existsSync(join(versionDir, "server.js")));
	assert.ok(lstatSync(join(roots.installRoot, "current")).isSymbolicLink());
	const launcherPath = join(roots.binDir, "pi-studio");
	assert.ok(lstatSync(launcherPath).isSymbolicLink());
	assert.equal(readlinkSync(launcherPath), join(roots.installRoot, "current", "bin", "pi-studio"));

	const versionOut = await run(process.execPath, [launcherPath, "--version"], { env: envFor(roots, fixture) });
	assert.equal(versionOut.status, 0, versionOut.stderr);
	assert.ok(versionOut.stdout.includes(packaged.version), versionOut.stdout);

	assert.equal(readFileSync(join(roots.stateDir, "board.json"), "utf8"), "{}\n", "state is untouched by an install");
	assert.equal(readFileSync(join(roots.stateDir, "keep.txt"), "utf8"), "user data stays\n");
	assert.deepEqual(readdirSync(roots.tmp), [], "the private temporary folder is cleaned up");
});

test("the installed copy updates to the next official release, then uninstalls and keeps state", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	const installed = await runInstaller(roots, fixture);
	assert.equal(installed.status, 0, installed.stderr || installed.stdout);

	const next = officialArchive("0.2.0", t);
	// The update path reads the release from the GitHub API root and its assets from the URLs the
	// release names, so both are answered by the one loopback fixture.
	fixture.serve({
		assets: { [next.archiveName]: next.bytes, [next.checksumName]: Buffer.from(`${next.sha}  ${next.archiveName}\n`) },
		release: {
			tag_name: "v0.2.0",
			draft: false,
			prerelease: false,
			assets: [
				{ name: next.archiveName, browser_download_url: `${fixture.baseUrl}/assets/${next.archiveName}` },
				{ name: next.checksumName, browser_download_url: `${fixture.baseUrl}/assets/${next.checksumName}` },
			],
		},
	});

	writeFileSync(join(roots.stateDir, "keep.txt"), "user data stays\n");
	const refused = await run(process.execPath, [join(roots.binDir, "pi-studio"), "update"], {
		env: envFor(roots, fixture, { PI_STUDIO_GITHUB_API: fixture.apiUrl }),
	});
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /--replace-custom/, "a custom copy is never replaced without consent");
	assert.equal(installedVersion(roots), packaged.version);

	const updated = await run(process.execPath, [join(roots.binDir, "pi-studio"), "update", "--replace-custom"], {
		env: envFor(roots, fixture, { PI_STUDIO_GITHUB_API: fixture.apiUrl }),
	});
	assert.equal(updated.status, 0, updated.stderr || updated.stdout);
	assert.equal(installedVersion(roots), "0.2.0");

	const versionOut = await run(process.execPath, [join(roots.binDir, "pi-studio"), "--version"]);
	assert.ok(versionOut.stdout.includes("0.2.0"), versionOut.stdout);

	const removed = await run(process.execPath, [join(roots.binDir, "pi-studio"), "uninstall"], { env: envFor(roots, fixture) });
	assert.equal(removed.status, 0, removed.stderr || removed.stdout);
	assert.ok(!existsSync(roots.installRoot), "the install root is gone");
	assert.ok(!existsSync(join(roots.binDir, "pi-studio")), "the launcher is gone");
	assert.equal(readFileSync(join(roots.stateDir, "keep.txt"), "utf8"), "user data stays\n", "state survives an uninstall");
});

test("a checksum mismatch stops the install before extraction", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	fixture.serve({ checksum: `${"0".repeat(64)}  ${packaged.archiveName}\n` });
	const refused = await runInstaller(roots, fixture);
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /checksum mismatch/);
	assert.ok(!existsSync(roots.installRoot), "nothing was installed");
	assert.deepEqual(readdirSync(roots.tmp), [], "the archive is not left behind");
});

test("an archive holding a link, a special file or an escaping path is refused even with a matching checksum", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	const source = mkdtempSync(join(tmpdir(), "pi-studio-evil-"));
	t.after(() => rmSync(source, { recursive: true, force: true }));
	const tree = join(source, `pi-studio-${packaged.version}`);
	mkdirSync(tree, { recursive: true });
	writeFileSync(join(tree, "package.json"), "{}\n");
	const secret = join(source, "secret.txt");
	writeFileSync(secret, "untouched\n");
	symlinkSync(secret, join(tree, "planted-link"));

	const linkArchive = join(source, `${packaged.version}-link.tar.gz`);
	execFileSync("tar", ["-czf", linkArchive, "-C", source, `pi-studio-${packaged.version}`], { timeout: CHILD_TIMEOUT_MS });
	const linkBytes = readFileSync(linkArchive);
	fixture.serve({
		archive: linkBytes,
		checksum: `${createHash("sha256").update(linkBytes).digest("hex")}  ${packaged.archiveName}\n`,
	});
	const linked = await runInstaller(roots, fixture);
	assert.notEqual(linked.status, 0);
	assert.match(linked.stderr, /link or special entry/);
	assert.equal(readFileSync(secret, "utf8"), "untouched\n");
	assert.ok(!existsSync(roots.installRoot), "nothing was installed");

	// A path that points outside the extraction folder is refused the same way.
	const absolute = join(source, `${packaged.version}-absolute.tar.gz`);
	execFileSync("tar", ["-czf", absolute, "-P", secret], { timeout: CHILD_TIMEOUT_MS });
	const absoluteBytes = readFileSync(absolute);
	fixture.serve({
		archive: absoluteBytes,
		checksum: `${createHash("sha256").update(absoluteBytes).digest("hex")}  ${packaged.archiveName}\n`,
	});
	const escaped = await runInstaller(roots, fixture);
	assert.notEqual(escaped.status, 0);
	assert.match(escaped.stderr, /absolute path/);
	assert.equal(readFileSync(secret, "utf8"), "untouched\n");
	assert.ok(!existsSync(roots.installRoot), "nothing was installed");
});

test("a release asset of another version is refused rather than installed in place of the pinned one", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	const other = officialArchive("0.2.0", t);
	fixture.serve({
		archive: other.bytes,
		checksum: `${other.sha}  ${packaged.archiveName}\n`,
	});
	const refused = await runInstaller(roots, fixture);
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /holds 0\.2\.0, and this installer names/);
	assert.ok(!existsSync(roots.installRoot), "nothing was installed");
});

test("a foreign launcher and a foreign install root are refused, and their files are kept", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	mkdirSync(roots.binDir, { recursive: true });
	writeFileSync(join(roots.binDir, "pi-studio"), "#!/bin/sh\necho foreign\n");
	const foreign = await runInstaller(roots, fixture);
	assert.notEqual(foreign.status, 0);
	assert.match(foreign.stderr, /foreign command/);
	assert.equal(readFileSync(join(roots.binDir, "pi-studio"), "utf8"), "#!/bin/sh\necho foreign\n");

	const other = tempRoots(t);
	mkdirSync(other.installRoot, { recursive: true });
	writeFileSync(join(other.installRoot, "keep.txt"), "not ours\n");
	const foreignRoot = await runInstaller(other, fixture);
	assert.notEqual(foreignRoot.status, 0);
	assert.match(foreignRoot.stderr, /not empty and is not owned/);
	assert.equal(readFileSync(join(other.installRoot, "keep.txt"), "utf8"), "not ours\n");
});

test("a truncated installer fails to parse and installs nothing", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	const truncated = join(roots.base, "truncated.sh");
	writeFileSync(truncated, packaged.installer.slice(0, Math.floor(packaged.installer.length / 2)));
	const refused = await run("sh", [truncated], { env: envFor(roots, fixture) });
	assert.notEqual(refused.status, 0, "a half-downloaded script never runs a step of its own");
	assert.ok(!existsSync(roots.installRoot), "nothing was installed");
	assert.deepEqual(readdirSync(roots.tmp), [], "nothing was downloaded either");
});

test("a release base that is not https is refused, except for an explicit loopback fixture", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	const remote = await runInstaller(roots, fixture, [], { PI_STUDIO_RELEASE_BASE_URL: "http://example.com/releases/download" });
	assert.notEqual(remote.status, 0);
	assert.match(remote.stderr, /only allowed for an explicit loopback test fixture/);
	const scheme = await runInstaller(roots, fixture, [], { PI_STUDIO_RELEASE_BASE_URL: "ftp://example.com/releases" });
	assert.notEqual(scheme.status, 0);
	assert.match(scheme.stderr, /must start with https:\/\//);
	assert.ok(!existsSync(roots.installRoot), "nothing was installed");
});

test("the installer rejects an argument it does not implement, and reports its version", async (t) => {
	const roots = tempRoots(t);
	const fixture = await startFixture(t);
	const unknown = await runInstaller(roots, fixture, ["--force"]);
	assert.notEqual(unknown.status, 0);
	assert.match(unknown.stderr, /unknown argument: --force/);
	const printed = await runInstaller(roots, fixture, ["--version"]);
	assert.equal(printed.status, 0, printed.stderr);
	assert.equal(printed.stdout.trim(), packaged.version);
	const help = await runInstaller(roots, fixture, ["--help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--replace-custom/);
	assert.ok(!existsSync(roots.installRoot), "neither flag installs anything");
});
