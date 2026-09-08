import path from "node:path";
import type { CapacityDomainBudget, CapacityDomainSample } from "./capacity-accounting";
import { type CapacityReservation, CapacityStore } from "./capacity-store";
import {
  inspectManagedStopContainers,
  inspectWorkspaceContainers,
  resolveRunningWorkspaceContainer,
} from "./devpod-environment";
import type { ExecutionOutcome } from "./execution-outcome";
import { processBirthIdentity } from "./file-lock";
import { listHostRouteState } from "./host-routes";
import { readManagedRuntimeState } from "./managed-runtime-state";
import { claimLifecycleEffect, installLifecycleEffectClaim } from "./reliability-context";
import {
  type ReliabilityEvent,
  type ReliabilityFence,
  reliabilityFence,
} from "./reliability-contract";
import { stepReliability } from "./reliability-model";
import {
  assertCapacityEffect,
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
import { DEVROUTER_HOME } from "./router";
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
    if (worker.kind !== "stop") assertCapacityEffect(record, worker.workerId, Date.now());
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

/** Persist intent before the controller waits for admission; no worker is launched. */
export function prepareLifecycleOperation(
  kind: LifecycleWorkerRequest["kind"],
  repoPath: string,
  options: LifecycleWorkerRequest["options"] = {},
  command?: string[],
): LifecycleWorkerRequest {
  repoPath = comparableWorkspacePath(repoPath);
  if (isLinkedWorktree(repoPath) && !readPersistedWorkspace(repoPath)) {
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
    if (
      record.version === 2 &&
      record.capacity?.validUntilMs === 0 &&
      !record.worker &&
      record.state.stopProof.workloadsStopped &&
      record.state.stopProof.routesRemoved
    ) {
      const retained = new CapacityStore(path.join(DEVROUTER_HOME, "controller"))
        .read()
        .reservations.some((entry) => entry.environmentId === record.state.environmentId);
      if (!retained) record.capacity = null;
    }
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
  return {
    kind,
    repoPath,
    identity,
    ...ids,
    fence,
    options,
    ...(command ? { command } : {}),
  };
}

export async function superviseLifecycle(
  kind: LifecycleWorkerRequest["kind"],
  repoPath: string,
  options: LifecycleWorkerRequest["options"] = {},
  command?: string[],
): Promise<unknown> {
  return runLifecycleWorker(prepareLifecycleOperation(kind, repoPath, options, command));
}

/** Admit a prepared operation; journal transactions never surround capacity transactions. */
export function admitLifecycleCapacity(
  request: LifecycleWorkerRequest,
  reservation: CapacityReservation,
  budgets: Record<string, CapacityDomainBudget>,
  samples: Record<string, CapacityDomainSample>,
  nowMs: number,
  maxSampleAgeMs: number,
  directory = path.join(DEVROUTER_HOME, "controller"),
) {
  if (request.kind === "stop") throw new Error("Stop never requires capacity admission.");
  const capacity = new CapacityStore(directory);
  const snapshot = capacity.read();
  const previous = updateReliabilityOperation(request.identity, (record) => {
    if (
      !matchesFence(record, request.fence) ||
      record.worker ||
      record.state.operation?.id !== request.operationId ||
      record.state.operation.status !== "NOT_STARTED" ||
      record.state.operation.drained ||
      reservation.operationId !== request.operationId ||
      reservation.environmentId !== record.state.environmentId
    )
      throw new Error("Lifecycle intent changed while waiting for capacity.");
    const binding = record.capacity;
    if (!binding) return undefined;
    const retained = snapshot.reservations.find(
      (entry) => entry.reservationId === binding.reservationId,
    );
    if (
      !retained ||
      retained.environmentId !== reservation.environmentId ||
      retained.operationId !== binding.operationId ||
      retained.policyRevision !== binding.policyRevision
    )
      throw new Error("Earlier capacity reservation does not match lifecycle intent.");
    if (binding.operationId === request.operationId) {
      if (
        binding.workerId !== request.workerId ||
        binding.reservationId !== reservation.reservationId ||
        binding.policyRevision !== reservation.policyRevision ||
        Object.entries(reservation.totals).some(
          ([domain, bytes]) =>
            !Object.hasOwn(retained.totals, domain) || bytes > retained.totals[domain],
        ) ||
        (reservation.startup && !retained.startup) ||
        (reservation.heavy && !retained.heavy)
      )
        throw new Error("Repeated capacity request changed its admitted requirements.");
    } else {
      const earlier = record.state.operationHistory.find(
        (operation) => operation.id === binding.operationId,
      );
      if (!earlier?.drained) throw new Error("Earlier capacity worker drainage is not proven.");
    }
    // A retry must also pass fresh all-domain admission before renewing authority.
    binding.validUntilMs = 0;
    return {
      revision: snapshot.revision,
      operationId: binding.operationId,
      reservationId: binding.reservationId,
    };
  });
  const decision = capacity.reserve(reservation, budgets, samples, nowMs, maxSampleAgeMs, previous);
  if (decision.admitted) {
    bindLifecycleCapacity(
      request,
      {
        reservationId: reservation.reservationId,
        policyRevision: reservation.policyRevision,
        validUntilMs:
          Math.min(...Object.values(samples).map((sample) => sample.sampledAtMs)) + maxSampleAgeMs,
      },
      directory,
    );
  }
  return decision;
}

/** Retire only positively undispatched intent, retaining all runtime charges. */
export function retireQueuedLifecycle(
  request: LifecycleWorkerRequest,
  supersededOnly = false,
): boolean {
  return updateReliabilityOperation(request.identity, (record) => {
    if (
      !matchesFence(record, request.fence) ||
      record.state.operation?.id !== request.operationId
    ) {
      const operation =
        record.state.operation?.id === request.operationId
          ? record.state.operation
          : record.state.operationHistory.find((entry) => entry.id === request.operationId);
      if (
        operation?.drained &&
        ["NOT_STARTED", "NOT_LAUNCHED"].includes(operation.status) &&
        record.worker?.operationId !== request.operationId
      )
        return true;
      throw new Error("Queued operation absence is not proven.");
    }
    if (supersededOnly) return false;
    if (
      record.worker ||
      record.state.operation?.id !== request.operationId ||
      !["NOT_STARTED", "NOT_LAUNCHED"].includes(record.state.operation.status)
    )
      throw new Error("Queued operation absence is not proven.");
    if (record.capacity) record.capacity.validUntilMs = 0;
    stepRecord(record, { ...request.fence, type: "drained", operationId: request.operationId });
    return true;
  });
}

/** Bind an already-persisted reservation without holding the scheduler lock. */
export function bindLifecycleCapacity(
  request: LifecycleWorkerRequest,
  binding: { reservationId: string; policyRevision: number; validUntilMs: number },
  directory = path.join(DEVROUTER_HOME, "controller"),
): void {
  if (request.kind === "stop") throw new Error("Stop never requires capacity admission.");
  updateReliabilityOperation(request.identity, (record) => {
    if (
      !matchesFence(record, request.fence) ||
      record.worker ||
      record.state.operation?.id !== request.operationId ||
      record.state.operation.status !== "NOT_STARTED" ||
      record.state.operation.drained
    )
      throw new Error("Lifecycle intent changed while waiting for capacity.");
    const previous = record.capacity;
    if (
      previous &&
      previous.validUntilMs !== 0 &&
      (previous.operationId !== request.operationId ||
        previous.workerId !== request.workerId ||
        previous.reservationId !== binding.reservationId ||
        previous.policyRevision !== binding.policyRevision)
    )
      throw new Error("Lifecycle retains an earlier capacity binding.");
    record.version = 2;
    record.capacity = { ...binding, operationId: request.operationId, workerId: request.workerId };
    assertCapacityEffect(record, request.workerId, Date.now(), directory);
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
        const retained = readManagedRuntimeState(
          request.repoPath,
          request.identity.workspace ?? undefined,
        );
        stopProjects = [
          ...new Set([...projects, ...(retained ? [retained.composeProject] : [])]),
        ] as string[];
        for (const project of stopProjects) inspectManagedStopContainers(project);
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
  claimLifecycleEffect();
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
  const routes = listHostRouteState().filter((route) =>
    sameWorkspacePath(route.repoPath, request.repoPath),
  );
  if (routes.length) throw new Error("Workspace routes remain published after stop.");
  const settlement = updateReliabilityOperation(request.identity, (record) => {
    if (!matchesFence(record, request.fence) || record.worker)
      throw new Error("Stop proof was superseded or an earlier worker remains.");
    stepRecord(record, {
      ...request.fence,
      type: "stop-proof",
      workloadsStopped: true,
      routesRemoved: true,
    });
    if (record.version === 2 && record.capacity) {
      record.capacity.validUntilMs = 0;
      return {
        environmentId: record.state.environmentId,
        operationId: record.capacity.operationId,
        reservationId: record.capacity.reservationId,
        policyRevision: record.capacity.policyRevision,
      };
    }
    return undefined;
  });
  if (settlement) {
    new CapacityStore(path.join(DEVROUTER_HOME, "controller")).releaseAfterStop(settlement);
    updateReliabilityOperation(request.identity, (record) => {
      if (
        !matchesFence(record, request.fence) ||
        record.worker ||
        record.capacity?.reservationId !== settlement.reservationId ||
        record.capacity.operationId !== settlement.operationId ||
        record.capacity.policyRevision !== settlement.policyRevision ||
        record.capacity.validUntilMs !== 0
      )
        throw new Error("Capacity settlement was superseded before journal confirmation.");
      record.capacity = null;
    });
  }
}
