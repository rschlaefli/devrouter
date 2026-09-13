import { beforeEach, describe, expect, it, vi } from "vitest";
import { findOwnedNetworkClaim } from "../network-claim-lookup";
import {
  assertRetainedNetworkConfiguration,
  createManagedNetworkSession,
} from "../network-managed";
import { readNetworkPolicy } from "../network-policy";

vi.mock("../network-claim-lookup", () => ({
  findOwnedNetworkClaim: vi.fn(),
  networkOwnerKey: vi.fn(() => "owner"),
}));
vi.mock("../network-policy", () => ({ readNetworkPolicy: vi.fn() }));
vi.mock("../devpod-environment", () => ({
  resolveManagedStopEndpoint: vi.fn(() => "unix:///tmp/synthetic.sock"),
}));
const input = {
  repoPath: "/synthetic",
  provider: "devsy" as const,
  hadExactProvider: false,
  plan: vi.fn(),
  replacePlan: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findOwnedNetworkClaim).mockReturnValue(undefined);
  vi.mocked(readNetworkPolicy).mockReturnValue({ status: "absent", path: "/synthetic-policy" });
});
describe("managed network eligibility boundary", () => {
  it("cannot bypass retained claims by removing managed configuration or requesting repair", () => {
    vi.mocked(findOwnedNetworkClaim).mockReturnValue({ state: "attached" } as never);
    expect(() =>
      assertRetainedNetworkConfiguration({
        repoPath: input.repoPath,
        managedRuntime: false,
        repair: false,
      }),
    ).toThrow();
    expect(() =>
      assertRetainedNetworkConfiguration({
        repoPath: input.repoPath,
        managedRuntime: true,
        repair: true,
      }),
    ).toThrow();
    vi.mocked(findOwnedNetworkClaim).mockReturnValue({ state: "reserved" } as never);
    expect(() =>
      assertRetainedNetworkConfiguration({
        repoPath: input.repoPath,
        managedRuntime: true,
        repair: false,
      }),
    ).toThrow();
    vi.mocked(findOwnedNetworkClaim).mockReturnValue(undefined);
    expect(() =>
      assertRetainedNetworkConfiguration({
        repoPath: input.repoPath,
        managedRuntime: false,
        repair: false,
      }),
    ).not.toThrow();
  });
  it("preserves legacy no-policy and pre-existing registration behavior", () => {
    expect(createManagedNetworkSession(input)).toBeUndefined();
    vi.mocked(readNetworkPolicy).mockReturnValue({
      status: "valid",
      path: "/synthetic-policy",
      policy: {},
    } as never);
    expect(createManagedNetworkSession({ ...input, hadExactProvider: true })).toBeUndefined();
    expect(input.plan).not.toHaveBeenCalled();
    expect(input.replacePlan).not.toHaveBeenCalled();
  });
  it("rejects explicit requests without policy or on primary checkout before effects", () => {
    expect(() =>
      createManagedNetworkSession({ ...input, request: { prefixLength: 26 } }),
    ).toThrow();
    vi.mocked(readNetworkPolicy).mockReturnValue({
      status: "valid",
      path: "/synthetic-policy",
      policy: {},
    } as never);
    expect(() =>
      createManagedNetworkSession({ ...input, request: { prefixLength: 26 } }),
    ).toThrow();
    expect(input.replacePlan).not.toHaveBeenCalled();
  });
});
