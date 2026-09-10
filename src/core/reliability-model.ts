import {
  assertReliabilityState,
  isReliabilityCounter,
  isReliabilityId,
  isReliabilityProfile,
  RELIABILITY_MAX_ITEMS,
  type ReliabilityConsumer,
  type ReliabilityEffect,
  type ReliabilityEvent,
  type ReliabilityIncident,
  type ReliabilityObservation,
  type ReliabilityOperation,
  type ReliabilityState,
  type ReliabilityTransition,
  reliabilityFence,
} from "./reliability-contract";

const INFRASTRUCTURE_VALUES = ["healthy", "failed", "unknown"] as const;
const APPLICATION_VALUES = ["verified", "unready", "unverified"] as const;
const ADMISSION_VALUES = ["admitted", "waiting", "unknown", "denied-unadmittable"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function uniqueIds(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length && values.every(isReliabilityId);
}

function isFence(value: unknown): boolean {
  return (
    record(value) &&
    isReliabilityId(value.environmentId) &&
    isReliabilityCounter(value.intentRevision) &&
    isReliabilityCounter(value.runtimeGeneration) &&
    isReliabilityCounter(value.controllerEpoch)
  );
}

function isConsumer(value: unknown): value is ReliabilityConsumer {
  return (
    record(value) &&
    isReliabilityId(value.id) &&
    typeof value.pinned === "boolean" &&
    Array.isArray(value.requiredCapabilities) &&
    value.requiredCapabilities.length <= 128 &&
    uniqueIds(value.requiredCapabilities)
  );
}

function isObservation(value: unknown): value is ReliabilityObservation {
  return (
    record(value) &&
    isReliabilityId(value.capability) &&
    oneOf(value.infrastructure, INFRASTRUCTURE_VALUES) &&
    oneOf(value.application, APPLICATION_VALUES) &&
    isReliabilityCounter(value.observedAtMs) &&
    isReliabilityCounter(value.validForMs)
  );
}

function assertReliabilityEvent(value: unknown): asserts value is ReliabilityEvent {
  if (!record(value) || !isFence(value) || typeof value.type !== "string") {
    throw new Error("Invalid reliability event.");
  }

  let valid = false;
  switch (value.type) {
    case "request":
      valid =
        oneOf(value.mode, ["start", "attach"] as const) &&
        isReliabilityId(value.key) &&
        isReliabilityId(value.operationId) &&
        isReliabilityProfile(value.profile) &&
        isConsumer(value.consumer);
      break;
    case "operation-request":
      valid =
        oneOf(value.kind, ["ensure", "exec"] as const) &&
        isReliabilityId(value.key) &&
        isReliabilityId(value.operationId) &&
        isReliabilityProfile(value.profile) &&
        isConsumer(value.consumer) &&
        typeof value.runtimeRunning === "boolean" &&
        (value.recoverInterruptedEnsure === undefined ||
          typeof value.recoverInterruptedEnsure === "boolean");
      break;
    case "drained":
      valid = isReliabilityId(value.operationId);
      break;
    case "release":
      valid = isReliabilityId(value.consumerId);
      break;
    case "stop":
    case "park":
    case "dispatch":
      valid = true;
      break;
    case "admission":
      valid = oneOf(value.result, ADMISSION_VALUES);
      break;
    case "resume":
      valid =
        typeof value.pressureDwellSatisfied === "boolean" && isReliabilityId(value.operationId);
      break;
    case "dispatch-persisted":
    case "launched":
    case "interrupted":
    case "not-started":
    case "settle":
      valid = isReliabilityId(value.operationId);
      break;
    case "completion":
      valid = isReliabilityId(value.operationId) && isReliabilityCounter(value.exitCode);
      break;
    case "observation":
      valid = isObservation(value.observation);
      break;
    case "stop-proof":
      valid =
        typeof value.workloadsStopped === "boolean" && typeof value.routesRemoved === "boolean";
      break;
    case "epoch":
    case "runtime":
      valid = isReliabilityCounter(value.type === "epoch" ? value.nextEpoch : value.nextGeneration);
      break;
    case "recover":
      valid =
        isReliabilityId(value.incidentId) &&
        isReliabilityCounter(value.actionLimit) &&
        value.actionLimit > 0 &&
        isReliabilityId(value.operationId);
      break;
    case "rearm":
      valid = isReliabilityId(value.incidentId);
      break;
    default:
      valid = false;
  }

  if (!valid) throw new Error("Invalid reliability event.");
}

function cloneConsumer(consumer: ReliabilityConsumer): ReliabilityConsumer {
  return { ...consumer, requiredCapabilities: [...consumer.requiredCapabilities] };
}

function cloneObservation(observation: ReliabilityObservation): ReliabilityObservation {
  return { ...observation };
}

function cloneOperation(operation: ReliabilityOperation): ReliabilityOperation {
  return { ...operation };
}

function cloneIncident(incident: ReliabilityIncident): ReliabilityIncident {
  return { ...incident };
}

function cloneState(state: ReliabilityState): ReliabilityState {
  return {
    ...state,
    stopProof: { ...state.stopProof },
    operationHistory: state.operationHistory.map((entry) => ({
      ...entry,
      consumer: cloneConsumer(entry.consumer),
    })),
    consumers: state.consumers.map(cloneConsumer),
    requests: state.requests.map((request) => ({ ...request })),
    observations: state.observations.map(cloneObservation),
    operation: state.operation ? cloneOperation(state.operation) : null,
    incident: state.incident ? cloneIncident(state.incident) : null,
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameConsumer(left: ReliabilityConsumer, right: ReliabilityConsumer): boolean {
  return (
    left.id === right.id &&
    left.pinned === right.pinned &&
    sameSet(left.requiredCapabilities, right.requiredCapabilities)
  );
}

function sameFence(left: ReliabilityState, right: ReliabilityEvent): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.intentRevision === right.intentRevision &&
    left.runtimeGeneration === right.runtimeGeneration &&
    left.controllerEpoch === right.controllerEpoch
  );
}

function effect(
  state: ReliabilityState,
  kind: ReliabilityEffect["kind"],
  operationId: string | null,
): ReliabilityEffect {
  return { ...reliabilityFence(state), kind, operationId };
}

function transition(
  state: ReliabilityState,
  outcome: ReliabilityTransition["outcome"],
  effects: ReliabilityEffect[] = [],
): ReliabilityTransition {
  assertReliabilityState(state);
  return { state, effects, outcome };
}

function unchanged(
  state: ReliabilityState,
  outcome: ReliabilityTransition["outcome"],
  reason?: string,
): ReliabilityTransition {
  const result = transition(cloneState(state), outcome);
  if (reason) result.reason = reason;
  return result;
}

function blocked(state: ReliabilityState, reason: string): ReliabilityTransition {
  return unchanged(state, "blocked", reason);
}

function advance(value: number): number | null {
  return value === Number.MAX_SAFE_INTEGER ? null : value + 1;
}

function possibleDispatch(operation: ReliabilityOperation | null): boolean {
  return (
    operation !== null &&
    ["DISPATCH_PENDING", "DISPATCH_RECORDED", "RUNNING", "COMPLETION_UNKNOWN"].includes(
      operation.status,
    )
  );
}

function pendingCommand(operation: ReliabilityOperation | null): boolean {
  return (
    operation !== null && !["COMPLETED", "NOT_LAUNCHED", "INTERRUPTED"].includes(operation.status)
  );
}

function setUnknown(operation: ReliabilityOperation | null): ReliabilityOperation | null {
  if (!operation || !possibleDispatch(operation)) return operation;
  return { ...operation, status: "COMPLETION_UNKNOWN", exitCode: null };
}

function updateRunningPhase(state: ReliabilityState): void {
  if (
    state.desired !== "running" ||
    state.phase === "recovering" ||
    (state.operation !== null && !["COMPLETED", "NOT_LAUNCHED"].includes(state.operation.status))
  ) {
    return;
  }
  // Readiness belongs to each consumer projection, not the shared lifecycle phase.
  state.phase = "stable";
}

function handleRequest(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "request" }>,
): ReliabilityTransition {
  if (state.executionPolicy === "manual" && event.mode === "start")
    return blocked(
      state,
      "start requests are not admitted under manual execution policy; use the ensure/stop commands.",
    );
  const existing = state.requests.find((request) => request.key === event.key);
  if (existing) {
    const consumer = state.consumers.find((candidate) => candidate.id === existing.consumerId);
    if (
      consumer &&
      existing.mode === event.mode &&
      existing.profile === event.profile &&
      existing.operationId === event.operationId &&
      existing.consumerId === event.consumer.id &&
      sameConsumer(consumer, event.consumer)
    ) {
      return unchanged(state, "joined");
    }
    return unchanged(state, "conflict");
  }

  if (event.mode === "start") {
    if (
      state.desired !== "stopped-by-user" ||
      state.phase !== "idle" ||
      state.chargeHeld ||
      possibleDispatch(state.operation)
    ) {
      return unchanged(state, "blocked");
    }

    const intentRevision = advance(state.intentRevision);
    if (intentRevision === null) return unchanged(state, "blocked");

    state.intentRevision = intentRevision;
    state.desired = "running";
    state.phase = "queued";
    state.profile = event.profile;
    state.admission = "waiting";
    state.chargeHeld = false;
    state.stopProof = { workloadsStopped: false, routesRemoved: false };
    state.consumers = [cloneConsumer(event.consumer)];
    state.requests = [
      {
        key: event.key,
        mode: event.mode,
        consumerId: event.consumer.id,
        operationId: event.operationId,
        profile: event.profile,
        intentRevision,
      },
    ];
    state.observations = [];
    state.operation = {
      id: event.operationId,
      kind: "ensure",
      drained: false,
      status: "NOT_STARTED",
      exitCode: null,
    };
    return transition(state, "accepted", [effect(state, "request-admission", event.operationId)]);
  }

  if (
    (state.desired !== "running" && state.desired !== "parked-for-capacity") ||
    state.profile === null
  )
    return unchanged(state, "blocked");
  if (state.profile !== event.profile) return unchanged(state, "conflict");
  if (!state.operation) return unchanged(state, "blocked");
  if (state.operation.id !== event.operationId) return unchanged(state, "conflict");

  const existingConsumer = state.consumers.find((consumer) => consumer.id === event.consumer.id);
  if (
    state.requests.length >= RELIABILITY_MAX_ITEMS ||
    (!existingConsumer && state.consumers.length >= RELIABILITY_MAX_ITEMS)
  )
    return unchanged(state, "blocked");
  if (existingConsumer && !sameConsumer(existingConsumer, event.consumer)) {
    return unchanged(state, "conflict");
  }
  if (!existingConsumer) state.consumers.push(cloneConsumer(event.consumer));
  state.requests.push({
    key: event.key,
    mode: event.mode,
    consumerId: event.consumer.id,
    operationId: state.operation.id,
    profile: event.profile,
    intentRevision: state.intentRevision,
  });
  return transition(state, "accepted");
}

