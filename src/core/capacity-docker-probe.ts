import http from "node:http";
import path from "node:path";

const MAX_BYTES = 1_048_576;
const MAX_CONTAINERS = 256;
const CONTAINER_ID = /^[0-9a-f]{64}$/;

function failure(): Error {
  return new Error("Docker capacity probe failed.");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function request(endpoint: string, resource: string, signal: AbortSignal): Promise<unknown> {
  if (
    typeof endpoint !== "string" ||
    endpoint.length > 4096 ||
    !path.isAbsolute(endpoint) ||
    endpoint.includes("\0") ||
    signal.aborted
  )
    return Promise.reject(failure());
  return new Promise<unknown>((resolve, reject) => {
    let finished = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const req = http.request({ socketPath: endpoint, path: resource, method: "GET", agent: false });
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        req.destroy();
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(failure());
    const timer = setTimeout(abort, 3000);
    signal.addEventListener("abort", abort, { once: true });
    req.on("error", abort);
    req.on("response", (response) => {
      response.on("error", abort);
      response.on("aborted", abort);
      if (response.statusCode !== 200) {
        abort();
        return;
      }
      response.on("data", (chunk: Buffer) => {
        if (finished) return;
        size += chunk.length;
        if (size > MAX_BYTES) {
          abort();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (finished) return;
        try {
          finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          abort();
        }
      });
    });
    req.end();
  }).catch(() => {
    throw failure();
  });
}

export async function readDockerCapacityInfo(
  endpoint: string,
  signal: AbortSignal,
): Promise<{ ID: string; MemTotal: number }> {
  const value = await request(endpoint, "/info", signal);
  if (
    !object(value) ||
    typeof value.ID !== "string" ||
    !/^[a-zA-Z0-9:_-]{1,256}$/.test(value.ID) ||
    !counter(value.MemTotal) ||
    value.MemTotal === 0
  )
    throw failure();
  return { ID: value.ID, MemTotal: value.MemTotal };
}

export async function listDockerCapacityContainers(
  endpoint: string,
  signal: AbortSignal,
): Promise<Array<{ id: string; state: string }>> {
  const value = await request(endpoint, "/containers/json?all=true", signal);
  if (!Array.isArray(value) || value.length > MAX_CONTAINERS) throw failure();
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (
      !object(entry) ||
      typeof entry.Id !== "string" ||
      !CONTAINER_ID.test(entry.Id) ||
      ids.has(entry.Id) ||
      typeof entry.State !== "string" ||
      !["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(
        entry.State,
      )
    )
      throw failure();
    ids.add(entry.Id);
    return { id: entry.Id, state: entry.State };
  });
}

export async function readDockerCapacityMemory(
  endpoint: string,
  containerId: string,
  signal: AbortSignal,
): Promise<{ usage: number; limit: number }> {
  if (typeof containerId !== "string" || !CONTAINER_ID.test(containerId)) throw failure();
  const value = await request(endpoint, `/containers/${containerId}/stats?stream=false`, signal);
  if (!object(value) || !object(value.memory_stats)) throw failure();
  const memory = value.memory_stats;
  if (!counter(memory.usage) || !counter(memory.limit)) throw failure();
  return { usage: memory.usage, limit: memory.limit };
}
