// The systemd user service: install, status and remove for the per-user unit.
//
// The service listens on every interface (0.0.0.0) by default, so a reverse proxy on another
// machine (NetBird and alike) — which cannot dial this machine's loopback — and other computers
// on the LAN can reach the fixed port; `--host 127.0.0.1` pins loopback instead. A manual
// `pi-studio` start keeps its loopback default; only the service widens it. The unit pins the
// port and the host in its own environment, so a stray PI_STUDIO_HOST in the login shell can
// never change the board's reach while the service runs. No sudo, state folder or install root
// is touched: this only writes one file under the user's systemd config folder and drives the
// user manager. The token still guards every data route; binding wide only decides who can
// knock, never who gets in.
//
// A systemd service never sees a login shell's environment, and pi reads its provider keys
// (OPENROUTER_API_KEY and friends) from there — so without help every pi child the daemon spawns
// starts keyless. The install therefore copies the shell's provider keys into `pi-studio.env`
// beside the unit, mode 0600, and the unit reads it back with EnvironmentFile. Secrets stay out
// of the unit file, where `systemctl cat` and `systemctl show` would print them. Changing a key
// in the shell needs one more `service install` to carry it over.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fail, stateDirOf } from "./runtime.mjs";

export const SERVICE_NAME = "pi-studio.service";
/** The port every install uses unless asked otherwise: high, unprivileged, and the one the proxy points at. */
export const FIXED_PORT = 4801;
export const LOOPBACK = "127.0.0.1";
/** The address the service listens on unless asked otherwise: every interface, LAN and overlay alike. */
export const ALL_INTERFACES = "0.0.0.0";

/** system-runner injection point: tests hand over a fake that records argv and never starts systemd. */
function defaultRunner(argv) {
	return new Promise((resolvePromise) => {
		execFile(argv[0], argv.slice(1), { encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
			if (error) {
				const message = String(stderr || error.message || "").trim();
				resolvePromise({ status: typeof error.code === "number" ? error.code : 1, stdout: String(stdout || ""), stderr: message });
			} else {
				resolvePromise({ status: 0, stdout: String(stdout || ""), stderr: "" });
			}
		});
	});
}

export function validatePort(value) {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`port must be a number from 1 to 65535, got ${JSON.stringify(value)}`);
	return port;
}

/**
 * One address to pin the service to, refused for the same reason the daemon refuses it in
 * server/listen.ts: a value with a space in it is one argument nobody meant.
 */
export function validateHost(value) {
	const host = typeof value === "string" ? value.trim() : "";
	if (!host || /[\s\u0000-\u001f]/.test(host) || host.length > 253) {
		fail(`host must be one address, such as ${LOOPBACK}, ${ALL_INTERFACES} or 192.168.1.20, got ${JSON.stringify(value)}`);
	}
	return host;
}

/** Every non-loopback IPv4 address this machine answers on — the LAN and NetBird addresses a proxy or another computer can dial. */
export function localAddresses() {
	const found = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (String(entry.family) === "IPv4" && !entry.internal) found.push(entry.address);
		}
	}
	return found;
}

/** The folder the user manager reads units from, honouring XDG_CONFIG_HOME like the rest of the app. */
export function serviceUnitDir(flags = {}) {
	const raw = flags["config-home"] || process.env.XDG_CONFIG_HOME || "";
	if (raw) return join(resolve(raw), "systemd", "user");
	return join(homedir(), ".config", "systemd", "user");
}

export function serviceUnitPath(flags = {}) {
	return join(serviceUnitDir(flags), SERVICE_NAME);
}

/** The file the unit reads its provider keys from: beside the unit, readable by this user only. */
export function serviceEnvPath(flags = {}) {
	return join(serviceUnitDir(flags), "pi-studio.env");
}

/**
 * Every provider key in a shell environment: pi names them all `*_API_KEY`, `*_KEY` or `*_TOKEN`
 * (OPENROUTER_API_KEY, HF_TOKEN, ANTHROPIC_OAUTH_TOKEN, …), so the suffix is the whole list and
 * a new pi provider needs no change here. Empty values and multi-line values are left out — a
 * key with a newline in it is not a key, and an env file cannot hold one anyway.
 */
export function captureProviderEnv(env = process.env) {
	const kept = {};
	for (const [name, value] of Object.entries(env)) {
		if (typeof value !== "string" || !value || !/(_API_KEY|_KEY|_TOKEN)$/.test(name)) continue;
		if (/[\r\n]/.test(value)) continue;
		kept[name] = value;
	}
	return kept;
}

/**
 * The env file's text: one `KEY="value"` per line, with the two characters a double-quoted
 * systemd value must escape. systemd does not expand `$` in these files, so values go verbatim.
 */
export function renderEnvFile(keys) {
	return Object.entries(keys)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
		.join("\n") + "\n";
}