export function canExecAfterInterruptedEnsure(state: ReliabilityState): boolean {
  const latestEnsure = [...state.operationHistory]
    .reverse()
    .find((operation) => operation.kind === "ensure");
  // A completed stop proof is positive evidence the workspace is quiescent, so
  // recovery is admitted regardless of whether desired records running or stopped.
  const quiescent = state.stopProof.workloadsStopped && state.stopProof.routesRemoved;
  return (
    state.executionPolicy === "manual" &&
    (state.desired === "running" || (quiescent && state.desired === "stopped-by-user")) &&
    latestEnsure?.status === "INTERRUPTED" &&
    latestEnsure.drained &&
    state.operation?.drained === true &&
    ((state.operation.kind === "ensure" && (state.phase === "recovering" || quiescent)) ||
      (state.operation.kind === "exec" &&
        ["COMPLETED", "NOT_LAUNCHED", "NOT_STARTED"].includes(state.operation.status)))
  );
}

function handleOperationRequest(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "operation-request" }>,
): ReliabilityTransition {
  if (state.executionPolicy !== "manual") return unchanged(state, "blocked");
  const previous = state.operationHistory.find((entry) => entry.key === event.key);
  if (previous)
    return unchanged(
      state,
      previous.id === event.operationId &&
        previous.kind === event.kind &&
        previous.profile === event.profile &&
        sameConsumer(previous.consumer, event.consumer)
        ? "joined"
        : "conflict",
    );
  if (state.operationHistory.some((entry) => entry.id === event.operationId))
    return unchanged(state, "conflict");
  // Tooling does not reconcile interrupted preparation. Every subsequent command
  // needs fresh identity proof until a later ensure replaces that startup result.
  if (
    event.kind === "exec" &&
    canExecAfterInterruptedEnsure(state) &&
    event.recoverInterruptedEnsure !== true
  )
    return blocked(
      state,
      "the latest ensure is INTERRUPTED and drained; exec requires recovering it first (run ensure, or exec with recovery proof).",
    );
  const fullyStopped = state.stopProof.workloadsStopped && state.stopProof.routesRemoved;
  const reconcileEnsure =
    event.kind === "ensure" &&
    state.operation?.kind === "ensure" &&
    ["NOT_STARTED", "INTERRUPTED"].includes(state.operation.status);
  if (
    state.operation &&
    (!state.operation.drained ||
      (!["COMPLETED", "NOT_LAUNCHED", "NOT_STARTED"].includes(state.operation.status) &&
        !fullyStopped &&
        !reconcileEnsure &&
        !(
          event.kind === "exec" &&
          event.recoverInterruptedEnsure === true &&
          canExecAfterInterruptedEnsure(state)
        )))
  )
    return blocked(
      state,
      `operation ${state.operation.id} is ${state.operation.status} (drained=${state.operation.drained}) and no stop proof, ensure reconciliation, or exec recovery supersedes it.`,
    );
  if (state.phase === "stopping" || state.desired === "parked-for-capacity")
    return blocked(
      state,
      `phase is '${state.phase}' with desired '${state.desired}'; wait for the running stop to finish.`,
    );
  if (
    event.kind === "exec" &&
    (!event.runtimeRunning || (state.desired !== "running" && state.intentRevision !== 0))
  )
    return blocked(
      state,
      `exec requires a running workspace (runtimeRunning=${event.runtimeRunning}, desired='${state.desired}').`,
    );
  const rollover = state.operationHistory.length >= RELIABILITY_MAX_ITEMS;
  let retired = -1;
  if (rollover) {
    // The supersede gates above already proved the current drained operation is
    // replaceable; retirement here only frees a deduplication entry. Drained
    // INTERRUPTED entries qualify: a crashed ensure or exec is exactly the state
    // a full journal is most likely to hold, and excluding it deadlocked every
    // command behind a saturated journal. The latest ensure result is still
    // retained because it supersedes older interrupted startup evidence.
    const latestEnsureId = [...state.operationHistory]
      .reverse()
      .find((entry) => entry.kind === "ensure")?.id;
    retired = state.operationHistory.findIndex(
      (entry) =>
        entry.id !== state.operation?.id &&
        entry.id !== latestEnsureId &&
        entry.drained &&
        ["COMPLETED", "NOT_LAUNCHED", "INTERRUPTED"].includes(entry.status),
    );
    if (retired === -1)
      return blocked(
        state,
        `journal holds ${state.operationHistory.length} entries and every retirable entry is the current operation or the latest ensure.`,
      );
  }
  if (state.desired !== "running" || rollover) {
    const revision = advance(state.intentRevision);
    if (revision === null) return unchanged(state, "blocked");
    state.intentRevision = revision;
  }
  // Retiring a deduplication entry requires a fresh fence for every accepted replacement.
  if (rollover) state.operationHistory.splice(retired, 1);
  state.desired = "running";
  state.phase = "queued";
  state.profile = event.profile;
  state.stopProof = { workloadsStopped: false, routesRemoved: false };
  state.consumers = [cloneConsumer(event.consumer)];
  state.requests = [
    {
      key: event.key,
      mode: "attach",
      consumerId: event.consumer.id,
      operationId: event.operationId,
      profile: event.profile,
      intentRevision: state.intentRevision,
    },
  ];
  state.operation = {
    id: event.operationId,
    kind: event.kind,
    drained: false,
    status: "NOT_STARTED",
    exitCode: null,
  };
  state.operationHistory.push({
    ...state.operation,
    key: event.key,
    profile: event.profile,
    consumer: cloneConsumer(event.consumer),
  });
  return transition(state, "accepted");
}

