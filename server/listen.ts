/**
 * Which address the daemon opens, and which links it prints once it has one.
 *
 * Loopback is the default because the link carries the daemon's token, and that token is the machine:
 * whoever holds it can ask an agent to run anything here. Reaching the board from another computer is
 * one flag away — `--host 0.0.0.0`, or `PI_STUDIO_HOST`, for everything this machine is on — and the
 * console says what that cost the moment it costs it.
 *
 * Read the same way `--state` is (`server/paths.ts`), so both of a daemon's addresses are one habit.
 */
import { hostname, networkInterfaces } from "node:os";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { STATE_DIR, STATE_FILE, readJsonFile, writeJsonFile } from "./paths.ts";

export const LOOPBACK = "127.0.0.1";

const EVERYWHERE = new Set(["0.0.0.0", "::"]);

type AddressEntry = { address: string; family: string | number; internal: boolean };

/** Only the three fields a link list reads, so a test can hand over a made-up machine. */
export type Interfaces = Record<string, readonly AddressEntry[] | undefined>;

function hostFromArgs(argv: readonly string[]): string {
	for (const [index, arg] of argv.entries()) {
		if (arg === "--host") return argv[index + 1] ?? "";
		if (arg.startsWith("--host=")) return arg.slice("--host=".length);
	}
	return "";
}

function argValue(argv: readonly string[], name: string): string {
	for (const [index, arg] of argv.entries()) {
		if (arg === name) return argv[index + 1] ?? "";
		if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
	}
	return "";
}

/** Where the winning bind address came from, so the startup line can say it once. */
export function bindSource(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env, fileHosts?: readonly string[]): string {
	if (hostFromArgs(argv)) return "the flag";
	if ((env.PI_STUDIO_HOST ?? "").trim()) return "the environment";
	if ((fileHosts ?? []).some((one) => one.trim())) return "the settings";
	return "loopback";
}

/**
 * The address to listen on: the flag, then the environment, then this machine only.
 *
 * A value with a space or a control character in it is refused rather than handed to the socket,
 * because `--host "0.0.0.0 --no-open"` is one argument nobody meant and the failure it causes is a
 * stack from a place that says nothing about what was typed.
 */
export function bindHost(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env, fileHost?: string): string {
	const asked = (hostFromArgs(argv) || env.PI_STUDIO_HOST || fileHost || "").trim();
	if (!asked) return LOOPBACK;
	if (/[\s\u0000-\u001f]/.test(asked) || asked.length > 253) {
		throw new Error(`"${asked}" is not an address: give one address, such as ${LOOPBACK}, 0.0.0.0 or 192.168.1.20`);
	}
	return asked;
}

/**
 * The addresses to listen on: the flag, then the environment, then the settings file's list, then this
 * machine only. The flag and the environment name one address; the settings page may tick several, and
 * the daemon answers on each of them.
 */
export function bindHosts(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env, fileHosts?: readonly string[]): string[] {
	const flag = (hostFromArgs(argv) || "").trim();
	const environment = (env.PI_STUDIO_HOST ?? "").trim();
	const filed = (fileHosts ?? []).map((one) => one.trim()).filter(Boolean);
	const asked = flag || environment || filed[0] || "";
	if (!asked) return [LOOPBACK];
	if (/[\s\u0000-\u001f]/.test(asked) || asked.length > 253) {
		throw new Error(`"${asked}" is not an address: give one address, such as ${LOOPBACK}, 0.0.0.0 or 192.168.1.20`);
	}
	if (flag || environment) return [asked];
	return filed;
}

/**
 * The daemon-level publish choice, kept in `daemon.json` beside the token: which addresses the daemon
 * publishes on and whether it may speak plain http there. The settings page writes it; the next daemon
 * start reads it. Only the shape is checked here — a stored address is answered for by the socket and
 * by the route that checks it before saving.
 */
export type PublishConfig = { hosts: string[]; allowPlainHttp: boolean };

