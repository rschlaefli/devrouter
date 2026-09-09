import path from "node:path";
import {
  inspectManagedStopContainers,
  inspectWorkspaceContainers,
  resolveRunningWorkspaceContainer,
} from "./devpod-environment";
import { captureDevsyExecProof, type DevsyExecProof } from "./devsy-exec-proof";
import { withMutationLock as withDevsyMutationLock } from "./devsy-mutation";
import type { ExecutionOutcome } from "./execution-outcome";
import { processBirthIdentity } from "./file-lock";
import { listHostRouteState } from "./host-routes";
import { type ManagedRuntimeState, readManagedRuntimeState } from "./managed-runtime-state";
import { managedStopRouteReferences, proveManagedStop } from "./managed-stop-recovery";
import { claimLifecycleEffect, installLifecycleEffectClaim } from "./reliability-context";
import {
  type ReliabilityEvent,
  type ReliabilityFence,
  reliabilityFence,
} from "./reliability-contract";
import { canExecAfterInterruptedEnsure, stepReliability } from "./reliability-model";
import {
  type ReliabilityIdentity,
  type ReliabilityOperationRecord,
  readReliabilityOperation,
  updateReliabilityOperation,
} from "./reliability-operation-store";
import {
  hasDuplicateOperation,
  LifecycleWorkerAdmissionBusyError,
  type LifecycleWorkerRequest,
  newLifecycleIds,
  runLifecycleWorker,
  workerGroupAbsent,
} from "./reliability-worker";
import { assertTraefikRoutesRemoved } from "./traefik-route-health";
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

const BUSY_EXEC_WAIT_MS = 30 * 60 * 1000;
const BUSY_EXEC_POLL_MS = 250;
const BUSY_EXEC_PROGRESS_MS = 10_000;

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

function reportBusyExecWait(operationId: string, waitedMs: number): void {
  process.stderr.write(
    `Lifecycle exec ${operationId} is waiting for the existing worker (${Math.ceil(waitedMs / 1000)}s).\n`,
  );
}

function installLifecycleWaitSignals(cancellation: { requested: boolean }): () => void {
  const onSignal = () => {
    cancellation.requested = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
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
  const copiedOptions = { ...options };
  const copiedCommand = command ? [...command] : undefined;
  if (kind === "stop") {
    const fence = updateReliabilityOperation(identity, (record) => {
      reconcileDrained(record);
      stepRecord(record, { ...reliabilityFence(record.state), type: "stop" });
      return reliabilityFence(record.state);
    });
    return runLifecycleWorker({ kind, repoPath, identity, ...ids, fence, options: copiedOptions });
  }
  const initial =
    readReliabilityOperation(identity) ?? updateReliabilityOperation(identity, (record) => record);
  const expectedFence = reliabilityFence(initial.state);
  const deadline = Date.now() + BUSY_EXEC_WAIT_MS;
  const cancellation = { requested: false };
  const removeSignals = installLifecycleWaitSignals(cancellation);
  let lastProgress = -Infinity;
  const assertWaiting = () => {
    if (cancellation.requested)
      throw new Error(`Lifecycle exec ${ids.operationId} cancelled before dispatch.`);
    if (Date.now() >= deadline)
      throw new Error(
        `Lifecycle exec ${ids.operationId} admission timed out; command was not launched.`,
      );
  };
  try {
    for (;;) {
      assertWaiting();
      let previous = readReliabilityOperation(identity);
      if (!previous || !matchesFence(previous, expectedFence))
        throw new Error(
          "Lifecycle intent changed while awaiting admission; command was not launched.",
        );
      if (hasDuplicateOperation(previous, ids.requestId, ids.operationId))
        throw new Error("Lifecycle request identity already exists; command was not replayed.");
      if (previous.worker) {
        const worker = previous.worker;
        const birth = processBirthIdentity(worker.pid);
        if (birth !== worker.birth && workerGroupAbsent(worker.pid)) {
          previous = updateReliabilityOperation(identity, (record) => {
            reconcileDrained(record);
            return record;
          });
        } else {
          if (
            !birth ||
            birth !== worker.birth ||
            previous.state.operation?.status === "COMPLETION_UNKNOWN"
          )
            throw new Error(
              "Existing lifecycle worker identity or completion is uncertain; preserve its evidence.",
            );
          if (kind !== "exec")
            throw new Error("A lifecycle worker is active; wait for its completion before ensure.");
          const now = Date.now();
          if (now - lastProgress >= BUSY_EXEC_PROGRESS_MS) {
            reportBusyExecWait(ids.operationId, now - (deadline - BUSY_EXEC_WAIT_MS));
            lastProgress = now;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(BUSY_EXEC_POLL_MS, deadline - now)),
          );
          continue;
        }
      }
      if (
        !previous.worker &&
        previous.state.operation?.status === "NOT_STARTED" &&
        !previous.state.operation.drained
      )
        previous = updateReliabilityOperation(identity, (record) => {
          reconcileDrained(record);
          return record;
        });
      assertWaiting();
      const runtimeRunning = kind === "exec" && Boolean(resolveRunningWorkspaceContainer(repoPath));
      let retainedExecProof: DevsyExecProof | undefined;
      if (
        kind === "exec" &&
        identity.provider === "devsy" &&
        canExecAfterInterruptedEnsure(previous.state)
      )
        retainedExecProof = withDevsyMutationLock("Prove retained exec", repoPath, () =>
          captureDevsyExecProof(repoPath),
        );
      assertWaiting();
      try {
        return await runLifecycleWorker(
          {
            kind,
            repoPath,
            identity,
            ...ids,
            fence: { ...expectedFence },
            options: copiedOptions,
            ...(copiedCommand ? { command: copiedCommand } : {}),
            ...(retainedExecProof ? { retainedExecProof } : {}),
            admission: {
              expectedRevision: previous.revision,
              profile: copiedOptions.profile ?? previous.state.profile ?? "full",
              consumer: { id: "manual-cli", requiredCapabilities: [], pinned: false },
              runtimeRunning,
              ...(retainedExecProof ? { recoverInterruptedEnsure: true } : {}),
            },
          },
          assertWaiting,
        );
      } catch (error) {
        if (!(error instanceof LifecycleWorkerAdmissionBusyError) || kind !== "exec") throw error;
        assertWaiting();
        await new Promise((resolve) => setTimeout(resolve, BUSY_EXEC_POLL_MS));
      }
    }
  } finally {
    removeSignals();
  }
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
            proveManagedStop(retained),
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
      const proof = proveManagedStop(stopBaselineState);
      if (proof.containers.some((container) => container.state.Running))
        throw new Error("Retained workspace workloads remain running.");
      if (proof.status === "proven-absent")
        assertTraefikRoutesRemoved(managedStopRouteReferences(stopBaselineState));
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
