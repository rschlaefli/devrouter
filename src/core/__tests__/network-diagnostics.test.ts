import { describe, expect, it } from "vitest";
import { collectNetworkCapacityReport } from "../network-capacity";
import { networkCapacityCheck } from "../network-diagnostics";

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
  it("can prove occupied pools without claiming route safety", () => {
    const result = report(true);
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
    expect(result.allocation.status).toBe("unknown");
    expect(result.evidence.routes).toBe("unknown");
    expect(networkCapacityCheck(result).level).toBe("warn");
  });
});