function handleAdmission(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "admission" }>,
): ReliabilityTransition {
  if (
    state.executionPolicy === "manual" ||
    (state.desired !== "running" && state.desired !== "parked-for-capacity") ||
    state.requests.length === 0
  ) {
    return unchanged(state, "blocked");
  }
  if (state.admission === event.result) return unchanged(state, "joined");
  if (
    state.desired === "parked-for-capacity" &&
    event.result === "admitted" &&
    (!state.stopProof.workloadsStopped || !state.stopProof.routesRemoved)
  )
    return unchanged(state, "blocked");

  state.admission = event.result;
  if (event.result === "admitted") {
    state.chargeHeld = true;
  }
  return transition(state, "accepted");
}

function handleDispatch(state: ReliabilityState): ReliabilityTransition {
  if (state.operation?.drained || state.operation?.status !== "NOT_STARTED")
    return unchanged(state, "stale");
  if (
    state.desired !== "running" ||
    (state.executionPolicy === "capacity-managed" && state.admission !== "admitted") ||
    state.consumers.length === 0
  ) {
    return blocked(
      state,
      `dispatch requires desired 'running' with a registered consumer (desired='${state.desired}', consumers=${state.consumers.length}).`,
    );
  }

  const corrective = state.phase === "recovering" && state.incident !== null;
  state.operation = { ...state.operation, status: "DISPATCH_PENDING", exitCode: null };
  state.phase = corrective ? "recovering" : "starting";
  return transition(state, "accepted", [effect(state, "persist-dispatch", state.operation.id)]);
}

