/**
 * The kontainer backend against a real Engine-shaped HTTP server on a real
 * Unix socket: demuxing, topology building (drift, workspace scoping, wiring
 * dedup, unused images), stats math and action validation. No Docker needed.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { after, before, test } from "node:test";

const { demuxDockerLogs, discoverRuntimes, requestJson } = await import("../server/kontainer/socket.ts");
const { buildSources, buildTopology, fetchStats, getState, scanWorkspaceFiles, statsFromPayload } = await import("../server/kontainer/topology.ts");
const { buildExecCommand, handleAction } = await import("../server/kontainer/actions.ts");
const { logEngineEvent, onKontainerAction, onKontainerEvents, onKontainerState } = await import("../server/routes/kontainer.ts");
const { snapshot } = await import("../server/logs.ts");
import type { Runtime } from "../server/kontainer/socket.ts";

const NOW = 1_700_000_000;

// ---------- a mock Engine on a Unix socket ----------

const tmp = mkdtempSync(join(tmpdir(), "pi-studio-kontainer-"));
const sockPath = join(tmp, "engine.sock");
const brokenSockPath = join(tmp, "broken.sock");

/** A stack whose compose project lives somewhere this board does not own. */
const OUTSIDE_LABELS = {
	"com.docker.compose.project": "elsewhere",
	"com.docker.compose.service": "web",
	"com.docker.compose.project.working_dir": "/elsewhere/stack",
};

let eventsOpened = 0;
let eventsClosed = 0;

const IMAGES = [
	{ Id: "sha256:aaa111", RepoTags: ["app:latest"], Size: 1000, Created: NOW - 100 },
	{ Id: "sha256:bbb222", RepoTags: ["db:13"], Size: 2000, Created: NOW - 200 },
	{ Id: "sha256:ccc333", RepoTags: ["<none>:<none>"], Size: 500, Created: NOW - 300 },
	{ Id: "sha256:ddd444", RepoTags: ["unused:1"], Size: 700, Created: NOW - 400 },
];

const CONTAINERS = [
	{
		Id: "111111aaaaaa",
		Names: ["/app-web"],
		Image: "app:latest",
		ImageID: "sha256:old999",
		State: "running",
		Status: "Up 2 hours",
		Created: NOW - 7200,
		Labels: { "com.docker.compose.project": "myproj", "com.docker.compose.service": "web", "com.docker.compose.project.working_dir": "/ws/myproj" },
		Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp", IP: "0.0.0.0" }],
		NetworkSettings: { Networks: { front: {} } },
		Mounts: [{ Type: "volume", Source: "appdata", Destination: "/data", Mode: "rw" }],
	},
	{
		Id: "222222bbbbbb",
		Names: ["/other"],
		Image: "db:13",
		ImageID: "sha256:bbb222",
		State: "exited",
		Status: "Exited (1) 3 hours ago",
		Created: NOW - 10800,
		Labels: {},
		Ports: [{ PrivatePort: 5432, Type: "tcp", IP: "" }],
		NetworkSettings: { Networks: { back: {} } },
		Mounts: [],
	},
	{
		Id: "333333cccccc",
		Names: ["/app-web-2"],
		Image: "app:latest",
		ImageID: "sha256:aaa111",
		State: "running",
		Status: "Up 2 hours",
		Created: NOW - 7200,
		Labels: { "com.docker.compose.project": "myproj", "com.docker.compose.service": "web" },
		Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp", IP: "0.0.0.0" }],
		NetworkSettings: { Networks: { front: {} } },
		Mounts: [{ Type: "volume", Source: "appdata", Destination: "/data", Mode: "rw" }],
	},
];

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	const url = req.url ?? "";
	const json = (payload: unknown) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(payload));
	};
	if (url === "/version") return json({ Version: "26.0.0" });
	if (url.startsWith("/images/json")) return json(IMAGES);
	if (url.startsWith("/containers/json")) return json(CONTAINERS);
	if (url === "/networks") return json([{ Name: "front", Driver: "bridge", IPAM: { Config: [{ Subnet: "172.20.0.0/16" }] } }]);
	if (url === "/volumes") return json({ Volumes: [{ Name: "appdata" }] });
	if (url.startsWith("/events")) {
		eventsOpened += 1;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.write('{"Type":"container","Action":"start"}\n');
		res.on("close", () => {
			eventsClosed += 1;
		});
		return;
	}
	if (url.startsWith("/containers/") && url.endsWith("/json")) {
		const id = url.split("/")[2];
		if (id === "444444dddddd") return json({ Config: { Labels: OUTSIDE_LABELS } });
		return json({ Config: { Labels: CONTAINERS.find((c) => c.Id === id)?.Labels ?? {} } });
	}
	if (url.includes("/stats") && !url.includes("111111aaaaaa")) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ message: "no such container" }));
		return;
	}
	if (url.includes("/stats")) {
		return json({
			cpu_stats: { cpu_usage: { total_usage: 300, percpu_usage: [1, 1] }, system_cpu_usage: 1000, online_cpus: 2 },
			precpu_stats: { cpu_usage: { total_usage: 100, percpu_usage: [1, 1] }, system_cpu_usage: 500 },
			memory_stats: { usage: 512, limit: 2048 },
		});
	}
	if (url.includes("/containers/") && url.endsWith("/start")) {
		res.writeHead(204);
		res.end();
		return;
	}
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ message: "no such route" }));
});

