import { expect, it, vi } from "vitest";
import { admitLifecycleCapacity, bindLifecycleCapacity } from "../reliability-lifecycle";

type GuardRecord = {
  state: {
    environmentId: string;
    intentRevision: number;
    runtimeGeneration: number;
    controllerEpoch: number;
    operation: { id: string; status: string; drained: boolean };
  };
  worker: { id: string } | null;
  capacity?: unknown;
};
const fixture = vi.hoisted(() => ({
  record: {} as GuardRecord,
  reserve: vi.fn(),
  assertEffect: vi.fn(),
}));
vi.mock("../capacity-store", () => ({
  CapacityStore: class {
    read() {
      return { revision: 1, reservations: [] };
    }
    reserve = fixture.reserve;
  },
}));
vi.mock("../reliability-operation-store", () => ({
  updateReliabilityOperation: (_identity: unknown, operation: (record: unknown) => unknown) =>
    operation(fixture.record),
  assertCapacityEffect: fixture.assertEffect,
}));

it.each([
  "drained",
  "completed",
  "dispatch-recorded",
  "active-worker",
])("never rebinds %s intent", (state) => {
  const fence = {
    environmentId: "synthetic",
    intentRevision: 1,
    runtimeGeneration: 1,
    controllerEpoch: 1,
  };
  const identity = {
    repoPath: "/tmp/synthetic-retired-intent",
    workspace: null,
    provider: "devsy" as const,
  };
  const request = {
    kind: "ensure" as const,
    repoPath: identity.repoPath,
    identity,
    requestId: "request",
    operationId: "operation",
    workerId: "worker",
    fence,
    options: {},
  };
  fixture.record = {
    state: {
      ...fence,
      operation: {
        id: "operation",
        status:
          state === "completed"
            ? "COMPLETED"
            : state === "dispatch-recorded"
              ? "DISPATCH_RECORDED"
              : "NOT_STARTED",
        drained: state === "drained",
      },
    },
    worker: state === "active-worker" ? { id: "prior-worker" } : null,
  };
  fixture.reserve.mockClear();
  fixture.assertEffect.mockClear();
  expect(() =>
    admitLifecycleCapacity(
      request,
      {
        environmentId: "synthetic",
        operationId: "operation",
        reservationId: "reservation",
        policyRevision: 1,
        totals: { host: 1 },
        startup: true,
        heavy: false,
      },
      {},
      {},
      100,
      15,
    ),
  ).toThrow("intent changed");
  expect(() =>
    bindLifecycleCapacity(request, {
      reservationId: "reservation",
      policyRevision: 1,
      validUntilMs: 200,
    }),
  ).toThrow("intent changed");
  expect(fixture.reserve).not.toHaveBeenCalled();
  expect(fixture.assertEffect).not.toHaveBeenCalled();
  expect(fixture.record.capacity).toBeUndefined();
});
