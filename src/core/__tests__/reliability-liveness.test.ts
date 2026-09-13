import { describe, expect, it } from "vitest";
import {
  createReliabilityState,
  type ReliabilityEvent,
  type ReliabilityState,
  reliabilityFence,
} from "../reliability-contract";
import { stepReliability } from "../reliability-model";

type Input = ReliabilityEvent extends infer Event
  ? Event extends ReliabilityEvent
    ? Omit<Event, keyof ReturnType<typeof reliabilityFence>>
    : never
  : never;

const consumer = { id: "manual-cli", requiredCapabilities: [], pinned: false };

function step(state: ReliabilityState, event: Input, nowMs = 100) {
  return stepReliability(
    state,
    { ...reliabilityFence(state), ...event } as ReliabilityEvent,
    nowMs,
  );
}

function ensureRequest(index: number | string, kind: "ensure" | "exec" = "ensure") {
  return {
    type: "operation-request",
    kind,
    key: `request-${index}`,
    operationId: `op-${index}`,
    profile: "manage,chat",
    consumer,
    runtimeRunning: kind === "exec",
  } as const;
}

/** Runs one accepted operation through dispatch to a drained completion. */
function finish(state: ReliabilityState, operationId: string): ReliabilityState {
  state = step(state, { type: "dispatch" }).state;
  const persisted = step(state, { type: "dispatch-persisted", operationId });
  expect(
    persisted.effects.some((effect) => effect.kind === "launch"),
    "dispatch persistence must launch",
  ).toBe(true);
  state = persisted.state;
  state = step(state, { type: "launched", operationId }).state;
  state = step(state, { type: "completion", operationId, exitCode: 0 }).state;
  return step(state, { type: "drained", operationId }).state;
}

function acceptEnsure(state: ReliabilityState, index: number | string): ReliabilityState {
  const result = step(state, ensureRequest(index));
  expect(result.outcome).toBe("accepted");
  return result.state;
}

/** Fills the journal with 128 completed ensure cycles. */
function saturated(): ReliabilityState {
  let state = createReliabilityState("env", 1, "manual");
  for (let index = 0; index < 128; index++)
    state = finish(acceptEnsure(state, index), `op-${index}`);
  return state;
}

/**
 * Mirrors reconcileDrained: once the worker group is provably gone, the CLI
 * records the interruption and drains the operation before any command runs.
 */
function reconcileWorkerLoss(state: ReliabilityState): ReliabilityState {
  const operation = state.operation;
  if (!operation || operation.drained) return state;
  if (
    ["DISPATCH_PENDING", "DISPATCH_RECORDED", "RUNNING", "COMPLETION_UNKNOWN"].includes(
      operation.status,
    )
  ) {
    state = step(state, { type: "interrupted", operationId: operation.id }).state;
  }
  return step(state, { type: "drained", operationId: operation.id }).state;
}

/** Leaves the operation mid-flight exactly at the given crash point. */
function crashEnsureAt(
  state: ReliabilityState,
  point:
    | "requested"
    | "dispatch-pending"
    | "dispatch-recorded"
    | "running"
    | "completion-unknown"
    | "completed",
): ReliabilityState {
  const operationId = `op-crash`;
  state = acceptEnsure(state, "crash");
  switch (point) {
    case "requested":
      return state;
    case "dispatch-pending":
      return step(state, { type: "dispatch" }).state;
    case "dispatch-recorded": {
      state = step(state, { type: "dispatch" }).state;
      return step(state, { type: "dispatch-persisted", operationId }).state;
    }
    case "running": {
      state = step(state, { type: "dispatch" }).state;
      state = step(state, { type: "dispatch-persisted", operationId }).state;
      return step(state, { type: "launched", operationId }).state;
    }
    case "completion-unknown": {
      state = step(state, { type: "dispatch" }).state;
      state = step(state, { type: "dispatch-persisted", operationId }).state;
      state = step(state, { type: "launched", operationId }).state;
      // A stop or generation change turns a running operation into unknown.
      return step(state, { type: "stop" }).state;
    }
    case "completed": {
      state = step(state, { type: "dispatch" }).state;
      state = step(state, { type: "dispatch-persisted", operationId }).state;
      state = step(state, { type: "launched", operationId }).state;
      return step(state, { type: "completion", operationId, exitCode: 0 }).state;
    }
  }
}

/**
 * An ensure makes progress when its admission is accepted and it can reach a
 * persisted dispatch (the launch effect), possibly after automatic worker-loss
 * reconciliation.
 */
function ensureReachesLaunch(state: ReliabilityState): boolean {
  state = reconcileWorkerLoss(state);
  const admission = step(state, ensureRequest("recovery"));
  if (admission.outcome !== "accepted") return false;
  let next = admission.state;
  const dispatch = step(next, { type: "dispatch" });
  if (dispatch.outcome !== "accepted") return false;
  next = dispatch.state;
  const persisted = step(next, { type: "dispatch-persisted", operationId: "op-recovery" });
  return (
    persisted.outcome === "accepted" && persisted.effects.some((effect) => effect.kind === "launch")
  );
}

