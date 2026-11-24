// The systemd user service: install, status and remove for the per-user unit.
//
// The daemon keeps its loopback-only default here: a reverse proxy (NetBird, Caddy, nginx, …)
// is the part that talks to the network, and the fixed port is its stable target. The unit pins
// the port and the host in its own environment, so a stray PI_STUDIO_HOST in the login shell
// can never widen the board beyond this machine while the service runs. No sudo, state folder
// or install root is touched: this only writes one file under the user's systemd config folder
// and drives the user manager.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fail, stateDirOf } from "./runtime.mjs";

export const SERVICE_NAME = "pi-studio.service";
/** The port every install uses unless asked otherwise: high, unprivileged, and the one the proxy points at. */
export const FIXED_PORT = 4801;
export const LOOPBACK = "127.0.0.1";

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

/** The folder the user manager reads units from, honouring XDG_CONFIG_HOME like the rest of the app. */
export function serviceUnitDir(flags = {}) {
	const raw = flags["config-home"] || process.env.XDG_CONFIG_HOME || "";
	if (raw) return join(resolve(raw), "systemd", "user");
	return join(homedir(), ".config", "systemd", "user");
}

export function serviceUnitPath(flags = {}) {
	return join(serviceUnitDir(flags), SERVICE_NAME);
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
export function renderUnit({ launcher, port, path }) {
	return [
		"[Unit]",
		"Description=pi-studio board (loopback only; reach it through your reverse proxy)",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${launcher} --no-open`,
		`Environment=PI_STUDIO_PORT=${port}`,
		`Environment=PI_STUDIO_HOST=${LOOPBACK}`,
		`Environment=PATH=${path}`,
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

/** Install (or reinstall) the unit, reload, enable linger and start the service. */
export async function installService({ appRoot, flags = {}, run = defaultRunner, out = console.log }) {
	requireLinux();
	const port = validatePort(flags.port ?? FIXED_PORT);
	const launcher = serviceLauncher(appRoot, flags);
	const unitPath = serviceUnitPath(flags);
	mkdirSync(serviceUnitDir(flags), { recursive: true });
	writeFileSync(unitPath, renderUnit({ launcher, port, path: servicePath(flags) }), "utf8");
	out(`pi-studio: service unit written to ${unitPath}`);
	const reloaded = await systemctl(run, "daemon-reload");
	if (reloaded.status !== 0) fail(`systemctl --user daemon-reload failed: ${reloaded.stderr || reloaded.stdout}`);
	await ensureLinger(run, out);
	const started = await systemctl(run, "enable", "--now", SERVICE_NAME);
	if (started.status !== 0) fail(`systemctl --user enable --now ${SERVICE_NAME} failed: ${started.stderr || started.stdout}`);
	const stateDir = stateDirOf(flags);
	const listening = await waitForPort(stateDir, port);
	if (listening) {
		out(`pi-studio: service is running on http://${LOOPBACK}:${port}/`);
		out(`pi-studio: point your reverse proxy at http://${LOOPBACK}:${port}/ — the secret link is printed at boot and kept out of the address bar`);
	} else {
		out(`pi-studio: service started; waiting for http://${LOOPBACK}:${port}/ — check: pi-studio service status`);
	}
	out(`pi-studio: manage it with: pi-studio service status, pi-studio service remove`);
	return { unitPath, port, launcher };
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
	out(`pi-studio: state ${running ? "running" : "not running"} (loopback only)`);
	if (running) out(`pi-studio: reverse proxy target http://${LOOPBACK}:${flags.port ?? FIXED_PORT}/`);
	const enabled = await systemctl(run, "is-enabled", SERVICE_NAME);
	if (enabled.stdout.trim() === "enabled") out(`pi-studio: enabled at boot (login)`);
	return { installed: true, active: running, unitPath };
}

/** Stop, disable and delete the unit. State, boards and the install itself are untouched. */
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
	const reloaded = await systemctl(run, "daemon-reload");
	if (reloaded.status !== 0) fail(`systemctl --user daemon-reload failed: ${reloaded.stderr || reloaded.stdout}`);
	out(`pi-studio: service removed (${unitPath}); boards and state are untouched`);
	return { removed: true, unitPath };
}
