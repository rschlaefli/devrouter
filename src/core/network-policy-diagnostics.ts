import {
  collectNetworkCapacityReport,
  type NetworkCapacityEvidenceStatus,
  type NetworkCapacityInventory,
  type NetworkCapacityNetwork,
  type NetworkCapacityPrefixLength,
  type NetworkCapacityReport,
  type NetworkCapacityRouteInventory,
  parseIPv4Cidr,
} from "./network-capacity";
import type { NetworkClaim } from "./network-claims";
import type { NetworkPolicy, NetworkPolicyReadResult } from "./network-policy";

const DEFAULT_POLICY_PREFIX: NetworkCapacityPrefixLength = 26;
const MAX_CLAIMS = 256;

export type NetworkPolicyDiagnosticInput = {
  policy: NetworkPolicyReadResult;
  inventory: NetworkCapacityInventory;
  /** Null means the persisted claims read failed or was otherwise unavailable. */
  claims: readonly NetworkClaim[] | null;
  routes: NetworkCapacityRouteInventory;
  prefixLength?: NetworkCapacityPrefixLength;
  endpointDemand?: number | null;
};

export type NetworkPolicyDiagnosticPolicyStatus =
  | "absent"
  | "invalid"
  | "valid"
  | "mismatched"
  | "unknown";

export type NetworkPolicyDiagnosticCount = number | "unknown";

export type NetworkPolicyDiagnosticCandidateCounts = {
  free: NetworkPolicyDiagnosticCount;
  occupied: NetworkPolicyDiagnosticCount;
  routeConflict: NetworkPolicyDiagnosticCount;
  endpointInsufficient: NetworkPolicyDiagnosticCount;
  unknown: NetworkPolicyDiagnosticCount;
};

export type NetworkPolicyDiagnosticBlocker =
  | "inventory-unknown"
  | "routes-unknown"
  | "claims-unknown"
  | "policy-absent"
  | "policy-invalid"
  | "policy-daemon-mismatch"
  | "prefix-not-permitted"
  | "endpoint-insufficient"
  | "route-conflict"
  | "capacity-exhausted"
  | "retained-resources";

export type NetworkPolicyDiagnosticCapacity = {
  status: "available" | "exhausted" | "unknown" | "blocked" | "not-configured";
  prefixLength: NetworkCapacityPrefixLength | "unknown";
  freeBlocks: NetworkPolicyDiagnosticCount;
  candidateBlocks: NetworkPolicyDiagnosticCount;
  candidateCounts: NetworkPolicyDiagnosticCandidateCounts;
  endpoint: {
    status: "available" | "insufficient" | "unknown";
    available: NetworkPolicyDiagnosticCount;
    demand: NetworkPolicyDiagnosticCount;
    reserve: NetworkPolicyDiagnosticCount;
  };
  occupiedNetworks: NetworkPolicyDiagnosticCount;
  retainedNetworks: NetworkPolicyDiagnosticCount;
  retainedReferences: NetworkPolicyDiagnosticCount;
  claimBlocksSubtracted: NetworkPolicyDiagnosticCount;
  blockers: NetworkPolicyDiagnosticBlocker[];
};

export type NetworkPolicyDiagnosticClaimSummary = {
  status: NetworkCapacityEvidenceStatus;
  total: NetworkPolicyDiagnosticCount;
  reserved: NetworkPolicyDiagnosticCount;
  attached: NetworkPolicyDiagnosticCount;
  uncertain: NetworkPolicyDiagnosticCount;
  blocksSubtracted: NetworkPolicyDiagnosticCount;
};

export type NetworkPolicyDiagnosticRecoveryCategory =
  | "no-action"
  | "collect-complete-network-inventory"
  | "collect-complete-route-evidence"
  | "repair-policy"
  | "align-policy-with-daemon"
  | "review-unresolved-claims"
  | "preserve-retained-resources"
  | "review-route-conflicts"
  | "review-endpoint-demand"
  | "review-capacity-policy"
  | "reuse-existing-network";

export type NetworkPolicyDiagnosticRecovery = {
  mode: "report-only";
  status: "clear" | "blocked";
  categories: NetworkPolicyDiagnosticRecoveryCategory[];
  retainedResourcesPreserved: true;
};

export type NetworkPolicyDiagnostics = {
  policy: {
    status: NetworkPolicyDiagnosticPolicyStatus;
    requestedPrefixLength: NetworkCapacityPrefixLength;
  };
  evidence: {
    inventory: NetworkCapacityEvidenceStatus;
    routes: NetworkCapacityEvidenceStatus;
    claims: NetworkCapacityEvidenceStatus;
  };
  claims: NetworkPolicyDiagnosticClaimSummary;
  daemonDefaultCapacity: NetworkPolicyDiagnosticCapacity;
  configuredPolicyCapacity: NetworkPolicyDiagnosticCapacity;
  recovery: NetworkPolicyDiagnosticRecovery;
};