function handleDispatchPersisted(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "dispatch-persisted" }>,
): ReliabilityTransition {
  if (!state.operation || state.operation.id !== event.operationId)
    return unchanged(state, "stale");
  if (state.operation.drained || state.operation.status !== "DISPATCH_PENDING")
    return unchanged(state, "stale");
  if (
    state.desired !== "running" ||
    (state.executionPolicy === "capacity-managed" &&
      (state.admission !== "admitted" || !state.chargeHeld))
  ) {
    state.operation = setUnknown(state.operation);
    state.chargeHeld = state.executionPolicy === "capacity-managed";
    return blocked(
      state,
      `dispatch persistence requires desired 'running' (desired='${state.desired}'); the operation outcome is unknown.`,
    );
  }
  if (
    state.phase === "recovering" &&
    state.incident !== null &&
    state.incident.correctiveActionsTaken >= state.incident.actionLimit
  ) {
    return unchanged(state, "blocked");
  }

  state.operation = { ...state.operation, status: "DISPATCH_RECORDED", exitCode: null };
  if (state.phase === "recovering" && state.incident !== null) {
    state.incident = {
      ...state.incident,
      correctiveActionsTaken: state.incident.correctiveActionsTaken + 1,
    };
  }
  return transition(state, "accepted", [effect(state, "launch", event.operationId)]);
}

