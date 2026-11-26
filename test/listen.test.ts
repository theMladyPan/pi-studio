import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOPBACK, bindHost, bindHosts, bindSource, boardLinks, boardUrls, childBaseUrl, generateTlsPair, isLoopback, localAddresses, tlsApplies, tlsConfig, tlsOff, validatePublishHost, validatePublishHosts } from "../server/listen.ts";

/**
 * Which address the daemon opens decides who can reach the board, so each way of asking is pinned here:
 * the default keeps the link on this machine, an explicit address is honoured, and a value with a space
 * in it is refused before the socket sees it.
 */

test("no flag and no environment answers on this machine only", () => {
	assert.equal(bindHost([], {}), LOOPBACK);
	assert.equal(bindHost(["--no-open"], {}), LOOPBACK);
});

test("the flag wins over the environment, and either one alone is enough", () => {
	assert.equal(bindHost(["--host", "0.0.0.0"], { PI_STUDIO_HOST: "192.168.1.5" }), "0.0.0.0");
	assert.equal(bindHost(["--host=192.168.1.20"], {}), "192.168.1.20");
	assert.equal(bindHost([], { PI_STUDIO_HOST: "192.168.1.5" }), "192.168.1.5");
	// A host given without a value falls back to the environment rather than to the empty string.
	assert.equal(bindHost(["--host"], { PI_STUDIO_HOST: "192.168.1.5" }), "192.168.1.5");
});

test("an address with a space or a control character is refused in one sentence", () => {
	// `--host "0.0.0.0 --no-open"` is one argument nobody meant, and the socket's complaint names the syscall.
	for (const asked of ["0.0.0.0 --no-open", "0.0.0.0 1", "0.0\u0000.0.0"]) {
		assert.throws(() => bindHost(["--host", asked], {}), /is not an address/, `accepted ${JSON.stringify(asked)}`);
	}
	// Surrounding whitespace is what a shell leaves behind, so it is trimmed rather than refused.
	assert.equal(bindHost(["--host", " 0.0.0.0\n"], {}), "0.0.0.0");
	// An empty value is no value at all, which is the default rather than a mistake.
	assert.equal(bindHost(["--host", " "], {}), LOOPBACK);
});

test("loopback is recognised in the three ways it is written", () => {
	assert.equal(isLoopback("127.0.0.1"), true);
	assert.equal(isLoopback("localhost"), true);
	assert.equal(isLoopback("::1"), true);
	assert.equal(isLoopback("0.0.0.0"), false);
	assert.equal(isLoopback("192.168.1.20"), false);
});

test("children dial loopback plain http, on the plain neighbour when TLS is on", () => {
	assert.equal(childBaseUrl(4801, false), "http://127.0.0.1:4801");
	// With TLS the main port speaks HTTPS only, so a plain fetch there dies before it reaches a route.
	// The child has to use the plain listener on the port below, which is the same neighbour the
	// daemon binds and the redirect tests below rely on.
	assert.equal(childBaseUrl(4801, true), "http://127.0.0.1:4800");
});

test("one address prints one link, and the whole machine prints the local one first", () => {
	const token = "abc123";
	const interfaces = {
		lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
		wlan0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
		eth0: [{ address: "10.0.0.4", family: "IPv4", internal: false }],
		wlan0v6: [{ address: "fe80::1", family: "IPv6", internal: false }],
	};
	assert.deepEqual(boardUrls("127.0.0.1", 4801, token), ["http://127.0.0.1:4801/?token=abc123"]);
	assert.deepEqual(boardUrls("0.0.0.0", 4801, token, interfaces), [
		"http://127.0.0.1:4801/?token=abc123",
		"http://192.168.1.20:4801/?token=abc123",
		"http://10.0.0.4:4801/?token=abc123",
	]);
	assert.deepEqual(boardUrls("192.168.1.20", 4801, token, interfaces), ["http://192.168.1.20:4801/?token=abc123"]);
	// An IPv6 address is a link a browser accepts only in brackets.
	assert.deepEqual(boardUrls("::1", 4801, token, interfaces), ["http://[::1]:4801/?token=abc123"]);
	assert.deepEqual(boardUrls("fd00::5", 4801, token, interfaces), ["http://[fd00::5]:4801/?token=abc123"]);
});

