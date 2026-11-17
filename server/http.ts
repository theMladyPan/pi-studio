// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The wire: reading a request body, answering it, and handing back a static file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DIR } from "./paths.ts";
import { MAX_BODY_BYTES } from "./limits.ts";



/** Read and parse a JSON body. Answers 400 or 413 itself and returns null, so the caller stops. */
export async function readJson(req, res) {
	const body = await readBody(req);
	if (body === undefined) {
		fail(res, 413, "body too large");
		return null;
	}
	if (!body.trim()) return {};
	try {
		return JSON.parse(body);
	} catch {
		fail(res, 400, "bad json");
		return null;
	}
}



export function fail(res, status, message) {
	res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
	res.end(message);
	return undefined;
}



export function answer(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(payload));
}



/**
 * A file under `public/`, with any extra headers the caller's surface needs. A page that carries a
 * Content Security Policy or a framing rule says so here rather than at four call sites that each have
 * to remember the same four lines.
 */
export function serveStatic(res, file, type, headers) {
	try {
		const body = readFileSync(join(PUBLIC_DIR, file));
		res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
		res.end(body);
	} catch (error) {
		console.error(`pi-studio: cannot serve ${file}: ${error.message}`);
		fail(res, 404, "not found");
	}
}



const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Answer a socket asking for a WebSocket upgrade without switching protocols. */
export function rejectUpgrade(socket, status, message) {
	const reason = status === 403 ? "Forbidden" : status === 409 ? "Conflict" : "Bad Request";
	socket.write(
		`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n${message}`,
	);
	socket.destroy();
}

function encodeWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
	let header;
	if (body.length < 126) {
		header = Buffer.from([0x80 | opcode, body.length]);
	} else if (body.length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(body.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(body.length), 2);
	}
	return Buffer.concat([header, body]);
}

/**
 * Upgrade one authenticated request to a WebSocket. The returned object keeps the small write shape
 * the board's broadcast helper already knows, so a board tab and a welcome tab differ only in which
 * client set they join.
 */
