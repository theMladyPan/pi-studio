#!/usr/bin/env node
/**
 * An example plugin: a program the daemon starts and asks for work, and one that offers the board a panel.
 *
 * It speaks the daemon's line protocol — one JSON-RPC message per line on stdin and stdout — and answers
 * two things: `initialize`, which is the handshake every plugin answers, and `visual.request`, which is
 * what its own panel asks through the board. Nothing here reaches a file, a network or a folder; it is the
 * smallest program that is still a real plugin, so it can be read as the shape a bigger one fills in.
 *
 * The panel it offers is declared in the daemon's `plugins.json` beside this executable's absolute path,
 * and served from this folder — see `README.md` next to it.
 */
import { createInterface } from "node:readline";

/** The protocol version this plugin speaks. A daemon that speaks another one refuses it at startup. */
const PROTOCOL_VERSION = 1;

/** What this panel may ask for. Anything else is refused, which is what a plugin refusing looks like. */
const METHODS = ["echo", "now"];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const refuse = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

createInterface({ input: process.stdin }).on("line", (line) => {
	if (line.trim() === "") return;
	let frame;
	try {
		frame = JSON.parse(line);
	} catch {
		return refuse(null, -32700, "the frame is not JSON");
	}
	if (typeof frame?.method !== "string") return;
	if (frame.method === "initialize") {
		return result(frame.id, { protocolVersion: PROTOCOL_VERSION, name: "example-panel", version: "0.0.1" });
	}
	// The daemon's notice on its way out: there is nothing to tidy here, so leaving is the whole answer.
	if (frame.method === "shutdown") return void process.exit(0);
	if (frame.method !== "visual.request") {
		return refuse(frame.id, -32601, `${frame.method} is not a method this plugin answers; it answers initialize and visual.request`);
	}
	// The daemon builds this envelope: the workspace it resolved from its own list, and the method and
	// params the panel asked for. A plugin never receives a folder it asked for itself.
	const { workspace, method, params } = frame.params ?? {};
	if (method === "echo") return result(frame.id, { workspace, method, params });
	if (method === "now") return result(frame.id, { workspace, at: Date.now() });
	refuse(frame.id, -32601, `${method} is not something this panel asks for; it asks for ${METHODS.join(" and ")}`);
});
