/**
 * Topology building and Engine reads for the kontainer drawer: images,
 * containers, wiring (ports / networks / volumes), per-container stats, detail
 * tabs, disk usage and the workspace file scan.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { demuxDockerLogs, discoverRuntimes, requestBuffer, requestJson, resolveRuntime } from "./socket.ts";
import type { Runtime } from "./socket.ts";

export type Scope = "workspace" | "all";
export type ContainerState = "running" | "exited" | "paused" | "restarting" | "created" | "dead";
export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none";

export interface KontainerImage {
	id: string;
	shortId: string;
	repo: string;
	tag: string;
	name: string;
	sizeBytes: number;
	created: number;
	dangling: boolean;
	inUse: boolean;
	drift: boolean;
	containerIds: string[];
	layersCount: number;
}

export interface PortBinding {
	id: string;
	hostIp: string;
	hostPort: number | null;
	containerPort: number;
	proto: string;
}

export interface KontainerContainer {
	id: string;
	shortId: string;
	name: string;
	imageName: string;
	imageId: string;
	state: ContainerState;
	health: ContainerHealth;
	statusText: string;
	exitCode: number | null;
	oomKilled: boolean;
	composeProject: string | null;
	composeService: string | null;
	composeWorkingDir: string | null;
	inWorkspace: boolean;
	staleImage: boolean;
	ports: PortBinding[];
	networkIds: string[];
	volumeIds: string[];
	created: number;
}

export interface PortWiring {
	id: string;
	label: string;
	hostIp: string;
	hostPort: number | null;
	containerPort: number;
	proto: string;
	listening: boolean;
	containerIds: string[];
}

export interface NetworkWiring {
	id: string;
	name: string;
	driver: string;
	subnet: string | null;
	containerIds: string[];
}

export interface VolumeWiring {
	id: string;
	kind: "volume" | "bind";
	label: string;
	source: string;
	destination: string;
	rw: boolean;
	containerIds: string[];
}

export interface TopologySummary {
	running: number;
	issues: number;
	totalContainers: number;
	workspaceContainers: number;
	allContainers: number;
	totalImages: number;
	unusedImages: number;
	unusedBytes: number;
	totalImageBytes: number;
}

export interface Topology {
	images: KontainerImage[];
	containers: KontainerContainer[];
	wiring: {
		ports: PortWiring[];
		networks: NetworkWiring[];
		volumes: VolumeWiring[];
	};
	summary: TopologySummary;
}

export interface KontainerState {
	available: boolean;
	reason: string | null;
	runtimes: Runtime[];
	activeRuntime: string | null;
	engineVersion: string | null;
	workspaceFolder: string;
	composeFiles: string[];
	dockerfiles: string[];
	scope: Scope;
	topology: Topology | null;
}

// ---------- small helpers ----------

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function shortId(id: string): string {
	return (id.startsWith("sha256:") ? id.slice(7) : id).slice(0, 12);
}

/** Lowercased, separator-normalized form for workspace membership tests. */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isInsideDir(candidate: string, dir: string): boolean {
	const c = normalizePath(candidate);
	const d = normalizePath(dir);
	return c === d || c.startsWith(d + "/");
}

export function normalizeProjectName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseRepoTag(repoTag: string): { repo: string; tag: string } {
	const at = repoTag.lastIndexOf("@");
	if (at > 0) return { repo: repoTag.slice(0, at), tag: repoTag.slice(at + 1) };
	const colon = repoTag.lastIndexOf(":");
	const slash = repoTag.lastIndexOf("/");
	if (colon > slash) return { repo: repoTag.slice(0, colon), tag: repoTag.slice(colon + 1) };
	return { repo: repoTag, tag: "latest" };
}

function toMs(seconds: unknown): number {
	const n = asNumber(seconds);
	return n > 0 && n < 1e12 ? n * 1000 : n;
}

const CONTAINER_STATES = new Set(["running", "exited", "paused", "restarting", "created", "dead"]);

function containerState(raw: unknown): ContainerState {
	const s = asString(raw).toLowerCase();
	return CONTAINER_STATES.has(s) ? (s as ContainerState) : "created";
}

function containerHealth(statusText: string): ContainerHealth {
	const s = statusText.toLowerCase();
	if (s.includes("(healthy)")) return "healthy";
	if (s.includes("(unhealthy)")) return "unhealthy";
	if (s.includes("(starting)")) return "starting";
	return "none";
}

