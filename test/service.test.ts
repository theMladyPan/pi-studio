import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { captureProviderEnv, FIXED_PORT, installService, removeService, renderEnvFile, renderUnit, servicePath, serviceStatus, validateHost, validatePort } from "../bin/service.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaries: string[] = [];

after(() => {
	for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temporaries.push(dir);
	return dir;
}

/**
 * A fake process runner: records argv, answers systemctl/loginctl from a script supplied
 * per test. No systemd is touched in any of these tests.
 */
function fakeRunner(script: (argv: string[]) => { status: number; stdout?: string; stderr?: string }) {
	const calls: string[][] = [];
	const run = async (argv: string[]) => {
		calls.push(argv);
		const answer = script(argv);
		return { status: answer.status, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
	};
	return { run, calls };
}

test("the fixed port is accepted and anything else is refused in one sentence", () => {
	assert.equal(validatePort(FIXED_PORT), FIXED_PORT);
	assert.equal(validatePort("4801"), 4801);
	for (const bad of ["0", "65536", "abc", "4801.5", ""]) {
		assert.throws(() => validatePort(bad), /port must be a number/, `accepted ${JSON.stringify(bad)}`);
	}
});

test("a host is one address: the loopback pin and a LAN address pass, a sentence does not", () => {
	assert.equal(validateHost("127.0.0.1"), "127.0.0.1");
	assert.equal(validateHost("0.0.0.0"), "0.0.0.0");
	assert.equal(validateHost(" 192.168.1.20 "), "192.168.1.20");
	for (const bad of ["", "0.0.0.0 --no-open", "a b", true]) {
		assert.throws(() => validateHost(bad), /host must be one address/, `accepted ${JSON.stringify(bad)}`);
	}
});

test("the unit listens on all interfaces, the fixed port, no browser and a restart", () => {
	const text = renderUnit({ launcher: "/home/u/.local/bin/pi-studio", port: FIXED_PORT, path: "/usr/bin:/bin" });
	assert.match(text, /ExecStart="\/home\/u\/\.local\/bin\/pi-studio" --no-open/);
	assert.match(text, /PI_STUDIO_PORT=4801/);
	assert.match(text, /PI_STUDIO_HOST=0\.0\.0\.0/);
	assert.match(text, /Restart=on-failure/);
	assert.match(text, /WantedBy=default\.target/);
	// A proxy on another machine cannot dial loopback, so the default must not pin it.
	assert.ok(!text.includes("PI_STUDIO_HOST=127.0.0.1"), "the default must reach the LAN");
});

test("only provider keys are carried, and a key with a newline never is", () => {
	const kept = captureProviderEnv({
		OPENROUTER_API_KEY: "sk-or-1",
		HF_TOKEN: "hf_1",
		ANTHROPIC_OAUTH_TOKEN: "oat-1",
		SWAN_API_KEY: "sk-1",
		PATH: "/usr/bin",
		PI_MODEL: "openrouter/x",
		EMPTY_API_KEY: "",
		BROKEN_API_KEY: "two\nlines",
		NUMERIC_API_KEY: 42 as unknown as string,
	});
	assert.deepEqual(Object.keys(kept).sort(), ["ANTHROPIC_OAUTH_TOKEN", "HF_TOKEN", "OPENROUTER_API_KEY", "SWAN_API_KEY"]);
	assert.equal(kept.OPENROUTER_API_KEY, "sk-or-1");
});

test("the env file quotes a value so systemd reads it verbatim", () => {
	assert.equal(renderEnvFile({ B_KEY: 'a"b\\c d$e', A_TOKEN: "x" }), 'A_TOKEN="x"\nB_KEY="a\\"b\\\\c d$e"\n');
});

test("the unit reads the keys file and never a key itself", () => {
	const text = renderUnit({ launcher: "/bin/pi-studio", port: FIXED_PORT, path: "/usr/bin", envFile: "/home/u/.config/systemd/user/pi-studio.env" });
	assert.match(text, /EnvironmentFile=\/home\/u\/\.config\/systemd\/user\/pi-studio\.env/);
	assert.ok(!/API_KEY=|_TOKEN=/.test(text), `a secret must not ride in the unit: ${text}`);
});

test("install carries the shell's provider keys into a user-only file", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	const stateDir = tempDir("pi-studio-service-state-");
	writeFileSync(join(stateDir, "daemon.json"), JSON.stringify({ token: "tok", port: FIXED_PORT }), "utf8");
	const { run } = fakeRunner((argv) => {
		if (argv[0] === "loginctl" && argv[1] === "show-user") return { status: 0, stdout: "Linger=yes" };
		return { status: 0 };
	});
	const result = await installService({
		appRoot: root,
		flags: { "config-home": configHome, state: stateDir },
		run,
		out: () => {},
		env: { OPENROUTER_API_KEY: "sk-or-test", PATH: "/usr/bin", PI_MODEL: "openrouter/x" },
	});
	assert.deepEqual(result.keys, ["OPENROUTER_API_KEY"]);
	assert.equal(statSync(result.envPath).mode & 0o777, 0o600);
	assert.equal(readFileSync(result.envPath, "utf8"), 'OPENROUTER_API_KEY="sk-or-test"\n');
	assert.ok(!readFileSync(result.unitPath, "utf8").includes("sk-or-test"), "the key must not ride in the unit");
});

test("the unit can still be pinned to loopback on request", () => {
	const text = renderUnit({ launcher: "/home/u/.local/bin/pi-studio", port: FIXED_PORT, host: "127.0.0.1", path: "/usr/bin:/bin" });
	assert.match(text, /PI_STUDIO_HOST=127\.0\.0\.1/);
	assert.match(text, /loopback only/);
});

test("the service sees the programs a login shell sees", () => {
	const path = servicePath({ path: "/usr/bin:/bin" });
	assert.ok(path.split(":").includes("/usr/bin"));
	assert.ok(path.split(":").some((one) => one.endsWith("/.pi/agent/bin")), `missing pi bin in ${path}`);
});

test("install writes the unit and starts the user service", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	const stateDir = tempDir("pi-studio-service-state-");
	// The daemon is imagined to be up already, so the wait answers at once.
	writeFileSync(join(stateDir, "daemon.json"), JSON.stringify({ token: "tok", port: FIXED_PORT }), "utf8");
	const { run, calls } = fakeRunner((argv) => {
		if (argv[0] === "loginctl" && argv[1] === "show-user") return { status: 0, stdout: "Linger=yes" };
		return { status: 0 };
	});
	const lines: string[] = [];
	const result = await installService({ appRoot: root, flags: { "config-home": configHome, state: stateDir }, run, out: (line: string) => lines.push(line) });
	assert.equal(result.port, FIXED_PORT);
	assert.ok(existsSync(result.unitPath));
	const unit = readFileSync(result.unitPath, "utf8");
	assert.match(unit, /PI_STUDIO_HOST=0\.0\.0\.0/);
	const verbs = calls.map((call) => call.join(" "));
	assert.ok(verbs.includes("systemctl --user daemon-reload"), `calls: ${verbs.join(" | ")}`);
	assert.ok(verbs.includes("systemctl --user enable pi-studio.service"), `calls: ${verbs.join(" | ")}`);
	// Reinstall must restart, or a changed host never reaches the running daemon.
	assert.ok(verbs.includes("systemctl --user restart pi-studio.service"), `calls: ${verbs.join(" | ")}`);
	assert.ok(lines.some((line) => line.includes("all interfaces")), `lines: ${lines.join(" | ")}`);
	assert.ok(lines.every((line) => !line.includes("http://127.0.0.1:4801/")), `lines: ${lines.join(" | ")}`);
	assert.ok(lines.every((line) => !line.includes("tok")), "the token never reaches the terminal");
});

