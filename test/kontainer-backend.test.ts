/**
 * The kontainer backend against a real Engine-shaped HTTP server on a real
 * Unix socket: demuxing, topology building (drift, workspace scoping, wiring
 * dedup, unused images), stats math and action validation. No Docker needed.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const { demuxDockerLogs, discoverRuntimes } = await import("../server/kontainer/socket.ts");
const { buildTopology, fetchStats, statsFromPayload } = await import("../server/kontainer/topology.ts");
const { buildExecCommand, handleAction } = await import("../server/kontainer/actions.ts");
import type { Runtime } from "../server/kontainer/socket.ts";

const NOW = 1_700_000_000;

// ---------- a mock Engine on a Unix socket ----------

const tmp = mkdtempSync(join(tmpdir(), "pi-studio-kontainer-"));
const sockPath = join(tmp, "engine.sock");

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

before(async () => {
	await new Promise<void>((resolvePromise) => server.listen(sockPath, resolvePromise));
});

after(async () => {
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
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
