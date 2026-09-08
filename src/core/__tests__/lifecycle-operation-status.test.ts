import { expect, it, vi } from "vitest";
import {
  projectLifecycleOperation,
  readLifecycleOperationStatus,
} from "../lifecycle-operation-status";
import type { ReliabilityOperation } from "../reliability-contract";

const fixture = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../reliability-operation-store", () => ({ readReliabilityOperation: fixture.read }));

it.each([
  ["NOT_STARTED", false, "queued", null],
  ["NOT_STARTED", true, "terminal", "NOT_STARTED"],
  ["DISPATCH_PENDING", false, "dispatching", null],
  ["DISPATCH_RECORDED", false, "dispatching", null],
  ["RUNNING", false, "running", null],
  ["RUNNING", true, "terminal", "COMPLETION_UNKNOWN"],
  ["NOT_LAUNCHED", false, "terminal", "NOT_STARTED"],
  ["INTERRUPTED", false, "terminal", "INTERRUPTED"],
  ["COMPLETION_UNKNOWN", true, "terminal", "COMPLETION_UNKNOWN"],
] as const)("projects %s drained=%s from journal evidence", (status, drained, phase, outcome) => {
  expect(
    projectLifecycleOperation({ id: "operation", kind: "exec", status, drained, exitCode: null }),
  ).toMatchObject({ operationId: "operation", phase, outcome, exitCode: null });
});

it("retains a completed nonzero exit code independently of worker drainage", () => {
  expect(
    projectLifecycleOperation({
      id: "operation",
      kind: "exec",
      status: "COMPLETED",
      drained: false,
      exitCode: 7,
    }),
  ).toEqual({
    operationId: "operation",
    phase: "terminal",
    outcome: "COMPLETED",
    exitCode: 7,
    reason: null,
  });
});

it("reconnects to retained history without substituting the current operation", () => {
  const old: ReliabilityOperation = {
    id: "old",
    kind: "exec",
    status: "COMPLETED",
    drained: true,
    exitCode: 3,
  };
  fixture.read.mockReturnValue({
    state: {
      operation: { ...old, id: "current", status: "NOT_STARTED", drained: false, exitCode: null },
      operationHistory: [old],
    },
  });
  const identity = {
    repoPath: "/tmp/synthetic-status",
    workspace: null,
    provider: "devsy" as const,
  };
  expect(readLifecycleOperationStatus(identity, "old")).toMatchObject({
    operationId: "old",
    outcome: "COMPLETED",
    exitCode: 3,
  });
  expect(readLifecycleOperationStatus(identity, "current")).toMatchObject({
    phase: "queued",
    outcome: null,
  });
  expect(readLifecycleOperationStatus(identity, "missing")).toBeUndefined();
});
