/**
 * The words a plugin executable and this daemon say to each other.
 *
 * One JSON-RPC 2.0 message per line, in both directions: the host spawns a trusted program and asks it
 * for work, and that program asks the host for work in return. A line is the frame because a pipe
 * carries no boundaries of its own, and LF is the boundary because every language can write one without
 * a library. Reading is streaming, so a frame that arrives in the middle of a multi-byte character still
 * reads, and one that would grow the buffer past a megabyte is dropped rather than kept.
 *
 * `initialize` is the only method this version fixes, and it carries the version handshake: the host
 * sends it first, so a plugin built for another protocol is refused at startup rather than at the first
 * call that means something.
 */
import { StringDecoder } from "node:string_decoder";

// ---------- the version and the limits ----------

/** What both ends say in `initialize`. A plugin that answers another number is refused. */
export const PROTOCOL_VERSION = 1;

/**
 * What this daemon may add inside one wire version: new methods, new fields, new optional keys.
 * A plugin that asks for a newer minor than this daemon carries is refused at the handshake rather
 * than at the first call that needs it, while one that asks for no minor than this one runs.
 */
export const PROTOCOL_MINOR = 0;

/** The one method the host calls before anything else. */
export const INITIALIZE = "initialize";

/** The notification the host sends on its way out, so a plugin can stop tidily. Best effort. */
export const SHUTDOWN = "shutdown";

/**
 * How large one frame may be, in bytes of the line without its LF. A megabyte holds a whole card of
 * text; anything past it is a runaway, and a frame nobody can send is a plugin that fills the heap.
 */
export const MAX_FRAME_BYTES = 1024 * 1024;

// ---------- the errors ----------

/** The standard JSON-RPC codes, then the implementation range for a plugin that is gone or silent. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** The plugin exited, timed out, or is not running any more. */
export const PLUGIN_UNAVAILABLE = -32000;

/** The id JSON-RPC pairs a request with its answer. A number is what this host sends. */
export type PluginId = string | number;

/** The error object a refusal carries, in the shape every JSON-RPC client reads. */
export type PluginErrorObject = { code: number; message: string; data?: unknown };

/** A frame on the wire, before it is a line. */
export type PluginWire =
	| { jsonrpc: "2.0"; id: PluginId; method: string; params?: unknown }
	| { jsonrpc: "2.0"; method: string; params?: unknown }
	| { jsonrpc: "2.0"; id: PluginId | null; result: unknown }
	| { jsonrpc: "2.0"; id: PluginId | null; error: PluginErrorObject };

// ---------- a frame read back ----------

/** A call waiting for an answer. */
export type PluginRequest = { kind: "request"; id: PluginId; method: string; params: unknown };

/** Something said with no answer wanted. */
export type PluginNotification = { kind: "notification"; method: string; params: unknown };

/** An answer to a call this end made: a result, or the error that replaced it. */
export type PluginResponse =
	| { kind: "response"; id: PluginId; result: unknown }
	| { kind: "response"; id: PluginId; error: PluginErrorObject };

/** A frame that could not be read, with the id it named when it named one at all. */
export type PluginInvalid = { kind: "invalid"; id: PluginId | null; error: PluginErrorObject };

export type PluginMessage = PluginRequest | PluginNotification | PluginResponse | PluginInvalid;

// ---------- building a frame ----------

