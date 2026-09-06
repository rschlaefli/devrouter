import {
  assertReliabilityState,
  isReliabilityCounter,
  isReliabilityId,
  RELIABILITY_MAX_OUTPUT_BYTES,
  type ReliabilityObservation,
  type ReliabilityState,
  reliabilityFence,
} from "./reliability-contract";

export type ReliabilitySummary =
  | "STARTING"
  | "READY"
  | "RECOVERING"
  | "WAITING_CAPACITY"
  | "PARKED_CAPACITY"
  | "APP_ERROR"
  | "BLOCKED"
  | "STOPPED"
  | "UNKNOWN";

function fresh(observation: ReliabilityObservation, nowMs: number): boolean {
  return (
    observation.observedAtMs <= nowMs && nowMs - observation.observedAtMs < observation.validForMs
  );
}

export function projectReliability(state: ReliabilityState, consumerId: string, nowMs: number) {
  assertReliabilityState(state);
  if (!isReliabilityId(consumerId) || !isReliabilityCounter(nowMs))
    throw new Error("Invalid reliability projection request.");
  const consumer = state.consumers.find((entry) => entry.id === consumerId);
  const required = consumer?.requiredCapabilities ?? [];
  const completeStop =
    state.stopProof.workloadsStopped && state.stopProof.routesRemoved && !state.chargeHeld;
  const observations = required.map((capability) =>
    state.observations.find((entry) => entry.capability === capability),
  );
  let summary: ReliabilitySummary;
  if (!consumer) summary = "BLOCKED";
  else if (state.desired === "stopped-by-user") summary = completeStop ? "STOPPED" : "UNKNOWN";
  else if (state.desired === "parked-for-capacity")
    summary = completeStop ? "PARKED_CAPACITY" : "BLOCKED";
  else if (
    state.operation?.status === "COMPLETION_UNKNOWN" ||
    state.operation?.status === "INTERRUPTED"
  )
    summary = "BLOCKED";
  else if (state.admission === "denied-unadmittable") summary = "BLOCKED";
  else if (state.admission === "waiting") summary = "WAITING_CAPACITY";
  else if (state.admission === "unknown") summary = "UNKNOWN";
  else if (state.phase === "recovering") summary = "RECOVERING";
  else if (
    observations.some((entry) => entry && fresh(entry, nowMs) && entry.infrastructure === "failed")
  )
    summary = "BLOCKED";
  else if (
    observations.some(
      (entry) =>
        entry &&
        fresh(entry, nowMs) &&
        entry.infrastructure === "healthy" &&
        entry.application === "unready",
    )
  )
    summary = "APP_ERROR";
  else if (state.phase === "queued" || state.phase === "starting" || state.phase === "verifying")
    summary = "STARTING";
  else if (
    state.phase !== "stable" ||
    required.length === 0 ||
    observations.some(
      (entry) => !entry || !fresh(entry, nowMs) || entry.infrastructure === "unknown",
    )
  )
    summary = "UNKNOWN";
  else if (observations.some((entry) => entry?.application !== "verified")) summary = "UNKNOWN";
  else summary = "READY";

  return {
    contractVersion: 1 as const,
    ...reliabilityFence(state),
    consumerId,
    state: summary,
    desired: state.desired,
    phase: state.phase,
    admission: state.admission,
    chargeHeld: state.chargeHeld,
    requiredCapabilities: [...required],
    observedAtMs: nowMs,
    capabilities: state.observations.map((entry) => ({
      capability: entry.capability,
      infrastructure: entry.infrastructure,
      application: entry.application,
      observedAtMs: entry.observedAtMs,
      validForMs: entry.validForMs,
      fresh: fresh(entry, nowMs),
      required: required.includes(entry.capability),
    })),
    operation: state.operation
      ? {
          id: state.operation.id,
          status: state.operation.status,
          exitCode: state.operation.exitCode,
        }
      : null,
    incident: state.incident
      ? {
          id: state.incident.id,
          correctiveActionsTaken: state.incident.correctiveActionsTaken,
          actionLimit: state.incident.actionLimit,
        }
      : null,
  };
}

export function encodeReliability(
  state: ReliabilityState,
  consumerId: string,
  nowMs: number,
): string {
  const json = JSON.stringify(projectReliability(state, consumerId, nowMs));
  if (Buffer.byteLength(json, "utf8") > RELIABILITY_MAX_OUTPUT_BYTES)
    throw new Error("Reliability output exceeds the byte limit.");
  return json;
}
