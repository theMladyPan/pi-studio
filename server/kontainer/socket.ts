/**
 * Runtime discovery and the small HTTP-over-Unix-socket client the kontainer
 * drawer talks to the Docker / Podman Engine API through.
 *
 * Reads never spawn `docker ps` / `inspect`: they go over the socket with
 * `node:http`. The CLI is spawned only by actions (compose, build, pull, login).
 */
import { request } from "node:http";
import type { ClientRequest } from "node:http";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logs.ts";

export type RuntimeKind = "docker" | "podman";
export type RuntimeCli = "docker" | "podman";

export interface Runtime {
	id: string;
	label: string;
	kind: RuntimeKind;
	socketPath: string;
	cli: RuntimeCli;
}

export interface SocketCandidate {
	path: string;
	kind: RuntimeKind;
	cli: RuntimeCli;
}

/** Candidate order from the contract: `$DOCKER_HOST`, system, per-user, home sockets. */
export function defaultCandidates(env: Record<string, string | undefined> = process.env, home: string = homedir(), uid: number = process.getuid?.() ?? 1000): SocketCandidate[] {
	const candidates: SocketCandidate[] = [];
	const dockerHost = env.DOCKER_HOST ?? "";
	if (dockerHost.startsWith("unix://")) {
		candidates.push({ path: dockerHost.slice("unix://".length), kind: "docker", cli: "docker" });
	}
	candidates.push({ path: "/var/run/docker.sock", kind: "docker", cli: "docker" });
	candidates.push({ path: `/run/user/${uid}/docker.sock`, kind: "docker", cli: "docker" });
	candidates.push({ path: `/run/user/${uid}/podman/podman.sock`, kind: "podman", cli: "podman" });
	candidates.push({ path: "/run/podman/podman.sock", kind: "podman", cli: "podman" });
	candidates.push({ path: join(home, ".docker/run/docker.sock"), kind: "docker", cli: "docker" });
	candidates.push({ path: join(home, ".orbstack/run/docker.sock"), kind: "docker", cli: "docker" });
	candidates.push({ path: join(home, ".colima/default/docker.sock"), kind: "docker", cli: "docker" });
	return candidates;
}

function isSocket(path: string): boolean {
	try {
		return statSync(path).isSocket();
	} catch {
		return false;
	}
}

function dedupeKey(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export interface DiscoverOptions {
	/** Overrides the default candidate list (tests inject a mock Unix socket here). */
	candidates?: SocketCandidate[];
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export function discoverRuntimes(opts: DiscoverOptions = {}): Runtime[] {
	const candidates = opts.candidates ?? defaultCandidates(opts.env ?? process.env, opts.home ?? homedir(), opts.uid ?? (process.getuid?.() ?? 1000));
	const seen = new Set<string>();
	const runtimes: Runtime[] = [];
	const kindCount = new Map<string, number>();
	for (const candidate of candidates) {
		if (!candidate.path || !isSocket(candidate.path)) continue;
		const key = dedupeKey(candidate.path);
		if (seen.has(key)) continue;
		seen.add(key);
		const n = (kindCount.get(candidate.kind) ?? 0) + 1;
		kindCount.set(candidate.kind, n);
		const id = n === 1 ? candidate.kind : `${candidate.kind}-${n}`;
		const name = candidate.kind === "docker" ? "Docker" : "Podman";
		runtimes.push({ id, label: `${name} (${candidate.path})`, kind: candidate.kind, socketPath: candidate.path, cli: candidate.cli });
	}
	return runtimes;
}

/** The runtime a `?runtime=` param names, or the first discovered one. */
export function resolveRuntime(runtimes: Runtime[], requested: string | null | undefined): Runtime | null {
	if (runtimes.length === 0) return null;
	if (requested) {
		const found = runtimes.find((r) => r.id === requested);
		if (found) return found;
	}
	return runtimes[0];
}

export interface SocketRequestOptions {
	method?: string;
	body?: string;
	timeoutMs?: number;
	headers?: Record<string, string>;
}

/** What an engine caller may say about the runtime it talks to: the socket, and the CLI name when known. */
export type EngineRuntime = { socketPath: string; cli?: string };

/** The drawer's column for one engine line: the CLI name, so an API call reads beside the CLI call that would have made it. */
function engineSource(runtime: EngineRuntime): string {
	return runtime.cli ?? "kontainer";
}

/** The engine's own sentence in a body: the `message` field a refusal carries, or the trimmed body. */
function engineDetail(body: Buffer): string {
	let message = body.toString("utf8").trim();
	try {
		const parsed = JSON.parse(message) as { message?: string };
		if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
	} catch {}
	return message;
}

function engineError(status: number, body: Buffer): Error {
	return new Error(`engine request failed (${status}): ${engineDetail(body) || "empty response"}`);
}

/**
 * One JSON request over the Engine socket. Throws on a non-2xx status. The call lands in the daemon's
 * log where a human can find it without the drawer open: a write is news (`info`, a failure is `error`),
 * a read is only `debug` until it fails, because the drawer polls reads every second and a poll is not news.
 */
export function requestJson(runtime: EngineRuntime, path: string, opts: SocketRequestOptions = {}): Promise<unknown> {
	const method = opts.method ?? "GET";
	const command = `${method} ${path}`;
	const source = engineSource(runtime);
	const startedAt = Date.now();
	const isRead = method === "GET";
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath: runtime.socketPath,
				path,
				method,
				timeout: opts.timeoutMs ?? 15_000,
				headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const body = Buffer.concat(chunks);
					const status = res.statusCode ?? 500;
					const dur = Date.now() - startedAt;
					if (status >= 400) {
						log(isRead ? "debug" : "error", source, `${command} · ${engineDetail(body).slice(0, 300) || `failed with ${status}`}`, { cmd: command, exit: status, dur });
						reject(engineError(status, body));
						return;
					}
					if (!isRead) log("info", source, command, { cmd: command, exit: status, dur });
					if (body.length === 0) {
						resolve(null);
						return;
					}
					try {
						resolve(JSON.parse(body.toString("utf8")));
					} catch {
						reject(new Error("engine returned a non-JSON response"));
					}
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("engine request timed out")));
		req.on("error", (error) => {
			log(isRead ? "debug" : "error", source, `${command} · ${(error as Error).message}`, { cmd: command, exit: "failed", dur: Date.now() - startedAt });
			reject(error);
		});
		if (opts.body !== undefined) req.write(opts.body);
		req.end();
	});
}

