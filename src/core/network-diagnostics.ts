import type { DiagnosticCheck } from "../types";
import { collectNetworkCapacityReport, type NetworkCapacityReport } from "./network-capacity";
import { type NetworkClaim, readNetworkClaims } from "./network-claims";
import { collectDockerNetworkInventory } from "./network-inventory";
import { readNetworkPolicy } from "./network-policy";
import { diagnoseNetworkPolicy, type NetworkPolicyDiagnostics } from "./network-policy-diagnostics";
import { collectNetworkRoutes } from "./network-routes";

export type NetworkCapacityInspection = NetworkCapacityReport & {
  managedPolicy?: NetworkPolicyDiagnostics;
};

/** Report only. Host and guest route qualification is required before allocation. */
export function inspectNetworkCapacity(): NetworkCapacityInspection {
  const snapshot = collectDockerNetworkInventory();
  const identity = { endpoint: snapshot.endpoint ?? "", daemonId: snapshot.daemonId ?? "" };
  const report = collectNetworkCapacityReport(identity, {
    collectInventory: () => ({ ...snapshot, ...identity }),
  });
  let claims: NetworkClaim[] | null = null;
  try {
    if (snapshot.daemonId) claims = readNetworkClaims({ daemonId: snapshot.daemonId });
  } catch {
    // An unreadable claim store cannot be represented as zero reservations.
  }
  return {
    ...report,
    managedPolicy: diagnoseNetworkPolicy({
      policy: readNetworkPolicy(),
      inventory: { ...snapshot, ...identity },
      claims,
      routes: collectNetworkRoutes({ endpoint: identity.endpoint }),
    }),
  };
}

export function hasExhaustedDockerPools(report: NetworkCapacityReport): boolean {
  const candidates = report.pools.flatMap((pool) => pool.candidates);
  return (
    report.evidence.inventory === "complete" &&
    report.pools.length > 0 &&
    report.pools.every((pool) => pool.candidates.length > 0) &&
    candidates.every((candidate) => candidate.status === "occupied")
  );
}

export function networkCapacityCheck(report: NetworkCapacityInspection): DiagnosticCheck {
  const exhausted = hasExhaustedDockerPools(report);
  const retained = report.networks.filter(
    (network) =>
      network.activeEndpoints === 0 &&
      typeof network.retainedReferences === "number" &&
      network.retainedReferences > 0,
  ).length;
  const managed = report.managedPolicy;
  const managedDetails = managed
    ? ` Managed policy: ${managed.policy.status}; /${managed.policy.requestedPrefixLength} capacity: ${managed.configuredPolicyCapacity.status}; claims: ${managed.claims.reserved} reserved, ${managed.claims.attached} attached, ${managed.claims.uncertain} uncertain.`
    : "";
  return {
    id: "global.network-capacity",
    level: "warn",
    summary: exhausted
      ? "Docker default address pools are exhausted for new networks."
      : "Network allocation readiness requires complete route and capacity evidence.",
    details: `${report.pools.length} pool(s); ${retained} network(s) have no active endpoints but retain container references. Allocation readiness: ${report.allocation.status}.${managedDetails}`,
    suggestion: exhausted
      ? "Existing network reuse can continue. Review operator-approved route-safe pools or exact ownership-aware recovery. Stop and worktree removal do not release subnets; do not prune automatically."
      : "Review complete Docker, LAN, VPN and guest route evidence before allocating a new subnet. Unknown evidence does not authorize cleanup.",
  };
}
