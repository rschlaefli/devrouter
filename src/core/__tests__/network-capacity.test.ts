import { describe, expect, it } from "vitest";
import {
  calculateIPv4EndpointCapacity,
  classifyIPv4RouteOverlap,
  collectNetworkCapacityReport,
  type NetworkCapacityCollectionRequest,
  type NetworkCapacityInventory,
} from "../network-capacity";

const identity = {
  endpoint: "unix:///var/run/docker.sock",
  daemonId: "daemon-1",
};

const completeRoutes = { status: "complete" as const, routes: [] };

function request(overrides: Partial<NetworkCapacityCollectionRequest> = {}) {
  return { ...identity, routes: completeRoutes, ...overrides };
}

function inventory(overrides: Partial<NetworkCapacityInventory> = {}): NetworkCapacityInventory {
  return {
    ...identity,
    status: "complete",
    pools: [{ base: "10.0.0.0/24", size: 24 }],
    networks: [],
    reasons: [],
    ...overrides,
  };
}

function collect(
  currentRequest: NetworkCapacityCollectionRequest,
  currentInventory: NetworkCapacityInventory,
) {
  return collectNetworkCapacityReport(currentRequest, {
    collectInventory: () => currentInventory,
  });
}

function occupiedNetwork(subnet: string, id = "network-1") {
  return {
    id,
    name: id,
    driver: "bridge",
    subnets: [subnet],
    activeEndpoints: 0,
    retainedContainerIds: [],
  };
}

describe("IPv4 capacity primitives", () => {
  it("enforces endpoint reserve at the /26 threshold and permits larger overrides", () => {
    expect(calculateIPv4EndpointCapacity(26, 8, 53).status).toBe("available");
    expect(calculateIPv4EndpointCapacity(26, 8, 54).status).toBe("insufficient");
    expect(calculateIPv4EndpointCapacity(25, 8, 54).status).toBe("available");
    expect(calculateIPv4EndpointCapacity(24, 8, null).status).toBe("unknown");
    expect(calculateIPv4EndpointCapacity(26, -1, 1).status).toBe("unknown");
  });

  it.each([
    "10.0.0.4/32",
    "10.0.0.0/27",
    "0.0.0.0/1",
    "10.0.0.0/8",
  ])("rejects overlapping concrete host or tunnel prefix %s", (cidr) => {
    expect(
      classifyIPv4RouteOverlap("10.0.0.0/26", {
        status: "complete",
        routes: [{ cidr }],
      }).status,
    ).toBe("conflict");
  });
  it("calculates conventional /26 capacity with an eight-address reserve", () => {
    expect(calculateIPv4EndpointCapacity(26)).toMatchObject({
      totalAddresses: 64,
      conventionalUsableEndpoints: 61,
      reserve: 8,
      availableEndpoints: 53,
      status: "available",
    });
  });

  it("classifies default routes as non-conflicting and concrete routes by overlap", () => {
    expect(
      classifyIPv4RouteOverlap("10.0.0.0/26", {
        status: "complete",
        routes: [
          { cidr: "0.0.0.0/0", interface: "utun0", source: "vpn" },
          { cidr: "10.0.0.64/26", interface: "en0", source: "lan" },
        ],
      }),
    ).toEqual({ status: "clear", overlappingRouteCidrs: [] });

    expect(
      classifyIPv4RouteOverlap("10.0.0.64/26", {
        status: "complete",
        routes: [{ cidr: "10.0.0.0/24", interface: "vpn0", source: "vpn" }],
      }),
    ).toEqual({ status: "conflict", overlappingRouteCidrs: ["10.0.0.0/24"] });
  });
});

