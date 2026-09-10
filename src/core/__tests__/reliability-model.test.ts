import { describe, expect, it } from "vitest";
import {
  createReliabilityState,
  type ReliabilityEvent,
  type ReliabilityState,
  reliabilityFence,
} from "../reliability-contract";
import { stepReliability } from "../reliability-model";
import { projectReliability } from "../reliability-output";

type Input = ReliabilityEvent extends infer Event
  ? Event extends ReliabilityEvent
    ? Omit<Event, keyof ReturnType<typeof reliabilityFence>>
    : never
  : never;
const consumer = { id: "agent", requiredCapabilities: ["api"], pinned: false };
const request = {
  type: "request",
  mode: "start",
  key: "request",
  operationId: "op",
  profile: "web",
  consumer,
} as const;
function step(state: ReliabilityState, event: Input, nowMs = 100) {
  return stepReliability(
    state,
    { ...reliabilityFence(state), ...event } as ReliabilityEvent,
    nowMs,
  );
}
function started() {
  return step(createReliabilityState("env", 1), request).state;
}
function admitted() {
  return step(started(), { type: "admission", result: "admitted" }).state;
}
function running() {
  let state = step(admitted(), { type: "dispatch" }).state;
  state = step(state, { type: "dispatch-persisted", operationId: "op" }).state;
  return step(state, { type: "launched", operationId: "op" }).state;
}
function completed() {
  return step(running(), { type: "completion", operationId: "op", exitCode: 0 }).state;
}
const healthy = {
  capability: "api",
  infrastructure: "healthy",
  application: "verified",
  observedAtMs: 100,
  validForMs: 10,
} as const;

