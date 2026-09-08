import type { CapacityEstimates } from "../types";
import type { CapacityCharge } from "./capacity-accounting";
import type { CapacityPolicyEnrollment } from "./capacity-policy";
export type CapacityAdmissionContext = {
  estimates: CapacityEstimates;
  enrollment: CapacityPolicyEnrollment;
};

import { capacityEstimatesDigest } from "./repo-config";

function sum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total))
    throw new Error("Capacity requirement exceeds safe byte range.");
  return total;
}

/** Resolve the reviewed steady allocation; callers must independently prove settlement. */
export function capacitySteadyCharge(
  estimates: CapacityEstimates,
  enrollment: CapacityPolicyEnrollment,
  request: { environmentId: string; profile: string },
): CapacityCharge {
  if (capacityEstimatesDigest(estimates) !== enrollment.estimatesDigest)
    throw new Error("Capacity estimates changed since enrollment.");
  const profile = estimates.profiles[request.profile];
  if (!enrollment.profiles.includes(request.profile) || !profile)
    throw new Error("Steady capacity profile is not enrolled.");
  return {
    environmentId: request.environmentId,
    totals: {
      [enrollment.hostDomain]: profile.host.steadyBytes,
      [enrollment.runtimeDomain]: profile.runtime.steadyBytes,
    },
    startup: false,
    heavy: false,
  };
}

/** Resolve reviewed totals; this grants neither enrollment nor launch authority. */
export function capacityRequest(
  estimates: CapacityEstimates,
  enrollment: CapacityPolicyEnrollment,
  request: {
    environmentId: string;
    profile: string;
    activeProfile?: string;
    kind: "ensure" | "exec";
    operation?: string;
  },
): CapacityCharge {
  if (capacityEstimatesDigest(estimates) !== enrollment.estimatesDigest)
    throw new Error("Capacity estimates changed since enrollment.");
  for (const name of enrollment.profiles) {
    const profile = estimates.profiles[name];
    if (!profile) throw new Error("Enrolled capacity profile has no reviewed estimate.");
    for (const operation of Object.values(profile.operations)) {
      if (
        operation.hostIncrementBytes > enrollment.defaultOperation.hostIncrementBytes ||
        operation.runtimeIncrementBytes > enrollment.defaultOperation.runtimeIncrementBytes
      )
        throw new Error("Default operation estimate does not cover reviewed named operations.");
    }
  }
  if (!enrollment.profiles.includes(request.profile))
    throw new Error("Requested capacity profile is not enrolled.");
  const profile = estimates.profiles[request.profile];
  let host: number;
  let runtime: number;
  if (request.kind === "exec") {
    if (request.activeProfile !== request.profile)
      throw new Error("Execution requires the active capacity profile.");
    const increment =
      (request.operation && Object.hasOwn(profile.operations, request.operation)
        ? profile.operations[request.operation]
        : undefined) ?? enrollment.defaultOperation;
    host = sum(profile.host.steadyBytes, increment.hostIncrementBytes);
    runtime = sum(profile.runtime.steadyBytes, increment.runtimeIncrementBytes);
  } else if (request.activeProfile && request.activeProfile !== request.profile) {
    const active = estimates.profiles[request.activeProfile];
    if (!active || !enrollment.profiles.includes(request.activeProfile))
      throw new Error("Active capacity profile is not enrolled.");
    const transition = estimates.transitions?.[request.activeProfile]?.[request.profile];
    host =
      transition?.hostTotalBytes ?? sum(active.host.steadyBytes, profile.host.startupTotalBytes);
    runtime =
      transition?.runtimeTotalBytes ??
      sum(active.runtime.steadyBytes, profile.runtime.startupTotalBytes);
  } else {
    host = profile.host.startupTotalBytes;
    runtime = profile.runtime.startupTotalBytes;
  }
  return {
    environmentId: request.environmentId,
    totals: { [enrollment.hostDomain]: host, [enrollment.runtimeDomain]: runtime },
    startup: request.kind === "ensure",
    heavy: request.kind === "exec",
  };
}