function handleLaunched(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "launched" }>,
): ReliabilityTransition {
  if (!state.operation || state.operation.id !== event.operationId)
    return unchanged(state, "stale");
  if (state.operation.drained || state.operation.status !== "DISPATCH_RECORDED")
    return unchanged(state, "stale");
  state.operation = { ...state.operation, status: "RUNNING", exitCode: null };
  state.phase = state.phase === "recovering" ? "recovering" : "verifying";
  state.chargeHeld = state.executionPolicy === "capacity-managed";
  return transition(state, "accepted");
}

function handleCompletion(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "completion" }>,
): ReliabilityTransition {
  if (!state.operation || state.operation.id !== event.operationId)
    return unchanged(state, "stale");
  if (state.operation.status === "COMPLETED") {
    return state.operation.exitCode === event.exitCode
      ? unchanged(state, "joined")
      : unchanged(state, "conflict");
  }
  if (["NOT_STARTED", "NOT_LAUNCHED"].includes(state.operation.status))
    return unchanged(state, "stale");

  state.operation = { ...state.operation, status: "COMPLETED", exitCode: event.exitCode };
  if (state.desired === "running") state.phase = "verifying";
  updateRunningPhase(state);
  return transition(state, "accepted");
}

function handleInterrupted(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "interrupted" }>,
): ReliabilityTransition {
  if (!state.operation || state.operation.id !== event.operationId)
    return unchanged(state, "stale");
  if (state.operation.status === "INTERRUPTED") return unchanged(state, "joined");
  if (!possibleDispatch(state.operation) || state.operation.status === "COMPLETION_UNKNOWN") {
    return unchanged(state, "stale");
  }
  state.operation = { ...state.operation, status: "INTERRUPTED", exitCode: null };
  if (state.desired === "running") state.phase = "recovering";
  return transition(state, "accepted");
}

/**
 * Settles an operation whose worker is provably gone into the terminal
 * INTERRUPTED+drained state. This is the first-class escape hatch that keeps a
 * crashed lifecycle from wedging a record: settle never claims anything about
 * workloads or routes, it only marks the operation unobservable so a later
 * stop or ensure can replace it under the normal supersede proofs.
 */