describe("reliability transitions", () => {
  it.each([
    "epoch",
    "runtime",
  ] as const)("reclaims capacity when %s invalidates explicit-stop proof", (kind) => {
    let state = step(completed(), { type: "stop" }).state;
    state = step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: true }).state;
    expect(state.chargeHeld).toBe(false);
    const event =
      kind === "epoch"
        ? ({ type: "epoch", nextEpoch: 2 } as const)
        : ({ type: "runtime", nextGeneration: 1 } as const);
    state = step(state, event).state;
    expect(state.chargeHeld).toBe(true);
    expect(state.stopProof).toEqual({ workloadsStopped: false, routesRemoved: false });
    expect(projectReliability(state, "agent", 100).state).toBe("UNKNOWN");
  });

  it("treats request mode as part of idempotency identity", () => {
    const state = started();
    expect(step(state, { ...request, mode: "attach" })).toMatchObject({
      outcome: "conflict",
      state,
      effects: [],
    });
    expect(step(state, request).outcome).toBe("joined");
  });
  it("rejects pre-generation observations even when relabeled with the current fence", () => {
    let state = step(completed(), { type: "observation", observation: healthy }).state;
    state = step(state, { type: "runtime", nextGeneration: 1 }, 105).state;
    expect(state.observationsAfterMs).toBe(105);
    expect(step(state, { type: "observation", observation: healthy }, 106).outcome).toBe("stale");
    state = step(state, { type: "admission", result: "admitted" }, 106).state;
    expect(projectReliability(state, "agent", 106).state).not.toBe("READY");
    state = step(
      state,
      { type: "observation", observation: { ...healthy, observedAtMs: 106 } },
      106,
    ).state;
    expect(projectReliability(state, "agent", 106).state).toBe("READY");
  });

  it("blocks full observation and request collections without mutating state", () => {
    let state = completed();
    for (let index = 0; index < 128; index++)
      state = step(state, {
        type: "observation",
        observation: { ...healthy, capability: `cap-${index}` },
      }).state;
    expect(step(state, { type: "observation", observation: healthy })).toMatchObject({
      outcome: "blocked",
      state,
      effects: [],
    });
    state = completed();
    for (let index = 1; index < 128; index++)
      state = step(state, {
        ...request,
        mode: "attach",
        key: `key-${index}`,
        consumer: { ...consumer, id: `consumer-${index}` },
      }).state;
    expect(
      step(state, {
        ...request,
        mode: "attach",
        key: "overflow",
        consumer: { ...consumer, id: "overflow" },
      }),
    ).toMatchObject({ outcome: "blocked", state, effects: [] });
  });
  it("fences old completions across recovery and refuses a reused current operation ID", () => {
    const state = completed();
    const recovery = {
      type: "recover",
      incidentId: "incident",
      actionLimit: 2,
      operationId: "repair",
    } as const;
    expect(step(state, { ...recovery, operationId: "op" }).outcome).toBe("conflict");
    let next = step(state, recovery).state;
    next = step(next, { type: "dispatch" }).state;
    const oldCompletion = {
      ...reliabilityFence(state),
      type: "completion",
      operationId: "repair",
      exitCode: 0,
    } as const;
    expect(stepReliability(next, oldCompletion, 100).outcome).toBe("stale");
    expect(next.operation?.status).toBe("DISPATCH_PENDING");
  });

  it("joins repeated stop without invalidating outstanding teardown proof", () => {
    const state = step(completed(), { type: "stop" }).state;
    expect(step(state, { type: "stop" })).toMatchObject({ state, effects: [], outcome: "joined" });
  });
  it("re-fences a repeated stop after full settlement before allowing ensure", () => {
    let state = step(completed(), { type: "stop" }).state;
    state = step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: true }).state;
    expect(state.phase).toBe("idle");
    expect(state.stopProof).toEqual({ workloadsStopped: true, routesRemoved: true });

    const repeated = step(state, { type: "stop" });
    expect(repeated.outcome).toBe("accepted");
    expect(repeated.state.intentRevision).toBe(state.intentRevision + 1);
    expect(repeated.state.phase).toBe("stopping");
    expect(repeated.state.stopProof).toEqual({ workloadsStopped: false, routesRemoved: false });
    expect(
      step(repeated.state, { ...request, key: "after-stop", operationId: "after-stop" }).outcome,
    ).toBe("blocked");
  });
  it("keeps consumers independently ready when another requires a failing capability", () => {
    let state = step(completed(), {
      ...request,
      mode: "attach",
      key: "second",
      consumer: { ...consumer, id: "worker", requiredCapabilities: ["db"] },
    }).state;
    state = step(state, { type: "observation", observation: healthy }).state;
    state = step(state, {
      type: "observation",
      observation: { ...healthy, capability: "db", infrastructure: "failed" },
    }).state;
    expect(projectReliability(state, "agent", 100).state).toBe("READY");
    expect(projectReliability(state, "worker", 100).state).toBe("BLOCKED");
  });
  it("does not mutate input or share mutable output state", () => {
    const state = started();
    const before = structuredClone(state);
    const result = step(state, request);
    expect(result.outcome).toBe("joined");
    result.state.consumers[0].requiredCapabilities.push("db");
    expect(state).toEqual(before);
  });

  it("joins duplicates without effects and rejects conflicting reuse", () => {
    const state = started();
    expect(step(state, request)).toMatchObject({ outcome: "joined", effects: [] });
    expect(step(state, { ...request, profile: "other" }).outcome).toBe("conflict");
    expect(step(state, { ...request, consumer: { ...consumer, pinned: true } }).outcome).toBe(
      "conflict",
    );
    const waiting = step(state, { type: "dispatch" });
    expect(waiting).toMatchObject({ outcome: "blocked", effects: [] });
    expect(waiting.state.chargeHeld).toBe(false);
  });

  it("shares consumers, respects every pin, and releases without stopping", () => {
    let state = completed();
    state = step(state, {
      ...request,
      mode: "attach",
      key: "second",
      consumer: { ...consumer, id: "human", pinned: true },
    }).state;
    expect(step(state, { type: "park" }).outcome).toBe("blocked");
    const released = step(state, { type: "release", consumerId: "human" });
    expect(released.effects).toEqual([]);
    expect(released.state.chargeHeld).toBe(true);
    expect(step(released.state, { type: "park" }).outcome).toBe("accepted");
  });

  it("stops before late readiness and attach can never undo stop", () => {
    const state = running();
    const late = { ...reliabilityFence(state), type: "observation", observation: healthy } as const;
    const stopped = step(state, { type: "stop" });
    expect(stopped.state.intentRevision).toBe(state.intentRevision + 1);
    expect(stopped.effects[0]).toMatchObject({ ...reliabilityFence(stopped.state), kind: "stop" });
    expect(stepReliability(stopped.state, late, 100)).toMatchObject({
      outcome: "stale",
      effects: [],
    });
    expect(step(stopped.state, { ...request, mode: "attach", key: "later" }).outcome).toBe(
      "blocked",
    );
    const proved = step(stopped.state, {
      type: "stop-proof",
      workloadsStopped: true,
      routesRemoved: true,
    }).state;
    expect(proved.operation?.status).toBe("COMPLETION_UNKNOWN");
    expect(projectReliability(proved, "agent", 100).state).toBe("STOPPED");
    expect(step(proved, { ...request, key: "fresh", operationId: "new" }).outcome).toBe("blocked");
  });

  it("requires both stop proofs together and preserves charges under uncertain evidence", () => {
    let state = step(completed(), { type: "park" }).state;
    state = step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: false }).state;
    expect(state.chargeHeld).toBe(true);
    state = step(state, { type: "stop-proof", workloadsStopped: false, routesRemoved: true }).state;
    expect(state.chargeHeld).toBe(true);
    state = step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: true }).state;
    expect(state.chargeHeld).toBe(false);
    expect(projectReliability(state, "agent", 100).state).toBe("PARKED_CAPACITY");
  });

  it("joins parked consumers without restart and resumes only with fresh admission and operation", () => {
    let state = step(completed(), { type: "park" }).state;
    expect(step(state, { type: "park" }).effects).toEqual([]);
    expect(step(state, { ...request, mode: "attach", key: "parked" }).effects).toEqual([]);
    state = step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: true }).state;
    const resume = {
      type: "resume",
      pressureDwellSatisfied: true,
      operationId: "resume-op",
    } as const;
    expect(step(state, resume).outcome).toBe("blocked");
    state = step(state, { type: "admission", result: "admitted" }).state;
    expect(projectReliability(state, "agent", 100).state).toBe("STARTING");
    expect(
      step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: true }).state
        .chargeHeld,
    ).toBe(true);
    expect(step(state, { ...resume, pressureDwellSatisfied: false }).outcome).toBe("blocked");
    expect(step(state, { ...resume, operationId: "op" }).outcome).toBe("blocked");
    const resumed = step(state, resume);
    expect(resumed.state).toMatchObject({
      desired: "running",
      chargeHeld: true,
      runtimeGeneration: state.runtimeGeneration + 1,
      operation: { id: "resume-op", status: "NOT_STARTED" },
    });
  });

  it.each([
    "DISPATCH_PENDING",
    "DISPATCH_RECORDED",
    "RUNNING",
  ] as const)("never replays %s after controller loss", (status) => {
    const state = admitted();
    state.operation!.status = status;
    const changed = step(state, { type: "epoch", nextEpoch: 2 }).state;
    expect(changed.operation?.status).toBe("COMPLETION_UNKNOWN");
    expect(changed.chargeHeld).toBe(true);
    expect(step(changed, { type: "dispatch" }).effects).toEqual([]);
    expect(
      step(changed, {
        type: "recover",
        incidentId: "incident",
        actionLimit: 2,
        operationId: "retry",
      }).effects,
    ).toEqual([]);
  });

  it("records dispatch before one launch and retains exact completion", () => {
    let result = step(admitted(), { type: "dispatch" });
    expect(result.effects.map((effect) => effect.kind)).toEqual(["persist-dispatch"]);
    expect(step(result.state, { type: "dispatch" }).effects).toEqual([]);
    result = step(result.state, { type: "dispatch-persisted", operationId: "op" });
    expect(result.effects.map((effect) => effect.kind)).toEqual(["launch"]);
    expect(step(result.state, { type: "dispatch-persisted", operationId: "op" }).effects).toEqual(
      [],
    );
    result = step(result.state, { type: "completion", operationId: "op", exitCode: 17 });
    expect(result.state.operation?.exitCode).toBe(17);
    expect(step(result.state, { type: "completion", operationId: "op", exitCode: 0 }).outcome).toBe(
      "conflict",
    );
  });

  it("withholds launch if admission becomes unknown after persistence was requested", () => {
    let state = step(admitted(), { type: "dispatch" }).state;
    state = step(state, { type: "admission", result: "unknown" }).state;
    const result = step(state, { type: "dispatch-persisted", operationId: "op" });
    expect(result.effects).toEqual([]);
    expect(result.state.operation?.status).toBe("COMPLETION_UNKNOWN");
    expect(result.state.chargeHeld).toBe(true);
  });

  it.each([
    "waiting",
    "denied-unadmittable",
    "unknown",
  ] as const)("retains running workload charges when admission becomes %s", (result) => {
    expect(step(completed(), { type: "admission", result }).state.chargeHeld).toBe(true);
  });

  it("fences every generation and rejects future and out-of-order observations", () => {
    let state = completed();
    for (const field of [
      "environmentId",
      "intentRevision",
      "runtimeGeneration",
      "controllerEpoch",
    ] as const) {
      const event = {
        ...reliabilityFence(state),
        type: "observation",
        observation: healthy,
        [field]: field === "environmentId" ? "other" : 99,
      } as ReliabilityEvent;
      expect(stepReliability(state, event, 100).outcome).toBe("stale");
    }
    expect(
      step(state, { type: "observation", observation: { ...healthy, observedAtMs: 101 } }).outcome,
    ).toBe("stale");
    state = step(state, { type: "observation", observation: healthy }).state;
    expect(projectReliability(state, "agent", 109).state).toBe("READY");
    expect(projectReliability(state, "agent", 110).state).toBe("UNKNOWN");
    expect(
      step(state, { type: "observation", observation: { ...healthy, observedAtMs: 99 } }).outcome,
    ).toBe("stale");
    expect(step(state, { type: "runtime", nextGeneration: 1 }).state.observations).toEqual([]);
  });

  it("retains incident budgets across observations and epochs and allows explicit rearm", () => {
    let state = completed();
    const recover = {
      type: "recover",
      incidentId: "incident",
      actionLimit: 1,
      operationId: "repair",
    } as const;
    state = step(state, recover).state;
    state = step(state, { type: "observation", observation: healthy }).state;
    expect(state.phase).toBe("recovering");
    state = step(state, { type: "epoch", nextEpoch: 2 }).state;
    state = step(state, { type: "admission", result: "admitted" }).state;
    state = step(state, { type: "dispatch" }).state;
    expect(state.incident?.correctiveActionsTaken).toBe(0);
    state = step(state, { type: "dispatch-persisted", operationId: "repair" }).state;
    expect(state.incident?.correctiveActionsTaken).toBe(1);
    expect(step(state, { type: "rearm", incidentId: "incident" }).outcome).toBe("blocked");
    state = step(state, { type: "completion", operationId: "repair", exitCode: 1 }).state;
    expect(step(state, { ...recover, operationId: "repair-2", actionLimit: 10 }).outcome).toBe(
      "blocked",
    );
    expect(
      step(state, { ...recover, incidentId: "replacement", operationId: "repair-2" }).outcome,
    ).toBe("conflict");
    state = step(state, { type: "rearm", incidentId: "incident" }).state;
    expect(state.incident).toBeNull();
    expect(step(state, { ...recover, operationId: "repair-2" }).outcome).toBe("accepted");
  });

  it("rejects invalid event and clock inputs without effects", () => {
    expect(() => step(started(), { type: "epoch", nextEpoch: -1 })).toThrow();
    expect(() => step(started(), { type: "stop" }, Number.NaN)).toThrow();
    expect(() => step(started(), { type: "unsupported" } as unknown as Input)).toThrow();
  });
});