function exitCodeFromStatus(statusText: string): number | null {
	const match = statusText.match(/Exited \((\d+)\)/);
	return match ? Number(match[1]) : null;
}

// ---------- topology ----------

export interface BuildTopologyInput {
	imagesRaw: unknown[];
	containersRaw: unknown[];
	networksRaw?: unknown[];
	volumesRaw?: unknown;
	folder: string;
	scope: Scope;
}

export function buildTopology(input: BuildTopologyInput): Topology {
	const folder = input.folder;
	const projectName = folder ? normalizeProjectName(basename(folder)) : "";

	// One image per local image record; `<none>:<none>` is dangling.
	const images: KontainerImage[] = [];
	const imageByName = new Map<string, KontainerImage>();
	const imageById = new Map<string, KontainerImage>();
	for (const raw of input.imagesRaw) {
		const image = asRecord(raw);
		const id = asString(image.Id);
		const repoTags = asArray(image.RepoTags).filter((t): t is string => typeof t === "string" && t.length > 0);
		const first = repoTags[0] ?? "<none>:<none>";
		const { repo, tag } = parseRepoTag(first);
		const dangling = repo === "<none>" || repoTags.length === 0;
		const entry: KontainerImage = {
			id,
			shortId: shortId(id),
			repo,
			tag,
			name: dangling ? "<none>:<none>" : first,
			sizeBytes: asNumber(image.Size),
			created: toMs(image.Created),
			dangling,
			inUse: false,
			drift: false,
			containerIds: [],
			layersCount: 0,
		};
		images.push(entry);
		imageById.set(id, entry);
		for (const repoTag of repoTags) {
			if (repoTag !== "<none>:<none>") imageByName.set(repoTag, entry);
		}
	}

	// Containers: workspace membership, ports, networks, volumes.
	const parsed: Array<{ container: KontainerContainer; mounts: Array<{ type: string; source: string; destination: string; rw: boolean }> }> = [];
	const allContainers: KontainerContainer[] = [];
	for (const raw of input.containersRaw) {
		const c = asRecord(raw);
		const labels = asRecord(c.Labels);
		const composeProject = asString(labels["com.docker.compose.project"]) || null;
		const composeService = asString(labels["com.docker.compose.service"]) || null;
		const composeWorkingDir = asString(labels["com.docker.compose.project.working_dir"]) || null;
		const names = asArray(c.Names).filter((n): n is string => typeof n === "string");
		const name = (names[0] ?? "").replace(/^\//, "");
		const statusText = asString(c.Status);
		const imageName = asString(c.Image);
		const imageId = asString(c.ImageID);
		const mountsRaw = asArray(c.Mounts);
		const mounts = mountsRaw.map((m) => {
			const mount = asRecord(m);
			const mode = asString(mount.Mode);
			return {
				type: asString(mount.Type) || "volume",
				source: asString(mount.Source),
				destination: asString(mount.Destination),
				rw: mode !== "ro" && mode !== "z" && mode !== "Z",
			};
		});
		const networkSettings = asRecord(c.NetworkSettings);
		const networks = asRecord(networkSettings.Networks);
		const networkIds = Object.keys(networks);
		const ports: PortBinding[] = asArray(c.Ports).map((p, index) => {
			const port = asRecord(p);
			const hostPortRaw = port.PublicPort;
			const hostPort = typeof hostPortRaw === "number" ? hostPortRaw : null;
			const containerPort = asNumber(port.PrivatePort);
			const proto = asString(port.Type) || "tcp";
			const hostIp = asString(port.IP);
			return { id: `${shortId(asString(c.Id))}:p${index}`, hostIp, hostPort, containerPort, proto };
		});
		const volumeIds = mounts.filter((m) => m.type === "volume").map((m) => m.source);
		const bindSources = mounts.filter((m) => m.type === "bind").map((m) => m.source);
		const inWorkspace =
			(composeWorkingDir !== null && !!folder && isInsideDir(composeWorkingDir, folder)) ||
			(bindSources.some((source) => !!folder && isInsideDir(source, folder))) ||
			(composeProject !== null && projectName !== "" && normalizeProjectName(composeProject) === projectName);
		const container: KontainerContainer = {
			id: asString(c.Id),
			shortId: shortId(asString(c.Id)),
			name,
			imageName,
			imageId,
			state: containerState(c.State),
			health: containerHealth(statusText),
			statusText,
			exitCode: exitCodeFromStatus(statusText),
			oomKilled: false,
			composeProject,
			composeService,
			composeWorkingDir,
			inWorkspace,
			staleImage: false,
			ports,
			networkIds,
			volumeIds,
			created: toMs(c.Created),
		};
		allContainers.push(container);
		parsed.push({ container, mounts });
	}

	// Stale-image drift: the name now points at a different local image id.
	for (const container of allContainers) {
		const current = imageByName.get(container.imageName);
		if (!current) continue;
		const containerImageId = container.imageId.startsWith("sha256:") ? container.imageId.slice(7) : container.imageId;
		const currentId = current.id.startsWith("sha256:") ? current.id.slice(7) : current.id;
		if (containerImageId && containerImageId !== currentId) {
			container.staleImage = true;
			current.drift = true;
		}
	}

	// Image <-> container links, over every container (drift and unused counts
	// describe the engine, not the current scope).
	const usedImageIds = new Set<string>();
	for (const container of allContainers) {
		const byId = imageById.get(container.imageId);
		const byName = byId ?? imageByName.get(container.imageName);
		if (byName && !byName.containerIds.includes(container.id)) {
			byName.containerIds.push(container.id);
			byName.inUse = true;
			usedImageIds.add(byName.id);
		}
	}

	// Scope filtering.
	const visible = input.scope === "all" ? allContainers : allContainers.filter((c) => c.inWorkspace);
	const visibleIds = new Set(visible.map((c) => c.id));
	const visibleImageIds = new Set<string>();
	for (const container of visible) {
		const byId = imageById.get(container.imageId);
		const byName = byId ?? imageByName.get(container.imageName);
		if (byName) visibleImageIds.add(byName.id);
	}
	const visibleImages =
		input.scope === "all" ? images : images.filter((image) => visibleImageIds.has(image.id) || image.dangling);

	// Wiring, deduplicated, filtered to visible containers.
	const portWiring = new Map<string, PortWiring>();
	const networkWiring = new Map<string, NetworkWiring>();
	const volumeWiring = new Map<string, VolumeWiring>();
	const networkMeta = new Map<string, { driver: string; subnet: string | null }>();
	for (const raw of input.networksRaw ?? []) {
		const network = asRecord(raw);
		const name = asString(network.Name);
		const ipam = asRecord(network.IPAM);
		const config = asArray(ipam.Config)[0];
		const subnet = config ? asString(asRecord(config).Subnet) || null : null;
		if (name) networkMeta.set(name, { driver: asString(network.Driver), subnet });
	}
	const volumeNames = new Set<string>();
	if (input.volumesRaw && typeof input.volumesRaw === "object") {
		for (const raw of asArray(asRecord(input.volumesRaw).Volumes)) {
			const name = asString(asRecord(raw).Name);
			if (name) volumeNames.add(name);
		}
	}
	for (const { container, mounts } of parsed) {
		if (!visibleIds.has(container.id)) continue;
		for (const port of container.ports) {
			const key = `${port.hostIp}:${port.hostPort ?? ""}:${port.containerPort}/${port.proto}`;
			const existing = portWiring.get(key);
			if (existing) {
				if (!existing.containerIds.includes(container.id)) existing.containerIds.push(container.id);
			} else {
				portWiring.set(key, {
					id: `port:${key}`,
					label: port.hostPort !== null ? `${port.hostIp ? `${port.hostIp}:` : ""}${port.hostPort} → ${port.containerPort}/${port.proto}` : `:${port.containerPort}/${port.proto} (unpublished)`,
					hostIp: port.hostIp,
					hostPort: port.hostPort,
					containerPort: port.containerPort,
					proto: port.proto,
					listening: port.hostPort !== null,
					containerIds: [container.id],
				});
			}
		}
		for (const networkId of container.networkIds) {
			const meta = networkMeta.get(networkId);
			const existing = networkWiring.get(networkId);
			if (existing) {
				if (!existing.containerIds.includes(container.id)) existing.containerIds.push(container.id);
			} else {
				networkWiring.set(networkId, {
					id: networkId,
					name: networkId,
					driver: meta?.driver ?? "",
					subnet: meta?.subnet ?? null,
					containerIds: [container.id],
				});
			}
		}
		for (const mount of mounts) {
			const key = `${mount.source}→${mount.destination}`;
			const existing = volumeWiring.get(key);
			if (existing) {
				if (!existing.containerIds.includes(container.id)) existing.containerIds.push(container.id);
			} else {
				volumeWiring.set(key, {
					id: `vol:${key}`,
					kind: mount.type === "bind" ? "bind" : "volume",
					label: volumeNames.has(mount.source) ? mount.source : mount.source,
					source: mount.source,
					destination: mount.destination,
					rw: mount.rw,
					containerIds: [container.id],
				});
			}
		}
	}

	const unused = images.filter((image) => !usedImageIds.has(image.id));
	const summary: TopologySummary = {
		running: visible.filter((c) => c.state === "running").length,
		issues: visible.filter((c) => c.health === "unhealthy" || c.staleImage || c.oomKilled || (c.state === "exited" && c.exitCode !== null && c.exitCode !== 0) || c.state === "dead").length,
		totalContainers: visible.length,
		workspaceContainers: allContainers.filter((c) => c.inWorkspace).length,
		allContainers: allContainers.length,
		totalImages: images.length,
		unusedImages: unused.length,
		unusedBytes: unused.reduce((sum, image) => sum + image.sizeBytes, 0),
		totalImageBytes: images.reduce((sum, image) => sum + image.sizeBytes, 0),
	};

	return {
		images: visibleImages,
		containers: visible,
		wiring: {
			ports: [...portWiring.values()],
			networks: [...networkWiring.values()],
			volumes: [...volumeWiring.values()],
		},
		summary,
	};
}

// ---------- workspace file scan ----------

const COMPOSE_NAMES = new Set(["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]);

export function scanWorkspaceFiles(folder: string): { composeFiles: string[]; dockerfiles: string[] } {
	const composeFiles: string[] = [];
	const dockerfiles: string[] = [];
	if (!folder) return { composeFiles, dockerfiles };
	const dirs: string[] = [folder];
	try {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") dirs.push(join(folder, entry.name));
		}
	} catch {
		return { composeFiles, dockerfiles };
	}
	for (const dir of dirs) {
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const full = join(dir, name);
			try {
				if (!statSync(full).isFile()) continue;
			} catch {
				continue;
			}
			if (COMPOSE_NAMES.has(name)) composeFiles.push(full);
			else if (name === "Dockerfile" || name.startsWith("Dockerfile.")) dockerfiles.push(full);
		}
	}
	composeFiles.sort();
	dockerfiles.sort();
	return { composeFiles, dockerfiles };
}

// ---------- Engine reads ----------

export interface ContainerStats {
	cpuPct: number;
	memUsed: number;
	memLimit: number;
}

export function cpuPctFromStats(stats: unknown): number {
	const root = asRecord(stats);
	const cpu = asRecord(root.cpu_stats);
	const precpu = asRecord(root.precpu_stats);
	const usage = asRecord(cpu.cpu_usage);
	const prevUsage = asRecord(precpu.cpu_usage);
	const total = asNumber(usage.total_usage);
	const prevTotal = asNumber(prevUsage.total_usage);
	const system = asNumber(cpu.system_cpu_usage);
	const prevSystem = asNumber(precpu.system_cpu_usage);
	const online = asNumber(cpu.online_cpus) || asArray(usage.percpu_usage).length || 1;
	const deltaTotal = total - prevTotal;
	const deltaSystem = system - prevSystem;
	if (deltaSystem <= 0 || deltaTotal < 0) return 0;
	return (deltaTotal / deltaSystem) * online * 100;
}

export function statsFromPayload(stats: unknown): ContainerStats {
	const memory = asRecord(asRecord(stats).memory_stats);
	return {
		cpuPct: cpuPctFromStats(stats),
		memUsed: asNumber(memory.usage),
		memLimit: asNumber(memory.limit),
	};
}

const STATS_CONCURRENCY = 4;
const STATS_TIMEOUT_MS = 4000;

/** Per-container stats, at most 4 in flight; one bad container never fails the rest. */
export async function fetchStats(runtime: Runtime, ids: string[]): Promise<Record<string, ContainerStats>> {
	const out: Record<string, ContainerStats> = {};
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < ids.length) {
			const id = ids[next++];
			try {
				const payload = await requestJson(runtime, `/containers/${encodeURIComponent(id)}/stats?stream=false`, { timeoutMs: STATS_TIMEOUT_MS });
				out[id] = statsFromPayload(payload);
			} catch {
				// Skipped: the UI simply shows no stats for this container.
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(STATS_CONCURRENCY, ids.length) }, () => worker()));
	return out;
}

