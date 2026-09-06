import { describe, expect, it } from "vitest";
import { createReliabilityState, type ReliabilityState } from "../reliability-contract";
import { encodeReliability, projectReliability } from "../reliability-output";

function readyState(): ReliabilityState {
  return {
    ...createReliabilityState("environment-1", 1),
    desired: "running",
    phase: "stable",
    admission: "admitted",
    chargeHeld: true,
    consumers: [{ id: "consumer", requiredCapabilities: ["api"], pinned: false }],
    observations: [
      {
        capability: "api",
        infrastructure: "healthy",
        application: "verified",
        observedAtMs: 100,
        validForMs: 50,
      },
    ],
  };
}

describe("reliability projection", () => {
  it("rejects oversized output instead of emitting truncated JSON", () => {
    const state = readyState();
    state.observations = Array.from({ length: 128 }, (_, index) => ({
      capability: `${index}`.padEnd(128, "a"),
      infrastructure: "healthy",
      application: "verified",
      observedAtMs: Number.MAX_SAFE_INTEGER,
      validForMs: Number.MAX_SAFE_INTEGER,
    }));
    state.consumers[0].requiredCapabilities = state.observations.map((entry) => entry.capability);
    expect(() => encodeReliability(state, "consumer", Number.MAX_SAFE_INTEGER)).toThrow();
  });

  it("requires fresh declared capability proof, including exact expiry", () => {
    const state = readyState();
    expect(projectReliability(state, "consumer", 149).state).toBe("READY");
    expect(projectReliability(state, "consumer", 150).state).toBe("UNKNOWN");
    expect(projectReliability(state, "consumer", 99).state).toBe("UNKNOWN");
    state.consumers[0].requiredCapabilities = [];
    expect(projectReliability(state, "consumer", 100).state).toBe("UNKNOWN");
  });

  it("reports optional failure without blocking required capabilities", () => {
    const state = readyState();
    state.observations.push({
      capability: "worker",
      infrastructure: "failed",
      application: "unverified",
      observedAtMs: 100,
      validForMs: 50,
    });
    const result = projectReliability(state, "consumer", 110);
    expect(result.state).toBe("READY");
    expect(result.capabilities.find((entry) => entry.capability === "worker")).toMatchObject({
      required: false,
      infrastructure: "failed",
    });
    state.consumers[0].requiredCapabilities.push("worker");
    expect(projectReliability(state, "consumer", 110).state).toBe("BLOCKED");
  });

  it("distinguishes application failure from infrastructure failure", () => {
    const state = readyState();
    state.observations[0].application = "unready";
    expect(projectReliability(state, "consumer", 110).state).toBe("APP_ERROR");
    state.observations[0].infrastructure = "unknown";
    expect(projectReliability(state, "consumer", 110).state).toBe("UNKNOWN");
  });

  it("reports fresh readiness failure during verification instead of indefinite startup", () => {
    const state = readyState();
    state.phase = "verifying";
    state.observations[0].application = "unready";
    expect(projectReliability(state, "consumer", 110).state).toBe("APP_ERROR");
    state.observations[0].infrastructure = "failed";
    expect(projectReliability(state, "consumer", 110).state).toBe("BLOCKED");
    expect(projectReliability(state, "consumer", 150).state).toBe("STARTING");
  });

  it.each([
    "COMPLETION_UNKNOWN",
    "INTERRUPTED",
  ] as const)("does not hide %s behind healthy observations", (status) => {
    const state = { ...readyState(), operation: { id: "operation", status, exitCode: null } };
    expect(projectReliability(state, "consumer", 110).state).toBe("BLOCKED");
  });

  it("requires complete stop proof and released charge to claim parking", () => {
    const state = readyState();
    state.desired = "parked-for-capacity";
    state.admission = "waiting";
    state.stopProof.workloadsStopped = true;
    expect(projectReliability(state, "consumer", 110).state).toBe("BLOCKED");
    state.stopProof.routesRemoved = true;
    expect(projectReliability(state, "consumer", 110).state).toBe("BLOCKED");
    state.chargeHeld = false;
    expect(projectReliability(state, "consumer", 110).state).toBe("PARKED_CAPACITY");
    state.desired = "stopped-by-user";
    expect(projectReliability(state, "consumer", 110).state).toBe("STOPPED");
  });

  it.each([
    "waiting",
    "unknown",
    "denied-unadmittable",
  ] as const)("does not claim ready when admission is %s", (admission) => {
    expect(projectReliability({ ...readyState(), admission }, "consumer", 110).state).not.toBe(
      "READY",
    );
  });

  it("rejects missing consumers without returning another consumer's capabilities", () => {
    const result = projectReliability(readyState(), "other-consumer", 110);
    expect(result.state).toBe("BLOCKED");
    expect(result.requiredCapabilities).toEqual([]);
  });

  it("serializes only approved fields at every nested level", () => {
    const secret = "synthetic-secret-not-a-real-credential";
    const state = {
      ...readyState(),
      token: secret,
      operation: { id: "operation", status: "COMPLETED" as const, exitCode: 17, argv: [secret] },
      incident: { id: "incident", correctiveActionsTaken: 1, actionLimit: 2, rawError: secret },
    };
    Object.assign(state.observations[0], { payload: secret });
    Object.assign(state.consumers[0], { email: secret });
    const encoded = encodeReliability(state, "consumer", 110);
    expect(encoded).not.toContain(secret);
    expect(JSON.parse(encoded).operation.exitCode).toBe(17);
  });
});