test("install switches on running after logout when linger is off", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	const stateDir = tempDir("pi-studio-service-state-");
	writeFileSync(join(stateDir, "daemon.json"), JSON.stringify({ token: "tok", port: FIXED_PORT }), "utf8");
	const { run, calls } = fakeRunner((argv) => {
		if (argv[0] === "loginctl" && argv[1] === "show-user") return { status: 0, stdout: "Linger=no" };
		return { status: 0 };
	});
	await installService({ appRoot: root, flags: { "config-home": configHome, state: stateDir }, run, out: () => {} });
	assert.ok(calls.some((call) => call[0] === "loginctl" && call[1] === "enable-linger"), `calls: ${calls.map((c) => c.join(" ")).join(" | ")}`);
});

test("install refuses a port that is not a port, before writing anything", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	const { run, calls } = fakeRunner(() => ({ status: 0 }));
	await assert.rejects(
		installService({ appRoot: root, flags: { "config-home": configHome, port: "abc" }, run, out: () => {} }),
		/port must be a number/,
	);
	assert.equal(calls.length, 0);
});

test("status reports the installed port, not the default, after a custom-port install", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	mkdirSync(join(configHome, "systemd", "user"), { recursive: true });
	writeFileSync(join(configHome, "systemd", "user", "pi-studio.service"), renderUnit({ launcher: "/bin/pi-studio", port: 9000, path: "/usr/bin" }), "utf8");
	const running = fakeRunner((argv) => {
		if (argv.includes("is-active")) return { status: 0, stdout: "active" };
		if (argv.includes("is-enabled")) return { status: 0, stdout: "enabled" };
		return { status: 0 };
	});
	const lines: string[] = [];
	await serviceStatus({ flags: { "config-home": configHome }, run: running.run, out: (line: string) => lines.push(line) });
	assert.ok(lines.some((line) => line.includes(":9000/")), `lines: ${lines.join(" | ")}`);
	assert.ok(lines.some((line) => line.includes("all interfaces")), `lines: ${lines.join(" | ")}`);
	assert.ok(lines.every((line) => !line.includes("4801")), `lines: ${lines.join(" | ")}`);
});

