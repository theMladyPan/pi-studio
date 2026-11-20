/**
 * Managed installation lifecycle: install from a staged tree, update from a local
 * GitHub Releases fixture, and uninstall — all under temporary roots.
 *
 * Nothing here touches a real state folder, a real install, or GitHub. The fixture
 * server is a loopback HTTP server on an ephemeral port, and every install/bin/state
 * root is a throwaway under the OS temp folder.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(root, "bin", "pi-studio");
/** Every child operation here is bounded, so a fixture or build that never answers fails the test. */
const CHILD_TIMEOUT_MS = 60_000;
let staged: string;

type ChildResult = { status: number; stdout: string; stderr: string };

/**
 * Run a child to completion without blocking this process.
 *
 * `spawnSync` would freeze the event loop, and the release fixture below listens on that same
 * loop: an `update` run that fetches its loopback fixture would then wait on a server that can
 * never answer. Output is drained into the result, and a timeout or a spawn failure reports a
 * nonzero status so the existing exit assertions still read the same way.
 */
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

before(async () => {
	staged = mkdtempSync(join(tmpdir(), "pi-studio-install-staged-"));
	const built = await run(process.execPath, [join(root, "bin", "build-release.mjs"), "--out", staged]);
	assert.equal(built.status, 0, built.stderr || built.stdout);
	// These lifecycle tests install the staged tree as a custom copy: an update replaces a custom
	// copy only with `--replace-custom`, which is the behavior under test. A checkout sitting
	// exactly on a clean release tag (the publishing CI checkout itself) would stage an official
	// build and silently drop that premise, so stamp it custom like a dirty tagged build.
	const buildPath = join(staged, "build.json");
	const build = JSON.parse(readFileSync(buildPath, "utf8"));
	build.official = false;
	build.custom = true;
	writeFileSync(buildPath, `${JSON.stringify(build, null, 2)}\n`);
});

after(() => {
	if (staged) rmSync(staged, { recursive: true, force: true });
});

function tempRoots(t: { after: (fn: () => void) => void }) {
	const base = mkdtempSync(join(tmpdir(), "pi-studio-install-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const roots = {
		base,
		installRoot: join(base, "install"),
		binDir: join(base, "bin"),
		stateDir: join(base, "state"),
	};
	mkdirSync(roots.stateDir, { recursive: true });
	return roots;
}

function envFor(roots: ReturnType<typeof tempRoots>, extra: Record<string, string> = {}) {
	return {
		...process.env,
		PI_STUDIO_INSTALL_ROOT: roots.installRoot,
		PI_STUDIO_BIN_DIR: roots.binDir,
		PI_STUDIO_STATE: roots.stateDir,
		...extra,
	};
}

function runLauncher(args: string[], roots: ReturnType<typeof tempRoots>, extra: Record<string, string> = {}) {
	return run(process.execPath, [launcher, ...args], { env: envFor(roots, extra) });
}

async function installStaged(roots: ReturnType<typeof tempRoots>) {
	// Drive the same manager the source install script uses, without spawning npm.
	const result = await run(
		process.execPath,
		["-e", `import(${JSON.stringify(join(root, "bin", "manage.mjs"))}).then(m=>m.installFromDir(${JSON.stringify(staged)},{}))`],
		{ env: envFor(roots) },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

function currentVersion(roots: ReturnType<typeof tempRoots>): string {
	const meta = JSON.parse(readFileSync(join(roots.installRoot, "install.json"), "utf8"));
	return meta.versions.find((v: { dir: string }) => v.dir === meta.currentVersionDir).version;
}

/** A version newer than `version`, so these update fixtures stay an upgrade whatever version is packaged. */
function newerThan(version: string): string {
	const [major, minor, patch] = version.split(".").map(Number);
	return `${major}.${minor}.${patch + 1}`;
}

function makeOfficialTree(version: string, promptText: string | null, buildOverrides: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), `pi-studio-official-${version}-`));
	cpSync(staged, dir, { recursive: true });
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	pkg.version = version;
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
	const commit = "a".repeat(40);
	const build = {
		name: "pi-studio",
		version,
		commit,
		commitShort: commit.slice(0, 7),
		tag: `v${version}`,
		official: true,
		custom: false,
		dirty: false,
		source: "source-build",
		...buildOverrides,
	};
	writeFileSync(join(dir, "build.json"), `${JSON.stringify(build, null, 2)}\n`);
	if (promptText !== null) {
		mkdirSync(join(dir, "prompts", "modes"), { recursive: true });
		writeFileSync(join(dir, "prompts", "modes", "boss.md"), promptText);
	}
	const tarball = join(dir, "..", `pi-studio-${version}.tar.gz`);
	execFileSync("tar", ["-czf", tarball, "-C", dirname(dir), join(dir).split("/").pop()!], { stdio: "pipe", timeout: CHILD_TIMEOUT_MS });
	const tarballBytes = readFileSync(tarball);
	const sha = createHash("sha256").update(tarballBytes).digest("hex");
	return { dir, tarball: tarballBytes, tarballName: `pi-studio-${version}.tar.gz`, sha, checksumName: `pi-studio-${version}.tar.gz.sha256` };
}