/** An engine that refuses every request, so the events route has a failure to report. */
const brokenServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
	res.writeHead(500, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ message: "engine is unhappy" }));
});

before(async () => {
	await new Promise<void>((resolvePromise) => server.listen(sockPath, resolvePromise));
	await new Promise<void>((resolvePromise) => brokenServer.listen(brokenSockPath, resolvePromise));
});

after(async () => {
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	await new Promise<void>((resolvePromise) => brokenServer.close(() => resolvePromise()));
	rmSync(tmp, { recursive: true, force: true });
});

function mockRuntime(): Runtime {
	const runtimes = discoverRuntimes({ candidates: [{ path: sockPath, kind: "docker", cli: "docker" }] });
	assert.equal(runtimes.length, 1);
	return runtimes[0];
}

// ---------- demux ----------

function frame(type: number, payload: string): Buffer {
	const body = Buffer.from(payload, "utf8");
	const header = Buffer.alloc(8);
	header[0] = type;
	header.writeUInt32BE(body.length, 4);
	return Buffer.concat([header, body]);
}

test("demuxDockerLogs parses multiplexed frames", () => {
	const buf = Buffer.concat([frame(1, "hello\n"), frame(2, "oops\n"), frame(1, "bye\n")]);
	assert.equal(demuxDockerLogs(buf), "hello\noops\nbye\n");
});

test("demuxDockerLogs treats a non-header buffer as raw TTY output", () => {
	assert.equal(demuxDockerLogs(Buffer.from("plain line\nsecond\n")), "plain line\nsecond\n");
	assert.equal(demuxDockerLogs(Buffer.from("short")), "short");
});

// ---------- topology ----------

test("buildTopology detects stale-image drift", () => {
	const topology = buildTopology({ imagesRaw: IMAGES, containersRaw: CONTAINERS, folder: "/ws/myproj", scope: "all" });
	const stale = topology.containers.find((c) => c.id === "111111aaaaaa");
	const fresh = topology.containers.find((c) => c.id === "333333cccccc");
	assert.equal(stale?.staleImage, true);
	assert.equal(fresh?.staleImage, false);
	assert.equal(topology.images.find((i) => i.id === "sha256:aaa111")?.drift, true);
	assert.equal(topology.images.find((i) => i.id === "sha256:bbb222")?.drift, false);
	// The drifted container stands on the image its tag now names, beside the container built from it,
	// so that image is still in use and the drawer has an edge to draw the stale build along.
	const local = topology.images.find((i) => i.id === "sha256:aaa111");
	assert.deepEqual(local?.containerIds, ["111111aaaaaa", "333333cccccc"]);
	assert.equal(local?.inUse, true);
});

test("buildTopology names an unpublished port as one instead of a null host port", () => {
	const topology = buildTopology({ imagesRaw: IMAGES, containersRaw: CONTAINERS, folder: "/ws/myproj", scope: "all" });
	const unpublished = topology.wiring.ports.find((p) => p.hostPort === null);
	assert.equal(unpublished?.label, ":5432/tcp (unpublished)");
	assert.equal(unpublished?.listening, false);
	assert.deepEqual(unpublished?.containerIds, ["222222bbbbbb"]);
});

