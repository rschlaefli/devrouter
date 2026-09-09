import type { DiagnosticCheck } from "../types";
import { collectNetworkCapacityReport, type NetworkCapacityReport } from "./network-capacity";
import { collectDockerNetworkInventory } from "./network-inventory";

/** Report only. Host and guest route qualification is required before allocation. */
export function inspectNetworkCapacity(): NetworkCapacityReport {
  const snapshot = collectDockerNetworkInventory();
  const identity = { endpoint: snapshot.endpoint ?? "", daemonId: snapshot.daemonId ?? "" };
  return collectNetworkCapacityReport(identity, {
    collectInventory: () => ({ ...snapshot, ...identity }),
  });
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

export function networkCapacityCheck(report: NetworkCapacityReport): DiagnosticCheck {
  const exhausted = hasExhaustedDockerPools(report);
  const retained = report.networks.filter(
    (network) =>
      network.activeEndpoints === 0 &&
      typeof network.retainedReferences === "number" &&
      network.retainedReferences > 0,
  ).length;
  return {
    id: "global.network-capacity",
    level: "warn",
    summary: exhausted
      ? "Docker default address pools are exhausted for new networks."
      : "Network allocation readiness requires complete route and capacity evidence.",
    details: `${report.pools.length} pool(s); ${retained} network(s) have no active endpoints but retain container references. Allocation readiness: ${report.allocation.status}.`,
    suggestion: exhausted
      ? "Existing network reuse can continue. Review operator-approved route-safe pools or exact ownership-aware recovery. Stop and worktree removal do not release subnets; do not prune automatically."
      : "Review complete Docker, LAN, VPN and guest route evidence before allocating a new subnet. Unknown evidence does not authorize cleanup.",
  };
}
