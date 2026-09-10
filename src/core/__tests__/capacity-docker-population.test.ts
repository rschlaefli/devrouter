import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readDockerCapacityPopulation } from "../capacity-docker-population";

const project = "synthetic-project";
const ids = Array.from({ length: 8 }, (_, i) => i.toString(16).padStart(64, "0"));
let root: string;
let endpoint: string;
let server: http.Server;
let mode: string;
let info: number;
let lists: number;
let inspections: number;
let pending: http.ServerResponse[];
let peak: number;
let closed: Promise<void>[];
function snapshot(id: string) {
  const running = id === ids[0];
  return {
    Id: id,
    State: {
      Status: running ? "running" : "exited",
      Running: running,
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    Config: {
      Env: ["SYNTHETIC=discarded"],
      Labels: {
        "com.docker.compose.project": mode === "foreign" ? "foreign" : project,
        "com.docker.compose.service": `service-${id}`,
        "com.docker.compose.project.working_dir": "/fixture",
        "com.docker.compose.project.config_files": "/fixture/compose.yml",
        "com.docker.compose.config-hash": "hash",
      },
    },
    Mounts: [
      {
        Type: "bind",
        Source: mode === "oversized" ? "x".repeat(150000) : "/fixture",
        Destination: "/workspace",
      },
    ],
  };
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "population-"));
  endpoint = path.join(root, "docker.sock");
  mode = "stable";
  info = 0;
  lists = 0;
  inspections = 0;
  pending = [];
  peak = 0;
  closed = [];
  server = http.createServer((req, res) => {
    expect(req.method).toBe("GET");
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/info") {
      info++;
      res.end(
        JSON.stringify({
          ID: mode === "daemon" || (mode === "daemon-after" && info === 2) ? "other" : "daemon",
          MemTotal: 1024,
        }),
      );
    } else if (url.pathname === "/containers/json") {
      lists++;
      expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({
        label: [`com.docker.compose.project=${project}`],
      });
      const population = (mode === "missing" && lists === 2 ? ids.slice(1) : ids).map((id) => ({
        Id: id,
        State: id === ids[0] ? "running" : "exited",
      }));
      if (mode === "changed" && lists === 2) population[0].State = "exited";
      res.end(JSON.stringify(population.reverse()));
    } else {
      inspections++;
      closed.push(new Promise<void>((resolve) => res.once("close", resolve)));
      const id = url.pathname.split("/")[2];
      if (mode === "concurrency" || mode === "failure") {
        pending.push(res);
        peak = Math.max(peak, pending.length);
        if (pending.length === 4) {
          const batch = pending;
          pending = [];
          if (mode === "failure") {
            batch[0].statusCode = 500;
            batch[0].end("synthetic-private-body");
          } else {
            batch.forEach((response, index) => {
              response.end(JSON.stringify(snapshot(ids[inspections - 4 + index])));
            });
          }
        }
      } else if (mode !== "timeout") res.end(JSON.stringify(snapshot(id)));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});
function read() {
  return readDockerCapacityPopulation(endpoint, "daemon", project, new AbortController().signal);
}
it("rejects a missing required project before HTTP", async () => {
  await expect(
    readDockerCapacityPopulation(
      endpoint,
      "daemon",
      undefined as unknown as string,
      new AbortController().signal,
    ),
  ).rejects.toThrow(Error);
  expect(info).toBe(0);
});
it("rejects caller cancellation before HTTP", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(
    readDockerCapacityPopulation(endpoint, "daemon", project, cancellation.signal),
  ).rejects.toThrow(Error);
  expect(info).toBe(0);
});
it("returns stable running and stopped siblings with sanitized snapshots", async () => {
  const result = await read();
  expect(result.map((entry) => entry.id)).toEqual(ids);
  expect(result[0].state.Running).toBe(true);
  expect(result.slice(1).every((entry) => !entry.state.Running)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  expect(info).toBe(2);
  expect(lists).toBe(2);
});
it.each([
  "daemon",
  "daemon-after",
  "missing",
  "changed",
  "foreign",
  "oversized",
])("rejects %s evidence", async (value) => {
  mode = value;
  await expect(read()).rejects.toThrow(Error);
});
it("limits inspection concurrency to four", async () => {
  mode = "concurrency";
  await expect(read()).resolves.toHaveLength(8);
  expect(peak).toBe(4);
});
it("cancels outstanding inspections on first failure without starting another batch", async () => {
  mode = "failure";
  await expect(read()).rejects.toThrow(Error);
  expect(inspections).toBe(4);
  expect(lists).toBe(1);
  await Promise.all(closed);
});
it("bounds the whole population request", async () => {
  mode = "timeout";
  await expect(read()).rejects.toThrow(Error);
}, 5000);