describe("collectNetworkCapacityReport", () => {
  it("keeps IPv6 evidence separate from occupied IPv4 capacity", () => {
    const network = occupiedNetwork("10.0.0.0/24");
    network.subnets.push("fd00::/64");
    const report = collect(request(), inventory({ networks: [network] }));
    expect(report.allocation.status).toBe("exhausted");
    expect(report.networks[0].ipv6Subnets).toEqual(["fd00::/64"]);
    expect(report.networks[0].ipv4Subnets).toEqual(["10.0.0.0/24"]);
  });

  it("does not double count overlapping pool declarations", () => {
    const report = collect(
      request(),
      inventory({
        pools: [
          { base: "10.0.0.0/24", size: 26 },
          { base: "10.0.0.0/25", size: 26 },
        ],
      }),
    );
    expect(report.allocation.status).toBe("unknown");
    expect(report.allocation.freeBlockCount).toBe("unknown");
  });
  it("suppresses untrusted collector exception content", () => {
    const report = collectNetworkCapacityReport(request(), {
      collectInventory: () => {
        throw new Error("synthetic-private-canary");
      },
    });
    expect(report.evidence.inventory).toBe("unknown");
    expect(JSON.stringify(report)).not.toContain("synthetic-private-canary");
  });
  it("reports exact exhaustion across thirty occupied /24 pool bases", () => {
    const pools = Array.from({ length: 30 }, (_, index) => ({
      base: `10.${index}.0.0/24`,
      size: 24,
    }));
    const networks = pools.map(({ base }, index) => occupiedNetwork(base, `network-${index}`));

    const report = collect(request(), inventory({ pools, networks }));

    expect(report.allocation).toMatchObject({ status: "exhausted", freeBlockCount: 0 });
    expect(report.pools).toHaveLength(30);
    expect(report.pools.every((pool) => pool.potentialFreeBlockCount === 0)).toBe(true);
  });

  it("does not reclaim an occupied /24 when a /26 report is requested", () => {
    const report = collect(
      request({ prefixLength: 26 }),
      inventory({ networks: [occupiedNetwork("10.0.0.0/24")] }),
    );

    expect(report.pools[0]?.candidates).toHaveLength(4);
    expect(report.pools[0]?.candidates.every((candidate) => candidate.status === "occupied")).toBe(
      true,
    );
    expect(report.allocation.freeBlockCount).toBe(0);
  });

  it("classifies fragmented network and route overlap while retaining free /26 blocks", () => {
    const report = collect(
      request({
        prefixLength: 26,
        routes: {
          status: "complete",
          routes: [{ cidr: "10.0.0.64/26", interface: "vpn0", source: "vpn" }],
        },
      }),
      inventory({ networks: [occupiedNetwork("10.0.0.0/26")] }),
    );

    expect(report.pools[0]?.candidates.map((candidate) => candidate.status)).toEqual([
      "occupied",
      "route-conflict",
      "free",
      "free",
    ]);
    expect(report.allocation).toMatchObject({ status: "available", freeBlockCount: 2 });
  });

  it("marks retained references unknown when the adapter reports unknown inventory", () => {
    const report = collect(
      request(),
      inventory({
        status: "unknown",
        networks: [occupiedNetwork("10.0.0.0/24")],
        reasons: ["container listing was incomplete"],
      }),
    );

    expect(report.networks[0]?.retainedReferences).toBe("unknown");
    expect(report.networks[0]?.cleanup.status).toBe("blocked");
    expect(report.allocation.blockers).toContain("Docker network inventory is unknown");
  });

  it("keeps cleanup blocked with zero active endpoints and retained references", () => {
    const report = collect(
      request(),
      inventory({
        networks: [
          {
            ...occupiedNetwork("10.0.0.0/24"),
            retainedContainerIds: ["stopped-container"],
          },
        ],
      }),
    );

    expect(report.networks[0]?.activeEndpoints).toBe(0);
    expect(report.networks[0]?.retainedReferences).toBe(1);
    expect(report.networks[0]?.cleanup.status).toBe("blocked");
  });

  it("marks route overlap unknown when route evidence is unavailable", () => {
    const report = collect(request({ prefixLength: 26, routes: undefined }), inventory());

    expect(
      report.pools[0]?.candidates.every((candidate) => candidate.routeStatus === "unknown"),
    ).toBe(true);
    expect(report.allocation.status).toBe("unknown");
  });

  it("fails closed when the collector returns a different daemon identity", () => {
    const report = collect(request(), inventory({ daemonId: "daemon-2" }));

    expect(report.evidence.inventory).toBe("unknown");
    expect(report.allocation.status).toBe("unknown");
    expect(report.allocation.blockers[0]).toContain("identity");
  });

  it("preserves adapter observation metadata without exposing extra fields", () => {
    const report = collect(
      request(),
      inventory({ observedAt: "2026-09-09T12:00:00.000Z", reasons: ["synthetic snapshot"] }),
    );

    expect(report.evidence).toMatchObject({
      observedAt: "2026-09-09T12:00:00.000Z",
      reasons: ["synthetic snapshot"],
    });
    expect(report).not.toHaveProperty("environment");
  });
});
