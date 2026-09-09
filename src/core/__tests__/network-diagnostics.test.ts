import { describe, expect, it } from "vitest";
import { collectNetworkCapacityReport } from "../network-capacity";
import { hasExhaustedDockerPools, networkCapacityCheck } from "../network-diagnostics";
import { diagnoseNetworkPolicy } from "../network-policy-diagnostics";

const identity = { endpoint: "unix:///tmp/synthetic.sock", daemonId: "synthetic" };

function report(occupied: boolean) {
  return collectNetworkCapacityReport(identity, {
    collectInventory: () => ({
      ...identity,
      status: "complete",
      reasons: [],
      pools: [{ base: "10.88.0.0/24", size: 24 }],
      networks: occupied
        ? [
            {
              id: "network",
              name: "synthetic_default",
              driver: "bridge",
              subnets: ["10.88.0.0/24"],
              activeEndpoints: 0,
              retainedContainerIds: ["container"],
            },
          ]
        : [],
    }),
  });
}

describe("network diagnostic integration", () => {
  it("keeps absent-policy diagnostics quiet only with proven unoccupied inventory", () => {
    const managedPolicy = diagnoseNetworkPolicy({
      policy: { status: "absent", path: "/synthetic/policy.json" },
      inventory: { ...identity, status: "complete", networks: [], pools: [], reasons: [] },
      claims: [],
      routes: { status: "unknown", routes: [] },
    });
    const available = { ...report(false), managedPolicy };
    expect(networkCapacityCheck(available).level).toBe("ok");
    expect(
      networkCapacityCheck({
        ...available,
        networks: [{ ...report(true).networks[0], ipv4Subnets: ["invalid"] }],
      }).level,
    ).toBe("warn");
    expect(available.allocation.status).toBe("unknown");
    expect(networkCapacityCheck({ ...report(true), managedPolicy }).level).toBe("warn");
    expect(
      networkCapacityCheck({
        ...available,
        evidence: { ...available.evidence, inventory: "unknown" },
      }).level,
    ).toBe("warn");
  });

  it("can prove occupied pools without claiming route safety", () => {
    const result = report(true);
    expect(hasExhaustedDockerPools(result)).toBe(true);
    expect(
      hasExhaustedDockerPools({
        ...result,
        evidence: { ...result.evidence, inventory: "unknown" },
      }),
    ).toBe(false);
    expect(result.allocation.status).toBe("unknown");
    expect(result.pools[0].candidates[0].status).toBe("occupied");
    expect(result.networks[0].retainedReferences).toBe(1);
    expect(networkCapacityCheck(result)).toMatchObject({
      id: "global.network-capacity",
      level: "warn",
    });
  });

  it("does not present an unoccupied pool as ready without route evidence", () => {
    const result = report(false);
    expect(hasExhaustedDockerPools(result)).toBe(false);
    expect(result.allocation.status).toBe("unknown");
    expect(result.evidence.routes).toBe("unknown");
    expect(networkCapacityCheck(result).level).toBe("warn");
  });
});
