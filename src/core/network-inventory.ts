import { spawnSync } from "node:child_process";
import { resolveManagedStopEndpoint, supportsManagedStopBaseline } from "./devpod-environment";

export type DockerNetworkSnapshot = {
  id: string;
  name: string;
  driver: string;
  subnets: string[];
  activeEndpoints: number;
  retainedContainerIds: string[];
  composeProject?: string;
  composeNetwork?: string;
};

export type DockerNetworkInventory = {
  status: "complete" | "unknown";
  endpoint?: string;
  daemonId?: string;
  pools: Array<{ base: string; size: number }>;
  networks: DockerNetworkSnapshot[];
  observedAt: string;
  reasons: string[];
};

export type NetworkInventoryReader = (
  endpoint: string,
  args: string[],
  timeoutMs: number,
) => string;

class NetworkInventoryError extends Error {}

const MAX_IDS = 4096;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const FULL_ID = /^[a-f0-9]{64}$/;
const NETWORK_TEMPLATE =
  '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"ipam":{{json .IPAM.Config}},"activeEndpoints":{{len .Containers}},"project":{{json (index .Labels "com.docker.compose.project")}},"network":{{json (index .Labels "com.docker.compose.network")}}';
const CONTAINER_TEMPLATE = '{"id":{{json .Id}},"networks":{{json .NetworkSettings.Networks}}}';

function readDocker(endpoint: string, args: string[], timeoutMs: number): string {
  const env = { ...process.env };
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_HOST;
  const result = spawnSync("docker", ["--host", endpoint, ...args], {
    env,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new NetworkInventoryError("Docker network inventory read failed or exceeded its bound.");
  }
  return result.stdout;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NetworkInventoryError("Docker network inventory contains a malformed record.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new NetworkInventoryError("Docker network inventory contains an invalid identity.");
  }
  return value;
}

function id(value: unknown): string {
  const result = text(value);
  if (!FULL_ID.test(result))
    throw new NetworkInventoryError("Docker inventory requires full object IDs.");
  return result;
}

function rows(output: string): unknown[] {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
    throw new NetworkInventoryError("Docker network inventory exceeded its output bound.");
  }
  const trimmed = output.trim();
  return trimmed ? trimmed.split(/\r?\n/).map((line) => JSON.parse(line) as unknown) : [];
}