function handleSettle(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "settle" }>,
): ReliabilityTransition {
  if (state.executionPolicy !== "manual") return unchanged(state, "stale");
  if (!state.operation || state.operation.id !== event.operationId)
    return unchanged(state, "stale");
  if (state.operation.drained && state.operation.status === "INTERRUPTED")
    return unchanged(state, "joined");
  // A completed outcome is already terminal evidence; settlement must never
  // rewrite it into an interruption.
  if (state.operation.status === "COMPLETED") return unchanged(state, "joined");
  state.operation = {
    ...state.operation,
    status: "INTERRUPTED",
    drained: true,
    exitCode: null,
  };
  if (state.desired === "running") state.phase = "recovering";
  return transition(state, "accepted");
}

function handleObservation(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "observation" }>,
  nowMs: number,
): ReliabilityTransition {
  if (state.desired !== "running") return unchanged(state, "stale");
  const previous = state.observations.find(
    (observation) => observation.capability === event.observation.capability,
  );
  if (
    event.observation.observedAtMs > nowMs ||
    event.observation.observedAtMs < state.observationsAfterMs ||
    (previous !== undefined && previous.observedAtMs >= event.observation.observedAtMs)
  ) {
    return unchanged(state, "stale");
  }
  if (!previous && state.observations.length >= RELIABILITY_MAX_ITEMS)
    return blocked(
      state,
      `observation set holds ${state.observations.length} distinct capabilities; observations repeat per capability and never retire.`,
    );

  state.observations = state.observations.filter(
    (observation) => observation.capability !== event.observation.capability,
  );
  state.observations.push(cloneObservation(event.observation));
  updateRunningPhase(state);
  return transition(state, "accepted");
}

function handleStop(state: ReliabilityState): ReliabilityTransition {
  if (state.desired === "stopped-by-user" && state.intentRevision > 0)
    return unchanged(state, "joined");
  const intentRevision = advance(state.intentRevision);
  if (intentRevision === null) return unchanged(state, "blocked");

  const operationId = state.operation?.id ?? null;
  state.intentRevision = intentRevision;
  state.desired = "stopped-by-user";
  state.phase = "stopping";
  state.profile = null;
  state.admission = state.executionPolicy === "manual" ? "not-applicable" : "unknown";
  state.stopProof = { workloadsStopped: false, routesRemoved: false };
  state.requests = [];
  state.observations = [];
  state.operation = setUnknown(state.operation);
  return transition(state, "accepted", [effect(state, "stop", operationId)]);
}

function handleStopProof(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "stop-proof" }>,
): ReliabilityTransition {
  if (state.desired === "running") return unchanged(state, "stale");
  if (
    state.executionPolicy === "manual" &&
    state.operation &&
    !state.operation.drained &&
    event.workloadsStopped &&
    event.routesRemoved
  )
    return blocked(
      state,
      `stop proof cannot settle while operation ${state.operation.id} is not drained; wait for its worker or settle the journal.`,
    );
  const previous = { ...state.stopProof };
  if (
    previous.workloadsStopped === event.workloadsStopped &&
    previous.routesRemoved === event.routesRemoved
  )
    return unchanged(state, "joined");
  state.stopProof = {
    workloadsStopped: event.workloadsStopped,
    routesRemoved: event.routesRemoved,
  };
  if (state.stopProof.workloadsStopped && state.stopProof.routesRemoved) {
    state.chargeHeld = false;
    state.phase = "idle";
    state.admission =
      state.executionPolicy === "manual"
        ? "not-applicable"
        : state.desired === "stopped-by-user"
          ? "unknown"
          : "waiting";
  } else {
    state.chargeHeld = state.executionPolicy === "capacity-managed";
    state.phase = "stopping";
  }
  return transition(state, "accepted");
}