type ClaimAssessment = {
  status: NetworkCapacityEvidenceStatus;
  claims: NetworkClaim[];
  summary: NetworkPolicyDiagnosticClaimSummary;
};

type PolicyAssessment = {
  status: NetworkPolicyDiagnosticPolicyStatus;
  policy?: NetworkPolicy;
};

/** Classify supplied evidence without reading or changing machine/provider state. */
export function diagnoseNetworkPolicy(
  input: NetworkPolicyDiagnosticInput,
): NetworkPolicyDiagnostics {
  const prefixLength = input.prefixLength ?? DEFAULT_POLICY_PREFIX;
  const claims = assessClaims(input.claims, input.inventory.daemonId);
  const policy = assessPolicy(input.policy, input.inventory.daemonId);
  const defaultCapacity = summarize(
    collectCapacityReport({
      inventory: input.inventory,
      routes: input.routes,
      claims: claims.claims,
      endpointDemand: input.endpointDemand,
    }),
    claims,
    input.inventory.networks.length,
  );
  const configuredCapacity = configuredSummary(
    input.inventory,
    input.routes,
    claims,
    policy,
    prefixLength,
    input.endpointDemand,
  );

  return {
    policy: { status: policy.status, requestedPrefixLength: prefixLength },
    evidence: {
      inventory: input.inventory.status,
      routes: input.routes.status,
      claims: claims.status,
    },
    claims: claims.summary,
    daemonDefaultCapacity: defaultCapacity,
    configuredPolicyCapacity: configuredCapacity,
    recovery: buildRecovery(policy, defaultCapacity, configuredCapacity, claims),
  };
}

function configuredSummary(
  inventory: NetworkCapacityInventory,
  routes: NetworkCapacityRouteInventory,
  claims: ClaimAssessment,
  policy: PolicyAssessment,
  prefixLength: NetworkCapacityPrefixLength,
  endpointDemand: number | null | undefined,
): NetworkPolicyDiagnosticCapacity {
  if (policy.status === "absent") return blocked(prefixLength, "policy-absent", "not-configured");
  if (policy.status === "invalid") return blocked(prefixLength, "policy-invalid");
  if (policy.status === "unknown") return blocked(prefixLength, "inventory-unknown");
  if (policy.status === "mismatched" || !policy.policy) {
    return blocked(prefixLength, "policy-daemon-mismatch");
  }
  if (!policy.policy.allowedPrefixes.includes(prefixLength)) {
    return blocked(prefixLength, "prefix-not-permitted");
  }

  return summarize(
    collectCapacityReport({
      inventory,
      routes,
      claims: claims.claims,
      pools: policy.policy.pools.map((base) => ({ base, size: prefixLength })),
      exclusions: policy.policy.exclusions,
      prefixLength,
      endpointDemand,
      endpointReserve: policy.policy.endpointReserve,
    }),
    claims,
    inventory.networks.length,
  );
}

function assessPolicy(evidence: NetworkPolicyReadResult, daemonId: string): PolicyAssessment {
  if (evidence.status === "absent") return { status: "absent" };
  if (evidence.status === "invalid") return { status: "invalid" };
  if (!daemonId) return { status: "unknown", policy: evidence.policy };
  return evidence.policy.daemonId === daemonId
    ? { status: "valid", policy: evidence.policy }
    : { status: "mismatched", policy: evidence.policy };
}

function assessClaims(claims: readonly NetworkClaim[] | null, daemonId: string): ClaimAssessment {
  if (!isClaimArray(claims) || claims.length > MAX_CLAIMS || !daemonId) return unknownClaims();

  const counts = { reserved: 0, attached: 0, uncertain: 0 };
  const validClaims: NetworkClaim[] = [];
  const subnets = new Set<string>();
  for (const claim of claims) {
    if (
      claim.daemonId !== daemonId ||
      !isClaimState(claim.state) ||
      !isCanonicalClaimSubnet(claim.subnet) ||
      subnets.has(claim.subnet)
    ) {
      return unknownClaims();
    }
    counts[claim.state as keyof typeof counts] += 1;
    subnets.add(claim.subnet);
    validClaims.push(claim);
  }
  return {
    status: "complete",
    claims: validClaims,
    summary: {
      status: "complete",
      total: claims.length,
      reserved: counts.reserved,
      attached: counts.attached,
      uncertain: counts.uncertain,
      blocksSubtracted: claims.length,
    },
  };
}

function isClaimArray(value: readonly NetworkClaim[] | null): value is readonly NetworkClaim[] {
  return Array.isArray(value);
}

