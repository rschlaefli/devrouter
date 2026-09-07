export const RELIABILITY_CONTRACT_VERSION = 2;
export const RELIABILITY_MAX_ITEMS = 128;
export const RELIABILITY_MAX_OUTPUT_BYTES = 32_768;

export type ReliabilityFence = {
  environmentId: string;
  intentRevision: number;
  runtimeGeneration: number;
  controllerEpoch: number;
};

export type ReliabilityConsumer = {
  id: string;
  requiredCapabilities: string[];
  pinned: boolean;
};

export type ReliabilityObservation = {
  capability: string;
  infrastructure: "healthy" | "failed" | "unknown";
  application: "verified" | "unready" | "unverified";
  observedAtMs: number;
  validForMs: number;
};

export type ReliabilityOperation = {
  id: string;
  kind: "ensure" | "exec";
  drained: boolean;
  status:
    | "NOT_STARTED"
    | "DISPATCH_PENDING"
    | "DISPATCH_RECORDED"
    | "RUNNING"
    | "COMPLETED"
    | "INTERRUPTED"
    | "COMPLETION_UNKNOWN";
  exitCode: number | null;
};

export type ReliabilityIncident = {
  id: string;
  correctiveActionsTaken: number;
  actionLimit: number;
};

export type ReliabilityState = ReliabilityFence & {
  contractVersion: 2;
  executionPolicy: "manual" | "capacity-managed";
  operationHistory: (ReliabilityOperation & {
    key: string;
    profile: string;
    consumer: ReliabilityConsumer;
  })[];
  observationsAfterMs: number;
  desired: "running" | "parked-for-capacity" | "stopped-by-user";
  phase: "idle" | "queued" | "starting" | "verifying" | "stable" | "recovering" | "stopping";
  profile: string | null;
  admission: "admitted" | "waiting" | "unknown" | "denied-unadmittable" | "not-applicable";
  chargeHeld: boolean;
  stopProof: { workloadsStopped: boolean; routesRemoved: boolean };
  consumers: ReliabilityConsumer[];
  requests: {
    key: string;
    mode: "start" | "attach";
    consumerId: string;
    operationId: string;
    profile: string;
    intentRevision: number;
  }[];
  observations: ReliabilityObservation[];
  operation: ReliabilityOperation | null;
  incident: ReliabilityIncident | null;
};

// Every effect is a request for an adapter, never authority to perform a mutation.
export type ReliabilityEffect = ReliabilityFence & {
  kind: "request-admission" | "persist-dispatch" | "launch" | "stop" | "reconcile";
  operationId: string | null;
};

export type ReliabilityEvent = ReliabilityFence &
  (
    | {
        type: "request";
        mode: "start" | "attach";
        key: string;
        operationId: string;
        profile: string;
        consumer: ReliabilityConsumer;
      }
    | {
        type: "operation-request";
        kind: "ensure" | "exec";
        key: string;
        operationId: string;
        profile: string;
        consumer: ReliabilityConsumer;
        runtimeRunning: boolean;
      }
    | { type: "drained"; operationId: string }
    | { type: "release"; consumerId: string }
    | { type: "stop" }
    | { type: "park" }
    | { type: "admission"; result: ReliabilityState["admission"] }
    | { type: "resume"; pressureDwellSatisfied: boolean; operationId: string }
    | { type: "dispatch" }
    | { type: "dispatch-persisted"; operationId: string }
    | { type: "launched"; operationId: string }
    | { type: "completion"; operationId: string; exitCode: number }
    | { type: "interrupted"; operationId: string }
    | { type: "observation"; observation: ReliabilityObservation }
    | { type: "stop-proof"; workloadsStopped: boolean; routesRemoved: boolean }
    | { type: "epoch"; nextEpoch: number }
    | { type: "runtime"; nextGeneration: number }
    | { type: "recover"; incidentId: string; actionLimit: number; operationId: string }
    | { type: "rearm"; incidentId: string }
  );

export type ReliabilityTransition = {
  state: ReliabilityState;
  effects: ReliabilityEffect[];
  outcome: "accepted" | "joined" | "stale" | "blocked" | "conflict";
};

export function isReliabilityId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

export function isReliabilityCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}

function boundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= RELIABILITY_MAX_ITEMS;
}

function uniqueIds(values: unknown[], key: string): boolean {
  return (
    values.every((value) => record(value) && isReliabilityId(value[key])) &&
    new Set(values.map((value) => (value as Record<string, unknown>)[key])).size === values.length
  );
}

function validOperation(value: unknown): boolean {
  return (
    record(value) &&
    isReliabilityId(value.id) &&
    oneOf(value.kind, ["ensure", "exec"]) &&
    typeof value.drained === "boolean" &&
    oneOf(value.status, [
      "NOT_STARTED",
      "DISPATCH_PENDING",
      "DISPATCH_RECORDED",
      "RUNNING",
      "COMPLETED",
      "INTERRUPTED",
      "COMPLETION_UNKNOWN",
    ]) &&
    (value.status === "COMPLETED" ? isReliabilityCounter(value.exitCode) : value.exitCode === null)
  );
}