/**
 * From ANY journal-saturated state reachable by crashing an ensure at any
 * step, at least one canonical command must make progress: either the ensure
 * reaches a launch, or a stop completes its proof (after which ensure reaches
 * a launch). This is the exact repro of the 2026-09-10 deadlock where a
 * saturated journal permanently refused every command behind a drained
 * INTERRUPTED ensure.
 */
describe("reliability journal liveness under a saturated cap", () => {
  const crashPoints = [
    "requested",
    "dispatch-pending",
    "dispatch-recorded",
    "running",
    "completion-unknown",
    "completed",
  ] as const;

  it("admits ensure after a completed stop against a saturated journal (incident repro)", () => {
    let state = crashEnsureAt(saturated(), "running");
    state = reconcileWorkerLoss(state);
    expect(state.operation?.status).toBe("INTERRUPTED");
    // The guard-ordered stop --delete completes and settles its proof.
    const stopped = step(state, { type: "stop" });
    expect(stopped.outcome).toBe("accepted");
    state = step(stopped.state, {
      type: "stop-proof",
      workloadsStopped: true,
      routesRemoved: true,
    }).state;
    expect(state.stopProof).toEqual({ workloadsStopped: true, routesRemoved: true });
    expect(ensureReachesLaunch(state)).toBe(true);
  });

  for (const stopProofSettled of [false, true]) {
    for (const point of crashPoints) {
      it(`crash at ${point} with ${stopProofSettled ? "completed" : "absent"} stop proof still progresses`, () => {
        let state = crashEnsureAt(saturated(), point);
        state = reconcileWorkerLoss(state);
        if (stopProofSettled) {
          state = step(state, { type: "stop" }).state;
          state = step(state, {
            type: "stop-proof",
            workloadsStopped: true,
            routesRemoved: true,
          }).state;
        }
        if (ensureReachesLaunch(state)) return;
        // Ensure is not admissible: a stop must be, and it must settle the
        // proof so the following ensure reaches a launch.
        const reconciled = reconcileWorkerLoss(state);
        const stop = step(reconciled, { type: "stop" });
        expect(["accepted", "joined"]).toContain(stop.outcome);
        const proof = step(stop.state, {
          type: "stop-proof",
          workloadsStopped: true,
          routesRemoved: true,
        });
        expect(proof.outcome).toBe("accepted");
        expect(ensureReachesLaunch(proof.state)).toBe(true);
      });
    }
  }

  it("retires exactly one drained INTERRUPTED entry per saturated replacement", () => {
    let state = crashEnsureAt(saturated(), "running");
    state = reconcileWorkerLoss(state);
    const before = state.operationHistory.length;
    state = finish(acceptEnsure(state, "recovery"), "op-recovery");
    expect(state.operationHistory.length).toBe(Math.min(before, 128));
  });
});

/**
 * Randomized walk over command-shaped event sequences. After every step the
 * walk asserts the liveness property from the reachable state, including with
 * a saturated journal, across 200 seeded rounds.
 */
describe("reliability journal liveness under randomized crashes", () => {
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function assertLiveness(state: ReliabilityState) {
    const reconciled = reconcileWorkerLoss(state);
    if (ensureReachesLaunch(reconciled)) return;
    const stop = step(reconciled, { type: "stop" });
    expect(["accepted", "joined"]).toContain(stop.outcome);
    const proof = step(stop.state, {
      type: "stop-proof",
      workloadsStopped: true,
      routesRemoved: true,
    });
    expect(proof.outcome).toBe("accepted");
    expect(ensureReachesLaunch(proof.state)).toBe(true);
  }

  it("keeps at least one canonical command progressing across 200 seeded rounds", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = mulberry32(seed);
      let state = createReliabilityState("env", 1, "manual");
      let counter = 0;
      for (let stepIndex = 0; stepIndex < 400; stepIndex++) {
        const operation = state.operation;
        const choice = random();
        if (
          !operation ||
          operation.drained ||
          ![
            "DISPATCH_PENDING",
            "DISPATCH_RECORDED",
            "RUNNING",
            "COMPLETION_UNKNOWN",
            "NOT_STARTED",
          ].includes(operation.status)
        ) {
          if (choice < 0.7) {
            const result = step(state, ensureRequest(`fuzz-${counter++}`, "ensure"));
            if (result.outcome === "accepted") state = result.state;
          } else {
            state = step(state, { type: "stop" }).state;
          }
        } else if (choice < 0.25) {
          state = step(state, { type: "dispatch" }).state;
        } else if (choice < 0.45) {
          const persisted = step(state, {
            type: "dispatch-persisted",
            operationId: operation.id,
          });
          if (persisted.outcome === "accepted") state = persisted.state;
        } else if (choice < 0.6) {
          const launched = step(state, { type: "launched", operationId: operation.id });
          if (launched.outcome === "accepted") state = launched.state;
        } else if (choice < 0.75) {
          const completed = step(state, {
            type: "completion",
            operationId: operation.id,
            exitCode: 0,
          });
          if (completed.outcome === "accepted") state = completed.state;
        } else if (choice < 0.9) {
          state = step(state, { type: "stop" }).state;
        } else {
          state = step(state, {
            type: "stop-proof",
            workloadsStopped: random() < 0.85,
            routesRemoved: true,
          }).state;
        }
        assertLiveness(state);
      }
    }
  }, 120_000);
});