export function upgradeWebSocket(req, socket, head) {
	const key = req.headers["sec-websocket-key"];
	const upgrade = String(req.headers.upgrade || "").toLowerCase();
	const connection = String(req.headers.connection || "")
		.split(",")
		.map((part) => part.trim().toLowerCase());
	const keyBytes = typeof key === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(key) && key.length % 4 === 0
		? Buffer.from(key, "base64")
		: Buffer.alloc(0);
	if (
		upgrade !== "websocket" ||
		!connection.includes("upgrade") ||
		keyBytes.length !== 16 ||
		req.headers["sec-websocket-version"] !== "13"
	) {
		rejectUpgrade(socket, 400, "bad websocket handshake");
		return null;
	}

	let closed = false;
	let inbound = Buffer.alloc(0);
	const client = {
		webSocket: true,
		readyState: 1,
		onClose: null,
		write(payload) {
			if (!closed && !socket.destroyed) socket.write(encodeWebSocketFrame(0x1, payload));
		},
		ping() {
			if (!closed && !socket.destroyed) socket.write(encodeWebSocketFrame(0x9));
		},
		close() {
			if (closed) return;
			try {
				socket.write(encodeWebSocketFrame(0x8));
			} catch {}
			socket.end();
			markClosed();
		},
		get writableEnded() {
			return closed || socket.destroyed;
		},
		get destroyed() {
			return closed || socket.destroyed;
		},
	};
	const markClosed = () => {
		if (closed) return;
		closed = true;
		client.readyState = 3;
		client.onClose?.();
	};
	const handleData = (chunk) => {
		inbound = Buffer.concat([inbound, chunk]);
		for (;;) {
			if (inbound.length < 2) return;
			const fin = (inbound[0] & 0x80) !== 0;
			const opcode = inbound[0] & 0x0f;
			const masked = (inbound[1] & 0x80) !== 0;
			if ((inbound[0] & 0x70) !== 0 || ![0, 1, 2, 8, 9, 10].includes(opcode) || !masked) {
				socket.destroy();
				return;
			}
			if (opcode >= 8 && (!fin || (inbound[1] & 0x7f) > 125)) {
				socket.destroy();
				return;
			}
			let payloadLength = inbound[1] & 0x7f;
			let offset = 2;
			if (payloadLength === 126) {
				if (inbound.length < 4) return;
				payloadLength = inbound.readUInt16BE(2);
				offset = 4;
			} else if (payloadLength === 127) {
				if (inbound.length < 10) return;
				const length = inbound.readBigUInt64BE(2);
				if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
					socket.destroy();
					return;
				}
				payloadLength = Number(length);
				offset = 10;
			}
			if (payloadLength > 16 * 1024 * 1024) {
				socket.destroy();
				return;
			}
			const maskLength = masked ? 4 : 0;
			if (inbound.length < offset + maskLength + payloadLength) return;
			let payload = Buffer.from(inbound.subarray(offset + maskLength, offset + maskLength + payloadLength));
			if (masked) {
				const mask = inbound.subarray(offset, offset + 4);
				for (let at = 0; at < payload.length; at++) payload[at] ^= mask[at % 4];
			}
			inbound = Buffer.from(inbound.subarray(offset + maskLength + payloadLength));
			if (opcode === 0x8) {
				if (payload.length === 1) {
					socket.destroy();
					return;
				}
				if (payload.length >= 2) {
					const code = payload.readUInt16BE(0);
					const known = code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
					const appCode = code >= 3000 && code <= 4999;
					if (!known && !appCode) {
						socket.destroy();
						return;
					}
					try {
						new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
					} catch {
						socket.destroy();
						return;
					}
				}
				client.close();
				return;
			}
			if (opcode === 0x9) {
				if (!closed && !socket.destroyed) socket.write(encodeWebSocketFrame(0xa, payload));
				continue;
			}
			if (opcode === 0xa) continue;
			// Application messages are not used in this direction: the browser only receives live
			// frames, so the server only needs control frames and close codes from it. Continuation
			// frames without a message and stray text frames are simply not accepted.
			if (opcode === 0 || opcode === 0x1 || opcode === 0x2) {
				socket.destroy();
				return;
			}
		}
	};

	socket.once("close", markClosed);
	socket.once("error", markClosed);
	socket.on("data", handleData);
	if (typeof socket.setNoDelay === "function") socket.setNoDelay(true);
	const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	if (head?.length) handleData(head);
	return client;
}

export function send(target, payload) {
	const data = JSON.stringify(payload);
	for (const client of target) {
		// A tab that closed is still in the set for a moment; writing to its dead socket would raise
		// an error nobody is listening for. Live clients are WebSocket adapters, so the JSON is the
		// frame; tests carry the same shape in a fake client.
		const frame = data;
		if (client.writableEnded || client.destroyed || client.closed) {
			target.delete(client);
			continue;
		}
		try {
			client.write(frame);
		} catch {
			target.delete(client);
		}
	}
}



// ---------- http plumbing --------------------------------------------------

/** Read a body as text, or `undefined` when it outgrew the limit. */
export function readBody(req, limit = MAX_BODY_BYTES) {
	return readBytes(req, limit).then((bytes) => bytes?.toString("utf8"));
}


/**
 * Read a body as the bytes that arrived, or `undefined` when it outgrew the limit. A dropped file is not
 * text, so the body is kept whole rather than decoded into a string a write would mangle.
 */
export function readBytes(req, limit = MAX_BODY_BYTES) {
	return new Promise((done) => {
		const chunks = [];
		let size = 0;
		let oversized = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) oversized = true;
			else chunks.push(chunk);
		});
		req.on("end", () => done(oversized ? undefined : Buffer.concat(chunks)));
		req.on("error", () => done(undefined));
	});
}
