import type { ReliabilityOperation } from "./reliability-contract";
import { type ReliabilityIdentity, readReliabilityOperation } from "./reliability-operation-store";

export type LifecycleOperationStatus = {
  operationId: string;
  phase: "queued" | "dispatching" | "running" | "terminal";
  outcome: "NOT_STARTED" | "COMPLETED" | "INTERRUPTED" | "COMPLETION_UNKNOWN" | null;
  reason: string | null;
  exitCode: number | null;
};

/** Project journal evidence without interpreting supervisor completion as command success. */
export function projectLifecycleOperation(
  operation: ReliabilityOperation,
): LifecycleOperationStatus {
  const result: LifecycleOperationStatus = {
    operationId: operation.id,
    phase: "terminal",
    outcome: null,
    reason: null,
    exitCode: null,
  };
  switch (operation.status) {
    case "NOT_STARTED":
      if (operation.drained) result.outcome = "NOT_STARTED";
      else result.phase = "queued";
      break;
    case "DISPATCH_PENDING":
    case "DISPATCH_RECORDED":
    case "RUNNING":
      if (operation.drained) {
        result.outcome = "COMPLETION_UNKNOWN";
        result.reason = "worker-drained-without-result";
      } else result.phase = operation.status === "RUNNING" ? "running" : "dispatching";
      break;
    case "COMPLETED":
      result.outcome = "COMPLETED";
      result.exitCode = operation.exitCode;
      break;
    case "NOT_LAUNCHED":
      result.outcome = "NOT_STARTED";
      break;
    case "INTERRUPTED":
    case "COMPLETION_UNKNOWN":
      result.outcome = operation.status;
      break;
  }
  return result;
}

/** Reconnection reads current or retained history; it never recreates a command payload. */
export function readLifecycleOperationStatus(
  identity: ReliabilityIdentity,
  operationId: string,
): LifecycleOperationStatus | undefined {
  const record = readReliabilityOperation(identity);
  if (!record) return undefined;
  const operation =
    record.state.operation?.id === operationId
      ? record.state.operation
      : record.state.operationHistory.find((entry) => entry.id === operationId);
  return operation ? projectLifecycleOperation(operation) : undefined;
}