function handlePark(state: ReliabilityState): ReliabilityTransition {
  if (state.executionPolicy === "manual") return unchanged(state, "blocked");
  if (state.desired === "parked-for-capacity") return unchanged(state, "joined");
  if (state.desired !== "running") return unchanged(state, "blocked");
  if (state.consumers.some((consumer) => consumer.pinned)) return unchanged(state, "blocked");
  if (possibleDispatch(state.operation)) return unchanged(state, "blocked");

  const intentRevision = advance(state.intentRevision);
  if (intentRevision === null) return unchanged(state, "blocked");

  const operationId = state.operation?.id ?? null;
  state.intentRevision = intentRevision;
  state.desired = "parked-for-capacity";
  state.phase = "stopping";
  state.admission = "waiting";
  state.stopProof = { workloadsStopped: false, routesRemoved: false };
  state.observations = [];
  state.requests = state.requests.map((request) => ({ ...request, intentRevision }));
  return transition(state, "accepted", [effect(state, "stop", operationId)]);
}

function handleResume(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "resume" }>,
): ReliabilityTransition {
  if (
    state.executionPolicy === "manual" ||
    state.desired !== "parked-for-capacity" ||
    !event.pressureDwellSatisfied ||
    !state.stopProof.workloadsStopped ||
    !state.stopProof.routesRemoved ||
    state.consumers.length === 0 ||
    state.admission !== "admitted" ||
    state.profile === null ||
    (state.incident !== null &&
      state.incident.correctiveActionsTaken >= state.incident.actionLimit) ||
    state.operation === null ||
    !["NOT_STARTED", "COMPLETED", "INTERRUPTED"].includes(state.operation.status) ||
    (["COMPLETED", "INTERRUPTED"].includes(state.operation.status) &&
      event.operationId === state.operation.id)
  ) {
    return unchanged(state, "blocked");
  }

  const intentRevision = advance(state.intentRevision);
  const runtimeGeneration = advance(state.runtimeGeneration);
  if (intentRevision === null || runtimeGeneration === null) return unchanged(state, "blocked");

  state.intentRevision = intentRevision;
  state.runtimeGeneration = runtimeGeneration;
  state.desired = "running";
  state.phase = "queued";
  state.stopProof = { workloadsStopped: false, routesRemoved: false };
  state.observations = [];
  state.chargeHeld = true;
  state.operation = {
    id: event.operationId,
    kind: "ensure",
    drained: false,
    status: "NOT_STARTED",
    exitCode: null,
  };
  state.requests = state.requests.map((request) => ({
    ...request,
    operationId: event.operationId,
    intentRevision,
  }));
  return transition(state, "accepted");
}

function handleGenerationChange(
  state: ReliabilityState,
  kind: "epoch" | "runtime",
  nextValue: number,
): ReliabilityTransition {
  const current = kind === "epoch" ? state.controllerEpoch : state.runtimeGeneration;
  if (nextValue <= current) return unchanged(state, "stale");

  if (kind === "epoch") state.controllerEpoch = nextValue;
  else state.runtimeGeneration = nextValue;
  state.observations = [];
  state.stopProof = { workloadsStopped: false, routesRemoved: false };
  state.operation = setUnknown(state.operation);
  if (state.operation !== null || state.profile !== null)
    state.chargeHeld = state.executionPolicy === "capacity-managed";
  state.admission = state.executionPolicy === "manual" ? "not-applicable" : "unknown";
  if (state.desired === "running") {
    state.phase =
      state.phase === "recovering" || state.operation?.status === "COMPLETION_UNKNOWN"
        ? "recovering"
        : "verifying";
  }
  return transition(state, "accepted");
}

function handleRecover(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "recover" }>,
): ReliabilityTransition {
  if (state.executionPolicy === "manual" || state.desired !== "running")
    return unchanged(state, "blocked");
  if (possibleDispatch(state.operation)) return unchanged(state, "blocked");

  if (state.incident !== null && state.incident.id !== event.incidentId) {
    return unchanged(state, "conflict");
  }

  if (state.incident !== null) {
    if (state.operation && pendingCommand(state.operation)) {
      return state.operation.id === event.operationId && state.phase === "recovering"
        ? unchanged(state, "joined")
        : unchanged(state, "conflict");
    }
    if (state.operation?.id === event.operationId && state.operation.status === "COMPLETED") {
      return unchanged(state, "joined");
    }
    if (state.incident.correctiveActionsTaken >= state.incident.actionLimit) {
      return unchanged(state, "blocked");
    }
  }

  if (state.incident === null) {
    if (state.operation?.status === "NOT_STARTED") return unchanged(state, "blocked");
    if (state.operation?.id === event.operationId) return unchanged(state, "conflict");
    state.incident = {
      id: event.incidentId,
      correctiveActionsTaken: 0,
      actionLimit: event.actionLimit,
    };
  }

  if (
    !state.operation ||
    state.operation.status === "COMPLETED" ||
    state.operation.status === "INTERRUPTED"
  ) {
    const runtimeGeneration = advance(state.runtimeGeneration);
    if (runtimeGeneration === null) return unchanged(state, "blocked");
    state.runtimeGeneration = runtimeGeneration;
    state.observations = [];
    state.operation = {
      id: event.operationId,
      kind: "ensure",
      drained: false,
      status: "NOT_STARTED",
      exitCode: null,
    };
  }
  state.phase = "recovering";
  return transition(state, "accepted");
}