function unknownClaims(): ClaimAssessment {
  return {
    status: "unknown",
    claims: [],
    summary: {
      status: "unknown",
      total: "unknown",
      reserved: "unknown",
      attached: "unknown",
      uncertain: "unknown",
      blocksSubtracted: "unknown",
    },
  };
}

function isClaimState(value: NetworkClaim["state"]): value is NetworkClaim["state"] {
  return value === "reserved" || value === "attached" || value === "uncertain";
}

function collectCapacityReport(options: {
  inventory: NetworkCapacityInventory;
  routes: NetworkCapacityRouteInventory;
  claims: readonly NetworkClaim[];
  pools?: Array<{ base: string; size: number }>;
  exclusions?: readonly string[];
  prefixLength?: NetworkCapacityPrefixLength;
  endpointDemand?: number | null;
  endpointReserve?: number;
}): NetworkCapacityReport {
  const syntheticNetworks: NetworkCapacityNetwork[] = [
    ...options.claims.map((claim, index) => syntheticNetwork("claim", index, claim.subnet)),
    ...(options.exclusions ?? []).map((subnet, index) =>
      syntheticNetwork("exclusion", index, subnet),
    ),
  ];
  return collectNetworkCapacityReport(
    {
      endpoint: options.inventory.endpoint,
      daemonId: options.inventory.daemonId,
      ...(options.prefixLength === undefined ? {} : { prefixLength: options.prefixLength }),
      endpointDemand: options.endpointDemand,
      endpointReserve: options.endpointReserve,
      routes: options.routes,
    },
    {
      collectInventory: () => ({
        ...options.inventory,
        pools: options.pools ?? options.inventory.pools,
        networks: [...options.inventory.networks, ...syntheticNetworks],
      }),
    },
  );
}

function syntheticNetwork(kind: string, index: number, subnet: string): NetworkCapacityNetwork {
  return {
    id: `diagnostic-${kind}-${index}`,
    name: `diagnostic-${kind}`,
    driver: "bridge",
    subnets: [subnet],
    activeEndpoints: 0,
    retainedContainerIds: [],
  };
}

function summarize(
  report: NetworkCapacityReport,
  claims: ClaimAssessment,
  observedNetworkCount: number,
): NetworkPolicyDiagnosticCapacity {
  const complete =
    report.evidence.inventory === "complete" &&
    report.evidence.containers === "complete" &&
    report.evidence.routes === "complete" &&
    claims.status === "complete";
  const candidateCounts = complete ? countCandidates(report) : unknownCandidates();
  const retainedReferences = complete ? retainedReferenceCount(report) : "unknown";
  return {
    status: complete ? report.allocation.status : "unknown",
    prefixLength: complete ? report.endpointCapacity.prefixLength : "unknown",
    freeBlocks: complete ? report.allocation.freeBlockCount : "unknown",
    candidateBlocks: complete
      ? report.pools.reduce((n, p) => n + p.candidates.length, 0)
      : "unknown",
    candidateCounts,
    endpoint: complete
      ? {
          status: report.endpointCapacity.status,
          available: report.endpointCapacity.availableEndpoints,
          demand: report.endpointCapacity.demand,
          reserve: report.endpointCapacity.reserve,
        }
      : { status: "unknown", available: "unknown", demand: "unknown", reserve: "unknown" },
    occupiedNetworks: complete ? observedNetworkCount : "unknown",
    retainedNetworks: complete ? retainedNetworkCount(report) : "unknown",
    retainedReferences,
    claimBlocksSubtracted: claims.status === "complete" ? claims.claims.length : "unknown",
    blockers: capacityBlockers(report, candidateCounts, complete),
  };
}

function blocked(
  prefixLength: NetworkCapacityPrefixLength,
  blocker: NetworkPolicyDiagnosticBlocker,
  status: "blocked" | "not-configured" = "blocked",
): NetworkPolicyDiagnosticCapacity {
  return {
    status,
    prefixLength,
    freeBlocks: "unknown",
    candidateBlocks: "unknown",
    candidateCounts: unknownCandidates(),
    endpoint: { status: "unknown", available: "unknown", demand: "unknown", reserve: "unknown" },
    occupiedNetworks: "unknown",
    retainedNetworks: "unknown",
    retainedReferences: "unknown",
    claimBlocksSubtracted: "unknown",
    blockers: [blocker],
  };
}