test("the addresses a machine answers on leave out loopback and IPv6", () => {
	// A fresh container has nothing but loopback, and a list holding it would print a link that is not new.
	assert.deepEqual(localAddresses({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }), []);
	assert.deepEqual(
		localAddresses({
			lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
			eth0: [{ address: "10.0.0.4", family: "IPv4", internal: false }],
		}),
		["10.0.0.4"],
	);
});

test("the settings file is the third voice in the bind, behind the flag and the environment", () => {
	assert.equal(bindHost([], {}, "0.0.0.0"), "0.0.0.0");
	assert.equal(bindHost([], { PI_STUDIO_HOST: "192.168.1.5" }, "0.0.0.0"), "192.168.1.5");
	assert.equal(bindHost(["--host", "10.0.0.4"], { PI_STUDIO_HOST: "192.168.1.5" }, "0.0.0.0"), "10.0.0.4");
	assert.deepEqual(bindHosts([], {}, ["127.0.0.1", "192.168.1.20"]), ["127.0.0.1", "192.168.1.20"]);
	assert.deepEqual(bindHosts([], { PI_STUDIO_HOST: "192.168.1.5" }, ["127.0.0.1"]), ["192.168.1.5"]);
	assert.deepEqual(bindHosts([], {}, []), [LOOPBACK]);
	assert.equal(bindSource([], {}, ["0.0.0.0"]), "the settings");
	assert.equal(bindSource([], { PI_STUDIO_HOST: "192.168.1.5" }, ["0.0.0.0"]), "the environment");
	assert.equal(bindSource(["--host", "10.0.0.4"], {}, ["0.0.0.0"]), "the flag");
	assert.equal(bindSource([], {}, []), "loopback");
});

test("a stored publish address is this machine's own or nowhere", () => {
	const interfaces = {
		lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
		wlan0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
	};
	assert.equal(validatePublishHost("127.0.0.1", interfaces), "127.0.0.1");
	assert.equal(validatePublishHost("0.0.0.0", interfaces), "0.0.0.0");
	assert.equal(validatePublishHost("192.168.1.20", interfaces), "192.168.1.20");
	for (const foreign of ["8.8.8.8", "192.168.1.99", "0.0.0.0 --no-open", "", "0.0.0.0\u0000"]) {
		assert.throws(() => validatePublishHost(foreign, interfaces), /is not an address/, `accepted ${JSON.stringify(foreign)}`);
	}
	assert.deepEqual(validatePublishHosts(["127.0.0.1", "192.168.1.20", "192.168.1.20"], interfaces), ["127.0.0.1", "192.168.1.20"]);
	assert.deepEqual(validatePublishHosts(["192.168.1.20", "0.0.0.0"], interfaces), ["0.0.0.0"]);
	assert.throws(() => validatePublishHosts([], interfaces), /pick at least one address/);
	assert.throws(() => validatePublishHosts(["8.8.8.8"], interfaces), /is not an address/);
	assert.throws(() => validatePublishHosts("0.0.0.0", interfaces), /a list of addresses/);
});

const MISSING_PAIR = { cert: "/nonexistent-dir/cert.pem", key: "/nonexistent-dir/key.pem" };

test("the npm commands pin their own address and TLS, so a stored publish choice cannot hijack localhost", () => {
	const scripts = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).scripts;
	// The local commands name loopback and switch TLS off: they answer on this machine over plain
	// http whatever `daemon.json` or the shell environment say, which is what a browser opening
	// the printed link needs. The LAN command names every interface and leaves TLS to the config.
	for (const name of ["start", "dev", "dev:alt"]) {
		assert.match(scripts[name], /--host 127\.0\.0\.1/, `${name} does not pin loopback`);
		assert.match(scripts[name], /--no-tls/, `${name} does not switch TLS off`);
	}
	assert.match(scripts.server, /--host 0\.0\.0\.0/, "server does not publish on every interface");
	assert.doesNotMatch(scripts.server, /--no-tls/, "server switches TLS off, so the LAN loses https");
	assert.match(scripts.server, /--no-open/, "server opens a browser");
});

test("TLS is off until both files are named, and a half pair is one sentence", () => {
	assert.equal(tlsConfig([], {}, MISSING_PAIR).enabled, false);
	assert.throws(() => tlsConfig(["--tls-cert", "/tmp/cert.pem"], {}), /TLS needs both/);
	assert.throws(() => tlsConfig([], { PI_STUDIO_TLS_KEY: "/tmp/key.pem" }), /TLS needs both/);
	assert.throws(() => tlsConfig(["--tls-cert", "/tmp/no-such-cert.pem", "--tls-key", "/tmp/no-such-key.pem"], {}), /TLS files could not be read/);
});

