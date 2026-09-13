import { processBirthIdentity } from "./file-lock";
import { reliabilityFence } from "./reliability-contract";
import { reconcileDrained } from "./reliability-lifecycle";
import { stepReliability } from "./reliability-model";
import {
  type ReliabilityIdentity,
  type ReliabilityOperationRecord,
  readReliabilityOperation,
  updateReliabilityOperation,
} from "./reliability-operation-store";
import { workerGroupAbsent } from "./reliability-worker";
import {
  comparableWorkspacePath,
  isLinkedWorktree,
  readPersistedWorkspace,
  resolveWorktreeWorkspace,
  withWorkspaceLifecycleLock,
} from "./workspace";
import { resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

export type WorkspaceJournalSettleResult = {
  repoPath: string;
  workspace: string | null;
  operationId: string;
  status: "settled" | "already-settled";
  priorStatus: string;
};

/**
 * First-class settlement for a record whose lifecycle worker is provably gone.
 * Settle never claims anything about workloads, routes, or registrations: it
 * marks the recorded operation INTERRUPTED and drained so the normal supersede
 * proofs (stop, ensure) can make progress again. Agents must never hand-edit
 * ~/.config/devrouter; this command is the supported equivalent.
 */
export async function settleWorkspaceJournal(
  repoPath: string,
): Promise<WorkspaceJournalSettleResult> {
  repoPath = comparableWorkspacePath(repoPath);
  if (isLinkedWorktree(repoPath) && !readPersistedWorkspace(repoPath)) {
    throw new Error("Settle requires the existing linked workspace identity.");
  }
  const identity: ReliabilityIdentity = {
    repoPath,
    workspace: resolveWorktreeWorkspace(repoPath) ?? null,
    provider: resolveWorkspaceRuntimeOrDefault(repoPath),
  };
  if (!readReliabilityOperation(identity)) {
    throw new Error(`No reliability journal exists for '${repoPath}'; nothing to settle.`);
  }
  const settled = await withWorkspaceLifecycleLock(repoPath, async () =>
    updateReliabilityOperation(identity, (record) => settleRecord(record)),
  );
  return { repoPath, workspace: identity.workspace, ...settled };
}

function settleRecord(record: ReliabilityOperationRecord): {
  operationId: string;
  status: "settled" | "already-settled";
  priorStatus: string;
} {
  if (record.worker) {
    const birth = processBirthIdentity(record.worker.pid);
    if (birth === record.worker.birth || !workerGroupAbsent(record.worker.pid)) {
      throw new Error(
        `Lifecycle worker '${record.worker.id}' is still running; settle is refused while its outcome is observable.`,
      );
    }
    // The worker group is provably gone; record its interruption and drain it
    // exactly as the close handler would have.
    reconcileDrained(record);
    if (record.worker) throw new Error("Dead lifecycle worker could not be drained.");
  }
  const operation = record.state.operation;
  if (!operation) throw new Error("No lifecycle operation is recorded; nothing to settle.");
  const priorStatus = operation.status;
  const transition = stepReliability(
    record.state,
    { ...reliabilityFence(record.state), type: "settle", operationId: operation.id },
    Date.now(),
  );
  if (!["accepted", "joined"].includes(transition.outcome))
    throw new Error(
      `Lifecycle settlement is ${transition.outcome}.${transition.reason ? ` ${transition.reason}` : ""}`,
    );
  record.state = transition.state;
  return {
    operationId: operation.id,
    status: transition.outcome === "joined" ? "already-settled" : "settled",
    priorStatus,
  };
}