export async function fetchTopology(runtime: Runtime, folder: string, scope: Scope): Promise<{ engineVersion: string | null; topology: Topology }> {
	const [versionRaw, imagesRaw, containersRaw, networksRaw, volumesRaw] = await Promise.all([
		requestJson(runtime, "/version").catch(() => null),
		requestJson(runtime, "/images/json?all=1"),
		requestJson(runtime, "/containers/json?all=1"),
		requestJson(runtime, "/networks").catch(() => []),
		requestJson(runtime, "/volumes").catch(() => null),
	]);
	const version = asRecord(versionRaw);
	const engineVersion = asString(version.Version) || null;
	const topology = buildTopology({
		imagesRaw: asArray(imagesRaw),
		containersRaw: asArray(containersRaw),
		networksRaw: asArray(networksRaw),
		volumesRaw: volumesRaw ?? undefined,
		folder,
		scope,
	});
	return { engineVersion, topology };
}

export interface DetailOptions {
	kind: string;
	id: string;
	tab: string;
	tail?: number;
}

export async function fetchDetail(runtime: Runtime, opts: DetailOptions): Promise<Record<string, unknown>> {
	const id = encodeURIComponent(opts.id);
	if (opts.kind === "container" && opts.tab === "logs") {
		const tail = opts.tail !== undefined && Number.isFinite(opts.tail) ? Math.max(1, Math.min(10000, Math.floor(opts.tail))) : 200;
		const buf = await requestBuffer(runtime, `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`);
		const text = demuxDockerLogs(buf);
		const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
		return { lines };
	}
	if (opts.kind === "container" && opts.tab === "inspect") {
		return { inspect: await requestJson(runtime, `/containers/${id}/json`) };
	}
	if (opts.kind === "container" && opts.tab === "layers") {
		const inspected = asRecord(await requestJson(runtime, `/containers/${id}/json`));
		const imageId = asString(asRecord(inspected.Config).Image) || asString(inspected.Image);
		if (!imageId) return { layers: [] };
		const history = asArray(await requestJson(runtime, `/images/${encodeURIComponent(imageId)}/history`));
		return { layers: history.map(mapHistoryLayer) };
	}
	if (opts.kind === "image" && opts.tab === "inspect") {
		return { inspect: await requestJson(runtime, `/images/${id}/json`) };
	}
	if (opts.kind === "image" && opts.tab === "layers") {
		const history = asArray(await requestJson(runtime, `/images/${id}/history`));
		return { layers: history.map(mapHistoryLayer) };
	}
	throw new Error(`unknown detail tab: ${opts.kind}/${opts.tab}`);
}

