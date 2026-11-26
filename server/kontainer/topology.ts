/**
 * Topology building and Engine reads for the kontainer drawer: images,
 * containers, wiring (ports / networks / volumes), per-container stats, detail
 * tabs, disk usage and the workspace file scan.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
	/** Bytes this image alone holds on disk (Size minus the layers it shares). Summing this, not sizeBytes, gives a reclaimable total. */
	uniqueSizeBytes: number;
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
	composeConfigFiles: string[];
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

export type SourceKind = "compose" | "dockerfile" | "containerfile";

export interface ComposeServiceSummary {
	name: string;
	image: string | null;
	dockerfile: string | null;
	state: "up" | "warn" | "down";
}

export interface KontainerSource {
	id: string;
	kind: SourceKind;
	relPath: string;
	dir: string;
	file: string;
	mtimeMs: number;
	meta: string;
	badge: string;
	statusText: string;
	unbuilt: boolean;
	edited: boolean;
	services: ComposeServiceSummary[];
	stages: string[];
	baseImage: string | null;
	exposedPorts: string[];
	imageIds: string[];
	containerIds: string[];
	preview: string;
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
	sources: KontainerSource[];
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

/** Image ids compare bare: engine listings carry `sha256:` on Id but not on ParentId or df ids. */
function bareId(id: string): string {
	return id.startsWith("sha256:") ? id.slice(7) : id;
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
	/** Per-image unique bytes from `/system/df` (Size minus SharedSize), keyed by bare or prefixed id. */
	uniqueSizeById?: ReadonlyMap<string, number>;
	folder: string;
	scope: Scope;
}

export function buildTopology(input: BuildTopologyInput): Topology {
	const folder = input.folder;
	const projectName = folder ? normalizeProjectName(basename(folder)) : "";

	// One image per local image record. Buildah keeps an untagged record per
	// Dockerfile instruction: each is the ParentId of the next, so its Size is
	// the cumulative virtual size and its layers are shared. Those are
	// intermediates, not images to list or sum (see the filter below).
	const parentIds = new Set<string>();
	for (const raw of input.imagesRaw) {
		const parent = asString(asRecord(raw).ParentId);
		if (parent) parentIds.add(bareId(parent));
	}
	const uniqueByBareId = new Map<string, number>();
	for (const [key, value] of input.uniqueSizeById ?? []) uniqueByBareId.set(bareId(key), value);
	const images: KontainerImage[] = [];
	const intermediateIds = new Set<string>();
	const imageByName = new Map<string, KontainerImage>();
	const imageById = new Map<string, KontainerImage>();
	for (const raw of input.imagesRaw) {
		const image = asRecord(raw);
		const id = asString(image.Id);
		const repoTags = asArray(image.RepoTags).filter((t): t is string => typeof t === "string" && t.length > 0);
		const first = repoTags[0] ?? "<none>:<none>";
		const { repo, tag } = parseRepoTag(first);
		const hasChild = parentIds.has(bareId(id));
		// Dangling in the engine's sense: untagged and childless. An untagged
		// parent is a build layer the tagged image above it still needs.
		const dangling = (repo === "<none>" || repoTags.length === 0) && !hasChild;
		if (repoTags.length === 0 && hasChild) intermediateIds.add(id);
		const sizeBytes = asNumber(image.Size);
		const shared = asNumber(image.SharedSize);
		const dfUnique = uniqueByBareId.get(bareId(id));
		const entry: KontainerImage = {
			id,
			shortId: shortId(id),
			repo,
			tag,
			name: repoTags.length === 0 ? "<none>:<none>" : first,
			sizeBytes,
			uniqueSizeBytes: dfUnique ?? (shared > 0 && shared <= sizeBytes ? sizeBytes - shared : sizeBytes),
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
		const composeConfigFiles = asString(labels["com.docker.compose.project.config_files"]).split(",").map((part) => part.trim()).filter(Boolean);
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
			composeConfigFiles,
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

	// Intermediates stay in the maps above so a container built from one still
	// links, but the drawer never lists them: they are layers of a top image,
	// and their cumulative sizes would be counted once per layer. A container
	// actually running one keeps it listed.
	const topImages = images.filter((image) => !intermediateIds.has(image.id) || usedImageIds.has(image.id));

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
		input.scope === "all" ? topImages : topImages.filter((image) => visibleImageIds.has(image.id) || image.dangling);

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

	const unused = topImages.filter((image) => !usedImageIds.has(image.id));
	const summary: TopologySummary = {
		running: visible.filter((c) => c.state === "running").length,
		issues: visible.filter((c) => c.health === "unhealthy" || c.staleImage || c.oomKilled || (c.state === "exited" && c.exitCode !== null && c.exitCode !== 0) || c.state === "dead").length,
		totalContainers: visible.length,
		workspaceContainers: allContainers.filter((c) => c.inWorkspace).length,
		allContainers: allContainers.length,
		totalImages: topImages.length,
		unusedImages: unused.length,
		// Unique bytes only: sizeBytes is cumulative per image, so summing it
		// charges every shared layer once per image that contains it.
		unusedBytes: unused.reduce((sum, image) => sum + image.uniqueSizeBytes, 0),
		totalImageBytes: topImages.reduce((sum, image) => sum + image.uniqueSizeBytes, 0),
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
const COMPOSE_VARIANT_RE = /^(docker-)?compose\.[a-zA-Z0-9_.-]+\.ya?ml$/;
const IGNORED_DIRS = new Set([".git", "node_modules", ".agents", ".venv", "dist", "build", "target", ".next", "vendor"]);
const MAX_WALKED_DIRS = 200;

function isComposeFileName(name: string): boolean {
	return COMPOSE_NAMES.has(name) || COMPOSE_VARIANT_RE.test(name);
}

function classifyBuildFile(name: string): SourceKind | null {
	if (name === "Dockerfile" || name.startsWith("Dockerfile.") || name.endsWith(".Dockerfile") || name.endsWith(".dockerfile")) return "dockerfile";
	if (name === "Containerfile" || name.startsWith("Containerfile.") || name.endsWith(".Containerfile") || name.endsWith(".containerfile")) return "containerfile";
	return null;
}

function toPosix(path: string): string {
	return path.replace(/\\/g, "/");
}

function relPosix(folder: string, abs: string): string {
	return toPosix(relative(resolve(folder), resolve(abs)));
}

interface WorkspaceEntry {
	abs: string;
	relPath: string;
	kind: SourceKind;
}

function scanWorkspaceEntries(folder: string): WorkspaceEntry[] {
	const entries: WorkspaceEntry[] = [];
	if (!folder) return entries;
	const queue: Array<{ dir: string; depth: number }> = [{ dir: folder, depth: 0 }];
	let walked = 0;
	while (queue.length > 0) {
		const { dir, depth } = queue.shift()!;
		if (walked >= MAX_WALKED_DIRS) break;
		walked += 1;
		let dirents: Dirent[];
		try {
			dirents = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of dirents) {
			if (entry.isSymbolicLink()) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < 2 && !IGNORED_DIRS.has(entry.name)) queue.push({ dir: full, depth: depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue;
			let kind: SourceKind | null = null;
			if (isComposeFileName(entry.name)) kind = "compose";
			else kind = classifyBuildFile(entry.name);
			if (!kind) continue;
			entries.push({ abs: full, relPath: relPosix(folder, full), kind });
		}
	}
	entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return entries;
}

export function scanWorkspaceFiles(folder: string): { composeFiles: string[]; dockerfiles: string[] } {
	const composeFiles: string[] = [];
	const dockerfiles: string[] = [];
	for (const entry of scanWorkspaceEntries(folder)) {
		if (entry.kind === "compose") composeFiles.push(entry.abs);
		else dockerfiles.push(entry.abs);
	}
	composeFiles.sort();
	dockerfiles.sort();
	return { composeFiles, dockerfiles };
}

// ---------- source parsers ----------

function readFileTextSafe(abs: string): string {
	try {
		const buf = readFileSync(abs);
		return buf.subarray(0, 64 * 1024).toString("utf8");
	} catch {
		return "";
	}
}

function previewFromText(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	return normalized.split("\n").slice(0, 40).join("\n").slice(0, 4096);
}

function parseBuildfileText(text: string): { stages: string[]; baseImage: string | null; exposedPorts: string[]; fromCount: number } {
	const joined = text.replace(/\\\r?\n/g, " ");
	const stages: string[] = [];
	const exposedPorts: string[] = [];
	const stageNames = new Set<string>();
	let baseImage: string | null = null;
	let fromCount = 0;
	for (const rawLine of joined.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const from = line.match(/^FROM\s+(?:--[^\s]+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
		if (from) {
			fromCount += 1;
			const image = from[1];
			const stage = from[2];
			if (stage) stageNames.add(stage.toLowerCase());
			stages.push(stage ?? image);
			if (baseImage === null && !isEarlierStage(image, stageNames, stage)) baseImage = image;
			continue;
		}
		const expose = line.match(/^EXPOSE\s+(.+)$/i);
		if (expose) {
			for (const token of expose[1].split(/\s+/)) {
				const port = token.trim();
				if (port) exposedPorts.push(port);
			}
		}
	}
	return { stages, baseImage, exposedPorts, fromCount };
}

function isEarlierStage(image: string, stageNames: Set<string>, currentStage?: string): boolean {
	const lower = image.toLowerCase();
	if (!stageNames.has(lower)) return false;
	if (currentStage && currentStage.toLowerCase() === lower) return false;
	return true;
}

function stripYamlValue(raw: string): string {
	const value = raw.trim();
	if (!value) return "";
	if (value.startsWith('"') || value.startsWith("'")) {
		const quote = value[0];
		const end = value.indexOf(quote, 1);
		return end === -1 ? value.slice(1) : value.slice(1, end);
	}
	const comment = value.search(/\s+#/);
	const plain = comment === -1 ? value : value.slice(0, comment).trim();
	return plain.replace(/^["']|["']$/g, "");
}

interface RawComposeService {
	name: string;
	image: string | null;
	buildShorthand: string | null;
	buildContext: string | null;
	buildDockerfile: string | null;
	hasBuild: boolean;
}

interface ParsedCompose {
	projectName: string | null;
	services: RawComposeService[];
	volCount: number;
	netCount: number;
}

function parseComposeText(text: string): ParsedCompose {
	const parsed: ParsedCompose = { projectName: null, services: [], volCount: 0, netCount: 0 };
	let section: string | null = null;
	let serviceIndent: number | null = null;
	let current: RawComposeService | null = null;
	let inBuild = false;
	let buildIndent: number | null = null;
	let entryIndent: number | null = null;
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	for (const rawLine of lines) {
		if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
		const indentMatch = rawLine.match(/^ */);
		const indent = indentMatch ? indentMatch[0].length : 0;
		const content = rawLine.trim();
		if (indent === 0) {
			const top = content.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
			section = top ? top[1] : null;
			serviceIndent = null;
			current = null;
			inBuild = false;
			buildIndent = null;
			entryIndent = null;
			if (top && top[1] === "name") {
				const value = stripYamlValue(top[2]);
				parsed.projectName = value || null;
			}
			continue;
		}
		if (section === "services") {
			if (serviceIndent === null || indent === serviceIndent) {
				const key = content.match(/^([A-Za-z0-9_-]+):/);
				if (!key) continue;
				serviceIndent = indent;
				current = { name: key[1], image: null, buildShorthand: null, buildContext: null, buildDockerfile: null, hasBuild: false };
				parsed.services.push(current);
				inBuild = false;
				buildIndent = null;
				continue;
			}
			if (indent > serviceIndent && current) {
				if (inBuild && buildIndent !== null && indent <= buildIndent) inBuild = false;
				const kv = content.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
				if (!kv) continue;
				const key = kv[1];
				const value = stripYamlValue(kv[2]);
				if (inBuild && buildIndent !== null && indent > buildIndent) {
					if (key === "context") current.buildContext = value || null;
					else if (key === "dockerfile") current.buildDockerfile = value || null;
					continue;
				}
				if (key === "image") current.image = value || null;
				else if (key === "build") {
					current.hasBuild = true;
					if (value) {
						current.buildShorthand = value;
						inBuild = false;
					} else {
						inBuild = true;
						buildIndent = indent;
					}
				}
			}
			continue;
		}
		if (section === "volumes" || section === "networks") {
			if (entryIndent === null) {
				entryIndent = indent;
				if (/^[A-Za-z0-9_-]+:/.test(content)) {
					if (section === "volumes") parsed.volCount += 1;
					else parsed.netCount += 1;
				}
			} else if (indent === entryIndent && /^[A-Za-z0-9_-]+:/.test(content)) {
				if (section === "volumes") parsed.volCount += 1;
				else parsed.netCount += 1;
			}
		}
	}
	return parsed;
}

function resolveInside(folder: string, candidateAbs: string): string | null {
	if (!folder) return null;
	const base = resolve(folder);
	const target = resolve(candidateAbs);
	const rel = relative(base, target);
	if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) return null;
	return target;
}

function resolveServiceDockerfile(composeAbs: string, folder: string, service: RawComposeService): string | null {
	if (!service.hasBuild) return null;
	const composeDir = dirname(resolve(composeAbs));
	let dockerfileAbs: string | null = null;
	if (service.buildShorthand) {
		const contextAbs = isAbsolute(service.buildShorthand) ? resolve(service.buildShorthand) : resolve(composeDir, service.buildShorthand);
		try {
			if (statSync(contextAbs).isFile()) dockerfileAbs = contextAbs;
		} catch {}
		if (!dockerfileAbs) {
			dockerfileAbs = join(contextAbs, "Dockerfile");
			if (!existsSync(dockerfileAbs) && existsSync(join(contextAbs, "Containerfile"))) dockerfileAbs = join(contextAbs, "Containerfile");
		}
	} else {
		const contextValue = service.buildContext ?? ".";
		const contextAbs = isAbsolute(contextValue) ? resolve(contextValue) : resolve(composeDir, contextValue);
		if (service.buildDockerfile) {
			dockerfileAbs = isAbsolute(service.buildDockerfile) ? resolve(service.buildDockerfile) : resolve(contextAbs, service.buildDockerfile);
		} else {
			dockerfileAbs = join(contextAbs, "Dockerfile");
			if (!existsSync(dockerfileAbs) && existsSync(join(contextAbs, "Containerfile"))) dockerfileAbs = join(contextAbs, "Containerfile");
		}
	}
	if (!dockerfileAbs) return null;
	const inside = resolveInside(folder, dockerfileAbs);
	if (!inside) return null;
	return relPosix(folder, inside);
}

// ---------- buildSources linking ----------

function hasIssue(container: KontainerContainer): boolean {
	return container.health === "unhealthy" || container.staleImage || container.oomKilled || container.state === "dead" || (container.state === "exited" && container.exitCode !== null && container.exitCode !== 0);
}

function imageForContainer(topology: Topology | null, container: KontainerContainer): KontainerImage | undefined {
	if (!topology) return undefined;
	return topology.images.find((img) => img.id === container.imageId) ?? topology.images.find((img) => img.name === container.imageName);
}

function imageByRef(topology: Topology | null, ref: string): KontainerImage | undefined {
	if (!topology || !ref) return undefined;
	const { repo, tag } = parseRepoTag(ref);
	const canonical = `${repo}:${tag}`;
	return topology.images.find((img) => img.name === canonical) ?? topology.images.find((img) => img.name === ref);
}

function buildfileCandidates(folder: string, relPath: string, file: string, dir: string): Array<{ name: string; suffix: boolean }> {
	const workspaceName = basename(resolve(folder));
	const candidates: Array<{ name: string; suffix: boolean }> = [];
	const push = (name: string, suffix = false) => {
		if (name && !candidates.some((c) => c.name.toLowerCase() === name.toLowerCase())) candidates.push({ name, suffix });
	};
	const isRoot = dir === "./";
	const dirName = isRoot ? null : dir.replace(/\/$/, "").split("/").pop() ?? null;
	if (dirName) {
		push(dirName);
		if (workspaceName) push(`${workspaceName}-${dirName}`);
	} else if (workspaceName) {
		push(workspaceName);
	}
	let suffix: string | null = null;
	let prefix: string | null = null;
	if (file.startsWith("Dockerfile.")) suffix = file.slice("Dockerfile.".length);
	else if (file.startsWith("Containerfile.")) suffix = file.slice("Containerfile.".length);
	else if (file.endsWith(".Dockerfile")) prefix = file.slice(0, - ".Dockerfile".length);
	else if (file.endsWith(".dockerfile")) prefix = file.slice(0, - ".dockerfile".length);
	else if (file.endsWith(".Containerfile")) prefix = file.slice(0, - ".Containerfile".length);
	else if (file.endsWith(".containerfile")) prefix = file.slice(0, - ".containerfile".length);
	if (suffix) {
		push(suffix, true);
		if (workspaceName) push(`${workspaceName}-${suffix}`, true);
		if (dirName) push(`${dirName}-${suffix}`, true);
	}
	if (prefix) {
		push(prefix, true);
		if (workspaceName) push(`${workspaceName}-${prefix}`, true);
	}
	return candidates;
}

function imagesMatchingCandidates(topology: Topology | null, candidates: Array<{ name: string; suffix: boolean }>): KontainerImage[] {
	if (!topology) return [];
	const out: KontainerImage[] = [];
	for (const img of topology.images) {
		const repoLower = img.repo.toLowerCase();
		const baseRepo = repoLower.split("/").pop() ?? repoLower;
		const nameLower = img.name.toLowerCase();
		const matched = candidates.some(({ name, suffix }) => {
			const cand = name.toLowerCase();
			if (repoLower === cand || baseRepo === cand || nameLower === cand || nameLower === `${cand}:latest`) return true;
			if (suffix && (baseRepo.endsWith(`-${cand}`) || baseRepo.endsWith(`_${cand}`) || baseRepo.endsWith(`/${cand}`))) return true;
			return false;
		});
		if (matched) out.push(img);
	}
	return out;
}

interface ResolvedComposeService extends RawComposeService {
	dockerfile: string | null;
}

interface ParsedComposeEntry {
	entry: WorkspaceEntry;
	parsed: ParsedCompose;
	services: ResolvedComposeService[];
}

export function buildSources(opts: { folder: string; topology: Topology | null; entries?: WorkspaceEntry[] }): KontainerSource[] {
	const folder = opts.folder;
	const topology = opts.topology ?? null;
	if (!folder) return [];
	const entries = opts.entries ?? scanWorkspaceEntries(folder);
	const images = topology?.images ?? [];
	const containers = topology?.containers ?? [];
	const parsedCompose: ParsedComposeEntry[] = [];
	for (const entry of entries) {
		if (entry.kind !== "compose") continue;
		const parsed = parseComposeText(readFileTextSafe(entry.abs));
		const services: ResolvedComposeService[] = parsed.services.map((service) => ({ ...service, dockerfile: resolveServiceDockerfile(entry.abs, folder, service) }));
		parsedCompose.push({ entry, parsed, services });
	}
	const sources: KontainerSource[] = [];
	for (const entry of entries) {
		const text = readFileTextSafe(entry.abs);
		const preview = previewFromText(text);
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(entry.abs).mtimeMs;
		} catch {}
		const dir = entry.relPath.includes("/") ? entry.relPath.slice(0, entry.relPath.lastIndexOf("/") + 1) : "./";
		const file = basename(entry.abs);
		const base: Omit<KontainerSource, "meta" | "badge" | "statusText" | "unbuilt" | "edited" | "services" | "stages" | "baseImage" | "exposedPorts" | "imageIds" | "containerIds"> = {
			id: `src:${entry.relPath}`,
			kind: entry.kind,
			relPath: entry.relPath,
			dir,
			file,
			mtimeMs,
			preview,
		};
		if (entry.kind === "compose") {
			const parsedEntry = parsedCompose.find((item) => item.entry.abs === entry.abs)!;
			const parsed = parsedEntry.parsed;
			const composeDir = dirname(resolve(entry.abs));
			const dirBase = basename(composeDir);
			const isPrimary = COMPOSE_NAMES.has(file);
			const matched = containers.filter((container) => {
				const absNorm = normalizePath(resolve(entry.abs));
				if (container.composeConfigFiles?.some((cf) => {
					const cfNorm = normalizePath(cf);
					if (cfNorm === absNorm || cfNorm === normalizePath(entry.relPath)) return true;
					if (!isAbsolute(cf)) {
						const resolved = normalizePath(resolve(composeDir, cf));
						if (resolved === absNorm) return true;
						if (container.composeWorkingDir) {
							if (normalizePath(resolve(container.composeWorkingDir, cf)) === absNorm) return true;
						}
					}
					return false;
				})) return true;
				if (container.composeWorkingDir && normalizePath(container.composeWorkingDir) === normalizePath(composeDir)) {
					if (isPrimary) return true;
					if (container.composeProject && ((parsed.projectName && normalizeProjectName(container.composeProject) === normalizeProjectName(parsed.projectName)) || normalizeProjectName(container.composeProject) === normalizeProjectName(dirBase))) return true;
				}
				if (isPrimary && container.composeProject) {
					if (parsed.projectName && normalizeProjectName(container.composeProject) === normalizeProjectName(parsed.projectName)) return true;
					if (normalizeProjectName(container.composeProject) === normalizeProjectName(dirBase)) return true;
				}
				return false;
			});
			const summaries: ComposeServiceSummary[] = parsedEntry.services.map((service) => {
				let forService = matched.filter((c) => c.composeService === service.name);
				if (forService.length === 0) {
					const project = parsed.projectName ?? dirBase;
					forService = matched.filter((c) => !c.composeService && (c.name === service.name || c.name.startsWith(`${project}-${service.name}-`) || c.name.startsWith(`${project}_${service.name}_`) || c.name.includes(`-${service.name}-`) || c.name.endsWith(`-${service.name}`)));
				}
				const running = forService.some((c) => c.state === "running");
				const state: "up" | "warn" | "down" = !running ? "down" : forService.some(hasIssue) ? "warn" : "up";
				return { name: service.name, image: service.image, dockerfile: service.dockerfile, state };
			});
			const containerIds = matched.map((c) => c.id);
			const imageIdSet = new Set<string>();
			for (const container of matched) {
				const img = imageForContainer(topology, container);
				if (img) imageIdSet.add(img.id);
			}
			for (const service of parsedEntry.services) {
				if (service.image) {
					const img = imageByRef(topology, service.image);
					if (img) imageIdSet.add(img.id);
				}
				if (service.dockerfile) {
					const builtFile = entries.find((item) => item.relPath === service.dockerfile);
					if (builtFile) {
						const builtDir = builtFile.relPath.includes("/") ? builtFile.relPath.slice(0, builtFile.relPath.lastIndexOf("/") + 1) : "./";
						for (const img of imagesMatchingCandidates(topology, buildfileCandidates(folder, builtFile.relPath, basename(builtFile.abs), builtDir))) imageIdSet.add(img.id);
					}
				}
			}
			const upCount = matched.filter((c) => c.state === "running").length;
			const total = Math.max(upCount, summaries.length);
			let badge: string;
			let statusText: string;
			let unbuilt: boolean;
			if (upCount > 0) {
				unbuilt = false;
				if (matched.some(hasIssue)) {
					badge = "drift";
					statusText = `stack drift (${upCount}/${total} up)`;
				} else {
					badge = "active";
					statusText = `stack running (${upCount}/${total} up)`;
				}
			} else {
				badge = "stopped";
				statusText = "0 containers up";
				unbuilt = true;
			}
			const metaParts: string[] = [`${summaries.length} service${summaries.length === 1 ? "" : "s"}`];
			if (parsed.volCount) metaParts.push(`${parsed.volCount} vol${parsed.volCount === 1 ? "" : "s"}`);
			if (parsed.netCount) metaParts.push(`${parsed.netCount} net${parsed.netCount === 1 ? "" : "s"}`);
			sources.push({ ...base, meta: metaParts.join(" · "), badge, statusText, unbuilt, edited: false, services: summaries, stages: [], baseImage: null, exposedPorts: [], imageIds: [...imageIdSet], containerIds });
			continue;
		}
		// dockerfile / containerfile
		const parsedBuild = parseBuildfileText(text);
		const linked = new Set<string>();
		for (const composeEntry of parsedCompose) {
			const composeDir = dirname(resolve(composeEntry.entry.abs));
			const projects = [composeEntry.parsed.projectName, basename(composeDir), basename(resolve(folder))].filter((value): value is string => !!value);
			for (const service of composeEntry.services) {
				if (service.dockerfile !== entry.relPath) continue;
				if (service.image) {
					const img = imageByRef(topology, service.image);
					if (img) linked.add(img.id);
				}
				for (const container of containers) {
					if (container.composeService !== service.name) continue;
					if (!container.composeProject) continue;
					if (!projects.some((project) => normalizeProjectName(project) === normalizeProjectName(container.composeProject ?? ""))) continue;
					const img = imageForContainer(topology, container);
					if (img) linked.add(img.id);
				}
				for (const project of projects) {
					for (const candidate of [`${project}_${service.name}`, `${project}-${service.name}`]) {
						for (const img of imagesMatchingCandidates(topology, [{ name: candidate, suffix: false }])) linked.add(img.id);
					}
				}
			}
		}
		for (const img of imagesMatchingCandidates(topology, buildfileCandidates(folder, entry.relPath, file, dir))) linked.add(img.id);
		const imageIds = [...linked];
		const linkedImages = images.filter((img) => linked.has(img.id));
		const containerIds = containers.filter((container) => {
			const img = imageForContainer(topology, container);
			return !!img && linked.has(img.id);
		}).map((container) => container.id);
		const newest = linkedImages.length > 0 ? linkedImages.reduce((best, img) => (img.created > best.created ? img : best), linkedImages[0]) : null;
		const edited = !!newest && newest.created > 0 && mtimeMs > newest.created + 1000;
		let badge: string;
		let statusText: string;
		let unbuilt: boolean;
		if (imageIds.length === 0) {
			unbuilt = true;
			badge = "unbuilt";
			statusText = "not built yet";
		} else {
			unbuilt = false;
			const primary = newest ?? linkedImages[0];
			const label = `${primary.repo}:${primary.tag}`;
			const hasDrift = linkedImages.some((img) => img.drift);
			if (edited || hasDrift) {
				badge = edited ? "edited" : "drift";
				statusText = edited ? "modified after last build (drift)" : `drift → ${label}`;
			} else {
				badge = parsedBuild.stages.length > 1 ? "multi-stage" : "built";
				statusText = `built → ${label}`;
			}
		}
		const metaParts: string[] = [`FROM ${parsedBuild.baseImage || "scratch"}`];
		if (parsedBuild.fromCount > 1) metaParts.push(`${parsedBuild.fromCount} stages`);
		if (parsedBuild.exposedPorts.length) metaParts.push(`EXPOSE ${parsedBuild.exposedPorts.slice(0, 2).join(", ")}`);
		sources.push({ ...base, meta: metaParts.join(" · "), badge, statusText, unbuilt, edited, services: [], stages: parsedBuild.stages, baseImage: parsedBuild.baseImage, exposedPorts: parsedBuild.exposedPorts, imageIds, containerIds });
	}
	return sources;
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

/** One container CPU counter reading: nanoseconds of CPU time used, and when it was read. */
export interface CpuSample {
	total: number;
	atMs: number;
}

function cpuTotalFromStats(stats: unknown): number {
	return asNumber(asRecord(asRecord(asRecord(stats).cpu_stats).cpu_usage).total_usage);
}

/**
 * CPU percent between two of our own polls, by wall time: CPU nanoseconds used
 * since the previous poll, over the seconds elapsed. 100 is one busy core.
 * Wall time, not the engine's system counter: Podman's `system_cpu_usage`
 * counts busy time only, so the Docker formula overreads on Podman, and its
 * one-shot `precpu_stats` is zero, which turns that formula into a lifetime
 * average since the container started.
 */
export function cpuPctBetweenSamples(total: number, prev: CpuSample, nowMs: number): number {
	const elapsedMs = nowMs - prev.atMs;
	const delta = total - prev.total;
	if (elapsedMs <= 0 || delta < 0) return 0;
	return (delta / (elapsedMs * 1_000_000)) * 100;
}

export function statsFromPayload(stats: unknown, prev?: CpuSample, nowMs: number = Date.now()): ContainerStats {
	const memory = asRecord(asRecord(stats).memory_stats);
	return {
		cpuPct: prev ? cpuPctBetweenSamples(cpuTotalFromStats(stats), prev, nowMs) : cpuPctFromStats(stats),
		memUsed: asNumber(memory.usage),
		memLimit: asNumber(memory.limit),
	};
}

const STATS_CONCURRENCY = 4;
const STATS_TIMEOUT_MS = 4000;

/** Previous poll's counter per runtime and container, so CPU percent is measured between our own polls. */
const prevCpuSamples = new Map<string, CpuSample>();
const CPU_SAMPLE_TTL_MS = 15 * 60 * 1000;

/** Per-container stats, at most 4 in flight; one bad container never fails the rest. */
export async function fetchStats(runtime: Runtime, ids: string[], samples: Map<string, CpuSample> = prevCpuSamples): Promise<Record<string, ContainerStats>> {
	const out: Record<string, ContainerStats> = {};
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < ids.length) {
			const id = ids[next++];
			try {
				const payload = await requestJson(runtime, `/containers/${encodeURIComponent(id)}/stats?stream=false`, { timeoutMs: STATS_TIMEOUT_MS });
				const key = `${runtime.socketPath}\u0000${id}`;
				const prev = samples.get(key);
				const nowMs = Date.now();
				// Podman's one-shot precpu is zero, so the precpu formula would read as a lifetime average;
				// its first sample only sets the baseline. Docker keeps its precpu value for the first sample.
				out[id] = prev
					? statsFromPayload(payload, prev, nowMs)
					: runtime.kind === "podman"
						? { ...statsFromPayload(payload), cpuPct: 0 }
						: statsFromPayload(payload);
				samples.set(key, { total: cpuTotalFromStats(payload), atMs: nowMs });
			} catch {
				// Skipped: the UI simply shows no stats for this container.
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(STATS_CONCURRENCY, ids.length) }, () => worker()));
	const cutoff = Date.now() - CPU_SAMPLE_TTL_MS;
	for (const [key, sample] of samples) {
		if (key.startsWith(`${runtime.socketPath}\u0000`) && sample.atMs < cutoff) samples.delete(key);
	}
	return out;
}

export async function fetchTopology(runtime: Runtime, folder: string, scope: Scope): Promise<{ engineVersion: string | null; topology: Topology }> {
	const [versionRaw, imagesRaw, containersRaw, networksRaw, volumesRaw, dfRaw] = await Promise.all([
		requestJson(runtime, "/version").catch(() => null),
		requestJson(runtime, "/images/json?all=1"),
		requestJson(runtime, "/containers/json?all=1"),
		requestJson(runtime, "/networks").catch(() => []),
		requestJson(runtime, "/volumes").catch(() => null),
		// Unique sizes live only here: `/images/json` reports SharedSize as -1.
		// A df refusal degrades to cumulative sizes, never to a failed state.
		requestJson(runtime, "/system/df").catch(() => null),
	]);
	const version = asRecord(versionRaw);
	const engineVersion = asString(version.Version) || null;
	const uniqueSizeById = new Map<string, number>();
	for (const raw of asArray(asRecord(dfRaw).Images)) {
		const entry = asRecord(raw);
		const id = asString(entry.Id);
		const size = asNumber(entry.Size);
		const shared = asNumber(entry.SharedSize);
		if (id && shared >= 0 && shared <= size) uniqueSizeById.set(id, size - shared);
	}
	const topology = buildTopology({
		imagesRaw: asArray(imagesRaw),
		containersRaw: asArray(containersRaw),
		networksRaw: asArray(networksRaw),
		volumesRaw: volumesRaw ?? undefined,
		uniqueSizeById,
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

/**
 * Container log text as the drawer can draw it: plain lines, no terminal.
 * A program that writes colours or redraws its own line (a REPL, a progress
 * bar) emits a byte stream — ANSI sequences, carriage returns, backspaces —
 * and a `textContent` line would show the sequences as literal `[1;35m`
 * garbage. Strip the sequences and the stray control bytes, then collapse
 * each line the way a terminal would: a carriage return starts the line
 * over so only its last segment stands, and a backspace deletes backwards.
 */
export function cleanLogText(text: string): string {
	const stripped = text
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[@-Z\\-_]/g, "")
		.replace(/[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/g, "");
	return stripped
		.split("\n")
		.map((line) => {
			const withoutCr = line.endsWith("\r") ? line.slice(0, -1) : line;
			const lastSegment = withoutCr.split("\r").pop() ?? "";
			const chars: string[] = [];
			for (const char of lastSegment) {
				if (char === "\b") chars.pop();
				else chars.push(char);
			}
			return chars.join("");
		})
		.join("\n");
}

export async function fetchDetail(runtime: Runtime, opts: DetailOptions): Promise<Record<string, unknown>> {
	const id = encodeURIComponent(opts.id);
	if (opts.kind === "container" && opts.tab === "logs") {
		const tail = opts.tail !== undefined && Number.isFinite(opts.tail) ? Math.max(1, Math.min(10000, Math.floor(opts.tail))) : 200;
		const buf = await requestBuffer(runtime, `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`);
		const text = cleanLogText(demuxDockerLogs(buf));
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
	const entries = scanWorkspaceEntries(opts.folder);
	const composeFiles: string[] = [];
	const dockerfiles: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "compose") composeFiles.push(entry.abs);
		else dockerfiles.push(entry.abs);
	}
	composeFiles.sort();
	dockerfiles.sort();
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
		sources: [],
		scope: opts.scope,
		topology: null,
	};
	if (runtimes.length === 0) {
		return { ...base, sources: buildSources({ folder: opts.folder, topology: null, entries }), reason: "no Docker or Podman socket found" };
	}
	const runtime = resolveRuntime(runtimes, opts.runtimeId ?? null);
	if (!runtime) return { ...base, sources: buildSources({ folder: opts.folder, topology: null, entries }), reason: "no Docker or Podman socket found" };
	try {
		const { engineVersion, topology } = await fetchTopology(runtime, opts.folder, opts.scope);
		return { ...base, available: true, reason: null, activeRuntime: runtime.id, engineVersion, topology, sources: buildSources({ folder: opts.folder, topology, entries }) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ...base, sources: buildSources({ folder: opts.folder, topology: null, entries }), reason: message };
	}
}

export function resolveFolder(folder: string): string {
	return folder ? resolve(folder) : folder;
}