export function publishConfig(): PublishConfig {
	const saved = readJsonFile<any>(STATE_FILE, null);
	const stored = saved?.publish;
	// Both spellings are read: `hosts` is what the page writes, `host` is what an older build wrote.
	const hosts = Array.isArray(stored?.hosts) ? stored.hosts.filter((one: unknown) => typeof one === "string" && one) : typeof stored?.host === "string" && stored.host ? [stored.host] : [];
	return {
		// Empty means nothing was chosen, which the bind reads as loopback and the startup line names as such.
		hosts,
		allowPlainHttp: stored?.allowPlainHttp !== false,
	};
}

/** Persist the publish choice without disturbing the token and port beside it. */
export function savePublishConfig(next: PublishConfig): PublishConfig {
	const saved = readJsonFile<any>(STATE_FILE, null) ?? {};
	const kept = { hosts: next.hosts, allowPlainHttp: next.allowPlainHttp };
	writeJsonFile(STATE_FILE, { ...saved, publish: kept });
	return kept;
}

/**
 * Whether a settings write may name this address: loopback, everywhere, or one of this machine's own
 * interfaces. The flag and the environment are freer — a hostname there is the human's own word — but a
 * stored choice is answered for by the machine it runs on, so a foreign address is refused in one sentence.
 */
export function validatePublishHost(host: unknown, interfaces: Interfaces = networkInterfaces()): string {
	const asked = String(host ?? "").trim();
	if (!asked || /[\s\u0000-\u001f]/.test(asked) || asked.length > 253) {
		throw new Error(`"${asked}" is not an address: give one address, such as ${LOOPBACK}, 0.0.0.0 or 192.168.1.20`);
	}
	const allowed = new Set([LOOPBACK, "::1", "localhost", "0.0.0.0", "::", ...localAddresses(interfaces)]);
	if (!allowed.has(asked)) {
		const own = localAddresses(interfaces);
		throw new Error(`"${asked}" is not an address of this machine: give ${LOOPBACK}, 0.0.0.0${own.length ? ` or ${own.join(", ")}` : ""}`);
	}
	return asked;
}

/**
 * Whether a settings write may name these addresses: this machine's own, one or several, ticked in the
 * settings page. Duplicates go, and "all interfaces" makes the rest pointless, so it stands alone.
 */
export function validatePublishHosts(hosts: unknown, interfaces: Interfaces = networkInterfaces()): string[] {
	if (!Array.isArray(hosts)) throw new Error("the publish addresses are a list of addresses, not one");
	const own = localAddresses(interfaces);
	const checked: string[] = [];
	for (const one of hosts) {
		const asked = validatePublishHost(one, interfaces);
		if (!checked.includes(asked)) checked.push(asked);
	}
	if (!checked.length) throw new Error("pick at least one address to publish on");
	if (checked.includes("0.0.0.0") || checked.includes("::")) return ["0.0.0.0"];
	return checked;
}

/**
 * Native TLS from Node's own https module: the certificate and key the daemon is started with. Neither
 * file is read until the daemon starts, and a half-given pair is one sentence rather than a socket error.
 */
export type TlsConfig = { enabled: boolean; cert: string; key: string; certData: Buffer; keyData: Buffer };

/** The generated pair's home: the settings page writes it, and the daemon reads it at the next start. */
export function tlsFilesOf(dir = join(STATE_DIR, "tls")): { cert: string; key: string } {
	return { cert: join(dir, "cert.pem"), key: join(dir, "key.pem") };
}

/**
 * A self-signed pair for this machine's own addresses, written for the daemon to use. OpenSSL builds
 * the certificate: the browser wants subjectAltName entries for every name it may arrive by, which is
 * why the published addresses ride along with localhost and the machine's own names.
 */
