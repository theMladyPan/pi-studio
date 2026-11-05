import assert from "node:assert/strict";
import { test } from "node:test";
import { LOOPBACK, bindHost, boardUrls, isLoopback, localAddresses } from "../server/listen.ts";

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
