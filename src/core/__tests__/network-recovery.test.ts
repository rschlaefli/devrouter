import { beforeEach, describe, expect, it, vi } from "vitest";
import { releaseNetworkClaim } from "../network-claims";
import { recoverUnattachedNetworkReservation } from "../network-recovery";

const state = vi.hoisted(() => ({
  settled: true,
  registered: false,
  containers: false,
  occupied: false,
  daemon: "daemon",
  claims: true,
  events: [] as string[],
}));
vi.mock("../devpod-mutation", () => ({
  withMutationLock: (_a: string, _b: string, fn: () => void) => fn(),
}));
vi.mock("../devsy-mutation", () => ({
  withMutationLock: (_a: string, _b: string, fn: () => void) => {
    state.events.push("locked");
    fn();
  },
}));
vi.mock("../network-claim-lookup", () => ({
  findOwnedNetworkClaim: () =>
    state.claims
      ? {
          state: "uncertain",
          provider: "devsy",
          providerId: "synthetic",
          providerContext: "default",
          endpoint: "unix:///synthetic.sock",
          daemonId: "daemon",
          subnet: "10.88.0.0/26",
          operationId: "old",
          definitionSha256: "a".repeat(64),
        }
      : undefined,
}));
vi.mock("../network-claims", () => ({
  releaseNetworkClaim: vi.fn(() => {
    state.events.push("released");
    return true;
  }),
}));
vi.mock("../workspace", () => ({ readPersistedWorkspace: () => "synthetic" }));
vi.mock("../workspace-runtime", () => ({ resolveWorkspaceRuntimeOrDefault: () => "devsy" }));
vi.mock("../workspace-ownership", () => ({
  readWorkspaceOwnership: () => ({ worktreePath: "/synthetic", devpodId: "synthetic" }),
}));
vi.mock("../network-lifecycle", () => ({
  readNetworkOperationAuthority: () => ({ operationId: "new" }),
  assertNetworkOperationCurrent: () => {
    state.events.push("fenced");
  },
  networkOperationSettled: () => state.settled,
}));
vi.mock("../network-policy", () => ({
  readNetworkPolicy: () => ({ status: "valid", policy: { daemonId: "daemon" } }),
}));
vi.mock("../network-provider-inspect", () => ({
  inspectNetworkProviderBinding: () => ({
    provider: "devsy",
    providerId: "synthetic",
    providerContext: "default",
    endpoint: "unix:///synthetic.sock",
    daemonId: state.daemon,
    definitionSha256: "a".repeat(64),
    versionQualified: true,
    providerName: "docker",
    dockerPath: "docker",
    persistedContext: null,
    persistedEndpoint: state.registered ? "unix:///synthetic.sock" : null,
    registration: state.registered ? "owned" : "absent",
  }),
}));
vi.mock("../network-inventory", () => ({
  collectDockerNetworkInventory: () => ({
    status: "complete",
    daemonId: "daemon",
    networks: state.occupied ? [{ subnets: ["10.88.0.0/24"] }] : [],
  }),
}));
vi.mock("../devpod-environment", () => ({
  supportsManagedStopBaseline: () => true,
  inspectWorkspaceContainers: () => (state.containers ? [{}] : []),
  workspaceAppContainers: (rows: unknown[]) => rows,
}));
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    settled: true,
    registered: false,
    containers: false,
    occupied: false,
    daemon: "daemon",
    claims: true,
    events: [],
  });
});
describe("terminal no-effect reservation recovery", () => {
  it("releases only metadata after positive settlement, absence and identity proof", () => {
    recoverUnattachedNetworkReservation("/synthetic", true);
    expect(releaseNetworkClaim).toHaveBeenCalledTimes(1);
    expect(state.events[0]).toBe("locked");
    expect(state.events.at(-1)).toBe("released");
  });
  it.each([
    "settled",
    "registered",
    "containers",
    "occupied",
    "daemon",
  ] as const)("retains uncertain state when %s evidence fails", (key) => {
    if (key === "settled") state.settled = false;
    else if (key === "daemon") state.daemon = "replacement";
    else state[key] = true;
    expect(() => recoverUnattachedNetworkReservation("/synthetic", true)).toThrow();
    expect(releaseNetworkClaim).not.toHaveBeenCalled();
  });
  it("keeps legacy workspaces outside recovery and rejects configuration removal", () => {
    expect(() => recoverUnattachedNetworkReservation("/synthetic", false)).toThrow();
    state.claims = false;
    recoverUnattachedNetworkReservation("/synthetic", false);
    expect(releaseNetworkClaim).not.toHaveBeenCalled();
  });
});