test("buildTopology scopes to the workspace and keeps global counts", () => {
	const topology = buildTopology({ imagesRaw: IMAGES, containersRaw: CONTAINERS, networksRaw: [{ Name: "front", Driver: "bridge", IPAM: { Config: [{ Subnet: "172.20.0.0/16" }] } }], volumesRaw: { Volumes: [{ Name: "appdata" }] }, folder: "/ws/myproj", scope: "workspace" });
	assert.equal(topology.containers.length, 2);
	assert.equal(topology.summary.allContainers, 3);
	assert.equal(topology.summary.workspaceContainers, 2);
	assert.equal(topology.summary.totalContainers, 2);
	// Workspace mode keeps used + dangling images, drops the unused one.
	assert.deepEqual(topology.images.map((i) => i.id), ["sha256:aaa111", "sha256:ccc333"]);
	assert.equal(topology.summary.unusedImages, 2);
	assert.equal(topology.summary.unusedBytes, 1200);
	// Wiring is deduped and only covers visible containers.
	assert.equal(topology.wiring.ports.length, 1);
	assert.deepEqual(topology.wiring.ports[0].containerIds, ["111111aaaaaa", "333333cccccc"]);
	assert.equal(topology.wiring.ports[0].listening, true);
	assert.equal(topology.wiring.networks.length, 1);
	assert.equal(topology.wiring.networks[0].subnet, "172.20.0.0/16");
	assert.equal(topology.wiring.volumes.length, 1);
	assert.equal(topology.wiring.volumes[0].kind, "volume");
});

test("buildTopology in all scope keeps every image and container", () => {
	const topology = buildTopology({ imagesRaw: IMAGES, containersRaw: CONTAINERS, folder: "/ws/myproj", scope: "all" });
	assert.equal(topology.containers.length, 3);
	assert.equal(topology.images.length, 4);
	assert.equal(topology.summary.totalImages, 4);
	assert.equal(topology.summary.totalImageBytes, 4200);
	// One definition of an issue: the stale build and the failed exit, not the healthy fresh one.
	assert.equal(topology.summary.issues, 2);
});

// ---------- stats ----------

test("statsFromPayload computes CPU percentage and memory", () => {
	const stats = statsFromPayload({
		cpu_stats: { cpu_usage: { total_usage: 300, percpu_usage: [1, 1] }, system_cpu_usage: 1000, online_cpus: 2 },
		precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
		memory_stats: { usage: 512, limit: 2048 },
	});
	assert.equal(stats.cpuPct, 80);
	assert.equal(stats.memUsed, 512);
	assert.equal(stats.memLimit, 2048);
	assert.equal(statsFromPayload({}).cpuPct, 0);
});

test("fetchStats reads stats over the socket and skips failures", async () => {
	const runtime = mockRuntime();
	const stats = await fetchStats(runtime, ["111111aaaaaa", "missing-id"]);
	assert.equal(stats["111111aaaaaa"]?.cpuPct, 80);
	assert.equal(stats["111111aaaaaa"]?.memUsed, 512);
	assert.equal(stats["missing-id"], undefined);
});

// ---------- actions ----------

test("handleAction rejects bad container ids before touching the engine", async () => {
	const runtime = mockRuntime();
	for (const action of ["start", "stop", "restart", "kill", "remove", "recreate"]) {
		const result = await handleAction({ folder: "/ws/myproj" }, { action, id: "../../etc/passwd", runtime: runtime.id }, { runtimes: [runtime] });
		assert.equal(result.ok, false, action);
		assert.match(result.error ?? "", /valid container id/);
	}
});

test("handleAction rejects a Dockerfile that escapes the workspace", async () => {
	const runtime = mockRuntime();
	const result = await handleAction({ folder: "/ws/myproj" }, { action: "build", tag: "app:1", dockerfile: "../Dockerfile", runtime: runtime.id }, { runtimes: [runtime] });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /inside the workspace/);
	const traversal = await handleAction({ folder: "/ws/myproj" }, { action: "build", tag: "app:1", dockerfile: "/etc/Dockerfile", runtime: runtime.id }, { runtimes: [runtime] });
	assert.equal(traversal.ok, false);
});

test("handleAction lifecycle calls reach the engine", async () => {
	const runtime = mockRuntime();
	const result = await handleAction({ folder: "/ws/myproj" }, { action: "start", id: "111111aaaaaa", runtime: runtime.id }, { runtimes: [runtime] });
	assert.equal(result.ok, true);
});

test("buildExecCommand makes safe terminal commands", () => {
	assert.deepEqual(buildExecCommand({ mode: "exec", id: "111111aaaaaabbbb" }), { ok: true, command: "docker exec -it 111111aaaaaa sh" });
	assert.deepEqual(buildExecCommand({ mode: "logs", id: "111111aaaaaabbbb" }), { ok: true, command: "docker logs -f --tail 100 111111aaaaaa" });
	assert.deepEqual(buildExecCommand({ mode: "compose-logs" }), { ok: true, command: "docker compose logs -f" });
	assert.equal(buildExecCommand({ mode: "exec", id: "bad/../../id" }).ok, false);
	assert.equal(buildExecCommand({ mode: "compose-logs", composeFile: "../compose.yaml" }, { folder: "/ws/myproj" }).ok, false);
	assert.equal(buildExecCommand({ mode: "nope" }).ok, false);
});

