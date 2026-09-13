import { processBirthIdentity } from "./file-lock";
import { type ReliabilityFence, reliabilityFence } from "./reliability-contract";
import { type ReliabilityIdentity, readReliabilityOperation } from "./reliability-operation-store";

export type NetworkOperationAuthority = {
  operationId: string;
  workerId: string;
  fence: ReliabilityFence;
};

/** Read under the provider lock, before the shorter network allocation lock. */
export function readNetworkOperationAuthority(
  identity: ReliabilityIdentity,
): NetworkOperationAuthority {
  const record = readReliabilityOperation(identity);
  const worker = record?.worker;
  if (
    !record ||
    !worker ||
    worker.pid !== process.pid ||
    worker.birth !== processBirthIdentity(process.pid) ||
    !record.state.operation ||
    record.state.operation.id !== worker.operationId ||
    record.state.operation.drained ||
    record.state.operation.status !== "RUNNING"
  ) {
    throw new Error("Network allocation requires the current owned lifecycle worker.");
  }
  return {
    operationId: worker.operationId,
    workerId: worker.id,
    fence: reliabilityFence(record.state),
  };
}

/** Pure atomic-record read; never acquire the lifecycle lock under the allocation lock. */
export function assertNetworkOperationCurrent(
  identity: ReliabilityIdentity,
  expected: NetworkOperationAuthority,
): void {
  const record = readReliabilityOperation(identity);
  if (
    !record ||
    record.worker?.id !== expected.workerId ||
    record.worker?.operationId !== expected.operationId ||
    record.state.operation?.id !== expected.operationId ||
    record.state.operation?.status !== "RUNNING" ||
    record.state.operation?.drained ||
    Object.entries(expected.fence).some(
      ([key, value]) => record.state[key as keyof ReliabilityFence] !== value,
    )
  ) {
    throw new Error(
      "Network allocation operation was superseded; retained claims require reconciliation.",
    );
  }
}

export function networkOperationSettled(
  identity: ReliabilityIdentity,
  operationId: string,
  current?: NetworkOperationAuthority,
): boolean {
  if (current) {
    assertNetworkOperationCurrent(identity, current);
    if (current.operationId === operationId) return false;
  }
  const record = readReliabilityOperation(identity);
  if (!record || (record.worker && (!current || record.worker.id !== current.workerId)))
    return false;
  const operation = record.state.operationHistory.find((entry) => entry.id === operationId);
  return (
    !!operation?.drained && ["COMPLETED", "NOT_LAUNCHED", "INTERRUPTED"].includes(operation.status)
  );
}