export function generateTlsPair(dir?: string, names?: string[]): { cert: string; key: string; names: string[] } {
	const home = dir ?? join(STATE_DIR, "tls");
	const files = tlsFilesOf(home);
	const asked = [...new Set((names?.length ? names : []).map((one) => String(one).trim()).filter((one) => one && one !== "0.0.0.0" && one !== "::"))];
	// "All interfaces" (or no names at all) still wants the names a browser may arrive by.
	const wanted = asked.length ? asked : ["localhost", "127.0.0.1", hostname(), ...localAddresses()];
	const san = wanted.map((one) => (isIP(one) ? `IP:${one}` : `DNS:${one}`)).join(",");
	const certTmp = `${files.cert}.tmp`;
	const keyTmp = `${files.key}.tmp`;
	for (const one of [certTmp, keyTmp]) {
		try {
			unlinkSync(one);
		} catch {
			// A stale temporary is overwritten below.
		}
	}
	try {
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825", "-subj", "/CN=pi-studio", "-keyout", keyTmp, "-out", certTmp];
		if (san) args.push("-addext", `subjectAltName=${san}`);
		execFileSync("openssl", args, { stdio: "pipe", timeout: 30_000 });
		chmodSync(keyTmp, 0o600);
		chmodSync(certTmp, 0o644);
		renameSync(keyTmp, files.key);
		renameSync(certTmp, files.cert);
		return { cert: files.cert, key: files.key, names: wanted };
	} catch (error) {
		for (const one of [certTmp, keyTmp]) {
			try {
				unlinkSync(one);
			} catch {
				// Nothing left to clean.
			}
		}
		const detail = String((error as { stderr?: unknown })?.stderr ?? (error as Error).message ?? error).trim().split("\n").pop() ?? "";
		throw new Error(`a certificate could not be generated: ${detail}`);
	}
}

export function tlsConfig(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): TlsConfig {
	let cert = (argValue(argv, "--tls-cert") || env.PI_STUDIO_TLS_CERT || "").trim();
	let key = (argValue(argv, "--tls-key") || env.PI_STUDIO_TLS_KEY || "").trim();
	if (!cert && !key) {
		// The generated pair is the third voice, and it needs no environment to find it.
		const files = tlsFilesOf();
		if (!existsSync(files.cert) && !existsSync(files.key)) return { enabled: false, cert: "", key: "", certData: Buffer.alloc(0), keyData: Buffer.alloc(0) };
		cert = files.cert;
		key = files.key;
	}
	if (!cert || !key) throw new Error("TLS needs both a certificate and a key: give --tls-cert and --tls-key, or PI_STUDIO_TLS_CERT and PI_STUDIO_TLS_KEY");
	try {
		const certData = readFileSync(cert);
		const keyData = readFileSync(key);
		const certificate = new X509Certificate(certData);
		const privateKey = createPrivateKey(keyData);
		// A pair that parses but does not belong together fails every handshake, so the mismatch is
		// named here rather than at the first visitor.
		const certificateKey = certificate.publicKey.export({ type: "spki", format: "der" });
		const keyOfPrivate = createPublicKey(privateKey).export({ type: "spki", format: "der" });
		if (!certificateKey.equals(keyOfPrivate)) throw new Error("the certificate and the key do not belong together");
		return { enabled: true, cert, key, certData, keyData };
	} catch (error) {
		throw new Error(`TLS files could not be read: ${(error as Error).message}`);
	}
}

export function isLoopback(host: string): boolean {
	return host === LOOPBACK || host === "::1" || host === "localhost";
}

/** Every non-loopback IPv4 address this machine answers on, which is what another computer can type. */
export function localAddresses(interfaces: Interfaces = networkInterfaces()): string[] {
	const found: string[] = [];
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			// `family` is a string on every Node this app runs on, and a number on releases before 18.
			if (String(entry.family) === "IPv4" && !entry.internal) found.push(entry.address);
		}
	}
	return found;
}

/**
 * The links worth printing, in the order a human would try them: this machine first, then every other
 * address it answers on. One address when the daemon holds one, and the whole list when it holds all.
 */
export function boardUrls(host: string, port: number, token: string, interfaces?: Interfaces, scheme = "http"): string[] {
	const link = (address: string) => `${scheme}://${address.includes(":") ? `[${address}]` : address}:${port}/?token=${token}`;
	if (!EVERYWHERE.has(host)) return [link(host)];
	// Loopback answers under either spelling of "everything", so the tab on this machine keeps its link.
	return [link(LOOPBACK), ...localAddresses(interfaces).map(link)];
}
