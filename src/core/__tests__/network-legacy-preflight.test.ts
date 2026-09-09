import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectLegacyNetworkCapacity } from "../network-diagnostics";
import { collectDockerNetworkInventory } from "../network-inventory";
import { inspectNetworkProviderBinding } from "../network-provider-inspect";

vi.mock("../network-provider-inspect", () => ({ inspectNetworkProviderBinding: vi.fn() }));
vi.mock("../network-inventory", () => ({ collectDockerNetworkInventory: vi.fn() }));
const input = { provider: "devsy" as const, providerId: "synthetic", repoPath: "/synthetic" };
const identity = { endpoint: "unix:///tmp/provider.sock", daemonId: "provider-daemon" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inspectNetworkProviderBinding).mockReturnValue({
    ...identity,
    registration: "absent",
  } as never);
  vi.mocked(collectDockerNetworkInventory).mockReturnValue({
    ...identity,
    status: "complete",
    reasons: [],
    observedAt: new Date(0).toISOString(),
    pools: [{ base: "10.88.0.0/24", size: 24 }],
    networks: [
      {
        id: "a".repeat(64),
        name: "synthetic_default",
        driver: "bridge",
        subnets: ["10.88.0.0/24"],
        activeEndpoints: 0,
        retainedContainerIds: ["b".repeat(64)],
      },
    ],
  });
});
describe("legacy preflight advisory", () => {
  it("reports exhausted provider pools including retained allocations", () => {
    const report = inspectLegacyNetworkCapacity(input);
    expect(report?.networks[0].retainedReferences).toBe(1);
    expect(collectDockerNetworkInventory).toHaveBeenCalledWith({
      endpoint: identity.endpoint,
      expectedDaemonId: identity.daemonId,
    });
  });
  it("does not query ambient Docker when destination qualification fails or a workspace exists", () => {
    vi.mocked(inspectNetworkProviderBinding).mockImplementation(() => {
      throw new Error("private-output");
    });
    expect(inspectLegacyNetworkCapacity(input)).toBeUndefined();
    expect(collectDockerNetworkInventory).not.toHaveBeenCalled();
    vi.mocked(inspectNetworkProviderBinding).mockReturnValue({
      ...identity,
      registration: "owned",
    } as never);
    expect(inspectLegacyNetworkCapacity(input)).toBeUndefined();
    expect(collectDockerNetworkInventory).not.toHaveBeenCalled();
  });
  it("does not turn unavailable inventory into exhaustion", () => {
    vi.mocked(collectDockerNetworkInventory).mockReturnValue({
      ...identity,
      status: "unknown",
      pools: [],
      networks: [],
      reasons: ["unavailable"],
      observedAt: new Date(0).toISOString(),
    });
    expect(inspectLegacyNetworkCapacity(input)).toBeUndefined();
  });
});