/** A call this end makes. */
export function requestFrame(id: PluginId, method: string, params?: unknown): PluginWire {
	return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

/** Something this end says with no answer wanted. */
export function notificationFrame(method: string, params?: unknown): PluginWire {
	return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

/** The answer to a call the other end made. */
export function resultFrame(id: PluginId, result: unknown): PluginWire {
	return { jsonrpc: "2.0", id, result: result ?? null };
}

/** The refusal that stands in for an answer. A frame nobody could read is answered with a null id. */
export function errorFrame(id: PluginId | null, error: PluginErrorObject): PluginWire {
	return { jsonrpc: "2.0", id, error };
}

/**
 * One message as the line it goes out as. A frame past the limit throws rather than going out: the
 * other end would drop it, and a caller is better told here than left waiting for an answer that
 * could never arrive.
 */
export function encodeFrame(message: PluginWire): string {
	const text = JSON.stringify(message);
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_FRAME_BYTES) throw new Error(`a plugin frame of ${bytes} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`);
	return `${text}\n`;
}

// ---------- reading a frame ----------

/**
 * One line as the message it is, or as the reason it is not one. Nothing here throws: a plugin that
 * says something unreadable is answered with a parse error, and the connection stays up.
 */
export function parseMessage(line: string): PluginMessage {
	let bag: unknown;
	try {
		bag = JSON.parse(line);
	} catch {
		return invalid(null, PARSE_ERROR, "the frame is not JSON");
	}
	if (typeof bag !== "object" || bag === null || Array.isArray(bag)) return invalid(null, INVALID_REQUEST, "a frame must be one JSON object");
	const message = bag as Record<string, unknown>;
	if (message.jsonrpc !== "2.0") return invalid(message.id, INVALID_REQUEST, 'every frame must say "jsonrpc": "2.0"');
	const hasId = "id" in message;
	const id = idOf(message.id);
	if (hasId && id === null) return invalid(null, INVALID_REQUEST, "an id must be a string or a number");
	if (typeof message.method === "string" && message.method.trim() !== "") {
		const method = message.method;
		return hasId ? { kind: "request", id: id as PluginId, method, params: message.params } : { kind: "notification", method, params: message.params };
	}
	if (!hasId) return invalid(null, INVALID_REQUEST, "a frame is a request, a response or a notification");
	const named = id as PluginId;
	if ("error" in message) return { kind: "response", id: named, error: errorObject(message.error) };
	if ("result" in message) return { kind: "response", id: named, result: message.result };
	return invalid(named, INVALID_REQUEST, "a response carries a result or an error");
}

function invalid(id: unknown, code: number, message: string): PluginInvalid {
	return { kind: "invalid", id: idOf(id), error: { code, message } };
}

function idOf(value: unknown): PluginId | null {
	return typeof value === "string" || typeof value === "number" ? value : null;
}

/** A refusal read as the three things a caller can act on, whatever the plugin actually wrote. */
function errorObject(value: unknown): PluginErrorObject {
	if (typeof value !== "object" || value === null) return { code: INTERNAL_ERROR, message: "the plugin answered an error that is not an object" };
	const bag = value as Record<string, unknown>;
	const code = typeof bag.code === "number" && Number.isFinite(bag.code) ? bag.code : INTERNAL_ERROR;
	const message = typeof bag.message === "string" ? bag.message : "the plugin answered an error with no message";
	return bag.data === undefined ? { code, message } : { code, message, data: bag.data };
}

/**
 * The lines a stream of bytes makes, one chunk at a time.
 *
 * Chunks land in the middle of characters and in the middle of frames, so the bytes are decoded
 * through one decoder that carries a split character into the next chunk, and the text is held until
 * its LF arrives. One CR before the LF is stripped, because a plugin written on Windows writes its
 * lines that way. A frame past the limit, and everything up to its LF, is dropped and counted.
 */
export class FrameReader {
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	/** Set when the buffer passed the limit with no LF in it: the rest of that frame is dropped. */
	private discarding = false;

	/** The frames one chunk completed, and how many frames were dropped for their size. */
	push(chunk: Buffer | string): { frames: string[]; dropped: number } {
		const frames: string[] = [];
		let dropped = 0;
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		for (;;) {
			const end = this.buffer.indexOf("\n");
			if (end === -1) break;
			let line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			if (this.discarding) {
				this.discarding = false;
				dropped += 1;
				continue;
			}
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
				dropped += 1;
				continue;
			}
			if (line.trim() !== "") frames.push(line);
		}
		// A character is at most four bytes, so more characters than the limit is already over it.
		if (this.buffer.length > MAX_FRAME_BYTES) {
			this.buffer = "";
			this.discarding = true;
		}
		return { frames, dropped };
	}
}
