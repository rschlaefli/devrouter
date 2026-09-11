import { describe, expect, it } from "vitest";
import { createReliabilityState, type ReliabilityState } from "../reliability-contract";
import { decideRecovery } from "../reliability-model";

const NOW = 200;

function runningState(overrides: Partial<ReliabilityState> = {}): ReliabilityState {
  const state = createReliabilityState("env-1", 1);
  state.desired = "running";
  state.phase = "stable";
  state.profile = "full";
  state.admission = "admitted";
  state.consumers = [{ id: "consumer-1", requiredCapabilities: ["app-1"], pinned: false }];
  state.observations = [
    {
      capability: "app-1",
      infrastructure: "healthy",
      application: "verified",
      observedAtMs: 100,
      validForMs: 15_000,
    },
  ];
  return Object.assign(state, overrides);
}

function failed(state: ReliabilityState): ReliabilityState {
  state.observations = [
    {
      capability: "app-1",
      infrastructure: "failed",
      application: "unverified",
      observedAtMs: 100,
      validForMs: 15_000,
    },
  ];
  return state;
}

function decide(state: ReliabilityState, options: { actionLimit?: number; dwell?: boolean } = {}) {
  return decideRecovery({
    state,
    nowMs: NOW,
    actionLimit: options.actionLimit ?? 3,
    pressureDwellSatisfied: options.dwell ?? false,
  });
}

describe("decideRecovery", () => {
  it("never recommends an action for unmanaged or user-stopped environments", () => {
    expect(decide(createReliabilityState("env-1", 1, "manual"))).toEqual({
      action: "none",
      reason: "unmanaged",
    });
    expect(decide(createReliabilityState("env-1", 1))).toEqual({
      action: "none",
      reason: "user-stopped",
    });
  });

  it("stays idle while required capabilities are healthy", () => {
    expect(decide(runningState())).toEqual({ action: "none", reason: "healthy" });
  });

  it("opens an incident when a required capability fails", () => {
    expect(decide(failed(runningState()), { actionLimit: 3 })).toEqual({
      action: "start",
      reason: "recovery-eligible",
      actionLimit: 3,
    });
  });

  it("continues an incident that still has allowance", () => {
    expect(
      decide(
        failed(
          runningState({
            incident: { id: "incident-1", correctiveActionsTaken: 1, actionLimit: 3 },
          }),
        ),
      ),
    ).toEqual({
      action: "continue",
      reason: "recovery-eligible",
      incidentId: "incident-1",
      actionLimit: 3,
    });
  });

  it("blocks once the incident budget is exhausted", () => {
    expect(
      decide(
        failed(
          runningState({
            incident: { id: "incident-1", correctiveActionsTaken: 3, actionLimit: 3 },
          }),
        ),
      ),
    ).toEqual({ action: "blocked", reason: "budget-exhausted" });
  });

  it("waits for a dispatchable operation to drain first", () => {
    const state = failed(
      runningState({
        operation: {
          id: "op-1",
          kind: "ensure",
          drained: false,
          status: "RUNNING",
          exitCode: null,
        },
      }),
    );
    expect(decide(state)).toEqual({ action: "none", reason: "active-operation" });
  });

  it("ignores stale failure evidence", () => {
    const state = failed(runningState({ observationsAfterMs: 150 }));
    expect(decide(state)).toEqual({ action: "none", reason: "healthy" });
  });

  it("resumes a parked environment only once every condition holds", () => {
    const parked = (overrides: Partial<ReliabilityState> = {}) =>
      runningState({
        desired: "parked-for-capacity",
        phase: "stopping",
        admission: "admitted",
        chargeHeld: false,
        stopProof: { workloadsStopped: true, routesRemoved: true },
        operation: {
          id: "op-1",
          kind: "ensure",
          drained: true,
          status: "COMPLETED",
          exitCode: 0,
        },
        ...overrides,
      });

    expect(decide(parked(), { dwell: true })).toEqual({ action: "resume", reason: "parked" });
    expect(decide(parked(), { dwell: false })).toEqual({ action: "none", reason: "parked" });
    expect(
      decide(parked({ stopProof: { workloadsStopped: true, routesRemoved: false } }), {
        dwell: true,
      }),
    ).toEqual({ action: "none", reason: "parked" });
    expect(decide(parked({ consumers: [] }), { dwell: true })).toEqual({
      action: "none",
      reason: "parked",
    });
  });

  it("rejects an invalid recovery budget", () => {
    expect(() => decide(failed(runningState()), { actionLimit: 0 })).toThrow(/budget/);
  });
});