test("handleAction exec.cmd needs no engine and returns the command", async () => {
	const result = await handleAction({ folder: "/ws/myproj" }, { action: "exec.cmd", mode: "exec", id: "111111aaaaaabbbb" }, { runtimes: [] });
	assert.deepEqual(result, { ok: true, command: "docker exec -it 111111aaaaaa sh" });
});

// ---------- recreate and compose safety ----------

test("recreate only runs a stack that lives inside the workspace folder", async () => {
	const runtime = mockRuntime();
	const outside = await handleAction({ folder: "/ws/myproj" }, { action: "recreate", id: "444444dddddd", runtime: runtime.id }, { runtimes: [runtime] });
	assert.equal(outside.ok, false);
	assert.equal(outside.error, "container compose working_dir is outside current workspace");

	const calls: Array<{ cli: string; args: string[]; cwd: string }> = [];
	const run = async (cli: string, args: string[], opts: { cwd: string }) => {
		calls.push({ cli, args, cwd: opts.cwd });
		return { code: 0, output: "" };
	};
	const inside = await handleAction({ folder: "/ws/myproj" }, { action: "recreate", id: "111111aaaaaa", runtime: runtime.id }, { runtimes: [runtime], run });
	assert.equal(inside.ok, true);
	assert.equal(calls[0]?.cwd, "/ws/myproj");
	assert.deepEqual(calls[0]?.args, ["compose", "up", "-d", "--no-deps", "--force-recreate", "web"]);
});

test("compose actions name the project when the request carries one", async () => {
	const runtime = mockRuntime();
	const calls: string[][] = [];
	const run = async (_cli: string, args: string[]) => {
		calls.push(args);
		return { code: 0, output: "" };
	};
	const named = await handleAction({ folder: "/ws/myproj" }, { action: "compose.restart", project: "myproj", runtime: runtime.id }, { runtimes: [runtime], run });
	assert.equal(named.ok, true);
	assert.deepEqual(calls[0], ["compose", "-p", "myproj", "restart"]);

	const bad = await handleAction({ folder: "/ws/myproj" }, { action: "compose.restart", project: "--project-directory=/etc", runtime: runtime.id }, { runtimes: [runtime], run });
	assert.equal(bad.ok, false);
	assert.match(bad.error ?? "", /valid compose project name/);
	assert.equal(calls.length, 1, "a rejected project name never reaches the CLI");

	const unnamed = await handleAction({ folder: "/ws/myproj" }, { action: "compose.down", runtime: runtime.id }, { runtimes: [runtime], run });
	assert.equal(unnamed.ok, true);
	assert.deepEqual(calls[1], ["compose", "down"]);
});

// ---------- workspace sources ----------

function writeWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-sources-"));
	const folder = join(root, "myproj");
	mkdirSync(join(folder, "services", "worker"), { recursive: true });
	mkdirSync(join(folder, "services", "api"), { recursive: true });
	writeFileSync(join(folder, "compose.yaml"), [
		"name: myproj",
		"services:",
		"  web:",
		"    image: app:latest",
		"    build:",
		"      context: .",
		"      dockerfile: Dockerfile",
		"  worker:",
		"    build: ./services/worker",
		"volumes:",
		"  appdata:",
		"networks:",
		"  front:",
		"",
	].join("\n"));
	writeFileSync(join(folder, "Dockerfile"), ["FROM node:20 AS build", "FROM node:20-slim", "EXPOSE 3000", ""].join("\n"));
	writeFileSync(join(folder, "services", "worker", "Containerfile"), ["FROM python:3.12-slim AS base", "FROM base AS runtime", "EXPOSE 8080 9090", ""].join("\n"));
	writeFileSync(join(folder, "services", "api", "Dockerfile"), "FROM alpine\n");
	// Dockerfile is older than its image; the worker Containerfile is newer than its image.
	utimesSync(join(folder, "Dockerfile"), new Date((NOW - 1000) * 1000), new Date((NOW - 1000) * 1000));
	utimesSync(join(folder, "services", "worker", "Containerfile"), new Date(NOW * 1000), new Date(NOW * 1000));
	return folder;
}

