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
