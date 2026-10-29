// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The wire: reading a request body, answering it, and handing back a static file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DIR } from "./paths.ts";
import { MAX_BODY_BYTES } from "./core.ts";



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



export function serveStatic(res, file, type) {
	try {
		const body = readFileSync(join(PUBLIC_DIR, file));
		res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
		res.end(body);
	} catch (error) {
		console.error(`pi-studio: cannot serve ${file}: ${error.message}`);
		fail(res, 404, "not found");
	}
}



export function send(target, payload) {
	const frame = `data: ${JSON.stringify(payload)}\n\n`;
	for (const client of target) {
		// A tab that closed is still in the set for a moment; writing to its dead socket would raise
		// an error nobody is listening for.
		if (client.writableEnded || client.destroyed) {
			target.delete(client);
			continue;
		}
		client.write(frame);
	}
}



// ---------- http plumbing --------------------------------------------------

export function readBody(req, limit = MAX_BODY_BYTES) {
	return new Promise((done) => {
		const chunks = [];
		let size = 0;
		let oversized = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) oversized = true;
			else chunks.push(chunk);
		});
		req.on("end", () => done(oversized ? undefined : Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => done(undefined));
	});
}