test("the printed links follow the scheme the daemon speaks", () => {
	assert.deepEqual(boardUrls("127.0.0.1", 4801, "abc123", undefined, "https"), ["https://127.0.0.1:4801/?token=abc123"]);
});

test("--no-tls and PI_STUDIO_TLS=0 switch TLS off even when a pair exists", () => {
	assert.equal(tlsOff(["--no-tls"], {}), true);
	assert.equal(tlsOff([], { PI_STUDIO_TLS: "0" }), true);
	assert.equal(tlsOff([], { PI_STUDIO_TLS: "false" }), true);
	assert.equal(tlsOff([], { PI_STUDIO_TLS: "1" }), false);
	assert.equal(tlsOff([], {}), false);
	// A generated pair on disk does not turn TLS back on once it was switched off.
	const dir = mkdtempSync(join(tmpdir(), "pi-studio-tls-off-"));
	const made = generateTlsPair(dir, ["localhost"]);
	assert.equal(tlsConfig(["--no-tls"], {}, made).enabled, false);
	assert.equal(tlsConfig([], { PI_STUDIO_TLS: "0" }, made).enabled, false);
});

test("a generated pair serves beyond loopback only; a named pair serves anywhere", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-studio-tls-applies-"));
	const generated = generateTlsPair(dir, ["localhost"]);
	const fromGenerated = tlsConfig([], {}, generated);
	assert.equal(fromGenerated.explicit, false);
	assert.equal(tlsApplies(fromGenerated, ["127.0.0.1"]), false);
	assert.equal(tlsApplies(fromGenerated, ["0.0.0.0"]), true);
	assert.equal(tlsApplies(fromGenerated, ["192.168.1.20"]), true);
	const named = tlsConfig(["--tls-cert", generated.cert, "--tls-key", generated.key], {});
	assert.equal(named.explicit, true);
	assert.equal(tlsApplies(named, ["127.0.0.1"]), true);
	assert.equal(tlsApplies(tlsConfig([], {}, MISSING_PAIR), ["0.0.0.0"]), false);
});

test("with TLS beyond loopback the printed local link is plain http on the neighbour", () => {
	const interfaces = {
		lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
		wlan0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
	};
	const links = boardLinks(["0.0.0.0"], 4801, "abc123", true, interfaces);
	assert.equal(links[0], "http://127.0.0.1:4800/?token=abc123");
	assert.ok(links.includes("https://192.168.1.20:4801/?token=abc123"), links.join(", "));
	assert.ok(!links.some((one) => one.startsWith("https://127.0.0.1")), links.join(", "));
	// Without TLS, and on an explicitly-HTTPS loopback start, the scheme follows the listener.
	assert.deepEqual(boardLinks(["127.0.0.1"], 4801, "abc123", false), ["http://127.0.0.1:4801/?token=abc123"]);
	assert.deepEqual(boardLinks(["127.0.0.1"], 4801, "abc123", true), ["https://127.0.0.1:4801/?token=abc123"]);
});

test("a generated pair parses, matches, and covers the names it was asked for", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-studio-tls-gen-"));
	const made = generateTlsPair(dir, ["localhost", "127.0.0.1", "192.168.1.114"]);
	const certificate = new X509Certificate(readFileSync(made.cert));
	assert.ok(String(certificate.subjectAltName).includes("DNS:localhost"));
	assert.ok(String(certificate.subjectAltName).includes("IP Address:127.0.0.1"));
	assert.ok(String(certificate.subjectAltName).includes("IP Address:192.168.1.114"));
	assert.equal(statSync(made.key).mode & 0o777, 0o600, "the key is readable by others");
	const fromFile = tlsConfig(["--tls-cert", made.cert, "--tls-key", made.key], {});
	assert.equal(fromFile.enabled, true);
	// A different key is not the certificate's pair.
	const other = generateTlsPair(join(dir, "other"), ["localhost"]);
	assert.throws(() => tlsConfig(["--tls-cert", made.cert, "--tls-key", other.key], {}), /do not belong together/);
});
