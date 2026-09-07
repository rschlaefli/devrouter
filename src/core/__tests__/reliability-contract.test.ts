import { describe, expect, it } from "vitest";
import {
  assertReliabilityState,
  createReliabilityState,
  RELIABILITY_MAX_ITEMS,
  reliabilityFence,
} from "../reliability-contract";

describe("reliability state contract", () => {
  it("starts without claiming absent resources or readiness", () => {
    const state = createReliabilityState("environment-1", 1);
    expect(state.stopProof).toEqual({ workloadsStopped: false, routesRemoved: false });
    expect(state.admission).toBe("unknown");
    expect(reliabilityFence(state)).toEqual({
      environmentId: "environment-1",
      controllerEpoch: 1,
      runtimeGeneration: 0,
      intentRevision: 0,
    });
  });

  it.each([
    { contractVersion: 1 },
    { intentRevision: -1 },
    { controllerEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { runtimeGeneration: NaN },
    { admission: "available" },
    { environmentId: "../../secret" },
    { phase: "ready" },
    { desired: "restarting" },
    { stopProof: { workloadsStopped: true } },
    { operation: { id: "op", status: "COMPLETED", exitCode: null } },
    { operation: { id: "op", status: "RUNNING", exitCode: 0 } },
    { incident: { id: "incident", correctiveActionsTaken: 3, actionLimit: 2 } },
    {
      observations: [
        {
          capability: "api",
          infrastructure: "healthy",
          application: "verified",
          observedAtMs: 0,
          validForMs: Infinity,
        },
      ],
    },
    {
      requests: [
        {
          key: "request",
          consumerId: "consumer",
          operationId: "op",
          profile: "small",
          intentRevision: 1,
        },
      ],
    },
    { consumers: [{ id: "consumer", requiredCapabilities: ["api", "api"], pinned: false }] },
  ])("rejects invalid state %j", (override) => {
    expect(() =>
      assertReliabilityState({ ...createReliabilityState("environment-1", 1), ...override }),
    ).toThrow();
  });

  it("keeps manual authority separate from capacity-managed state", () => {
    const state = createReliabilityState("environment-1", 1, "manual");
    expect(state.executionPolicy).toBe("manual");
    expect(state.admission).toBe("not-applicable");
    expect(() => assertReliabilityState({ ...state, admission: "admitted" })).toThrow();
    expect(() => assertReliabilityState({ ...state, chargeHeld: true })).toThrow();
    expect(() => assertReliabilityState({ ...state, desired: "parked-for-capacity" })).toThrow();
    expect(() =>
      assertReliabilityState({ ...state, executionPolicy: "capacity-managed" }),
    ).toThrow();
  });

  it("rejects duplicate consumer identity and bounded collection overflow", () => {
    const consumer = { id: "consumer", requiredCapabilities: ["api"], pinned: false };
    const state = createReliabilityState("environment-1", 1);
    expect(() => assertReliabilityState({ ...state, consumers: [consumer, consumer] })).toThrow();
    expect(() =>
      assertReliabilityState({
        ...state,
        consumers: Array.from({ length: RELIABILITY_MAX_ITEMS + 1 }, (_, i) => ({
          ...consumer,
          id: `consumer-${i}`,
        })),
      }),
    ).toThrow();
  });
});