function capacityBlockers(
  report: NetworkCapacityReport,
  candidates: NetworkPolicyDiagnosticCandidateCounts,
  complete: boolean,
): NetworkPolicyDiagnosticBlocker[] {
  const blockers: NetworkPolicyDiagnosticBlocker[] = [];
  if (report.evidence.inventory !== "complete" || report.evidence.containers !== "complete") {
    blockers.push("inventory-unknown");
  }
  if (report.evidence.routes !== "complete") blockers.push("routes-unknown");
  if (!complete) blockers.push("claims-unknown");
  if (candidates.routeConflict === "unknown" || candidates.routeConflict > 0) {
    if (candidates.routeConflict !== 0) blockers.push("route-conflict");
  }
  if (candidates.endpointInsufficient === "unknown" || candidates.endpointInsufficient > 0) {
    if (candidates.endpointInsufficient !== 0) blockers.push("endpoint-insufficient");
  }
  if (complete && report.allocation.status === "exhausted") blockers.push("capacity-exhausted");
  const retainedReferences = complete ? retainedReferenceCount(report) : "unknown";
  if (typeof retainedReferences === "number" && retainedReferences > 0) {
    blockers.push("retained-resources");
  }
  return [...new Set(blockers)];
}

function buildRecovery(
  policy: PolicyAssessment,
  daemonDefault: NetworkPolicyDiagnosticCapacity,
  configured: NetworkPolicyDiagnosticCapacity,
  claims: ClaimAssessment,
): NetworkPolicyDiagnosticRecovery {
  const categories: NetworkPolicyDiagnosticRecoveryCategory[] = [];
  const capacities = [daemonDefault, configured];
  const add = (category: NetworkPolicyDiagnosticRecoveryCategory) => {
    if (!categories.includes(category)) categories.push(category);
  };
  if (capacities.some((capacity) => capacity.blockers.includes("inventory-unknown"))) {
    add("collect-complete-network-inventory");
  }
  if (capacities.some((capacity) => capacity.blockers.includes("routes-unknown"))) {
    add("collect-complete-route-evidence");
  }
  if (claims.status !== "complete") add("review-unresolved-claims");
  if (policy.status === "invalid") add("repair-policy");
  if (policy.status === "mismatched") add("align-policy-with-daemon");
  if (capacities.some((capacity) => capacity.blockers.includes("route-conflict"))) {
    add("review-route-conflicts");
  }
  if (capacities.some((capacity) => capacity.blockers.includes("endpoint-insufficient"))) {
    add("review-endpoint-demand");
  }
  if (
    capacities.some(
      (capacity) =>
        capacity.status === "exhausted" ||
        capacity.status === "unknown" ||
        capacity.blockers.includes("prefix-not-permitted"),
    )
  ) {
    add("review-capacity-policy");
  }
  if (
    claims.summary.total !== 0 ||
    capacities.some(
      (capacity) =>
        typeof capacity.retainedReferences === "number" && capacity.retainedReferences > 0,
    )
  ) {
    add("preserve-retained-resources");
  }
  if (capacities.some((capacity) => capacity.status === "exhausted")) {
    add("reuse-existing-network");
  }
  if (categories.length === 0) add("no-action");
  return {
    mode: "report-only",
    status: categories.length === 1 && categories[0] === "no-action" ? "clear" : "blocked",
    categories,
    retainedResourcesPreserved: true,
  };
}

function countCandidates(report: NetworkCapacityReport): NetworkPolicyDiagnosticCandidateCounts {
  const counts = { free: 0, occupied: 0, routeConflict: 0, endpointInsufficient: 0, unknown: 0 };
  for (const candidate of report.pools.flatMap((pool) => pool.candidates)) {
    switch (candidate.status) {
      case "free":
        counts.free += 1;
        break;
      case "occupied":
        counts.occupied += 1;
        break;
      case "route-conflict":
        counts.routeConflict += 1;
        break;
      case "endpoint-insufficient":
        counts.endpointInsufficient += 1;
        break;
      case "unknown":
        counts.unknown += 1;
        break;
    }
  }
  return counts;
}

function unknownCandidates(): NetworkPolicyDiagnosticCandidateCounts {
  return {
    free: "unknown",
    occupied: "unknown",
    routeConflict: "unknown",
    endpointInsufficient: "unknown",
    unknown: "unknown",
  };
}

function retainedReferenceCount(report: NetworkCapacityReport): number | "unknown" {
  let total = 0;
  for (const network of report.networks) {
    if (network.retainedReferences === "unknown") return "unknown";
    total += network.retainedReferences;
  }
  return total;
}

function retainedNetworkCount(report: NetworkCapacityReport): number | "unknown" {
  let total = 0;
  for (const network of report.networks) {
    if (network.retainedReferences === "unknown") return "unknown";
    if (network.retainedReferences > 0) total += 1;
  }
  return total;
}

function isCanonicalClaimSubnet(subnet: string): boolean {
  const prefix = subnet?.slice(subnet.lastIndexOf("/") + 1);
  return (
    (prefix === "24" || prefix === "25" || prefix === "26") && parseIPv4Cidr(subnet) === subnet
  );
}