/**
 * One raw-buffer request over the Engine socket (container logs). A container's own output is never
 * logged — it would flood the ring in seconds — but a refusal to fetch it is worth a `debug` line.
 */
export function requestBuffer(runtime: EngineRuntime, path: string, opts: SocketRequestOptions = {}): Promise<Buffer> {
	const command = `GET ${path}`;
	const source = engineSource(runtime);
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath: runtime.socketPath,
				path,
				method: opts.method ?? "GET",
				timeout: opts.timeoutMs ?? 15_000,
				headers: { ...(opts.headers ?? {}) },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const body = Buffer.concat(chunks);
					const status = res.statusCode ?? 500;
					if (status >= 400) {
						log("debug", source, `${command} · ${engineDetail(body).slice(0, 300) || `failed with ${status}`}`, { cmd: command, exit: status, dur: Date.now() - startedAt });
						reject(engineError(status, body));
						return;
					}
					resolve(body);
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("engine request timed out")));
		req.on("error", (error) => {
			log("debug", source, `${command} · ${(error as Error).message}`, { cmd: command, exit: "failed", dur: Date.now() - startedAt });
			reject(error);
		});
		req.end();
	});
}

export interface SocketStreamHandle {
	close: () => void;
	request: ClientRequest;
}

/**
 * A streaming request over the Engine socket (the events feed). The returned
 * `close()` destroys the upstream request; the SSE route calls it the moment
 * the browser goes away, so nothing leaks when the drawer closes.
 */
export function openSocketStream(runtime: EngineRuntime, path: string, onChunk: (chunk: Buffer) => void, onError?: (error: Error) => void): SocketStreamHandle {
	const req = request({ socketPath: runtime.socketPath, path, method: "GET", headers: { Accept: "application/json" } }, (res) => {
		if ((res.statusCode ?? 500) >= 400) {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => onError?.(engineError(res.statusCode ?? 500, Buffer.concat(chunks))));
			return;
		}
		res.on("data", onChunk);
	});
	req.on("error", (error) => onError?.(error as Error));
	req.end();
	return { close: () => req.destroy(), request: req };
}

/**
 * Docker's multiplexed log stream: 8-byte headers (stream type 0/1/2, three
 * zero bytes, big-endian payload length). A buffer that does not start with a
 * valid header is raw TTY output and is returned as-is.
 */
export function demuxDockerLogs(buf: Buffer): string {
	if (buf.length < 8) return buf.toString("utf8");
	const type = buf[0];
	const looksMultiplexed = (type === 0 || type === 1 || type === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
	if (!looksMultiplexed) return buf.toString("utf8");
	const parts: string[] = [];
	let offset = 0;
	while (offset + 8 <= buf.length) {
		const frameType = buf[offset];
		if (frameType > 2 || buf[offset + 1] !== 0 || buf[offset + 2] !== 0 || buf[offset + 3] !== 0) break;
		const length = buf.readUInt32BE(offset + 4);
		if (length > buf.length - (offset + 8)) break;
		parts.push(buf.subarray(offset + 8, offset + 8 + length).toString("utf8"));
		offset += 8 + length;
	}
	if (offset === 0) return buf.toString("utf8");
	return parts.join("");
}