/** The launcher the unit starts: the installed command when there is one, else this copy's own. */
export function serviceLauncher(appRoot, flags = {}) {
	const installed = join(flags["bin-dir"] ? resolve(flags["bin-dir"]) : join(homedir(), ".local", "bin"), "pi-studio");
	if (existsSync(installed)) return installed;
	return join(appRoot, "bin", "pi-studio");
}

/**
 * The PATH the service runs with. The user manager's own PATH has no ~/.pi/agent/bin, so a child
 * would not find `pi` in it: the installer's PATH is reused and the user's own bin folders are
 * added when they are not there yet, so the service sees the same programs the shell does.
 */
export function servicePath(flags = {}) {
	const home = homedir();
	const wanted = [join(home, ".pi", "agent", "bin"), join(home, ".local", "bin"), join(home, "bin")];
	const found = String(flags.path ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const dir of wanted) if (!found.includes(dir)) found.push(dir);
	return found.join(delimiter);
}

/** The unit text for one install. Ports and addresses here are data, never shell: nothing is interpolated into a command. */
export function renderUnit({ launcher, port, host = ALL_INTERFACES, path, envFile }) {
	return [
		"[Unit]",
		`Description=pi-studio board (${host === LOOPBACK ? "loopback only; reach it through your reverse proxy" : "on all interfaces, for LAN and reverse-proxy access"})`,
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart="${launcher}" --no-open`,
		...(envFile ? [`EnvironmentFile=${envFile}`] : []),
		`Environment=PI_STUDIO_PORT=${port}`,
		`Environment=PI_STUDIO_HOST=${host}`,
		`Environment="PATH=${path}"`,
		"Restart=on-failure",
		"RestartSec=2",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

function requireLinux() {
	if (process.platform !== "linux") fail("the systemd service needs Linux; this machine is not one");
}

function username() {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER || process.env.LOGNAME || "";
	}
}

async function systemctl(run, ...args) {
	return run(["systemctl", "--user", ...args]);
}

async function ensureLinger(run, say) {
	const who = username();
	if (!who) {
		say(`pi-studio: could not tell which user to keep running after logout; run: loginctl enable-linger $USER`);
		return false;
	}
	const shown = await run(["loginctl", "show-user", who, "--property=Linger"]);
	if (shown.status === 0 && /Linger=yes/i.test(shown.stdout)) return true;
	const enabled = await run(["loginctl", "enable-linger", who]);
	if (enabled.status === 0) {
		say(`pi-studio: keeping your service running after logout (loginctl enable-linger ${who})`);
		return true;
	}
	say(`pi-studio: could not switch on running after logout: ${enabled.stderr || "loginctl failed"}`);
	say(`pi-studio: the service runs while you are logged in; to keep it after logout run: loginctl enable-linger ${who}`);
	return false;
}

async function waitForPort(stateDir, port, tries = 20) {
	for (let attempt = 0; attempt < tries; attempt += 1) {
		try {
			const saved = JSON.parse(readFileSync(join(stateDir, "daemon.json"), "utf8"));
			if (Number(saved?.port) === port && saved?.token) return true;
		} catch {
			// The daemon has not written its state file yet; wait and ask again.
		}
		await new Promise((done) => setTimeout(done, 250));
	}
	return false;
}

/** The port a written unit names, so status reports the install that exists, not the default. */
function portFromUnit(unitPath) {
	try {
		const found = /PI_STUDIO_PORT=(\d+)/.exec(readFileSync(unitPath, "utf8"));
		const port = found ? Number(found[1]) : 0;
		return Number.isInteger(port) && port > 0 && port < 65536 ? port : FIXED_PORT;
	} catch {
		return FIXED_PORT;
	}
}

/** The host a written unit names, so status and tips report the install that exists, not the default. */
function hostFromUnit(unitPath) {
	try {
		const found = /PI_STUDIO_HOST=(\S+)/.exec(readFileSync(unitPath, "utf8"));
		return found ? found[1] : ALL_INTERFACES;
	} catch {
		return ALL_INTERFACES;
	}
}

/** Where a proxy or another computer should dial, for the address a unit actually binds. */
function dialTip(host, port) {
	if (host === LOOPBACK) return `http://${LOOPBACK}:${port}/`;
	if (host !== ALL_INTERFACES) return `http://${host}:${port}/`;
	const addresses = localAddresses();
	return addresses.length ? addresses.map((address) => `http://${address}:${port}/`).join(" or ") : `http://<lan-address>:${port}/`;
}

/** Install (or reinstall) the unit, reload, enable linger and restart the service so a changed host or port takes effect. */
export async function installService({ appRoot, flags = {}, run = defaultRunner, out = console.log, env = process.env }) {
	requireLinux();
	const port = validatePort(flags.port ?? FIXED_PORT);
	const host = validateHost(flags.host ?? ALL_INTERFACES);
	const launcher = serviceLauncher(appRoot, flags);
	const unitPath = serviceUnitPath(flags);
	const envPath = serviceEnvPath(flags);
	// The shell's provider keys ride along in their own locked-down file, never in the unit.
	const keys = captureProviderEnv(env);
	mkdirSync(serviceUnitDir(flags), { recursive: true });
	writeFileSync(envPath, renderEnvFile(keys), { encoding: "utf8", mode: 0o600 });
	chmodSync(envPath, 0o600);
	const tempPath = `${unitPath}.tmp`;
	writeFileSync(tempPath, renderUnit({ launcher, port, host, path: servicePath(flags), envFile: envPath }), "utf8");
	try {
		renameSync(tempPath, unitPath);
		const reloaded = await systemctl(run, "daemon-reload");
		if (reloaded.status !== 0) fail(`systemctl --user daemon-reload failed: ${reloaded.stderr || reloaded.stdout}`);
		await ensureLinger(run, out);
		const enabled = await systemctl(run, "enable", SERVICE_NAME);
		if (enabled.status !== 0) fail(`systemctl --user enable ${SERVICE_NAME} failed: ${enabled.stderr || enabled.stdout}`);
		const started = await systemctl(run, "restart", SERVICE_NAME);
		if (started.status !== 0) fail(`systemctl --user restart ${SERVICE_NAME} failed: ${started.stderr || started.stdout}`);
	} catch (error) {
		rmSync(tempPath, { force: true });
		rmSync(envPath, { force: true });
		if (existsSync(unitPath)) {
			rmSync(unitPath, { force: true });
			await systemctl(run, "daemon-reload");
		}
		throw error;
	}
	out(`pi-studio: service unit written to ${unitPath}`);
	out(`pi-studio: listening on ${host === ALL_INTERFACES ? "all interfaces (LAN and NetBird included)" : host}, port ${port}`);
	const names = Object.keys(keys).sort((a, b) => a.localeCompare(b));
	out(names.length
		? `pi-studio: ${names.length} provider keys carried into ${envPath} (0600) — re-run service install after changing keys in your shell`
		: `pi-studio: no provider keys in this shell's environment — pi children will find no API keys; run install from a shell that has them`);
	const stateDir = stateDirOf(flags);
	const listening = await waitForPort(stateDir, port);
	if (listening) {
		out(`pi-studio: point your reverse proxy at ${dialTip(host, port)} — the secret link is printed at boot and kept out of the address bar`);
	} else {
		out(`pi-studio: service started; waiting for ${dialTip(host, port)} — check: pi-studio service status`);
	}
	out(`pi-studio: manage it with: pi-studio service status, pi-studio service remove`);
	return { unitPath, envPath, keys: names, port, host, launcher };
}

/** Report whether the service is installed and whether it is running. The token is never printed. */
export async function serviceStatus({ flags = {}, run = defaultRunner, out = console.log }) {
	requireLinux();
	const unitPath = serviceUnitPath(flags);
	if (!existsSync(unitPath)) {
		out(`pi-studio: no service installed at ${unitPath}; run: pi-studio service install`);
		return { installed: false, active: false, unitPath };
	}
	const active = await systemctl(run, "is-active", SERVICE_NAME);
	const running = active.status === 0 && active.stdout.trim() === "active";
	out(`pi-studio: service installed at ${unitPath}`);
	const host = hostFromUnit(unitPath);
	const port = portFromUnit(unitPath);
	out(`pi-studio: state ${running ? "running" : "not running"} (${host === ALL_INTERFACES ? "all interfaces" : host})`);
	if (running) out(`pi-studio: reverse proxy target ${dialTip(host, port)}`);
	const enabled = await systemctl(run, "is-enabled", SERVICE_NAME);
	if (enabled.stdout.trim() === "enabled") out(`pi-studio: enabled at boot (login)`);
	return { installed: true, active: running, unitPath };
}

/** Stop, disable and delete the unit and its keys file. State, boards and the install itself stay. */
export async function removeService({ flags = {}, run = defaultRunner, out = console.log }) {
	requireLinux();
	const unitPath = serviceUnitPath(flags);
	if (!existsSync(unitPath)) {
		out(`pi-studio: no service installed at ${unitPath}; nothing to remove`);
		return { removed: false, unitPath };
	}
	const stopped = await systemctl(run, "disable", "--now", SERVICE_NAME);
	if (stopped.status !== 0) fail(`systemctl --user disable --now ${SERVICE_NAME} failed: ${stopped.stderr || stopped.stdout}`);
	rmSync(unitPath, { force: true });
	const envPath = serviceEnvPath(flags);
	const hadKeys = existsSync(envPath);
	rmSync(envPath, { force: true });
	const reloaded = await systemctl(run, "daemon-reload");
	if (reloaded.status !== 0) fail(`systemctl --user daemon-reload failed: ${reloaded.stderr || reloaded.stdout}`);
	out(`pi-studio: service removed (${unitPath})${hadKeys ? ", keys file removed too" : ""}; boards and state are untouched`);
	return { removed: true, unitPath };
}
