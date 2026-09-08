import path from "node:path";
import {
  inspectManagedStopContainers,
  inspectWorkspaceContainers,
  resolveRunningWorkspaceContainer,
} from "./devpod-environment";
import { withMutationLock as withDevsyMutationLock } from "./devsy-mutation";
import type { ExecutionOutcome } from "./execution-outcome";
import { processBirthIdentity } from "./file-lock";
import { listHostRouteState } from "./host-routes";
import { type ManagedRuntimeState, readManagedRuntimeState } from "./managed-runtime-state";
import { proveRetainedManagedStop } from "./managed-stop-recovery";
import { claimLifecycleEffect, installLifecycleEffectClaim } from "./reliability-context";
import {
  type ReliabilityEvent,
  type ReliabilityFence,
  reliabilityFence,
} from "./reliability-contract";
import { stepReliability } from "./reliability-model";
import {
  type ReliabilityIdentity,
  type ReliabilityOperationRecord,
  updateReliabilityOperation,
} from "./reliability-operation-store";
import {
  type LifecycleWorkerRequest,
  newLifecycleIds,
  runLifecycleWorker,
  workerGroupAbsent,
} from "./reliability-worker";
import {
  comparableWorkspacePath,
  isLinkedWorktree,
  readPersistedWorkspace,
  resolveWorktreeWorkspace,
  sameWorkspacePath,
  withWorkspaceLifecycleLock,
} from "./workspace";
import { resolveLinkedTarget } from "./workspace-ensure";
import { resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

export { claimLifecycleEffect } from "./reliability-context";

let activeWorker: LifecycleWorkerRequest | undefined;
let cancelled = false;
let lockHeld = false;
let stopProjects: string[] = [];
let stopBaselineState: ManagedRuntimeState | undefined;

function matchesFence(record: ReliabilityOperationRecord, fence: ReliabilityFence): boolean {
  return Object.entries(reliabilityFence(record.state)).every(
    ([key, value]) => value === fence[key as keyof ReliabilityFence],
  );
}

export function cancelLifecycleWorker(): void {
  cancelled = true;
}

function claimActiveLifecycleEffect(): void {
  const worker = activeWorker;
  if (!worker) return;
  if (cancelled || !process.connected) throw new Error("Lifecycle worker was cancelled.");
  updateReliabilityOperation(worker.identity, (record) => {
    if (
      !matchesFence(record, worker.fence) ||
      (worker.kind !== "stop" && record.worker?.id !== worker.workerId)
    ) {
      throw new Error("Lifecycle intent superseded this worker.");
    }
    if (record.effectSequence === Number.MAX_SAFE_INTEGER)
      throw new Error("Lifecycle effect sequence exhausted.");
    record.effectSequence += 1;
  });
}

export async function withLifecycleOperationLock<T>(
  repoPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (activeWorker && lockHeld) {
    if (!sameWorkspacePath(repoPath, activeWorker.repoPath))
      throw new Error("Lifecycle worker cannot change checkout.");
    claimLifecycleEffect();
    return operation();
  }
  return withWorkspaceLifecycleLock(repoPath, operation);
}

function stepRecord(record: ReliabilityOperationRecord, event: ReliabilityEvent): void {
  const transition = stepReliability(record.state, event, Date.now());
  if (!["accepted", "joined"].includes(transition.outcome))
    throw new Error(`Lifecycle transition is ${transition.outcome}.`);
  record.state = transition.state;
}

function reconcileDrained(record: ReliabilityOperationRecord): void {
  const worker = record.worker;
  if (!worker) {
    if (record.state.operation?.status === "NOT_STARTED" && !record.state.operation.drained) {
      stepRecord(record, {
        ...reliabilityFence(record.state),
        type: "drained",
        operationId: record.state.operation.id,
      });
    }
    return;
  }
  if (processBirthIdentity(worker.pid) === worker.birth || !workerGroupAbsent(worker.pid)) return;
  if (record.state.operation) {
    const interrupted = stepReliability(
      record.state,
      {
        ...reliabilityFence(record.state),
        type: "interrupted",
        operationId: worker.operationId,
      },
      Date.now(),
    );
    record.state = interrupted.state;
    stepRecord(record, {
      ...reliabilityFence(record.state),
      type: "drained",
      operationId: worker.operationId,
    });
    record.worker = null;
  }
}

export async function superviseLifecycle(
  kind: LifecycleWorkerRequest["kind"],
  repoPath: string,
  options: LifecycleWorkerRequest["options"] = {},
  command?: string[],
): Promise<unknown> {
  repoPath = comparableWorkspacePath(repoPath);
  if (isLinkedWorktree(repoPath) && !readPersistedWorkspace(repoPath)) {
    if (kind === "stop") throw new Error("Stop requires the existing linked workspace identity.");
    resolveLinkedTarget(repoPath);
  }
  const identity: ReliabilityIdentity = {
    repoPath,
    workspace: resolveWorktreeWorkspace(repoPath) ?? null,
    provider: resolveWorkspaceRuntimeOrDefault(repoPath),
  };
  const ids = newLifecycleIds();
  let fence!: ReliabilityFence;
  const runtimeRunning =
    kind === "exec" ? Boolean(resolveRunningWorkspaceContainer(repoPath)) : false;
  updateReliabilityOperation(identity, (record) => {
    reconcileDrained(record);
    if (kind === "stop") {
      stepRecord(record, { ...reliabilityFence(record.state), type: "stop" });
    } else {
      if (record.worker)
        throw new Error(
          "An earlier lifecycle worker may still be active; use explicit stop to reconcile it.",
        );
      record.outcome = null;
      stepRecord(record, {
        ...reliabilityFence(record.state),
        type: "operation-request",
        kind,
        key: ids.requestId,
        operationId: ids.operationId,
        profile: options.profile ?? record.state.profile ?? "full",
        consumer: { id: "manual-cli", requiredCapabilities: [], pinned: false },
        runtimeRunning,
      });
    }
    fence = reliabilityFence(record.state);
  });
  return runLifecycleWorker({
    kind,
    repoPath,
    identity,
    ...ids,
    fence,
    options,
    ...(command ? { command } : {}),
  });
}

async function acquireWorkerLock<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    let entered = false;
    try {
      if (cancelled || !process.connected) throw new Error("Lifecycle worker was cancelled.");
      return await withWorkspaceLifecycleLock(repoPath, async () => {
        entered = true;
        return operation();
      });
    } catch (error) {
      if (
        entered ||
        Date.now() >= deadline ||
        !(error instanceof Error) ||
        !error.message.includes("workspace lifecycle is already running")
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function executeLifecycleWorker<T>(
  request: LifecycleWorkerRequest,
  operation: () => Promise<T>,
): Promise<T> {
  if (activeWorker) throw new Error("Lifecycle worker accepts one operation.");
  activeWorker = request;
  installLifecycleEffectClaim(claimActiveLifecycleEffect);
  return acquireWorkerLock(request.repoPath, async () => {
    lockHeld = true;
    try {
      claimLifecycleEffect();
      if (
        resolveWorkspaceRuntimeOrDefault(request.repoPath) !== request.identity.provider ||
        (resolveWorktreeWorkspace(request.repoPath) ?? null) !== request.identity.workspace
      ) {
        throw new Error("Lifecycle provider or workspace identity changed before execution.");
      }
      if (request.kind === "stop") {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const pending = updateReliabilityOperation(request.identity, (record) => {
            reconcileDrained(record);
            return record.worker !== null;
          });
          if (!pending) break;
          if (Date.now() >= deadline)
            throw new Error("Earlier worker cessation is not proven; stop remains pending.");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const retained = readManagedRuntimeState(
          request.repoPath,
          request.identity.workspace ?? undefined,
        );
        if (retained?.stopBaseline) {
          stopBaselineState = retained;
          withDevsyMutationLock("Verify retained stop", request.repoPath, () =>
            proveRetainedManagedStop(retained),
          );
        } else {
          const containers = inspectWorkspaceContainers();
          const owned = containers.filter((container) =>
            sameWorkspacePath(
              container.labels["com.docker.compose.project.working_dir"] ?? "",
              path.join(request.repoPath, ".devcontainer"),
            ),
          );
          const projects = owned.map((container) => container.labels["com.docker.compose.project"]);
          if (projects.some((project) => !project))
            throw new Error("Workspace stop population has incomplete identity.");
          stopProjects = [
            ...new Set([...projects, ...(retained ? [retained.composeProject] : [])]),
          ] as string[];
          for (const project of stopProjects) inspectManagedStopContainers(project);
        }
      } else {
        updateReliabilityOperation(request.identity, (record) => {
          stepRecord(record, {
            ...request.fence,
            type: "launched",
            operationId: request.operationId,
          });
        });
      }
      return await operation();
    } finally {
      lockHeld = false;
    }
  });
}

export function recordLifecycleOutcome(outcome: ExecutionOutcome): void {
  const request = activeWorker;
  if (request?.kind !== "exec") return;
  updateReliabilityOperation(request.identity, (record) => {
    if (!matchesFence(record, request.fence) || record.state.operation?.id !== request.operationId)
      return;
    const event: ReliabilityEvent =
      outcome.status === "completed" && outcome.exitCode !== null
        ? {
            ...request.fence,
            type: "completion",
            operationId: request.operationId,
            exitCode: outcome.exitCode,
          }
        : {
            ...request.fence,
            type: outcome.status === "not-started" ? "not-started" : "interrupted",
            operationId: request.operationId,
          };
    stepRecord(record, event);
    record.outcome = { ...outcome, operationId: request.operationId };
  });
}

export function recordLifecycleCompletion(exitCode: number): void {
  const request = activeWorker;
  if (!request || request.kind === "stop") return;
  updateReliabilityOperation(request.identity, (record) => {
    if (!matchesFence(record, request.fence)) return;
    stepRecord(record, {
      ...request.fence,
      type: "completion",
      operationId: request.operationId,
      exitCode,
    });
  });
}

export function recordLifecycleUnknown(): void {
  const request = activeWorker;
  if (!request || request.kind === "stop") return;
  updateReliabilityOperation(request.identity, (record) => {
    if (!matchesFence(record, request.fence)) return;
    stepRecord(record, { ...request.fence, type: "interrupted", operationId: request.operationId });
  });
}

export function proveLifecycleStopped(): void {
  const request = activeWorker;
  if (request?.kind !== "stop")
    throw new Error("Full stop proof requires an explicit stop worker.");
  const settle = () => {
    claimLifecycleEffect();
    if (stopBaselineState) {
      if (
        proveRetainedManagedStop(stopBaselineState).some((container) => container.state.Running)
      ) {
        throw new Error("Retained workspace workloads remain running.");
      }
    } else {
      for (const project of stopProjects) {
        const containers = inspectManagedStopContainers(project);
        if (containers.some((container) => container.state.Running))
          throw new Error("Workspace workloads remain running after stop.");
      }
      const remaining = inspectWorkspaceContainers().filter((container) =>
        sameWorkspacePath(
          container.labels["com.docker.compose.project.working_dir"] ?? "",
          path.join(request.repoPath, ".devcontainer"),
        ),
      );
      if (
        remaining.some(
          (container) =>
            container.state.Running ||
            !stopProjects.includes(container.labels["com.docker.compose.project"] ?? ""),
        )
      ) {
        throw new Error("Workspace population changed during stop proof.");
      }
    }
    const routes = listHostRouteState().filter((route) =>
      sameWorkspacePath(route.repoPath, request.repoPath),
    );
    if (routes.length) throw new Error("Workspace routes remain published after stop.");
    updateReliabilityOperation(request.identity, (record) => {
      if (!matchesFence(record, request.fence) || record.worker)
        throw new Error("Stop proof was superseded or an earlier worker remains.");
      stepRecord(record, {
        ...request.fence,
        type: "stop-proof",
        workloadsStopped: true,
        routesRemoved: true,
      });
    });
  };
  if (stopBaselineState)
    withDevsyMutationLock("Settle retained stop", stopBaselineState.repoPath, settle);
  else settle();
}
