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

/**
 * The address to listen on: the flag, then the environment, then this machine only.
 *
 * A value with a space or a control character in it is refused rather than handed to the socket,
 * because `--host "0.0.0.0 --no-open"` is one argument nobody meant and the failure it causes is a
 * stack from a place that says nothing about what was typed.
 */
export function bindHost(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): string {
	const asked = (hostFromArgs(argv) || env.PI_STUDIO_HOST || "").trim();
	if (!asked) return LOOPBACK;
	if (/[\s\u0000-\u001f]/.test(asked) || asked.length > 253) {
		throw new Error(`"${asked}" is not an address: give one address, such as ${LOOPBACK}, 0.0.0.0 or 192.168.1.20`);
	}
	return asked;
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
export function boardUrls(host: string, port: number, token: string, interfaces?: Interfaces): string[] {
	const link = (address: string) => `http://${address.includes(":") ? `[${address}]` : address}:${port}/?token=${token}`;
	if (!EVERYWHERE.has(host)) return [link(host)];
	// Loopback answers under either spelling of "everything", so the tab on this machine keeps its link.
	return [link(LOOPBACK), ...localAddresses(interfaces).map(link)];
}