describe("manual operation lifecycle", () => {
  const ensure = {
    type: "operation-request",
    kind: "ensure",
    key: "manual-1",
    operationId: "manual-op-1",
    profile: "web",
    consumer,
    runtimeRunning: false,
  } as const;
  function manual() {
    return createReliabilityState("env", 1, "manual");
  }
  function dispatched(kind: "ensure" | "exec" = "ensure") {
    let state = step(manual(), { ...ensure, kind, runtimeRunning: kind === "exec" }).state;
    state = step(state, { type: "dispatch" }).state;
    state = step(state, { type: "dispatch-persisted", operationId: ensure.operationId }).state;
    return step(state, { type: "launched", operationId: ensure.operationId }).state;
  }
  function drained() {
    const state = step(dispatched(), {
      type: "completion",
      operationId: ensure.operationId,
      exitCode: 0,
    }).state;
    return step(state, { type: "drained", operationId: ensure.operationId }).state;
  }
  it.each([
    "ai,chat,manage,live-quiz,email",
    " manage,ai,manage ",
  ])("retains combined profile selection through manual dispatch: %s", (profile) => {
    let state = step(manual(), { ...ensure, profile }).state;
    expect(state.profile).toBe(profile);
    expect(state.operationHistory[0].profile).toBe(profile);
    state = step(state, { type: "dispatch" }).state;
    expect(state.operation?.status).toBe("DISPATCH_PENDING");
    expect(step(state, { ...ensure, profile }).outcome).toBe("joined");
  });

  it.each([
    "",
    ",ai",
    "ai,",
    "ai,,chat",
    "ai,../chat",
    "a".repeat(4097),
  ])("rejects malformed profile selections before dispatch: %s", (profile) => {
    expect(() => step(manual(), { ...ensure, profile })).toThrow();
  });

  it("dispatches explicit manual operations without manufacturing host capacity", () => {
    const state = dispatched();
    expect(state.operation?.status).toBe("RUNNING");
    expect(state.admission).toBe("not-applicable");
    expect(state.chargeHeld).toBe(false);
    expect(projectReliability(state, consumer.id, 100).capacity).toBe("unmanaged");
    expect(step(state, { type: "admission", result: "admitted" }).outcome).toBe("blocked");
    expect(step(drained(), { type: "park" }).outcome).toBe("blocked");
    expect(
      step(drained(), {
        type: "recover",
        operationId: "repair",
        incidentId: "incident",
        actionLimit: 1,
      }).outcome,
    ).toBe("blocked");
  });
  it.each([
    "ensure",
    "exec",
  ] as const)("permits successive %s after completion and worker drainage", (kind) => {
    let state = drained();
    const next = {
      ...ensure,
      kind,
      key: "manual-2",
      operationId: "manual-op-2",
      runtimeRunning: true,
    };
    const beforeDrain = step(dispatched(), {
      type: "completion",
      operationId: ensure.operationId,
      exitCode: 0,
    }).state;
    expect(step(beforeDrain, next).outcome).toBe("blocked");
    const revision = state.intentRevision;
    state = step(state, next).state;
    expect(state.operation?.id).toBe(next.operationId);
    expect(state.intentRevision).toBe(revision);
    expect(state.runtimeGeneration).toBe(0);
    expect(step(state, ensure)).toMatchObject({ outcome: "joined", effects: [], state });
    expect(state.operationHistory[0]).toMatchObject({
      status: "COMPLETED",
      exitCode: 0,
      drained: true,
    });
    expect(step(state, { ...ensure, kind: "exec" }).outcome).toBe("conflict");
  });
  it("rejects consumer payload drift even after a later operation replaces the slot", () => {
    let state = drained();
    state = step(state, { ...ensure, key: "next", operationId: "next" }).state;
    expect(
      step(state, {
        ...ensure,
        consumer: { ...consumer, requiredCapabilities: ["api", "database"] },
      }).outcome,
    ).toBe("conflict");
    expect(step(state, { ...ensure, consumer: { ...consumer, pinned: true } }).outcome).toBe(
      "conflict",
    );
    expect(step(state, ensure).outcome).toBe("joined");
  });
  it("requires runtime proof for exec and never overturns explicit stop", () => {
    expect(step(manual(), { ...ensure, kind: "exec" }).outcome).toBe("blocked");
    // A first record can adopt a positively proven existing runtime without starting it.
    expect(step(manual(), { ...ensure, kind: "exec", runtimeRunning: true }).outcome).toBe(
      "accepted",
    );
    let state = step(drained(), { type: "stop" }).state;
    state = step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: true }).state;
    expect(
      step(state, {
        ...ensure,
        key: "exec",
        operationId: "exec",
        kind: "exec",
        runtimeRunning: true,
      }).outcome,
    ).toBe("blocked");
    expect(step(state, { ...ensure, key: "resume", operationId: "resume" }).outcome).toBe(
      "accepted",
    );
    expect(step(state, ensure).outcome).toBe("joined");
  });
  it("allows ensure after a positively drained startup that never dispatched", () => {
    let state = step(manual(), ensure).state;
    state = step(state, { type: "drained", operationId: ensure.operationId }).state;
    expect(step(state, { ...ensure, key: "next", operationId: "next" }).outcome).toBe("accepted");
    expect(step(state, ensure).effects).toEqual([]);
  });
  it("reconciles a drained interrupted ensure without erasing its result or replaying its identity", () => {
    let state = step(dispatched(), { type: "interrupted", operationId: ensure.operationId }).state;
    const next = { ...ensure, key: "next", operationId: "next" };
    expect(step(state, next).outcome).toBe("blocked");
    state = step(state, { type: "drained", operationId: ensure.operationId }).state;
    expect(step(state, { ...next, kind: "exec", runtimeRunning: true }).outcome).toBe("blocked");
    const reconciled = step(state, next);
    expect(reconciled.outcome).toBe("accepted");
    expect(reconciled.state.operationHistory[0]).toMatchObject({
      id: ensure.operationId,
      status: "INTERRUPTED",
      exitCode: null,
      drained: true,
    });
    const duplicate = step(reconciled.state, ensure);
    expect(duplicate.outcome).toBe("joined");
    expect(duplicate.effects).toEqual([]);
    expect(duplicate.state.operation?.id).toBe("next");
    state = step(state, { type: "stop" }).state;
    expect(step(state, next).outcome).toBe("blocked");
  });
  it("admits proved tooling after drained interrupted ensure and preserves its result", () => {
    let state = step(dispatched(), { type: "interrupted", operationId: ensure.operationId }).state;
    const exec = {
      ...ensure,
      kind: "exec" as const,
      key: "tool",
      operationId: "tool",
      runtimeRunning: true,
      recoverInterruptedEnsure: true,
    };
    expect(step(state, exec).outcome).toBe("blocked");
    state = step(state, { type: "drained", operationId: ensure.operationId }).state;
    expect(step(state, { ...exec, runtimeRunning: false }).outcome).toBe("blocked");
    expect(step(state, { ...exec, recoverInterruptedEnsure: false }).outcome).toBe("blocked");
    const result = step(state, exec);
    expect(result.outcome).toBe("accepted");
    expect(result.state.operationHistory[0]).toMatchObject({
      id: ensure.operationId,
      status: "INTERRUPTED",
      drained: true,
      exitCode: null,
    });
    expect(step(result.state, ensure).effects).toEqual([]);
    expect(step(step(state, { type: "stop" }).state, exec).outcome).toBe("blocked");
    let unknown = step(dispatched("exec"), {
      type: "interrupted",
      operationId: ensure.operationId,
    }).state;
    unknown = step(unknown, { type: "drained", operationId: ensure.operationId }).state;
    expect(step(unknown, exec).outcome).toBe("blocked");
  });
  it.each([
    "not-started",
    "completion",
  ] as const)("requires fresh proof after recovery exec %s until preparation completes", (outcome) => {
    let state = step(dispatched(), { type: "interrupted", operationId: ensure.operationId }).state;
    state = step(state, { type: "drained", operationId: ensure.operationId }).state;
    const exec = {
      ...ensure,
      kind: "exec" as const,
      key: "tool",
      operationId: "tool",
      runtimeRunning: true,
      recoverInterruptedEnsure: true,
    };
    state = step(state, exec).state;
    state = step(state, { type: "dispatch" }).state;
    state = step(state, { type: "dispatch-persisted", operationId: "tool" }).state;
    state = step(state, { type: "launched", operationId: "tool" }).state;
    state = step(
      state,
      outcome === "completion"
        ? { type: "completion", operationId: "tool", exitCode: 7 }
        : { type: "not-started", operationId: "tool" },
    ).state;
    state = step(state, { type: "drained", operationId: "tool" }).state;
    const retry = { ...exec, key: "retry", operationId: "retry" };
    expect(step(state, { ...retry, recoverInterruptedEnsure: false }).outcome).toBe("blocked");
    expect(step(state, retry).outcome).toBe("accepted");
    expect(step(state, exec).outcome).toBe("joined");
    state = step(state, { ...ensure, key: "prepare", operationId: "prepare" }).state;
    state = step(state, { type: "dispatch" }).state;
    state = step(state, { type: "dispatch-persisted", operationId: "prepare" }).state;
    state = step(state, { type: "launched", operationId: "prepare" }).state;
    state = step(state, { type: "completion", operationId: "prepare", exitCode: 0 }).state;
    state = step(state, { type: "drained", operationId: "prepare" }).state;
    expect(step(state, { ...retry, recoverInterruptedEnsure: false }).outcome).toBe("accepted");
  });
  it("keeps uncertain exec blocked until worker drainage and complete explicit-stop proof", () => {
    let state = step(dispatched("exec"), {
      type: "interrupted",
      operationId: ensure.operationId,
    }).state;
    state = step(state, { type: "drained", operationId: ensure.operationId }).state;
    const next = { ...ensure, key: "next", operationId: "next" };
    expect(step(state, next).outcome).toBe("blocked");
    state = step(state, { type: "stop" }).state;
    state = step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: false }).state;
    expect(state.chargeHeld).toBe(false);
    expect(step(state, next).outcome).toBe("blocked");
    state = step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: true }).state;
    expect(step(state, next).outcome).toBe("accepted");
  });
  it("fences late effects and does not equate stopped workloads with a drained worker", () => {
    const old = dispatched();
    let state = step(old, { type: "stop" }).state;
    expect(
      stepReliability(
        state,
        {
          ...reliabilityFence(old),
          type: "completion",
          operationId: ensure.operationId,
          exitCode: 0,
        },
        100,
      ).outcome,
    ).toBe("stale");
    expect(
      step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: true }).outcome,
    ).toBe("blocked");
    state = step(state, { type: "drained", operationId: ensure.operationId }).state;
    state = step(state, { type: "stop-proof", workloadsStopped: true, routesRemoved: true }).state;
    expect(projectReliability(state, consumer.id, 100).state).toBe("STOPPED");
    expect(state.operation?.status).toBe("COMPLETION_UNKNOWN");
  });
  function finish(state: ReliabilityState) {
    const operationId = state.operation!.id;
    state = step(state, { type: "dispatch" }).state;
    state = step(state, { type: "dispatch-persisted", operationId }).state;
    state = step(state, { type: "completion", operationId, exitCode: 0 }).state;
    return step(state, { type: "drained", operationId }).state;
  }
  function fullHistory() {
    let state = manual();
    for (let index = 0; index < 128; index++) {
      state = finish(
        step(state, { ...ensure, key: `request-${index}`, operationId: `op-${index}` }).state,
      );
    }
    return state;
  }
  it("cannot dispatch a drained operation", () => {
    const state = step(step(manual(), ensure).state, {
      type: "drained",
      operationId: ensure.operationId,
    }).state;
    expect(step(state, { type: "dispatch" }).effects).toEqual([]);
  });
  it("accepts more than 256 completed cycles with bounded history across stop and resume", () => {
    let state = manual();
    for (let index = 0; index < 300; index++) {
      if (index > 0 && index % 70 === 0) {
        state = step(state, { type: "stop" }).state;
        state = step(state, {
          type: "stop-proof",
          workloadsStopped: true,
          routesRemoved: true,
        }).state;
      }
      const before = state;
      const accepted = step(state, {
        ...ensure,
        kind: index % 2 ? "exec" : "ensure",
        runtimeRunning: true,
        key: `request-${index}`,
        operationId: `op-${index}`,
      });
      expect(accepted.outcome).toBe("accepted");
      expect(accepted.state.intentRevision).toBe(
        before.intentRevision + (before.desired !== "running" || index >= 128 ? 1 : 0),
      );
      state = finish(accepted.state);
      expect(state.operation?.status).toBe("COMPLETED");
      expect(state.operation?.drained).toBe(true);
      expect(state.operationHistory).toHaveLength(Math.min(index + 1, 128));
    }
    expect(state.operationHistory[0].id).toBe("op-172");
  });
  it("does not resurrect interrupted preparation when settled tooling history rolls over", () => {
    let state = step(dispatched(), { type: "interrupted", operationId: ensure.operationId }).state;
    state = step(state, { type: "drained", operationId: ensure.operationId }).state;
    state = finish(step(state, { ...ensure, key: "prepared", operationId: "prepared" }).state);
    for (let index = 0; index < 256; index++) {
      const result = step(state, {
        ...ensure,
        kind: "exec",
        key: `tool-${index}`,
        operationId: `tool-${index}`,
        runtimeRunning: true,
      });
      expect(result.outcome).toBe("accepted");
      state = finish(result.state);
    }
    expect(state.operationHistory.find((entry) => entry.id === "prepared")?.status).toBe(
      "COMPLETED",
    );
    // The drained interrupted entry is retirable like any settled result, so a
    // saturated journal eventually frees its deduplication key; the completed
    // preparation result is retained and must survive the replacement.
    expect(state.operationHistory.some((entry) => entry.id === ensure.operationId)).toBe(false);
    const result = step(state, ensure);
    expect(result.outcome).toBe("accepted");
    expect(result.state.operationHistory.find((entry) => entry.id === "prepared")?.status).toBe(
      "COMPLETED",
    );
  });
  it("checks retained duplicates and conflicts before rollover and fences old events", () => {
    const full = fullHistory();
    const retained = { ...ensure, key: "request-127", operationId: "op-127" };
    expect(step(full, retained)).toEqual({ state: full, outcome: "joined", effects: [] });
    expect(step(full, { ...retained, profile: "other" })).toEqual({
      state: full,
      outcome: "conflict",
      effects: [],
    });
    expect(step(full, { ...retained, key: "new-key" }).outcome).toBe("conflict");
    const state = step(full, ensure).state;
    expect(state.operationHistory.some((entry) => entry.id === "op-0")).toBe(false);
    expect(step(state, retained).outcome).toBe("joined");
    for (const event of [
      { ...ensure, key: "request-0", operationId: "op-0" },
      { type: "completion", operationId: "op-0", exitCode: 0 },
      { type: "drained", operationId: "op-0" },
    ] as Input[]) {
      expect(
        stepReliability(state, { ...reliabilityFence(full), ...event } as ReliabilityEvent, 100),
      ).toEqual({ state, outcome: "stale", effects: [] });
    }
  });
  it("retires only the oldest settled drained noncurrent entry", () => {
    const full = fullHistory();
    full.operationHistory[0] = {
      ...full.operationHistory[0],
      status: "COMPLETION_UNKNOWN",
      exitCode: null,
    };
    full.operationHistory[1].drained = false;
    const accepted = step(full, ensure);
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.state.operationHistory.slice(0, 2)).toEqual(full.operationHistory.slice(0, 2));
    expect(accepted.state.operationHistory.some((entry) => entry.id === "op-2")).toBe(false);
    expect(accepted.state.operationHistory.some((entry) => entry.id === "op-127")).toBe(true);
    for (const entry of full.operationHistory.slice(0, -1)) {
      entry.status = "COMPLETION_UNKNOWN";
      entry.exitCode = null;
    }
    const refusal = step(full, ensure);
    expect(refusal.outcome).toBe("blocked");
    expect(refusal.reason).toContain("retirable entry");
    expect(refusal.state).toEqual(full);
  });
  it.each([
    "INTERRUPTED",
    "NOT_STARTED",
  ] as const)("supersedes a drained current %s operation at rollover when a fresh ensure replaces it", (status) => {
    const full = fullHistory();
    full.operation = { ...full.operation!, status, exitCode: null };
    full.operationHistory[127] = { ...full.operationHistory[127], ...full.operation };
    const result = step(full, ensure);
    expect(result.outcome).toBe("accepted");
    // The superseded entry stays in history until a later rollover retires it.
    expect(result.state.operationHistory.some((entry) => entry.id === "op-127")).toBe(true);
    expect(result.state.operationHistory.some((entry) => entry.id === "op-0")).toBe(false);
    expect(result.state.operationHistory).toHaveLength(128);
  });
  it("does not roll over a current COMPLETION_UNKNOWN operation without a supersede proof", () => {
    const full = fullHistory();
    full.operation = { ...full.operation!, status: "COMPLETION_UNKNOWN", exitCode: null };
    full.operationHistory[127] = { ...full.operationHistory[127], ...full.operation };
    const result = step(full, ensure);
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("COMPLETION_UNKNOWN");
    expect(result.state).toEqual(full);
  });
  it("requires current drainage and preserves state when the counter is exhausted", () => {
    const full = fullHistory();
    full.operation!.drained = false;
    full.operationHistory[127].drained = false;
    const refusal = step(full, ensure);
    expect(refusal.outcome).toBe("blocked");
    expect(refusal.reason).toContain("drained=false");
    expect(refusal.state).toEqual(full);
    full.operation!.drained = true;
    full.operationHistory[127].drained = true;
    full.intentRevision = Number.MAX_SAFE_INTEGER;
    const exhausted = step(full, ensure);
    expect(exhausted.outcome).toBe("blocked");
    expect(exhausted.state).toEqual(full);
    expect(step(full, { ...ensure, key: "request-127", operationId: "op-127" }).outcome).toBe(
      "joined",
    );
  });
  it("permits rollover with no current operation or a drained not-launched operation", () => {
    for (const absent of [false, true]) {
      const full = fullHistory();
      full.operationHistory[0] = {
        ...full.operationHistory[0],
        status: "NOT_LAUNCHED",
        exitCode: null,
      };
      full.operation = absent
        ? null
        : { ...full.operation!, status: "NOT_LAUNCHED", exitCode: null };
      if (full.operation)
        full.operationHistory[127] = { ...full.operationHistory[127], ...full.operation };
      expect(step(full, ensure).outcome).toBe("accepted");
    }
  });
  it("does not enable rollover for capacity-managed operations", () => {
    const full = fullHistory();
    full.executionPolicy = "capacity-managed";
    full.admission = "waiting";
    expect(step(full, ensure)).toEqual({ state: full, outcome: "blocked", effects: [] });
  });
  it("settles a lost operation as unobservable so the next ensure supersedes it", () => {
    let state = step(dispatched(), { type: "interrupted", operationId: ensure.operationId }).state;
    state = step(state, { type: "drained", operationId: ensure.operationId }).state;
    state = step(state, { type: "settle", operationId: ensure.operationId }).state;
    expect(state.operation).toMatchObject({ status: "INTERRUPTED", drained: true });
    expect(state.operationHistory[0]).toMatchObject({ status: "INTERRUPTED", drained: true });
    expect(step(state, { type: "settle", operationId: ensure.operationId }).outcome).toBe("joined");
    // The settled operation's own request still joins; a fresh request supersedes it.
    expect(step(state, ensure).outcome).toBe("joined");
    const result = step(state, { ...ensure, key: "after-settle", operationId: "after-settle" });
    expect(result.outcome).toBe("accepted");
  });
  it("settles an interrupted running operation into recovery and keeps exec recovery available", () => {
    let state = dispatched();
    state = step(state, { type: "settle", operationId: ensure.operationId }).state;
    expect(state.operation).toMatchObject({ status: "INTERRUPTED", drained: true });
    expect(state.phase).toBe("recovering");
    const exec = {
      ...ensure,
      kind: "exec",
      runtimeRunning: true,
      recoverInterruptedEnsure: true,
      key: "exec-after-settle",
      operationId: "exec-after-settle",
    } as const;
    expect(step(state, exec).outcome).toBe("accepted");
  });
  it("joins settle for a completed outcome and stales foreign or non-manual settles", () => {
    const state = drained();
    expect(step(state, { type: "settle", operationId: ensure.operationId }).outcome).toBe("joined");
    expect(step(state, { type: "settle", operationId: "foreign" }).outcome).toBe("stale");
    const shared = step(state, { ...ensure, key: "again", operationId: "again" }).state;
    shared.executionPolicy = "capacity-managed";
    shared.admission = "waiting";
    expect(step(shared, { type: "settle", operationId: "again" }).outcome).toBe("stale");
  });
});

