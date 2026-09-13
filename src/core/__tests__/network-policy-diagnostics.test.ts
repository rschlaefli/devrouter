import { describe, expect, it } from "vitest";
import type { NetworkCapacityInventory } from "../network-capacity";
import type { NetworkClaim } from "../network-claims";
import type { NetworkPolicy } from "../network-policy";
import {
  diagnoseNetworkPolicy,
  type NetworkPolicyDiagnosticInput,
} from "../network-policy-diagnostics";

const identity = {
  endpoint: "synthetic://daemon",
  daemonId: "daemon-a",
};

const routes = { status: "complete" as const, routes: [] };

function policy(overrides: Partial<NetworkPolicy> = {}): NetworkPolicy {
  return {
    version: 1,
    daemonId: identity.daemonId,
    pools: ["10.88.0.0/24"],
    exclusions: [],
    allowedPrefixes: [26],
    endpointReserve: 8,
    ...overrides,
  };
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

function claim(
  state: NetworkClaim["state"],
  subnet: string,
  overrides: Partial<NetworkClaim> = {},
): NetworkClaim {
  return {
    ownerKey: `owner-${state}`,
    providerId: "provider-a",
    provider: "devpod",
    providerContext: "context-a",
    definitionSha256: "a".repeat(64),
    endpoint: identity.endpoint,
    daemonId: identity.daemonId,
    configFingerprint: "config-a",
    subnet,
    prefix: 26,
    operationId: `operation-${state}`,
    fence: {
      environmentId: "environment-a",
      intentRevision: 1,
      runtimeGeneration: 1,
      controllerEpoch: 1,
    },
    workerId: `worker-${state}`,
    state,
    ...overrides,
  };
}

function input(
  overrides: Partial<NetworkPolicyDiagnosticInput> = {},
): NetworkPolicyDiagnosticInput {
  return {
    policy: { status: "valid", path: "synthetic-policy", policy: policy() },
    inventory: inventory(),
    claims: [],
    routes,
    ...overrides,
  };
}

describe("diagnoseNetworkPolicy", () => {
  it("distinguishes daemon-default capacity from a policy-owned /26 capacity", () => {
    const report = diagnoseNetworkPolicy(input());

    expect(report.policy.status).toBe("valid");
    expect(report.daemonDefaultCapacity).toMatchObject({
      status: "available",
      prefixLength: 24,
      freeBlocks: 1,
    });
    expect(report.configuredPolicyCapacity).toMatchObject({
      status: "available",
      prefixLength: 26,
      freeBlocks: 4,
      endpoint: { available: 53 },
    });
  });

  it.each([
    ["absent", { status: "absent" as const, path: "synthetic-policy" }, "not-configured"],
    [
      "invalid",
      { status: "invalid" as const, path: "synthetic-policy", error: "private-value" },
      "blocked",
    ],
    [
      "mismatched",
      {
        status: "valid" as const,
        path: "synthetic-policy",
        policy: policy({ daemonId: "other-daemon" }),
      },
      "blocked",
    ],
  ])("reports a values-free %s policy state", (_label, policyEvidence, capacityStatus) => {
    const report = diagnoseNetworkPolicy(input({ policy: policyEvidence }));

    expect(report.configuredPolicyCapacity.status).toBe(capacityStatus);
    expect(JSON.stringify(report)).not.toContain(identity.endpoint);
    expect(JSON.stringify(report)).not.toContain(identity.daemonId);
    expect(JSON.stringify(report)).not.toContain("private-value");
  });

  it("subtracts reserved, attached, and uncertain claims while preserving their counts", () => {
    const report = diagnoseNetworkPolicy(
      input({
        claims: [
          claim("reserved", "10.88.0.0/26"),
          claim("attached", "10.88.0.64/26"),
          claim("uncertain", "10.88.0.128/26"),
        ],
      }),
    );

    expect(report.claims).toEqual({
      status: "complete",
      total: 3,
      reserved: 1,
      attached: 1,
      uncertain: 1,
      blocksSubtracted: 3,
    });
    expect(report.configuredPolicyCapacity).toMatchObject({
      status: "available",
      freeBlocks: 1,
      claimBlocksSubtracted: 3,
      candidateCounts: { occupied: 3, free: 1 },
    });
    expect(report.recovery.categories).toContain("preserve-retained-resources");
  });

  it("requires complete route evidence before reporting allocatable capacity", () => {
    const report = diagnoseNetworkPolicy(input({ routes: { status: "unknown", routes: [] } }));

    expect(report.evidence.routes).toBe("unknown");
    expect(report.daemonDefaultCapacity.status).toBe("unknown");
    expect(report.configuredPolicyCapacity.status).toBe("unknown");
    expect(report.recovery.categories).toContain("collect-complete-route-evidence");
  });

  it("keeps retained resources report-only and recommends safe recovery categories", () => {
    const report = diagnoseNetworkPolicy(
      input({
        inventory: {
          ...inventory(),
          networks: [
            {
              id: "network-private",
              name: "network-private",
              driver: "bridge",
              subnets: ["10.0.0.0/24"],
              activeEndpoints: 0,
              retainedContainerIds: ["container-private"],
            },
          ],
          pools: [{ base: "10.0.0.0/24", size: 24 }],
        },
      }),
    );

    expect(report.daemonDefaultCapacity.status).toBe("exhausted");
    expect(report.daemonDefaultCapacity.retainedReferences).toBe(1);
    expect(report.recovery).toEqual({
      mode: "report-only",
      status: "blocked",
      categories: [
        "review-capacity-policy",
        "preserve-retained-resources",
        "reuse-existing-network",
      ],
      retainedResourcesPreserved: true,
    });
    expect(JSON.stringify(report)).not.toContain("network-private");
    expect(JSON.stringify(report)).not.toContain("container-private");
  });

  it("does not claim capacity when claim evidence exceeds its bound", () => {
    const tooManyClaims = Array.from({ length: 257 }, (_, index) =>
      claim("reserved", `10.88.${Math.floor(index / 4)}.${(index % 4) * 64}/26`, {
        ownerKey: `owner-${index}`,
      }),
    );
    const report = diagnoseNetworkPolicy(input({ claims: tooManyClaims }));

    expect(report.evidence.claims).toBe("unknown");
    expect(report.configuredPolicyCapacity.status).toBe("unknown");
    expect(report.configuredPolicyCapacity.freeBlocks).toBe("unknown");
    expect(report.recovery.categories).toContain("review-unresolved-claims");
  });

  it("preserves a failed persisted-claims read as unknown evidence", () => {
    const report = diagnoseNetworkPolicy(input({ claims: null }));

    expect(report.evidence.claims).toBe("unknown");
    expect(report.claims).toEqual({
      status: "unknown",
      total: "unknown",
      reserved: "unknown",
      attached: "unknown",
      uncertain: "unknown",
      blocksSubtracted: "unknown",
    });
    expect(report.daemonDefaultCapacity).toMatchObject({
      status: "unknown",
      freeBlocks: "unknown",
      claimBlocksSubtracted: "unknown",
    });
    expect(report.configuredPolicyCapacity).toMatchObject({
      status: "unknown",
      freeBlocks: "unknown",
      claimBlocksSubtracted: "unknown",
    });
    expect(report.recovery.categories).toContain("review-unresolved-claims");
  });
});
