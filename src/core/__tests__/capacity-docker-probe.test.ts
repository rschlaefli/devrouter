import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  inspectDockerCapacityContainer,
  listDockerCapacityContainers,
  readDockerCapacityInfo,
  readDockerCapacityMemory,
} from "../capacity-docker-probe";

const id = "a".repeat(64);
let root: string;
let endpoint: string;
let server: http.Server;
let respond: (request: http.IncomingMessage, response: http.ServerResponse) => void;
let requests: Array<{ method: string | undefined; url: string | undefined }>;
const signal = () => new AbortController().signal;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "docker-probe-"));
  endpoint = path.join(root, "docker.sock");
  requests = [];
  respond = (_request, response) =>
    response.end(JSON.stringify({ ID: "synthetic-daemon", MemTotal: 1024 }));
  server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    respond(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

it("uses only the explicit socket and fixed GET paths, returning minimal raw data", async () => {
  vi.stubEnv("DOCKER_HOST", "unix:///synthetic-not-used.sock");
  vi.stubEnv("DOCKER_CONTEXT", "synthetic-not-used");
  respond = (request, response) => {
    response.end(
      JSON.stringify(
        request.url === "/info"
          ? { ID: "synthetic-daemon", MemTotal: 1024, extra: "discarded" }
          : request.url === "/containers/json?all=true"
            ? [{ Id: id, State: "running", Labels: { synthetic: "discarded" } }]
            : { memory_stats: { usage: 500, limit: 1024, stats: { cache: 400 } } },
      ),
    );
  };
  expect(await readDockerCapacityInfo(endpoint, signal())).toEqual({
    ID: "synthetic-daemon",
    MemTotal: 1024,
  });
  expect(await listDockerCapacityContainers(endpoint, signal())).toEqual([
    { id, state: "running" },
  ]);
  expect(await readDockerCapacityMemory(endpoint, id, signal())).toEqual({
    usage: 500,
    limit: 1024,
  });
  expect(requests).toEqual([
    { method: "GET", url: "/info" },
    { method: "GET", url: "/containers/json?all=true" },
    { method: "GET", url: `/containers/${id}/stats?stream=false` },
  ]);
});

it.each([
  "status",
  "json",
  "oversized",
])("rejects %s responses without exposing payloads", async (mode) => {
  const body = mode === "oversized" ? "x".repeat(1_048_577) : "synthetic-private-response";
  respond = (_request, response) => {
    if (mode === "status") response.statusCode = 503;
    response.end(body);
  };
  const result = readDockerCapacityInfo(endpoint, signal());
  await expect(result).rejects.toThrow(Error);
  const error = await result.catch((rejection: Error) => rejection);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(body);
});

it.each([
  {},
  { ID: "", MemTotal: 10 },
  { ID: "daemon", MemTotal: -1 },
  { ID: "daemon", MemTotal: Number.MAX_SAFE_INTEGER + 1 },
])("rejects missing or unsafe info fields (%j)", async (body) => {
  respond = (_request, response) => response.end(JSON.stringify(body));
  await expect(readDockerCapacityInfo(endpoint, signal())).rejects.toThrow(Error);
});

it.each([
  {},
  { usage: 1 },
  { usage: -1, limit: 10 },
  { usage: 0.5, limit: 10 },
  { usage: 1, limit: Number.MAX_SAFE_INTEGER + 1 },
])("rejects missing or unsafe raw memory stats (%j)", async (memory) => {
  respond = (_request, response) => response.end(JSON.stringify({ memory_stats: memory }));
  await expect(readDockerCapacityMemory(endpoint, id, signal())).rejects.toThrow(Error);
});

it.each([
  "short",
  "A".repeat(64),
  `../${id}`,
  "",
])("rejects invalid container ID before HTTP (%s)", async (invalid) => {
  await expect(readDockerCapacityMemory(endpoint, invalid, signal())).rejects.toThrow(Error);
  expect(requests).toEqual([]);
});

it.each(["population", "duplicate", "state"])("rejects invalid container list %s", async (mode) => {
  const entries =
    mode === "population"
      ? Array.from({ length: 257 }, (_, index) => ({
          Id: index.toString(16).padStart(64, "0"),
          State: "running",
        }))
      : mode === "duplicate"
        ? [
            { Id: id, State: "running" },
            { Id: id, State: "running" },
          ]
        : [{ Id: id }];
  respond = (_request, response) => response.end(JSON.stringify(entries));
  await expect(listDockerCapacityContainers(endpoint, signal())).rejects.toThrow(Error);
});

it("rejects pre-aborted requests without opening a connection", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(readDockerCapacityInfo(endpoint, controller.signal)).rejects.toThrow(Error);
  expect(requests).toEqual([]);
});

