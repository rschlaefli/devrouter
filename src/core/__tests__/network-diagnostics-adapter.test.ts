import { beforeEach, describe, expect, it, vi } from "vitest";
import { readNetworkClaims } from "../network-claims";
import { inspectNetworkCapacity } from "../network-diagnostics";

vi.mock("../network-inventory", () => ({
  collectDockerNetworkInventory: () => ({
    status: "complete",
    endpoint: "unix:///synthetic.sock",
    daemonId: "synthetic",
    pools: [{ base: "10.88.0.0/24", size: 24 }],
    networks: [],
    reasons: [],
  }),
}));
vi.mock("../network-policy", async (original) => ({
  ...(await original<typeof import("../network-policy")>()),
  readNetworkPolicy: () => ({
    status: "valid",
    policy: {
      version: 1,
      daemonId: "synthetic",
      pools: ["10.88.0.0/24"],
      exclusions: [],
      allowedPrefixes: [26],
      endpointReserve: 8,
    },
  }),
}));
vi.mock("../network-routes", () => ({
  collectNetworkRoutes: () => ({ status: "complete", routes: [] }),
}));
vi.mock("../network-claims", () => ({ readNetworkClaims: vi.fn(() => []) }));
beforeEach(() => vi.clearAllMocks());
describe("read-only policy diagnostics adapter", () => {
  it("includes machine-policy capacity without changing daemon-default evidence", () => {
    const report = inspectNetworkCapacity();
    expect(report.pools[0].candidatePrefixLength).toBe(24);
    expect(report.managedPolicy?.policy.status).toBe("valid");
    expect(report.managedPolicy?.configuredPolicyCapacity.freeBlocks).toBe(4);
  });
  it("never reports unreadable claim state as an empty allocation ledger", () => {
    vi.mocked(readNetworkClaims).mockImplementationOnce(() => {
      throw new Error("synthetic failure");
    });
    const report = inspectNetworkCapacity();
    expect(report.managedPolicy?.evidence.claims).toBe("unknown");
    expect(report.managedPolicy?.configuredPolicyCapacity.status).not.toBe("available");
    expect(report.managedPolicy?.claims.total).toBe("unknown");
  });
});