test("scanWorkspaceFiles recognizes compose variants and build files to depth 2", () => {
	const folder = writeWorkspace();
	try {
		writeFileSync(join(folder, "compose.e2e.yml"), "services: {}\n");
		writeFileSync(join(folder, "Containerfile.cli"), "FROM alpine\n");
		mkdirSync(join(folder, ".git"));
		writeFileSync(join(folder, ".git", "compose.yaml"), "services: {}\n");
		mkdirSync(join(folder, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(folder, "node_modules", "pkg", "Dockerfile"), "FROM alpine\n");
		mkdirSync(join(folder, "a", "b", "c"), { recursive: true });
		writeFileSync(join(folder, "a", "b", "c", "compose.yaml"), "services: {}\n");
		mkdirSync(join(folder, "linkfile"));
		symlinkSync(join(folder, "Dockerfile"), join(folder, "linkfile", "Dockerfile"));
		symlinkSync(join(folder, "services"), join(folder, "linked-services"));
		const { composeFiles, dockerfiles } = scanWorkspaceFiles(folder);
		const rel = (paths: string[]) => paths.map((p) => p.slice(folder.length + 1)).sort();
		assert.deepEqual(rel(composeFiles), ["compose.e2e.yml", "compose.yaml"]);
		assert.deepEqual(rel(dockerfiles), ["Containerfile.cli", "Dockerfile", "services/api/Dockerfile", "services/worker/Containerfile"]);
	} finally {
		rmSync(folder, { recursive: true, force: true });
		rmSync(join(folder, ".."), { recursive: true, force: true });
	}
});

test("buildSources parses compose and build files and links them to topology", () => {
	const folder = writeWorkspace();
	try {
		const imagesRaw = [
			{ Id: "sha256:aaa111", RepoTags: ["app:latest"], Size: 1000, Created: NOW - 100 },
			{ Id: "sha256:ccc333", RepoTags: ["myproj-worker:latest"], Size: 1000, Created: NOW - 100 },
		];
		const containersRaw = [
			{
				Id: "111111aaaaaa",
				Names: ["/myproj-web-1"],
				Image: "app:latest",
				ImageID: "sha256:aaa111",
				State: "running",
				Status: "Up 2 hours",
				Created: NOW - 7200,
				Labels: { "com.docker.compose.project": "myproj", "com.docker.compose.service": "web", "com.docker.compose.project.working_dir": folder, "com.docker.compose.project.config_files": join(folder, "compose.yaml") },
				Ports: [],
				NetworkSettings: { Networks: {} },
				Mounts: [],
			},
		];
		const topology = buildTopology({ imagesRaw, containersRaw, folder, scope: "all" });
		assert.equal(topology.containers[0]?.composeConfigFiles.length, 1);
		const sources = buildSources({ folder, topology });
		const compose = sources.find((source) => source.id === "src:compose.yaml");
		assert.ok(compose);
		assert.equal(compose.kind, "compose");
		assert.equal(compose.dir, "./");
		assert.equal(compose.file, "compose.yaml");
		assert.equal(compose.meta, "2 services · 1 vol · 1 net");
		assert.equal(compose.badge, "active");
		assert.equal(compose.statusText, "stack running (1/2 up)");
		assert.equal(compose.unbuilt, false);
		assert.deepEqual(compose.services, [
			{ name: "web", image: "app:latest", dockerfile: "Dockerfile", state: "up" },
			{ name: "worker", image: null, dockerfile: "services/worker/Containerfile", state: "down" },
		]);
		assert.deepEqual(compose.containerIds, ["111111aaaaaa"]);
		assert.ok(compose.imageIds.includes("sha256:aaa111"));
		assert.ok(compose.preview.startsWith("name: myproj"));
		const dockerfile = sources.find((source) => source.id === "src:Dockerfile");
		assert.ok(dockerfile);
		assert.equal(dockerfile.kind, "dockerfile");
		assert.deepEqual(dockerfile.stages, ["build", "node:20-slim"]);
		assert.equal(dockerfile.baseImage, "node:20");
		assert.deepEqual(dockerfile.exposedPorts, ["3000"]);
		assert.equal(dockerfile.meta, "FROM node:20 · 2 stages · EXPOSE 3000");
		assert.equal(dockerfile.badge, "multi-stage");
		assert.equal(dockerfile.statusText, "built → app:latest");
		assert.equal(dockerfile.edited, false);
		assert.deepEqual(dockerfile.imageIds, ["sha256:aaa111"]);
		assert.deepEqual(dockerfile.containerIds, ["111111aaaaaa"]);
		const containerfile = sources.find((source) => source.id === "src:services/worker/Containerfile");
		assert.ok(containerfile);
		assert.equal(containerfile.kind, "containerfile");
		assert.equal(containerfile.dir, "services/worker/");
		assert.deepEqual(containerfile.stages, ["base", "runtime"]);
		assert.equal(containerfile.baseImage, "python:3.12-slim");
		assert.deepEqual(containerfile.exposedPorts, ["8080", "9090"]);
		assert.equal(containerfile.meta, "FROM python:3.12-slim · 2 stages · EXPOSE 8080, 9090");
		assert.equal(containerfile.edited, true);
		assert.equal(containerfile.badge, "edited");
		assert.equal(containerfile.statusText, "modified after last build (drift)");
		assert.deepEqual(containerfile.imageIds, ["sha256:ccc333"]);
		const unbuilt = sources.find((source) => source.id === "src:services/api/Dockerfile");
		assert.ok(unbuilt);
		assert.equal(unbuilt.badge, "unbuilt");
		assert.equal(unbuilt.statusText, "not built yet");
		assert.equal(unbuilt.unbuilt, true);
	} finally {
		rmSync(join(folder, ".."), { recursive: true, force: true });
	}
});

test("buildSources without topology marks compose down and build files unbuilt", () => {
	const folder = writeWorkspace();
	try {
		const sources = buildSources({ folder, topology: null });
		const compose = sources.find((source) => source.id === "src:compose.yaml");
		assert.equal(compose?.badge, "stopped");
		assert.equal(compose?.statusText, "0 containers up");
		assert.equal(compose?.unbuilt, true);
		assert.ok(compose?.services.every((service) => service.state === "down"));
		const dockerfile = sources.find((source) => source.id === "src:Dockerfile");
		assert.equal(dockerfile?.badge, "unbuilt");
		assert.equal(dockerfile?.statusText, "not built yet");
	} finally {
		rmSync(join(folder, ".."), { recursive: true, force: true });
	}
});

test("getState returns sources even when no runtime socket is available", async () => {
	const folder = writeWorkspace();
	try {
		const state = await getState({ folder, scope: "workspace", runtimes: [] });
		assert.equal(state.available, false);
		assert.equal(state.topology, null);
		assert.ok(state.sources.some((source) => source.id === "src:compose.yaml"));
		assert.ok(state.sources.some((source) => source.id === "src:services/worker/Containerfile"));
		assert.ok(state.composeFiles.length >= 1);
		assert.ok(state.dockerfiles.length >= 2);
	} finally {
		rmSync(join(folder, ".."), { recursive: true, force: true });
	}
});

test("handleAction build honours dockerfile and context inside the workspace", async () => {
	const runtime = mockRuntime();
	const folder = writeWorkspace();
	try {
		const calls: string[][] = [];
		const run = async (_cli: string, args: string[]) => {
			calls.push(args);
			return { code: 0, output: "" };
		};
		const inside = await handleAction({ folder }, { action: "build", tag: "app:1", dockerfile: "services/api/Dockerfile", context: "services/api", runtime: runtime.id }, { runtimes: [runtime], run });
		assert.equal(inside.ok, true);
		assert.deepEqual(calls[0], ["build", "-f", join(folder, "services/api/Dockerfile"), "-t", "app:1", join(folder, "services/api")]);
		const defaulted = await handleAction({ folder }, { action: "build", tag: "app:1", runtime: runtime.id }, { runtimes: [runtime], run });
		assert.equal(defaulted.ok, true);
		assert.deepEqual(calls[1], ["build", "-t", "app:1", "."]);
		const outside = await handleAction({ folder }, { action: "build", tag: "app:1", context: "../outside", runtime: runtime.id }, { runtimes: [runtime], run });
		assert.equal(outside.ok, false);
		assert.equal(outside.error, "build context must be inside the workspace folder");
		assert.equal(calls.length, 2, "a rejected context never reaches the CLI");
	} finally {
		rmSync(join(folder, ".."), { recursive: true, force: true });
	}
});

// ---------- routes ----------

type FakeResponse = EventEmitter & {
	status: number;
	body: string;
	chunks: string[];
	writableEnded: boolean;
	writeHead: (status: number, headers?: Record<string, string>) => void;
	write: (chunk: string | Buffer) => boolean;
	end: (body?: string) => void;
};

function fakeResponse(): FakeResponse {
	const res = new EventEmitter() as FakeResponse;
	res.status = 0;
	res.body = "";
	res.chunks = [];
	res.writableEnded = false;
	res.writeHead = (status) => {
		res.status = status;
	};
	res.write = (chunk) => {
		res.chunks.push(String(chunk));
		return true;
	};
	res.end = (body) => {
		if (body !== undefined) res.body = String(body);
		res.writableEnded = true;
	};
	return res;
}

function fakeRequest(body: unknown): IncomingMessage {
	return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
}

/** Point runtime discovery at the mock engine for the length of one call. */
async function withEngine<T>(socketPath: string, work: () => Promise<T>): Promise<T> {
	const previous = process.env.DOCKER_HOST;
	process.env.DOCKER_HOST = `unix://${socketPath}`;
	try {
		return await work();
	} finally {
		if (previous === undefined) delete process.env.DOCKER_HOST;
		else process.env.DOCKER_HOST = previous;
	}
}

/** Wait for `check` to hold, so a stream test never races the socket. */
async function until(check: () => boolean, what: string, ms = 4000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((done) => setTimeout(done, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

test("onKontainerState answers the topology and its runtime", async () => {
	const state = JSON.parse(
		await withEngine(sockPath, async () => {
			const res = fakeResponse();
			await onKontainerState({} as IncomingMessage, res as unknown as ServerResponse, new URL("http://daemon/kontainer/state?workspace=/ws/myproj&scope=all&runtime=docker"), { folder: "/ws/myproj" });
			assert.equal(res.status, 200);
			return res.body;
		}),
	) as { available: boolean; activeRuntime: string | null; topology: { containers: unknown[] } };
	assert.equal(state.available, true);
	assert.equal(state.activeRuntime, "docker");
	assert.equal(state.topology.containers.length, 3);
});

test("onKontainerAction reports a rejected action as ok:false on a 200", async () => {
	const rejected = JSON.parse(
		await withEngine(sockPath, async () => {
			const res = fakeResponse();
			await onKontainerAction(fakeRequest({ action: "start", id: "../../etc/passwd" }), res as unknown as ServerResponse, { folder: "/ws/myproj" });
			assert.equal(res.status, 200, "the route still answers 200; the body carries the verdict");
			return res.body;
		}),
	) as { ok: boolean; error?: string };
	assert.equal(rejected.ok, false);
	assert.match(rejected.error ?? "", /valid container id/);

	const accepted = JSON.parse(
		await withEngine(sockPath, async () => {
			const res = fakeResponse();
			await onKontainerAction(fakeRequest({ action: "start", id: "111111aaaaaa" }), res as unknown as ServerResponse, { folder: "/ws/myproj" });
			assert.equal(res.status, 200);
			return res.body;
		}),
	) as { ok: boolean; output?: string };
	assert.equal(accepted.ok, true);
	assert.equal(accepted.output, "");
});

test("onKontainerEvents streams engine events and closes the upstream socket when the tab goes", async () => {
	eventsOpened = 0;
	eventsClosed = 0;
	const opened = await withEngine(sockPath, async () => {
		const req = new EventEmitter() as unknown as IncomingMessage;
		const res = fakeResponse();
		await onKontainerEvents(req, res as unknown as ServerResponse, new URL("http://daemon/kontainer/events?runtime=docker"), { folder: "/ws/myproj" });
		await until(() => res.chunks.join("").includes("event: change"), "the first engine event");
		assert.equal(eventsOpened, 1);
		assert.equal(eventsClosed, 0, "the engine stream stays open while the tab is there");
		(req as unknown as EventEmitter).emit("close");
		(req as unknown as EventEmitter).emit("close");
		await until(() => eventsClosed === 1, "the engine stream to be destroyed");
		await new Promise((done) => setTimeout(done, 50));
		return { closed: eventsClosed, ended: res.writableEnded, chunks: res.chunks.join("") };
	});
	assert.equal(opened.closed, 1, "one close tears the upstream down once");
	assert.equal(opened.ended, false, "the client's own disconnect is not answered with an end");
	assert.doesNotMatch(opened.chunks, /event: error/);
});

test("onKontainerState includes workspace sources", async () => {
	const folder = writeWorkspace();
	try {
		const state = JSON.parse(
			await withEngine(sockPath, async () => {
				const res = fakeResponse();
				await onKontainerState({} as IncomingMessage, res as unknown as ServerResponse, new URL("http://daemon/kontainer/state?scope=all&runtime=docker"), { folder });
				assert.equal(res.status, 200);
				return res.body;
			}),
		) as { sources: Array<{ id: string }> };
		assert.ok(state.sources.some((source) => source.id === "src:compose.yaml"));
		assert.ok(state.sources.some((source) => source.id === "src:Dockerfile"));
	} finally {
		rmSync(join(folder, ".."), { recursive: true, force: true });
	}
});

test("onKontainerEvents tells the tab when the engine fails mid-stream", async () => {
	const failed = await withEngine(brokenSockPath, async () => {
		const req = new EventEmitter() as unknown as IncomingMessage;
		const res = fakeResponse();
		await onKontainerEvents(req, res as unknown as ServerResponse, new URL("http://daemon/kontainer/events?runtime=docker"), { folder: "/ws/myproj" });
		await until(() => res.writableEnded, "the error event to end the feed");
		return res.chunks.join("");
	});
	assert.match(failed, /event: error\ndata: \{"error":"engine request failed \(500\): engine is unhappy"\}\n\n/);
	assert.ok(snapshot().some((entry) => entry.level === "error" && entry.message.startsWith("events stream · engine request failed (500)")), "the mid-stream failure is one daemon line");
});

// ---------- engine calls and events in the daemon log ----------

test("a container lifecycle write lands in the daemon log as info with its command", async () => {
	const runtime = mockRuntime();
	const result = await handleAction({ folder: "/ws/myproj" }, { action: "start", id: "999999aaaaaa", runtime: runtime.id }, { runtimes: [runtime] });
	assert.equal(result.ok, true);
	const line = snapshot().find((entry) => entry.message === "POST /containers/999999aaaaaa/start");
	assert.ok(line, "the start is in the ring");
	assert.equal(line.level, "info");
	assert.equal(line.source, "docker");
	assert.equal(line.meta?.cmd, "POST /containers/999999aaaaaa/start");
	assert.equal(line.meta?.exit, 204);
});

test("a failed engine read is debug and a failed write is error, so polls stay out of the default view", async () => {
	const brokenRuntime = { socketPath: brokenSockPath, cli: "docker" };
	await assert.rejects(requestJson(brokenRuntime, "/containers/json"), /engine request failed \(500\)/);
	await assert.rejects(requestJson(brokenRuntime, "/containers/abc/start", { method: "POST" }), /engine request failed \(500\)/);
	const readFailure = snapshot().find((entry) => entry.message.startsWith("GET /containers/json"));
	const writeFailure = snapshot().find((entry) => entry.message.startsWith("POST /containers/abc/start"));
	assert.ok(readFailure && readFailure.level === "debug" && readFailure.meta?.exit === 500);
	assert.ok(writeFailure && writeFailure.level === "error" && writeFailure.meta?.exit === 500);
});

test("logEngineEvent says a death out loud and ordinary churn at debug, and drops a line it cannot read", () => {
	const beforeSeen = snapshot().length;
	logEngineEvent('{"Type":"container","Action":"start","id":"abcdef1234567890","Actor":{"Attributes":{"name":"web"}}}', "docker");
	logEngineEvent('{"Type":"container","Action":"die","id":"abcdef1234567890","Actor":{"Attributes":{"name":"web","exitCode":"1"}}}', "docker");
	logEngineEvent("not json at all", "docker");
	logEngineEvent("{}", "docker");
	assert.equal(snapshot().length - beforeSeen, 2, "only the two readable events were written");
	const churn = snapshot()[snapshot().length - 2];
	const death = snapshot()[snapshot().length - 1];
	assert.equal(churn.level, "debug");
	assert.equal(churn.message, "container start web");
	assert.equal(churn.source, "docker");
	assert.equal(death.level, "error");
	assert.match(death.message, /^container die web/);
	assert.match(death.message, /exit 1/);
});

test("the events feed writes what the engine did as it forwards it", async () => {
	const beforeSeen = snapshot().length;
	const closedBefore = eventsClosed;
	const req = new EventEmitter() as unknown as IncomingMessage;
	const res = fakeResponse();
	await withEngine(sockPath, async () => {
		await onKontainerEvents(req, res as unknown as ServerResponse, new URL("http://daemon/kontainer/events?runtime=docker"), { folder: "/ws/myproj" });
		await until(() => res.chunks.join("").includes("event: change"), "the first engine event");
		(req as unknown as EventEmitter).emit("close");
		await until(() => eventsClosed > closedBefore, "the engine stream to be destroyed");
	});
	const seen = snapshot().slice(beforeSeen);
	assert.ok(seen.some((entry) => entry.level === "debug" && entry.message === "container start" && entry.source === "docker"), "the forwarded start is one debug line");
});