it("cancels an in-flight response", async () => {
  const controller = new AbortController();
  respond = () => controller.abort();
  await expect(readDockerCapacityInfo(endpoint, controller.signal)).rejects.toThrow(Error);
  expect(requests).toHaveLength(1);
});

it("times out a response that never completes", async () => {
  respond = () => {};
  await expect(readDockerCapacityInfo(endpoint, signal())).rejects.toThrow(Error);
}, 5000);

function ownedContainer() {
  return {
    Id: id,
    State: { Status: "exited", Running: false, Paused: false, Restarting: false, Dead: false },
    Config: {
      Env: ["SYNTHETIC_SECRET=not-returned"],
      Labels: {
        "com.docker.compose.project": "synthetic-project",
        "com.docker.compose.service": "db",
        "com.docker.compose.project.working_dir": "/fixture/.devcontainer",
        "com.docker.compose.project.config_files": "/fixture/.devcontainer/compose.yml",
        "com.docker.compose.config-hash": "synthetic-hash",
        unrelated: "not-returned",
      },
    },
    Mounts: [
      { Type: "volume", Source: "/synthetic/volume", Destination: "/data", Other: "not-returned" },
    ],
  };
}

it("returns stopped ownership evidence without environment or unrelated metadata", async () => {
  const value = ownedContainer();
  respond = (_request, response) => response.end(JSON.stringify(value));
  const result = await inspectDockerCapacityContainer(endpoint, id, "synthetic-project", signal());
  expect(result.id).toBe(id);
  expect(result.state.Running).toBe(false);
  expect(result.labels["com.docker.compose.service"]).toBe("db");
  expect(result.mounts).toEqual([
    { Type: "volume", Source: "/synthetic/volume", Destination: "/data" },
  ]);
  expect(JSON.stringify(result)).not.toContain("not-returned");
  expect(requests).toEqual([{ method: "GET", url: `/containers/${id}/json` }]);
});

it.each([
  "id",
  "project",
  "state",
  "mount",
])("rejects mismatched or malformed ownership evidence (%s)", async (mode) => {
  const value = ownedContainer();
  if (mode === "id") value.Id = "b".repeat(64);
  if (mode === "project") value.Config.Labels["com.docker.compose.project"] = "foreign";
  if (mode === "state") value.State.Running = true;
  if (mode === "mount") (value.Mounts[0] as unknown as Record<string, unknown>).Source = null;
  respond = (_request, response) => response.end(JSON.stringify(value));
  await expect(
    inspectDockerCapacityContainer(endpoint, id, "synthetic-project", signal()),
  ).rejects.toThrow(Error);
});

it("encodes an optional exact Compose project filter", async () => {
  respond = (_request, response) => response.end("[]");
  await expect(
    listDockerCapacityContainers(endpoint, signal(), "synthetic-project"),
  ).resolves.toEqual([]);
  const url = new URL(requests[0].url!, "http://fixture");
  expect(url.pathname).toBe("/containers/json");
  expect(url.searchParams.get("all")).toBe("true");
  expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({
    label: ["com.docker.compose.project=synthetic-project"],
  });
});
it.each([
  "",
  "../other",
  "project&all=false",
])("rejects invalid project filter %s before HTTP", async (project) => {
  await expect(listDockerCapacityContainers(endpoint, signal(), project)).rejects.toThrow(Error);
  expect(requests).toEqual([]);
});
