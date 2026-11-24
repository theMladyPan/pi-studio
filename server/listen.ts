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
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { STATE_FILE, readJsonFile, writeJsonFile } from "./paths.ts";

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
export function bindSource(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env, fileHost?: string): string {
	if (hostFromArgs(argv)) return "the flag";
	if ((env.PI_STUDIO_HOST ?? "").trim()) return "the environment";
	if ((fileHost ?? "").trim()) return "the settings";
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
 * The daemon-level publish choice, kept in `daemon.json` beside the token: which address the daemon
 * publishes on and whether it may speak plain http there. The settings page writes it; the next daemon
 * start reads it. Only the shape is checked here — a stored address is answered for by the socket and
 * by the route that checks it before saving.
 */
export type PublishConfig = { host: string; allowPlainHttp: boolean };

export function publishConfig(): PublishConfig {
	const saved = readJsonFile<any>(STATE_FILE, null);
	const stored = saved?.publish;
	return {
		// Empty means nothing was chosen, which the bind reads as loopback and the startup line names as such.
		host: typeof stored?.host === "string" && stored.host ? stored.host : "",
		allowPlainHttp: stored?.allowPlainHttp !== false,
	};
}

/** Persist the publish choice without disturbing the token and port beside it. */
export function savePublishConfig(next: PublishConfig): PublishConfig {
	const saved = readJsonFile<any>(STATE_FILE, null) ?? {};
	const kept = { host: next.host, allowPlainHttp: next.allowPlainHttp };
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
 * Native TLS from Node's own https module: the certificate and key the daemon is started with. Neither
 * file is read until the daemon starts, and a half-given pair is one sentence rather than a socket error.
 */
export type TlsConfig = { enabled: boolean; cert: string; key: string; certData: Buffer; keyData: Buffer };

export function tlsConfig(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): TlsConfig {
	const cert = (argValue(argv, "--tls-cert") || env.PI_STUDIO_TLS_CERT || "").trim();
	const key = (argValue(argv, "--tls-key") || env.PI_STUDIO_TLS_KEY || "").trim();
	if (!cert && !key) return { enabled: false, cert: "", key: "", certData: Buffer.alloc(0), keyData: Buffer.alloc(0) };
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