function handleRearm(
  state: ReliabilityState,
  event: Extract<ReliabilityEvent, { type: "rearm" }>,
): ReliabilityTransition {
  if (state.incident === null) return unchanged(state, "stale");
  if (state.incident.id !== event.incidentId) return unchanged(state, "conflict");
  if (pendingCommand(state.operation)) return unchanged(state, "blocked");

  state.incident = null;
  if (state.desired === "running") state.phase = "verifying";
  updateRunningPhase(state);
  return transition(state, "accepted");
}

function applyReliabilityEvent(
  state: ReliabilityState,
  event: ReliabilityEvent,
  nowMs: number,
): ReliabilityTransition {
  assertReliabilityEvent(event);

  if (!sameFence(state, event)) return unchanged(state, "stale");

  const next = cloneState(state);
  switch (event.type) {
    case "operation-request":
      return handleOperationRequest(next, event);
    case "drained":
      if (!next.operation || next.operation.id !== event.operationId)
        return unchanged(state, "stale");
      if (next.operation.drained) return unchanged(state, "joined");
      next.operation.drained = true;
      return transition(next, "accepted");
    case "request":
      return handleRequest(next, event);
    case "release": {
      const index = next.consumers.findIndex((consumer) => consumer.id === event.consumerId);
      if (index < 0) return transition(next, "stale");
      next.consumers.splice(index, 1);
      next.requests = next.requests.filter((request) => request.consumerId !== event.consumerId);
      return transition(next, "accepted");
    }
    case "stop":
      return handleStop(next);
    case "park":
      return handlePark(next);
    case "admission":
      return handleAdmission(next, event);
    case "resume":
      return handleResume(next, event);
    case "dispatch":
      return handleDispatch(next);
    case "dispatch-persisted":
      return handleDispatchPersisted(next, event);
    case "launched":
      return handleLaunched(next, event);
    case "not-started":
      if (next.executionPolicy !== "manual" || next.operation?.kind !== "exec")
        return unchanged(next, "blocked");
      if (
        next.operation.id !== event.operationId ||
        !["RUNNING", "DISPATCH_RECORDED"].includes(next.operation.status)
      )
        return unchanged(next, "stale");
      next.operation = { ...next.operation, status: "NOT_LAUNCHED", exitCode: null };
      return transition(next, "accepted");
    case "completion":
      return handleCompletion(next, event);
    case "interrupted":
      return handleInterrupted(next, event);
    case "settle":
      return handleSettle(next, event);
    case "observation":
      return handleObservation(next, event, nowMs);
    case "stop-proof":
      return handleStopProof(next, event);
    case "epoch":
      return handleGenerationChange(next, "epoch", event.nextEpoch);
    case "runtime":
      return handleGenerationChange(next, "runtime", event.nextGeneration);
    case "recover":
      return handleRecover(next, event);
    case "rearm":
      return handleRearm(next, event);
  }
}

export function stepReliability(
  state: ReliabilityState,
  event: ReliabilityEvent,
  nowMs: number,
): ReliabilityTransition {
  assertReliabilityState(state);
  if (!isReliabilityCounter(nowMs) || nowMs < state.observationsAfterMs)
    throw new Error("Invalid reliability clock.");
  const result = applyReliabilityEvent(state, event, nowMs);
  if (
    result.outcome === "accepted" &&
    result.state.executionPolicy === "manual" &&
    result.state.operation
  ) {
    const operation = result.state.operation;
    result.state.operationHistory = result.state.operationHistory.map((entry) =>
      entry.id === operation.id ? { ...entry, ...operation } : entry,
    );
  }
  if (!sameFence(result.state, event) && result.outcome === "accepted") {
    result.state.observationsAfterMs = nowMs;
  }
  return result;
}
