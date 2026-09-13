import { describe, expect, it, vi } from "vitest";
import { collectDockerNetworkInventory, type NetworkInventoryReader } from "../network-inventory";

const endpoint = "unix:///tmp/synthetic-docker.sock";
const networkId = "a".repeat(64);
const containerId = "b".repeat(64);

function fixture(overrides: { network?: Record<string, unknown>; membership?: unknown } = {}) {
  return vi.fn<NetworkInventoryReader>((target, args) => {
    expect(target).toBe(endpoint);
    if (args[0] === "info") {
      return args.at(-1) === "{{json .ID}}"
        ? JSON.stringify("synthetic-daemon")
        : JSON.stringify({
            id: "synthetic-daemon",
            pools: [{ Base: "10.88.0.0/24", Size: 24 }],
          });
    }
    if (args[0] === "network" && args[1] === "ls") return networkId;
    if (args[0] === "ps") return containerId;
    if (args[0] === "network" && args[1] === "inspect")
      return JSON.stringify({
        id: networkId,
        name: "synthetic_default",
        driver: "bridge",
        ipam: [{ Subnet: "10.88.0.0/24" }],
        activeEndpoints: 0,
        project: "synthetic",
        network: "default",
        ...overrides.network,
      });
    if (args[0] === "inspect")
      return JSON.stringify({
        id: containerId,
        networks: overrides.membership ?? { synthetic_default: { NetworkID: networkId } },
      });
    throw new Error("unexpected synthetic command");
  });
}

function collect(
  read = fixture(),
  options: Parameters<typeof collectDockerNetworkInventory>[0] = {},
) {
  return collectDockerNetworkInventory({ endpoint, ...options }, { read });
}

describe("pinned read-only Docker network inventory", () => {
  it("retains stopped-container references despite zero active endpoints", () => {
    const read = fixture();
    const result = collect(read);
    expect(result.status).toBe("complete");
    expect(result.networks[0]).toMatchObject({
      activeEndpoints: 0,
      retainedContainerIds: [containerId],
    });
    expect(result.daemonId).toBe("synthetic-daemon");
    expect(
      read.mock.calls.every(
        ([, args]) =>
          !args.some((arg) => ["rm", "prune", "stop", "create", "disconnect"].includes(arg)),
      ),
    ).toBe(true);
    expect(read.mock.calls.filter(([, args]) => args[0] === "inspect")[0][1]).toContain("--format");
  });

  it("accepts built-in non-bridge networks without IPAM", () => {
    const result = collect(fixture({ network: { driver: "host", ipam: null } }));
    expect(result.status).toBe("complete");
    expect(result.networks[0].subnets).toEqual([]);
  });

  it("does not treat missing bridge IPAM as an empty subnet population", () => {
    expect(collect(fixture({ network: { ipam: null } })).status).toBe("unknown");
  });

  it("marks dangling stopped-container references unknown", () => {
    const result = collect(fixture({ membership: { old: { NetworkID: "" } } }));
    expect(result.status).toBe("unknown");
  });

  it("rejects changed daemon identity before inspecting objects", () => {
    const read = fixture();
    expect(collect(read, { expectedDaemonId: "different-daemon" }).status).toBe("unknown");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects daemon replacement during inspection", () => {
    const base = fixture();
    const read = vi.fn<NetworkInventoryReader>((target, args, timeout) =>
      args.at(-1) === "{{json .ID}}" ? JSON.stringify("replacement") : base(target, args, timeout),
    );
    expect(collect(read).status).toBe("unknown");
  });

  it("rejects changed object populations and incomplete inspection", () => {
    for (const mode of ["population", "missing", "duplicate"]) {
      const base = fixture();
      let lists = 0;
      const read = vi.fn<NetworkInventoryReader>((target, args, timeout) => {
        if (args[0] === "ps" && ++lists > 1 && mode === "population") return "";
        if (args[0] === "inspect" && mode === "missing") return "";
        if (args[0] === "inspect" && mode === "duplicate") {
          const row = base(target, args, timeout);
          return `${row}\n${row}`;
        }
        return base(target, args, timeout);
      });
      expect(collect(read).status).toBe("unknown");
    }
  });

  it("bounds all reads by the remaining deadline", () => {
    let time = 0;
    const base = fixture();
    const read = vi.fn<NetworkInventoryReader>((target, args, timeout) => {
      time += 6;
      return base(target, args, timeout);
    });
    const result = collectDockerNetworkInventory(
      { endpoint, timeoutMs: 10 },
      { read, now: () => time },
    );
    expect(result.status).toBe("unknown");
    expect(read.mock.calls.map((call) => call[2])).toEqual([10, 4]);
  });

  it("does not expose subprocess errors or malformed response values", () => {
    const secret = "synthetic-sensitive-error-marker";
    const read = vi.fn<NetworkInventoryReader>(() => {
      throw new Error(`Docker ${secret}`);
    });
    const result = collect(read);
    expect(result.status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects unsupported endpoints without invoking Docker", () => {
    const read = fixture();
    expect(collect(read, { endpoint: "ssh://synthetic-remote" }).status).toBe("unknown");
    expect(read).not.toHaveBeenCalled();
  });
});