function ids(output: string): string[] {
  const values = output.trim() ? output.trim().split(/\r?\n/).map(id) : [];
  if (values.length > MAX_IDS || new Set(values).size !== values.length) {
    throw new NetworkInventoryError("Docker network inventory has duplicate or too many objects.");
  }
  return values.sort();
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Read-only evidence for one pinned daemon. Incomplete evidence never means zero usage. */
export function collectDockerNetworkInventory(
  options: { endpoint?: string; expectedDaemonId?: string; timeoutMs?: number } = {},
  dependencies: {
    read?: NetworkInventoryReader;
    resolveEndpoint?: () => string;
    now?: () => number;
  } = {},
): DockerNetworkInventory {
  const now = dependencies.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const started = now();
  const result: DockerNetworkInventory = {
    status: "unknown",
    pools: [],
    networks: [],
    observedAt: new Date(started).toISOString(),
    reasons: [],
  };
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new NetworkInventoryError("Docker network inventory timeout is invalid.");
    }
    const endpoint =
      options.endpoint ?? (dependencies.resolveEndpoint ?? resolveManagedStopEndpoint)();
    if (!supportsManagedStopBaseline(endpoint)) {
      throw new NetworkInventoryError("Network inventory requires an exact local Docker endpoint.");
    }
    result.endpoint = endpoint;
    const read = (args: string[]) => {
      const remaining = started + timeoutMs - now();
      if (remaining <= 0)
        throw new NetworkInventoryError("Docker network inventory deadline exceeded.");
      const output = (dependencies.read ?? readDocker)(endpoint, args, remaining);
      if (now() > started + timeoutMs)
        throw new NetworkInventoryError("Docker network inventory deadline exceeded.");
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
        throw new NetworkInventoryError("Docker network inventory exceeded its output bound.");
      }
      return output;
    };
    const info = record(
      JSON.parse(
        read(["info", "--format", '{"id":{{json .ID}},"pools":{{json .DefaultAddressPools}}}']),
      ),
    );
    result.daemonId = text(info.id);
    if (options.expectedDaemonId && result.daemonId !== options.expectedDaemonId) {
      throw new NetworkInventoryError("Docker daemon identity changed before network inspection.");
    }
    if (!Array.isArray(info.pools))
      throw new NetworkInventoryError("Docker default pools are unavailable.");
    result.pools = info.pools.map((value) => {
      const pool = record(value);
      const base = text(pool.Base);
      if (!Number.isSafeInteger(pool.Size) || Number(pool.Size) < 0 || Number(pool.Size) > 128) {
        throw new NetworkInventoryError("Docker default pool allocation size is invalid.");
      }
      return { base, size: Number(pool.Size) };
    });
    const networkIds = ids(read(["network", "ls", "--no-trunc", "--quiet"]));
    const containerIds = ids(read(["ps", "--all", "--quiet", "--no-trunc"]));
    const networks = networkIds.length
      ? rows(read(["network", "inspect", "--format", NETWORK_TEMPLATE, ...networkIds]))
      : [];
    result.networks = networks.map((value) => {
      const network = record(value);
      if (
        (!Array.isArray(network.ipam) && !(network.ipam === null && network.driver !== "bridge")) ||
        !Number.isSafeInteger(network.activeEndpoints) ||
        Number(network.activeEndpoints) < 0
      ) {
        throw new NetworkInventoryError("Docker network IPAM or endpoint evidence is unavailable.");
      }
      return {
        id: id(network.id),
        name: text(network.name),
        driver: text(network.driver),
        subnets: (network.ipam === null ? [] : (network.ipam as unknown[])).map((entry) =>
          text(record(entry).Subnet),
        ),
        activeEndpoints: Number(network.activeEndpoints),
        retainedContainerIds: [],
        ...(typeof network.project === "string" && network.project
          ? { composeProject: network.project }
          : {}),
        ...(typeof network.network === "string" && network.network
          ? { composeNetwork: network.network }
          : {}),
      };
    });
    if (!sameIds(networkIds, result.networks.map((network) => network.id).sort())) {
      throw new NetworkInventoryError("Docker network inspection was incomplete or duplicated.");
    }
    const byId = new Map(result.networks.map((network) => [network.id, network]));
    const containers = containerIds.length
      ? rows(read(["inspect", "--format", CONTAINER_TEMPLATE, ...containerIds]))
      : [];
    const inspected: string[] = [];
    for (const value of containers) {
      const container = record(value);
      const containerId = id(container.id);
      inspected.push(containerId);
      for (const membership of Object.values(record(container.networks))) {
        const reference = record(membership);
        // An empty network ID can survive network deletion on a stopped container.
        // It is unresolved ownership evidence, never proof that a subnet is free.
        const networkId = id(reference.NetworkID);
        const network = byId.get(networkId);
        if (!network)
          throw new NetworkInventoryError("A retained container references an unobserved network.");
        if (!network.retainedContainerIds.includes(containerId))
          network.retainedContainerIds.push(containerId);
      }
    }
    if (!sameIds(containerIds, inspected.sort())) {
      throw new NetworkInventoryError(
        "Docker retained-container inspection was incomplete or duplicated.",
      );
    }
    if (
      !sameIds(networkIds, ids(read(["network", "ls", "--no-trunc", "--quiet"]))) ||
      !sameIds(containerIds, ids(read(["ps", "--all", "--quiet", "--no-trunc"])))
    ) {
      throw new NetworkInventoryError(
        "Docker object population changed during network inspection.",
      );
    }
    const finalId = text(JSON.parse(read(["info", "--format", "{{json .ID}}"])));
    if (finalId !== result.daemonId)
      throw new NetworkInventoryError("Docker daemon identity changed during inspection.");
    result.status = "complete";
  } catch (error) {
    // Subprocess stderr and inspected content may contain unrelated private data.
    const reason =
      error instanceof NetworkInventoryError
        ? error.message
        : "Docker network inventory is unavailable or malformed.";
    result.reasons.push(reason);
  }
  return result;
}