type Fixture = { baseUrl: string; setRelease: (release: unknown, files: Record<string, Buffer>) => void; close: () => Promise<void> };

/** The one endpoint GitHub documents for the latest release; anything else is not found. */
const RELEASE_PATH = "/repos/theMladyPan/pi-studio/releases/latest";

async function startFixture(t: { after: (fn: () => Promise<void> | void) => void }): Promise<Fixture> {
	let release: unknown = null;
	let files: Record<string, Buffer> = {};
	const sockets = new Set<Socket>();
	const server = createServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === RELEASE_PATH) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(release));
			return;
		}
		if (url.pathname.startsWith("/assets/")) {
			const bytes = files[url.pathname.slice("/assets/".length)];
			if (bytes) {
				res.writeHead(200, { "content-type": "application/octet-stream" });
				res.end(bytes);
				return;
			}
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
	const baseUrl = `http://127.0.0.1:${port}`;
	const fixture: Fixture = {
		baseUrl,
		setRelease(nextRelease, nextFiles) {
			release = nextRelease;
			files = nextFiles;
		},
		close() {
			// Close the listener, release keep-alive connections the child left behind, and keep a
			// bounded fallback so a socket that never goes idle cannot hold the teardown open.
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

function releaseFor(
	fixture: Fixture,
	version: string,
	official: ReturnType<typeof makeOfficialTree>,
	checksumOverride: string | null = null,
	extra: Record<string, unknown> = {},
) {
	const checksum = Buffer.from(`${checksumOverride ?? official.sha}  ${official.tarballName}\n`);
	const release = {
		tag_name: `v${version}`,
		draft: false,
		prerelease: false,
		...extra,
		assets: [
			{ name: official.tarballName, browser_download_url: `${fixture.baseUrl}/assets/${official.tarballName}` },
			{ name: official.checksumName, browser_download_url: `${fixture.baseUrl}/assets/${official.checksumName}` },
		],
	};
	fixture.setRelease(release, { [official.tarballName]: official.tarball, [official.checksumName]: checksum });
}

test("--version works in the source clone and in a staged copy", async () => {
	const source = await run(process.execPath, [launcher, "--version"]);
	assert.equal(source.status, 0, source.stderr);
	assert.match(source.stdout, /^pi-studio \d+\.\d+\.\d+ \(commit \S+, custom, source\)/);

	const stagedOut = await run(process.execPath, [join(staged, "bin", "pi-studio"), "--version"]);
	assert.equal(stagedOut.status, 0, stagedOut.stderr);
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.ok(stagedOut.stdout.includes(`pi-studio ${pkg.version}`), stagedOut.stdout);
	assert.ok(existsSync(join(staged, "bin", "runtime.mjs")), "staged tree carries the lifecycle helpers");
	assert.ok(existsSync(join(staged, "bin", "manage.mjs")), "staged tree carries the lifecycle helpers");
	assert.ok(!existsSync(join(staged, "bin", "install.mjs")), "staged tree does not carry the source-only install entry");

	// The staged launcher asks the compiled doctor, which is the one rewrite the staging does beyond
	// the app entry: a specifier left as TypeScript would answer with a module-not-found instead.
	const stagedDoctor = await run(process.execPath, [join(staged, "bin", "pi-studio"), "doctor"]);
	assert.match(stagedDoctor.stdout, /^pi-studio \d+\.\d+\.\d+ at /m, stagedDoctor.stdout + stagedDoctor.stderr);
	for (const part of ["node", "git", "pi"]) assert.match(stagedDoctor.stdout, new RegExp(`(ok|missing)\\s+${part}`), stagedDoctor.stdout);
});

test("install stages a versioned copy, switches current and the launcher, and leaves the source alone", async (t) => {
	const roots = tempRoots(t);
	const beforeBytes = readFileSync(join(staged, "build.json"));
	await installStaged(roots);

	const meta = JSON.parse(readFileSync(join(roots.installRoot, "install.json"), "utf8"));
	assert.equal(meta.format, 1);
	assert.equal(meta.versions.length, 1);
	const versionDir = join(roots.installRoot, "versions", meta.currentVersionDir);
	assert.ok(existsSync(join(versionDir, "server.js")));
	assert.ok(existsSync(join(versionDir, "build.json")));
	assert.ok(lstatSync(join(roots.installRoot, "current")).isSymbolicLink());
	assert.equal(readlinkSync(join(roots.installRoot, "current")), versionDir);

	const launcherPath = join(roots.binDir, "pi-studio");
	assert.ok(lstatSync(launcherPath).isSymbolicLink());
	assert.equal(readlinkSync(launcherPath), join(roots.installRoot, "current", "bin", "pi-studio"));

	const out = await run(process.execPath, [launcherPath, "--version"]);
	assert.equal(out.status, 0, out.stderr);
	assert.ok(out.stdout.includes(`pi-studio ${currentVersion(roots)}`), out.stdout);
	assert.deepEqual(readFileSync(join(staged, "build.json")), beforeBytes, "the source tree is untouched");
});

test("install refuses a foreign launcher and a nonempty foreign install root", async (t) => {
	const roots = tempRoots(t);
	mkdirSync(roots.binDir, { recursive: true });
	writeFileSync(join(roots.binDir, "pi-studio"), "#!/bin/sh\necho foreign\n");
	const refused = await run(
		process.execPath,
		["-e", `import(${JSON.stringify(join(root, "bin", "manage.mjs"))}).then(m=>m.installFromDir(${JSON.stringify(staged)},{}))`],
		{ env: envFor(roots) },
	);
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /foreign command/);
	assert.equal(readFileSync(join(roots.binDir, "pi-studio"), "utf8"), "#!/bin/sh\necho foreign\n");

	const other = tempRoots(t);
	mkdirSync(other.installRoot, { recursive: true });
	writeFileSync(join(other.installRoot, "keep.txt"), "not ours\n");
	const refusedRoot = await run(
		process.execPath,
		["-e", `import(${JSON.stringify(join(root, "bin", "manage.mjs"))}).then(m=>m.installFromDir(${JSON.stringify(staged)},{}))`],
		{ env: envFor(other) },
	);
	assert.notEqual(refusedRoot.status, 0);
	assert.match(refusedRoot.stderr, /not empty and is not owned/);
	assert.equal(readFileSync(join(other.installRoot, "keep.txt"), "utf8"), "not ours\n");
});

test("update refuses to replace a custom copy without --replace-custom, then updates with it and writes a prompt report", async (t) => {
	const roots = tempRoots(t);
	await installStaged(roots);
	const customVersion = currentVersion(roots);
	const next = newerThan(customVersion);

	const fixture = await startFixture(t);
	const official = makeOfficialTree(next, "new shipped boss\n");
	t.after(() => rmSync(official.dir, { recursive: true, force: true }));
	releaseFor(fixture, next, official);

	const refused = await runLauncher(["update"], roots, { PI_STUDIO_GITHUB_API: fixture.baseUrl });
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /--replace-custom/);
	assert.equal(currentVersion(roots), customVersion);

	// A local override based on the old shipped copy, so the update has something to report.
	mkdirSync(join(roots.stateDir, "prompt-overrides", "modes"), { recursive: true });
	mkdirSync(join(roots.stateDir, "prompt-baseline", "modes"), { recursive: true });
	const oldShipped = readFileSync(join(roots.installRoot, "versions", JSON.parse(readFileSync(join(roots.installRoot, "install.json"), "utf8")).currentVersionDir, "prompts", "modes", "boss.md"), "utf8");
	writeFileSync(join(roots.stateDir, "prompt-baseline", "modes", "boss.md"), oldShipped);
	writeFileSync(join(roots.stateDir, "prompt-overrides", "modes", "boss.md"), "my boss\n");

	const updated = await runLauncher(["update", "--replace-custom"], roots, { PI_STUDIO_GITHUB_API: fixture.baseUrl });
	assert.equal(updated.status, 0, updated.stderr);
	assert.equal(currentVersion(roots), next);
	assert.equal(readFileSync(join(roots.stateDir, "prompt-overrides", "modes", "boss.md"), "utf8"), "my boss\n", "the override is preserved, never merged");
	const reports = [join(roots.stateDir, "prompt-update-reports", `prompt-update-${customVersion}-to-${next}.md`)];
	assert.ok(reports.some((path) => existsSync(path)), `prompt report written; stdout was: ${updated.stdout}`);
	assert.match(updated.stdout, /prompt update report/, updated.stdout);

	// The old version folder is kept, and re-running the update is a no-op.
	const meta = JSON.parse(readFileSync(join(roots.installRoot, "install.json"), "utf8"));
	assert.equal(meta.versions.length, 2);
	const noop = await runLauncher(["update"], roots, { PI_STUDIO_GITHUB_API: fixture.baseUrl });
	assert.equal(noop.status, 0, noop.stderr);
	assert.match(noop.stdout, /already up to date/);
	assert.equal(currentVersion(roots), next);
});

test("update refuses a corrupt checksum and a downgrade, leaving the current copy alone", async (t) => {
	const roots = tempRoots(t);
	await installStaged(roots);
	const customVersion = currentVersion(roots);
	const next = newerThan(customVersion);
	const fixture = await startFixture(t);

	const official = makeOfficialTree(next, null);
	t.after(() => rmSync(official.dir, { recursive: true, force: true }));
	releaseFor(fixture, next, official, "0".repeat(64));
	const corrupt = await runLauncher(["update", "--replace-custom"], roots, { PI_STUDIO_GITHUB_API: fixture.baseUrl });
	assert.notEqual(corrupt.status, 0);
	assert.match(corrupt.stderr, /checksum mismatch/);
	assert.equal(currentVersion(roots), customVersion);

	const older = makeOfficialTree("0.0.1", null);
	t.after(() => rmSync(older.dir, { recursive: true, force: true }));
	releaseFor(fixture, "0.0.1", older);
	const downgrade = await runLauncher(["update", "--replace-custom"], roots, { PI_STUDIO_GITHUB_API: fixture.baseUrl });
	assert.notEqual(downgrade.status, 0);
	assert.match(downgrade.stderr, /downgrade/);
	assert.equal(currentVersion(roots), customVersion);
});

test("update refuses a draft, a prerelease, a tag that is not v<version>, and an archive that is not the official build of its tag", async (t) => {
	const roots = tempRoots(t);
	await installStaged(roots);
	const customVersion = currentVersion(roots);
	const next = newerThan(customVersion);
	const fixture = await startFixture(t);

	const official = makeOfficialTree(next, null);
	t.after(() => rmSync(official.dir, { recursive: true, force: true }));

	releaseFor(fixture, next, official, null, { draft: true });
	const draft = await runLauncher(["update", "--replace-custom"], roots, { PI_STUDIO_GITHUB_API: fixture.baseUrl });
	assert.notEqual(draft.status, 0);
	assert.match(draft.stderr, /draft/);

	releaseFor(fixture, next, official, null, { prerelease: true });
	const prerelease = await runLauncher(["update", "--replace-custom"], roots, { PI_STUDIO_GITHUB_API: fixture.baseUrl });
	assert.notEqual(prerelease.status, 0);
	assert.match(prerelease.stderr, /prerelease/);

	releaseFor(fixture, next, official, null, { tag_name: next });
	const untagged = await runLauncher(["update", "--replace-custom"], roots, { PI_STUDIO_GITHUB_API: fixture.baseUrl });
	assert.notEqual(untagged.status, 0);
	assert.match(untagged.stderr, /invalid release tag/);

	// The checksum matches this archive, and the tag and asset names are right: only its own build.json
	// still has to prove it is the official build, so a repacked custom copy cannot pass as a release.
	const repacked = makeOfficialTree(next, null, { official: false, custom: true });
	t.after(() => rmSync(repacked.dir, { recursive: true, force: true }));
	releaseFor(fixture, next, repacked);
	const unofficial = await runLauncher(["update", "--replace-custom"], roots, { PI_STUDIO_GITHUB_API: fixture.baseUrl });
	assert.notEqual(unofficial.status, 0);
	assert.match(unofficial.stderr, /not an official build/);
	assert.equal(currentVersion(roots), customVersion, "every refusal left the installed copy alone");
});

/**
 * A minimal ustar archive written byte by byte, so a member name `tar` itself would refuse to
 * create (a `../` escape, or a size larger than the bytes that follow) can still be tested.
 */
function rawTar(entries: { name: string; data?: string; size?: number }[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const payload = Buffer.from(entry.data ?? "", "utf8");
		const size = entry.size ?? payload.length;
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "utf8");
		header.write("0000644\0", 100, "latin1");
		header.write("0000000\0", 108, "latin1");
		header.write("0000000\0", 116, "latin1");
		header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
		header.write("00000000000\0", 136, "latin1");
		header.write("        ", 148, "latin1");
		header.write("0", 156, "latin1");
		header.write("ustar\0" + "00", 257, "latin1");
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
		blocks.push(header);
		if (payload.length) {
			const padded = Buffer.alloc(Math.ceil(payload.length / 512) * 512);
			payload.copy(padded);
			blocks.push(padded);
		}
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

test("archive extraction rejects traversal and link entries", async () => {
	const { extractTarGz } = (await import(join(root, "bin", "manage.mjs"))) as unknown as {
		extractTarGz: (buffer: Buffer, destination: string) => void;
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-studio-traversal-"));
	const evil = join(dir, "evil");
	mkdirSync(evil, { recursive: true });
	writeFileSync(join(evil, "x.txt"), "x\n");
	symlinkSync(join(evil, "x.txt"), join(evil, "link"));
	const tarball = join(dir, "evil.tar.gz");
	execFileSync("tar", ["-czf", tarball, "-C", dir, "evil"], { stdio: "pipe", timeout: CHILD_TIMEOUT_MS });
	const out = join(dir, "out");
	mkdirSync(out, { recursive: true });
	assert.throws(() => extractTarGz(readFileSync(tarball), out), /link entry/);
	assert.ok(!existsSync(join(dir, "x.txt")) || readFileSync(join(dir, "x.txt"), "utf8") === "x\n");
	rmSync(dir, { recursive: true, force: true });
});

test("archive extraction rejects a real ../ member, a truncated entry and an oversized entry", async () => {
	const { extractTarGz } = (await import(join(root, "bin", "manage.mjs"))) as unknown as {
		extractTarGz: (buffer: Buffer, destination: string) => void;
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-studio-escape-"));
	const out = join(dir, "out");
	mkdirSync(out, { recursive: true });
	const inside = join(dir, "pi-studio-0.0.0");
	mkdirSync(inside, { recursive: true });

	const escaping = gzipSync(rawTar([{ name: "../escape.txt", data: "pwned\n" }]));
	assert.throws(() => extractTarGz(escaping, out), /escapes its folder/);
	assert.ok(!existsSync(join(dir, "escape.txt")), "nothing was written outside the extraction folder");

	const truncated = gzipSync(rawTar([{ name: "pi-studio-0.0.0/big.bin", data: "x", size: 4_000_000 }]));
	assert.throws(() => extractTarGz(truncated, out), /is truncated/);

	const oversized = gzipSync(rawTar([{ name: "pi-studio-0.0.0/huge.bin", data: "x", size: 600 * 1024 * 1024 }]));
	assert.throws(() => extractTarGz(oversized, out), /declares 629145600 bytes, more than/);

	assert.ok(!existsSync(join(inside, "big.bin")) && !existsSync(join(out, "pi-studio-0.0.0", "big.bin")), "no entry bytes landed");
	rmSync(dir, { recursive: true, force: true });
});

test("only a registered version folder of the owned install records the running marker", async (t) => {
	const roots = tempRoots(t);
	await installStaged(roots);
	const runtime = (await import(join(root, "bin", "runtime.mjs"))) as unknown as {
		managedRootOf: (appRoot: string) => { installRoot: string; versionDir: string } | null;
		registerManagedRuntime: (appRoot: string) => string | null;
	};
	const meta = JSON.parse(readFileSync(join(roots.installRoot, "install.json"), "utf8"));
	const versionDir = join(roots.installRoot, "versions", meta.currentVersionDir);
	const marker = join(roots.installRoot, "running.json");

	assert.equal(runtime.managedRootOf(root), null, "the source clone is not a managed copy");
	assert.equal(runtime.managedRootOf(staged), null, "a staged tree outside an install root is not managed");
	assert.deepEqual(runtime.managedRootOf(versionDir), { installRoot: roots.installRoot, versionDir: basename(versionDir) });

	// A version folder the install metadata does not register is not part of the installation.
	const stray = join(roots.installRoot, "versions", "stray-0.0.0");
	mkdirSync(stray, { recursive: true });
	writeFileSync(join(stray, "build.json"), "{}\n");
	assert.equal(runtime.managedRootOf(stray), null, "an unregistered version folder is not owned");

	// A source clone starting while the managed app runs must leave the managed marker alone.
	writeFileSync(marker, `${JSON.stringify({ pid: process.pid, versionDir: meta.currentVersionDir })}\n`);
	const before = readFileSync(marker, "utf8");
	assert.equal(runtime.registerManagedRuntime(root), null, "a source clone records nothing");
	assert.equal(readFileSync(marker, "utf8"), before, "the managed marker is untouched");

	// The launcher must never fall back to a guessed install root.
	assert.doesNotMatch(readFileSync(launcher, "utf8"), /installRootDir\(/, "the launcher derives its root from itself, never from a default");

	assert.equal(runtime.registerManagedRuntime(versionDir), marker, "a registered version folder records itself");
	assert.equal(runtime.registerManagedRuntime(staged), null, "a staged tree never claims the marker");
});

test("an installed launcher finds its own install root and bin folder", async (t) => {
	const roots = tempRoots(t);
	await installStaged(roots);
	const installedLauncher = join(roots.installRoot, "current", "bin", "pi-studio");
	// No install root, bin folder or state flags: only what the installed copy can rediscover.
	const { PI_STUDIO_INSTALL_ROOT: _root, PI_STUDIO_BIN_DIR: _bin, ...inherited } = process.env;
	const done = await run(process.execPath, [installedLauncher, "uninstall"], { env: { ...inherited, PI_STUDIO_STATE: roots.stateDir } });
	assert.equal(done.status, 0, done.stderr);
	assert.ok(!existsSync(roots.installRoot), "the install root it found is gone");
	assert.ok(!existsSync(join(roots.binDir, "pi-studio")), "the launcher it found is gone");
});

test("uninstall refuses when the app state sits inside the install root", async (t) => {
	const roots = tempRoots(t);
	await installStaged(roots);
	const innerState = join(roots.installRoot, "state");
	mkdirSync(join(innerState, "prompt-overrides"), { recursive: true });
	writeFileSync(join(innerState, "board.json"), "{}\n");
	const refused = await runLauncher(["uninstall"], roots, { PI_STUDIO_STATE: innerState });
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /is inside the install root/);
	assert.equal(readFileSync(join(innerState, "board.json"), "utf8"), "{}\n", "the state folder is kept");
	assert.ok(existsSync(roots.installRoot), "a refused uninstall removes nothing");
});

test("runtime marker: a live marker blocks uninstall, a proven-stale marker does not", async (t) => {
	const roots = tempRoots(t);
	await installStaged(roots);
	const runtime = (await import(join(root, "bin", "runtime.mjs"))) as unknown as {
		runningState: (installRoot: string) => { state: string };
		registerRuntime: (installRoot: string) => string | null;
	};
	const marker = join(roots.installRoot, "running.json");
	mkdirSync(roots.stateDir, { recursive: true });
	writeFileSync(join(roots.stateDir, "keep.txt"), "state stays\n");
	writeFileSync(join(roots.stateDir, "board.json"), "{}\n");

	assert.equal(runtime.runningState(roots.installRoot).state, "none", "a fresh install has no running marker");
	// What the launcher does before it imports the server: a managed copy records itself as running.
	assert.equal(runtime.registerRuntime(roots.installRoot), marker, "the launcher records its own pid");
	assert.equal(runtime.runningState(roots.installRoot).state, "live");

	writeFileSync(marker, `${JSON.stringify({ pid: process.pid, versionDir: "x" })}\n`);
	assert.equal(runtime.runningState(roots.installRoot).state, "live");
	const blocked = await runLauncher(["uninstall"], roots);
	assert.notEqual(blocked.status, 0);
	assert.match(blocked.stderr, /is running/);
	assert.ok(existsSync(roots.installRoot), "a blocked uninstall removes nothing");

	const stalePid = 4194303;
	assert.ok(!existsSync(`/proc/${stalePid}`), "fixture assumes the stale pid is unused");
	writeFileSync(marker, `${JSON.stringify({ pid: stalePid, versionDir: "x" })}\n`);
	assert.equal(runtime.runningState(roots.installRoot).state, "stale");

	const done = await runLauncher(["uninstall"], roots);
	assert.equal(done.status, 0, done.stderr);
	assert.ok(!existsSync(roots.installRoot));
	assert.ok(!existsSync(join(roots.binDir, "pi-studio")));
	assert.equal(readFileSync(join(roots.stateDir, "keep.txt"), "utf8"), "state stays\n", "state is preserved");
	assert.equal(readFileSync(join(roots.stateDir, "board.json"), "utf8"), "{}\n", "state is preserved");
});