test("install with --host 127.0.0.1 keeps the old loopback pin and says so", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	const stateDir = tempDir("pi-studio-service-state-");
	writeFileSync(join(stateDir, "daemon.json"), JSON.stringify({ token: "tok", port: FIXED_PORT }), "utf8");
	const { run } = fakeRunner((argv) => {
		if (argv[0] === "loginctl" && argv[1] === "show-user") return { status: 0, stdout: "Linger=yes" };
		return { status: 0 };
	});
	const lines: string[] = [];
	const result = await installService({ appRoot: root, flags: { "config-home": configHome, state: stateDir, host: "127.0.0.1" }, run, out: (line: string) => lines.push(line) });
	assert.equal(result.host, "127.0.0.1");
	assert.match(readFileSync(result.unitPath, "utf8"), /PI_STUDIO_HOST=127\.0\.0\.1/);
	assert.ok(lines.some((line) => line.includes("http://127.0.0.1:4801/")), `lines: ${lines.join(" | ")}`);
});

test("install refuses a host that is not one address, before writing anything", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	const { run, calls } = fakeRunner(() => ({ status: 0 }));
	await assert.rejects(
		installService({ appRoot: root, flags: { "config-home": configHome, host: "0.0.0.0 --no-open" }, run, out: () => {} }),
		/host must be one address/,
	);
	assert.equal(calls.length, 0);
});

test("install leaves no unit behind when systemctl fails", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	const stateDir = tempDir("pi-studio-service-state-");
	writeFileSync(join(stateDir, "daemon.json"), JSON.stringify({ token: "tok", port: FIXED_PORT }), "utf8");
	const { run } = fakeRunner((argv) => {
		if (argv.includes("enable") || argv.includes("restart")) return { status: 1, stderr: "no such unit" };
		if (argv[0] === "loginctl") return { status: 0, stdout: "Linger=yes" };
		return { status: 0 };
	});
	await assert.rejects(
		installService({ appRoot: root, flags: { "config-home": configHome, state: stateDir }, run, out: () => {} }),
		/enable pi-studio\.service/,
	);
	assert.ok(!existsSync(join(configHome, "systemd", "user", "pi-studio.service")), "a failed enable must not leave an orphan unit");
	assert.ok(!existsSync(join(configHome, "systemd", "user", "pi-studio.service.tmp")), "no temp unit survives either");
});