function mapHistoryLayer(raw: unknown): { id: string; created: number; createdBy: string; size: number; tags: string[] } {
	const layer = asRecord(raw);
	return {
		id: asString(layer.Id),
		created: asNumber(layer.Created),
		createdBy: asString(layer.CreatedBy),
		size: asNumber(layer.Size),
		tags: asArray(layer.Tags).filter((t): t is string => typeof t === "string"),
	};
}

export async function fetchDf(runtime: Runtime): Promise<{ df: unknown }> {
	return { df: await requestJson(runtime, "/system/df") };
}

// ---------- state assembly ----------

export interface StateOptions {
	folder: string;
	scope: Scope;
	runtimeId?: string | null;
	/** Test seam: pre-discovered runtimes. */
	runtimes?: Runtime[];
}

export async function getState(opts: StateOptions): Promise<KontainerState> {
	const { composeFiles, dockerfiles } = scanWorkspaceFiles(opts.folder);
	const runtimes = opts.runtimes ?? discoverRuntimes();
	const base: KontainerState = {
		available: false,
		reason: null,
		runtimes,
		activeRuntime: null,
		engineVersion: null,
		workspaceFolder: opts.folder,
		composeFiles,
		dockerfiles,
		scope: opts.scope,
		topology: null,
	};
	if (runtimes.length === 0) {
		return { ...base, reason: "no Docker or Podman socket found" };
	}
	const runtime = resolveRuntime(runtimes, opts.runtimeId ?? null);
	if (!runtime) return { ...base, reason: "no Docker or Podman socket found" };
	try {
		const { engineVersion, topology } = await fetchTopology(runtime, opts.folder, opts.scope);
		return { ...base, available: true, reason: null, activeRuntime: runtime.id, engineVersion, topology };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ...base, reason: message };
	}
}

export function resolveFolder(folder: string): string {
	return folder ? resolve(folder) : folder;
}