export function assertReliabilityState(value: unknown): asserts value is ReliabilityState {
  const intentRevision = record(value) ? value.intentRevision : undefined;
  const valid =
    record(value) &&
    value.contractVersion === RELIABILITY_CONTRACT_VERSION &&
    oneOf(value.executionPolicy, ["manual", "capacity-managed"]) &&
    (value.executionPolicy === "manual"
      ? value.admission === "not-applicable" && value.chargeHeld === false
      : value.admission !== "not-applicable") &&
    boundedArray(value.operationHistory) &&
    uniqueIds(value.operationHistory, "key") &&
    uniqueIds(value.operationHistory, "id") &&
    value.operationHistory.every(
      (entry) =>
        record(entry) &&
        isReliabilityId(entry.profile) &&
        record(entry.consumer) &&
        isReliabilityId(entry.consumer.id) &&
        typeof entry.consumer.pinned === "boolean" &&
        boundedArray(entry.consumer.requiredCapabilities) &&
        entry.consumer.requiredCapabilities.every(isReliabilityId) &&
        new Set(entry.consumer.requiredCapabilities).size ===
          entry.consumer.requiredCapabilities.length &&
        validOperation(entry),
    ) &&
    isReliabilityCounter(value.observationsAfterMs) &&
    isReliabilityId(value.environmentId) &&
    isReliabilityCounter(value.intentRevision) &&
    isReliabilityCounter(value.runtimeGeneration) &&
    isReliabilityCounter(value.controllerEpoch) &&
    oneOf(value.desired, ["running", "parked-for-capacity", "stopped-by-user"]) &&
    oneOf(value.phase, [
      "idle",
      "queued",
      "starting",
      "verifying",
      "stable",
      "recovering",
      "stopping",
    ]) &&
    (value.profile === null || isReliabilityId(value.profile)) &&
    oneOf(value.admission, [
      "admitted",
      "waiting",
      "unknown",
      "denied-unadmittable",
      "not-applicable",
    ]) &&
    typeof value.chargeHeld === "boolean" &&
    record(value.stopProof) &&
    typeof value.stopProof.workloadsStopped === "boolean" &&
    typeof value.stopProof.routesRemoved === "boolean" &&
    boundedArray(value.consumers) &&
    uniqueIds(value.consumers, "id") &&
    value.consumers.every(
      (consumer) =>
        record(consumer) &&
        typeof consumer.pinned === "boolean" &&
        boundedArray(consumer.requiredCapabilities) &&
        consumer.requiredCapabilities.every(isReliabilityId) &&
        new Set(consumer.requiredCapabilities).size === consumer.requiredCapabilities.length,
    ) &&
    boundedArray(value.requests) &&
    uniqueIds(value.requests, "key") &&
    value.requests.every(
      (request) =>
        record(request) &&
        oneOf(request.mode, ["start", "attach"]) &&
        isReliabilityId(request.consumerId) &&
        isReliabilityId(request.operationId) &&
        isReliabilityId(request.profile) &&
        isReliabilityCounter(request.intentRevision) &&
        isReliabilityCounter(intentRevision) &&
        request.intentRevision <= intentRevision,
    ) &&
    boundedArray(value.observations) &&
    uniqueIds(value.observations, "capability") &&
    value.observations.every(
      (observation) =>
        record(observation) &&
        oneOf(observation.infrastructure, ["healthy", "failed", "unknown"]) &&
        oneOf(observation.application, ["verified", "unready", "unverified"]) &&
        isReliabilityCounter(observation.observedAtMs) &&
        isReliabilityCounter(observation.validForMs),
    ) &&
    (value.operation === null || validOperation(value.operation)) &&
    (value.executionPolicy !== "manual" ||
      (value.desired !== "parked-for-capacity" && value.incident === null)) &&
    (value.incident === null ||
      (record(value.incident) &&
        isReliabilityId(value.incident.id) &&
        isReliabilityCounter(value.incident.correctiveActionsTaken) &&
        isReliabilityCounter(value.incident.actionLimit) &&
        value.incident.actionLimit > 0 &&
        value.incident.correctiveActionsTaken <= value.incident.actionLimit));
  if (!valid) throw new Error("Invalid reliability state.");
}

export function createReliabilityState(
  environmentId: string,
  controllerEpoch: number,
  executionPolicy: ReliabilityState["executionPolicy"] = "capacity-managed",
): ReliabilityState {
  const state: ReliabilityState = {
    contractVersion: RELIABILITY_CONTRACT_VERSION,
    executionPolicy,
    operationHistory: [],
    environmentId,
    controllerEpoch,
    intentRevision: 0,
    runtimeGeneration: 0,
    observationsAfterMs: 0,
    desired: "stopped-by-user",
    phase: "idle",
    profile: null,
    admission: executionPolicy === "manual" ? "not-applicable" : "unknown",
    chargeHeld: false,
    stopProof: { workloadsStopped: false, routesRemoved: false },
    consumers: [],
    requests: [],
    observations: [],
    operation: null,
    incident: null,
  };
  assertReliabilityState(state);
  return state;
}

export function reliabilityFence(state: ReliabilityFence): ReliabilityFence {
  return {
    environmentId: state.environmentId,
    intentRevision: state.intentRevision,
    runtimeGeneration: state.runtimeGeneration,
    controllerEpoch: state.controllerEpoch,
  };
}