test("remove stops the unit and deletes only the unit", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	const stateDir = tempDir("pi-studio-service-state-");
	writeFileSync(join(stateDir, "daemon.json"), JSON.stringify({ token: "tok", port: FIXED_PORT }), "utf8");
	mkdirSync(join(configHome, "systemd", "user"), { recursive: true });
	const unitPath = join(configHome, "systemd", "user", "pi-studio.service");
	writeFileSync(unitPath, "[Unit]\n", "utf8");
	const envPath = join(configHome, "systemd", "user", "pi-studio.env");
	writeFileSync(envPath, 'OPENROUTER_API_KEY="sk-or-test"\n', "utf8");
	const { run, calls } = fakeRunner(() => ({ status: 0 }));
	const result = await removeService({ flags: { "config-home": configHome }, run, out: () => {} });
	assert.equal(result.removed, true);
	assert.ok(!existsSync(unitPath));
	assert.ok(!existsSync(envPath), "the keys file is removed with the service");
	assert.ok(existsSync(join(stateDir, "daemon.json")), "state survives the removal");
	assert.ok(calls.some((call) => call.join(" ") === "systemctl --user disable --now pi-studio.service"));
	const idle = await removeService({ flags: { "config-home": configHome }, run, out: () => {} });
	assert.equal(idle.removed, false);
});

test("status says whether the unit is there and whether it runs, without the token", async () => {
	const configHome = tempDir("pi-studio-service-config-");
	const notInstalled = fakeRunner(() => ({ status: 0 }));
	const before = await serviceStatus({ flags: { "config-home": configHome }, run: notInstalled.run, out: () => {} });
	assert.equal(before.installed, false);
	mkdirSync(join(configHome, "systemd", "user"), { recursive: true });
	writeFileSync(join(configHome, "systemd", "user", "pi-studio.service"), "[Unit]\n", "utf8");
	const running = fakeRunner((argv) => {
		if (argv.includes("is-active")) return { status: 0, stdout: "active" };
		if (argv.includes("is-enabled")) return { status: 0, stdout: "enabled" };
		return { status: 0 };
	});
	const lines: string[] = [];
	const after = await serviceStatus({ flags: { "config-home": configHome }, run: running.run, out: (line: string) => lines.push(line) });
	assert.equal(after.installed, true);
	assert.equal(after.active, true);
	assert.ok(lines.some((line) => line.includes("running")));
	assert.ok(lines.some((line) => line.includes(":4801/")));
});

test("an explicitly asked port that is taken fails instead of moving elsewhere", async () => {
	// A throwaway server holds one port for the length of this test.
	const holder = createServer((_req, res) => {
		res.writeHead(200);
		res.end();
	});
	await new Promise<void>((resolvePromise) => holder.listen(0, "127.0.0.1", resolvePromise));
	const address = holder.address();
	assert.ok(typeof address === "object" && address);
	const heldPort = address.port;
	const stateDir = tempDir("pi-studio-service-strict-");
	const child = spawn(process.execPath, [join(root, "server.ts"), "--no-open"], {
		cwd: root,
		env: { ...process.env, PI_STUDIO_PORT: String(heldPort), PI_STUDIO_STATE: stateDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => (output += String(chunk)));
	child.stderr.on("data", (chunk) => (output += String(chunk)));
	const { code } = await new Promise<{ code: number | null }>((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error(`the daemon did not fail within 20s: ${output}`)), 20_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code });
		});
	});
	await new Promise<void>((resolvePromise) => holder.close(() => resolvePromise()));
	assert.notEqual(code, 0, `expected a failure, output: ${output}`);
	assert.match(output, new RegExp(`port ${heldPort} is already taken`), `output: ${output}`);
	assert.ok(!output.includes("listening on"), `the daemon must not have moved elsewhere: ${output}`);
});