describe("capacity-managed operation lifecycle", () => {
  const ensure = {
    type: "operation-request",
    kind: "ensure",
    key: "managed-1",
    operationId: "managed-op-1",
    profile: "web",
    consumer,
    runtimeRunning: false,
  } as const;

  function managed() {
    return createReliabilityState("env", 1, "capacity-managed");
  }

  function drained() {
    let state = step(managed(), ensure).state;
    state = step(state, { type: "admission", result: "admitted" }).state;
    state = step(state, { type: "dispatch" }).state;
    state = step(state, {
      type: "dispatch-persisted",
      operationId: ensure.operationId,
    }).state;
    state = step(state, { type: "launched", operationId: ensure.operationId }).state;
    state = step(state, {
      type: "completion",
      operationId: ensure.operationId,
      exitCode: 0,
    }).state;
    return step(state, { type: "drained", operationId: ensure.operationId }).state;
  }

  it("queues a managed ensure and blocks dispatch until admission", () => {
    const accepted = step(managed(), ensure);
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.state).toMatchObject({
      phase: "queued",
      admission: "waiting",
      chargeHeld: false,
      operation: { id: ensure.operationId, status: "NOT_STARTED", drained: false },
    });
    expect(accepted.effects).toEqual([
      expect.objectContaining({ kind: "request-admission", operationId: ensure.operationId }),
    ]);

    const blocked = step(accepted.state, { type: "dispatch" });
    expect(blocked).toMatchObject({ outcome: "blocked", effects: [] });
    expect(blocked.state).toEqual(accepted.state);

    const admitted = step(accepted.state, { type: "admission", result: "admitted" });
    expect(admitted.state.chargeHeld).toBe(true);
    expect(step(admitted.state, { type: "dispatch" }).outcome).toBe("accepted");
  });

  it("joins a repeated managed request without a second admission effect", () => {
    const accepted = step(managed(), ensure);
    const joined = step(accepted.state, ensure);
    expect(joined).toMatchObject({ outcome: "joined", effects: [] });
    expect(joined.state).toEqual(accepted.state);
  });

  it("requires fresh admission for a managed exec while retaining its held charge", () => {
    const state = drained();
    expect(state.chargeHeld).toBe(true);

    const next = {
      ...ensure,
      kind: "exec",
      key: "managed-exec",
      operationId: "managed-exec",
      runtimeRunning: true,
    } as const;
    const accepted = step(state, next);
    expect(accepted).toMatchObject({
      outcome: "accepted",
      state: {
        phase: "queued",
        admission: "waiting",
        chargeHeld: true,
        operation: { id: next.operationId, kind: "exec", status: "NOT_STARTED", drained: false },
      },
      effects: [
        expect.objectContaining({ kind: "request-admission", operationId: next.operationId }),
      ],
    });

    const blocked = step(accepted.state, { type: "dispatch" });
    expect(blocked).toMatchObject({ outcome: "blocked", effects: [] });
    expect(blocked.state).toEqual(accepted.state);

    const readmitted = step(accepted.state, { type: "admission", result: "admitted" });
    expect(readmitted.state.chargeHeld).toBe(true);
    expect(step(readmitted.state, { type: "dispatch" }).outcome).toBe("accepted");
  });
});
