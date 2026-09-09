import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CapacityEstimates } from "../types";
import {
  type CapacityDomainBudget,
  type CapacityDomainSample,
  evaluateCapacity,
} from "./capacity-accounting";
import {
  type CapacityPolicy,
  type CapacityPolicyEnrollment,
  readCapacityPolicy,
} from "./capacity-policy";
import { type CapacityAdmissionContext, capacitySteadyCharge } from "./capacity-request";
import {
  type CapacityReservation,
  CapacitySnapshotChangedError,
  CapacityStore,
} from "./capacity-store";
import { ControllerStore } from "./controller-store";
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
  type ReliabilityConsumer,
  type ReliabilityEvent,
  type ReliabilityFence,
  reliabilityFence,
} from "./reliability-contract";
import { canExecAfterInterruptedEnsure, stepReliability } from "./reliability-model";
import {
  assertCapacityEffect,
  type CapacityControllerIdentity,
  type CapacityExecSteady,
  type CapacityPhaseSettlement,
  clearStartupWitness,
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
import { DEVROUTER_HOME } from "./router";
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

const BUSY_LIFECYCLE_WAIT_MS = 30 * 60 * 1000;
const BUSY_LIFECYCLE_POLL_MS = 250;
const BUSY_LIFECYCLE_PROGRESS_MS = 10_000;

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
    if (kind !== "stop" && record.state.executionPolicy !== "manual")
      throw new Error("Enrolled lifecycle operations require controller admission.");
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

/** Accept once under the journal lock; reconnecting requests receive no launch payload. */
export function prepareManagedLifecycleOperation(input: {
  identity: ReliabilityIdentity;
  controller: CapacityControllerIdentity;
  policyRevision: number;
  requestId: string;
  kind: "ensure" | "exec";
  profile: string;
  consumer: ReliabilityConsumer;
  runtimeRunning: boolean;
  command?: string[];
}): { operationId: string; request?: LifecycleWorkerRequest } {
  if (
    input.kind === "exec"
      ? !Array.isArray(input.command) ||
        input.command.length === 0 ||
        input.command.some((arg) => typeof arg !== "string" || arg.includes("\0"))
      : input.command !== undefined
  )
    throw new Error("Invalid managed operation command.");
  if (Buffer.byteLength(JSON.stringify(input)) > 32_768)
    throw new Error("Managed operation input exceeds its byte limit.");
  const ids = newLifecycleIds();
  return updateReliabilityOperation(input.identity, (record) => {
    assertCurrentCapacityController(input.controller);
    if (
      record.version !== 2 ||
      record.state.executionPolicy !== "capacity-managed" ||
      record.enrollment?.policyRevision !== input.policyRevision
    )
      throw new Error("Managed operation requires current durable enrollment.");
    const previous = record.state.operationHistory.find((entry) => entry.key === input.requestId);
    if (record.phaseSettlement) throw new Error("Capacity phase settlement is pending.");
    const operationId = previous?.id ?? ids.operationId;
    const transition = stepReliability(
      record.state,
      {
        ...reliabilityFence(record.state),
        type: "operation-request",
        kind: input.kind,
        key: input.requestId,
        operationId,
        profile: input.profile,
        consumer: input.consumer,
        runtimeRunning: input.runtimeRunning,
      },
      Date.now(),
    );
    if (transition.outcome === "joined") return { operationId };
    if (transition.outcome !== "accepted")
      throw new Error(`Managed lifecycle transition is ${transition.outcome}.`);
    if (record.worker) throw new Error("An earlier lifecycle worker remains undrained.");
    record.state = transition.state;
    record.outcome = null;
    // A newly accepted operation supersedes any prior startup witness; the next
    // publication rebinds the witness to this operation's fence before mutation.
    record.startupWitness = null;
    return {
      operationId,
      request: {
        ...ids,
        requestId: input.requestId,
        operationId,
        kind: input.kind,
        repoPath: input.identity.repoPath,
        identity: { ...input.identity },
        fence: reliabilityFence(record.state),
        options: { profile: input.profile, quiet: true },
        ...(input.command ? { command: [...input.command] } : {}),
      },
    };
  });
}

function assertCurrentCapacityController(
  expected: CapacityControllerIdentity | undefined,
  directory = path.join(DEVROUTER_HOME, "controller"),
): void {
  const current = new ControllerStore(directory).read();
  if (!expected || current?.store !== expected.store || current.epoch !== expected.epoch)
    throw new Error("Capacity controller incarnation changed.");
}

/** Reduce completed phase charges only after the exact worker has drained. */
export function settlePreparedLifecycleCapacity(input: {
  identity: ReliabilityIdentity;
  controller: CapacityControllerIdentity;
  estimates: CapacityEstimates;
  enrollment: CapacityPolicyEnrollment;
  directory?: string;
}): boolean {
  const directory = input.directory ?? path.join(DEVROUTER_HOME, "controller");
  const store = new CapacityStore(directory);
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = store.read();
    const pending = updateReliabilityOperation(input.identity, (record) => {
      assertCurrentCapacityController(input.controller, directory);
      const operation = record.state.operation;
      const binding = record.capacity;
      if (
        !binding ||
        !record.enrollment ||
        record.worker ||
        record.state.desired !== "running" ||
        record.state.phase === "stopping" ||
        operation?.status !== "COMPLETED" ||
        !operation.drained ||
        record.enrollment.estimatesDigest !== input.enrollment.estimatesDigest ||
        record.enrollment.hostDomain !== input.enrollment.hostDomain ||
        record.enrollment.runtimeDomain !== input.enrollment.runtimeDomain ||
        binding.operationId !== operation.id ||
        record.enrollment.policyRevision !== binding.policyRevision
      )
        return null;
      const proof = operation.kind === "ensure" ? record.preparation : binding.execSteady;
      if (
        !proof ||
        !matchesFence(record, proof.fence) ||
        record.activeProfile !== proof.profile ||
        record.state.profile !== proof.profile
      )
        return null;
      if (operation.kind === "ensure") {
        if (record.preparation?.operationId !== operation.id) return null;
      } else if (operation.kind === "exec") {
        if (
          record.outcome?.operationId !== operation.id ||
          record.outcome.status !== "completed" ||
          (record.outcome.exitCode !== 0 && record.outcome.exitCode !== 1) ||
          record.outcome.transport.exitCode !==
            (record.identity.provider === "devsy" ? record.outcome.exitCode : 0) ||
          record.outcome.transport.signal !== null ||
          record.outcome.exitCode !== operation.exitCode ||
          binding.execSteady?.estimatesDigest !== input.enrollment.estimatesDigest
        )
          return null;
      } else return null;
      const target: CapacityReservation = {
        ...capacitySteadyCharge(input.estimates, input.enrollment, {
          environmentId: record.state.environmentId,
          profile: proof.profile,
        }),
        operationId: operation.id,
        reservationId: binding.reservationId,
        policyRevision: binding.policyRevision,
      };
      if (
        operation.kind === "exec" &&
        !isDeepStrictEqual(target.totals, binding.execSteady?.totals)
      )
        return null;
      const retained = snapshot.reservations.find(
        (entry) => entry.environmentId === target.environmentId,
      );
      if (
        !retained ||
        retained.reservationId !== target.reservationId ||
        retained.operationId !== target.operationId ||
        retained.policyRevision !== target.policyRevision
      )
        return null;
      if (!record.phaseSettlement && isDeepStrictEqual(retained, target)) return null;
      const marker: CapacityPhaseSettlement = {
        id: binding.reservationId,
        fence: { ...proof.fence },
        target,
        estimatesDigest: input.enrollment.estimatesDigest,
      };
      if (record.phaseSettlement && !isDeepStrictEqual(record.phaseSettlement, marker))
        throw new Error("Capacity phase settlement proof changed.");
      binding.validUntilMs = 0;
      record.phaseSettlement = marker;
      return marker;
    });
    if (!pending) return false;
    try {
      store.reduceAfterPhase(pending.target, snapshot.revision);
    } catch (error) {
      if (error instanceof CapacitySnapshotChangedError) continue;
      throw error;
    }
    return updateReliabilityOperation(input.identity, (record) => {
      assertCurrentCapacityController(input.controller, directory);
      if (
        !matchesFence(record, pending.fence) ||
        !isDeepStrictEqual(record.phaseSettlement, pending)
      )
        return false;
      record.phaseSettlement = null;
      return true;
    });
  }
  return false;
}

function reportBusyLifecycleWait(
  kind: "ensure" | "exec",
  operationId: string,
  waitedMs: number,
): void {
  process.stderr.write(
    `Lifecycle ${kind} ${operationId} is waiting for the existing worker (${Math.ceil(waitedMs / 1000)}s).\n`,
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
  if (initial.state.executionPolicy !== "manual")
    throw new Error("Enrolled lifecycle operations require controller admission.");
  const expectedFence = reliabilityFence(initial.state);
  const deadline = Date.now() + BUSY_LIFECYCLE_WAIT_MS;
  const cancellation = { requested: false };
  const removeSignals = installLifecycleWaitSignals(cancellation);
  let lastProgress = -Infinity;
  const assertWaiting = () => {
    if (cancellation.requested)
      throw new Error(`Lifecycle ${kind} ${ids.operationId} cancelled before dispatch.`);
    if (Date.now() >= deadline)
      throw new Error(
        `Lifecycle ${kind} ${ids.operationId} admission timed out; command was not launched.`,
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
          const now = Date.now();
          if (now - lastProgress >= BUSY_LIFECYCLE_PROGRESS_MS) {
            reportBusyLifecycleWait(
              kind,
              ids.operationId,
              now - (deadline - BUSY_LIFECYCLE_WAIT_MS),
            );
            lastProgress = now;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(BUSY_LIFECYCLE_POLL_MS, deadline - now)),
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
          undefined,
          assertWaiting,
        );
      } catch (error) {
        if (!(error instanceof LifecycleWorkerAdmissionBusyError)) throw error;
        assertWaiting();
        await new Promise((resolve) => setTimeout(resolve, BUSY_LIFECYCLE_POLL_MS));
      }
    }
  } finally {
    removeSignals();
  }
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
  controller?: CapacityControllerIdentity,
  admission?: CapacityAdmissionContext,
) {
  if (request.kind === "stop") throw new Error("Stop never requires capacity admission.");
  const capacity = new CapacityStore(directory);
  const snapshot = capacity.read();
  let execSteady: CapacityExecSteady | undefined;
  const previous = updateReliabilityOperation(request.identity, (record) => {
    if (record.phaseSettlement) throw new Error("Capacity phase settlement is pending.");
    if (record.state.executionPolicy === "capacity-managed")
      assertCurrentCapacityController(controller, directory);
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
    if (admission?.pool) {
      const policy = readCapacityPolicy(directory);
      const { pool, enrollment } = admission;
      const runtime = policy?.domains[pool.runtimeDomain];
      if (
        policy?.admissions !== "enabled" ||
        policy.revision !== reservation.policyRevision ||
        runtime?.kind !== "runtime" ||
        policy.domains[pool.hostDomain]?.kind !== "host" ||
        runtime.daemonId !== pool.daemonId ||
        runtime.hostDomain !== pool.hostDomain ||
        runtime.hostChargeCeilingBytes !== pool.hostChargeCeilingBytes ||
        enrollment.runtimeDomain !== pool.runtimeDomain ||
        enrollment.hostDomain !== pool.hostDomain ||
        !record.enrollment ||
        record.enrollment.policyRevision !== policy.revision ||
        record.enrollment.runtimeDomain !== pool.runtimeDomain ||
        record.enrollment.hostDomain !== pool.hostDomain ||
        record.enrollment.daemonId !== pool.daemonId ||
        record.enrollment.endpoint !== runtime.endpoint
      )
        throw new Error("Capacity pool does not match durable policy enrollment.");
    }
    const binding = record.capacity;
    if (!binding) {
      record.version = 2;
      record.capacity = null;
      return undefined;
    }
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
    if (request.kind === "exec" && admission) {
      const { estimates, enrollment } = admission;
      const profile = request.options.profile;
      if (
        !profile ||
        !record.enrollment ||
        record.enrollment.policyRevision !== reservation.policyRevision ||
        record.enrollment.estimatesDigest !== enrollment.estimatesDigest ||
        record.enrollment.hostDomain !== enrollment.hostDomain ||
        record.enrollment.runtimeDomain !== enrollment.runtimeDomain ||
        record.activeProfile !== profile
      )
        throw new Error("Exec settlement estimates do not match durable enrollment.");
      const totals = capacitySteadyCharge(estimates, enrollment, {
        environmentId: record.state.environmentId,
        profile,
      }).totals;
      const receipt: CapacityExecSteady = {
        profile,
        estimatesDigest: enrollment.estimatesDigest,
        fence: { ...request.fence },
        totals,
      };
      if (binding.operationId === request.operationId) {
        if (binding.execSteady && !isDeepStrictEqual(binding.execSteady, receipt))
          throw new Error("Repeated exec settlement proof changed.");
        execSteady = binding.execSteady;
      } else if (
        !retained.startup &&
        !retained.heavy &&
        isDeepStrictEqual(retained.totals, totals)
      ) {
        execSteady = receipt;
      }
    } else if (binding.operationId === request.operationId && binding.execSteady) {
      throw new Error("Repeated exec admission requires its reviewed estimates.");
    }
    // A retry must also pass fresh all-domain admission before renewing authority.
    binding.validUntilMs = 0;
    return {
      revision: snapshot.revision,
      operationId: binding.operationId,
      reservationId: binding.reservationId,
    };
  });
  if (controller) assertCurrentCapacityController(controller, directory);
  const decision = capacity.reserve(
    reservation,
    budgets,
    samples,
    nowMs,
    maxSampleAgeMs,
    previous,
    snapshot.revision,
    admission?.pool,
  );
  if (decision.admitted) {
    bindLifecycleCapacity(
      request,
      {
        reservationId: reservation.reservationId,
        policyRevision: reservation.policyRevision,
        snapshotRevision: decision.revision,
        ...(controller ? { controller } : {}),
        ...(execSteady ? { execSteady } : {}),
        validUntilMs:
          Math.min(...Object.values(samples).map((sample) => sample.sampledAtMs)) + maxSampleAgeMs,
      },
      directory,
    );
  }
  return decision;
}

/** Renew local effect authority from fresh evidence without releasing retained charges. */
export function renewLifecycleCapacity(
  request: LifecycleWorkerRequest,
  policy: CapacityPolicy,
  samples: Record<string, CapacityDomainSample>,
  controller: CapacityControllerIdentity,
  directory = path.join(DEVROUTER_HOME, "controller"),
  nowMs = Date.now(),
): boolean {
  return updateReliabilityOperation(request.identity, (record) => {
    const binding = record.capacity;
    if (
      !matchesFence(record, request.fence) ||
      !binding ||
      binding.operationId !== request.operationId ||
      binding.workerId !== request.workerId ||
      binding.controller?.store !== controller.store ||
      binding.controller?.epoch !== controller.epoch
    )
      throw new Error("Capacity renewal no longer owns this operation.");
    binding.validUntilMs = 0;
    try {
      if (
        record.state.executionPolicy !== "capacity-managed" ||
        record.state.operation?.id !== request.operationId ||
        record.state.operation.drained ||
        record.state.desired !== "running" ||
        policy.admissions !== "enabled" ||
        policy.revision !== binding.policyRevision ||
        JSON.stringify(readCapacityPolicy(directory)) !== JSON.stringify(policy)
      )
        return false;
      const enrolled = record.enrollment;
      const runtime = enrolled && policy.domains[enrolled.runtimeDomain];
      const enrollment = policy.enrollments.find(
        (entry) =>
          entry.repoPath === record.identity.repoPath &&
          entry.workspace === record.identity.workspace &&
          entry.provider === record.identity.provider &&
          entry.providerId === enrolled?.providerId &&
          entry.gitCommonDir === enrolled.gitCommonDir &&
          entry.estimatesDigest === enrolled.estimatesDigest &&
          entry.hostDomain === enrolled.hostDomain &&
          entry.runtimeDomain === enrolled.runtimeDomain &&
          entry.profiles.includes(record.state.profile ?? ""),
      );
      if (
        !enrolled ||
        enrolled.policyRevision !== policy.revision ||
        !enrollment ||
        runtime?.kind !== "runtime" ||
        runtime.endpoint !== enrolled.endpoint ||
        runtime.daemonId !== enrolled.daemonId
      )
        return false;
      const snapshot = new CapacityStore(directory).read();
      const reservation = snapshot.reservations.find(
        (entry) => entry.reservationId === binding.reservationId,
      );
      if (
        !reservation ||
        reservation.environmentId !== record.state.environmentId ||
        reservation.operationId !== request.operationId ||
        reservation.policyRevision !== policy.revision
      )
        return false;
      const maxAge = policy.scheduling.maxSampleAgeSeconds * 1000;
      const decision = evaluateCapacity(
        policy.domains,
        samples,
        snapshot.reservations,
        reservation,
        nowMs,
        maxAge,
        snapshot.pools,
      );
      if (!decision.admitted) {
        // Unknown collection stays local to the affected domain. While an active
        // startup witness proves accounting ownership of the changing runtime
        // domain, its transient unknown sample must not invalidate authority —
        // but any unknown elsewhere, or any non-unknown reason, still blocks it.
        const witnessedDomain = enrolled?.runtimeDomain;
        const tolerated =
          record.startupWitness != null &&
          decision.reason === "unknown" &&
          typeof witnessedDomain === "string" &&
          decision.domain === witnessedDomain &&
          (() => {
            const remaining = Object.fromEntries(
              Object.entries(reservation.totals).filter(([domain]) => domain !== witnessedDomain),
            );
            return (
              Object.keys(remaining).length === 0 ||
              evaluateCapacity(
                policy.domains,
                samples,
                snapshot.reservations,
                { ...reservation, totals: remaining },
                nowMs,
                maxAge,
                snapshot.pools,
              ).admitted
            );
          })();
        if (!tolerated) return false;
      }
      binding.snapshotRevision = snapshot.revision;
      binding.validUntilMs =
        Math.min(
          ...Object.keys(reservation.totals).map((domain) => samples[domain]?.sampledAtMs ?? 0),
        ) + maxAge;
      assertCapacityEffect(record, request.workerId, nowMs, directory);
      return true;
    } catch {
      binding.validUntilMs = 0;
      return false;
    }
  });
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
    if (record.worker || !["NOT_STARTED", "NOT_LAUNCHED"].includes(record.state.operation.status))
      throw new Error("Queued operation absence is not proven.");
    if (record.capacity) record.capacity.validUntilMs = 0;
    stepRecord(record, { ...request.fence, type: "drained", operationId: request.operationId });
    return true;
  });
}

/** Bind an already-persisted reservation without holding the scheduler lock. */
export function bindLifecycleCapacity(
  request: LifecycleWorkerRequest,
  binding: {
    reservationId: string;
    policyRevision: number;
    validUntilMs: number;
    snapshotRevision: number;
    controller?: CapacityControllerIdentity;
    execSteady?: CapacityExecSteady;
  },
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
    if (record.state.executionPolicy === "capacity-managed")
      stepRecord(record, { ...request.fence, type: "admission", result: "admitted" });
  });
}

/**
 * Replace the active startup witness after the strict baseline capture persisted.
 * Only this operation's witness is cleared, with the freshly read live fence, so
 * a concurrent superseding generation is left to its own lifecycle.
 */
export function clearActiveLifecycleStartupWitness(): void {
  const request = activeWorker;
  if (!request || request.kind === "stop") return;
  const record = readReliabilityOperation(request.identity);
  if (record?.startupWitness?.operationId !== request.operationId) return;
  clearStartupWitness(request.identity, reliabilityFence(record.state));
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

export function recordLifecycleCompletion(exitCode: number, preparedProfile?: string): void {
  const request = activeWorker;
  if (!request || request.kind === "stop") return;
  updateReliabilityOperation(request.identity, (record) => {
    if (!matchesFence(record, request.fence)) return;
    if (preparedProfile !== undefined && record.enrollment) {
      if (
        request.kind !== "ensure" ||
        record.worker?.id !== request.workerId ||
        record.state.operation?.id !== request.operationId ||
        record.state.profile !== preparedProfile
      )
        throw new Error("Prepared profile does not match the active lifecycle worker.");
      // Application failure does not invalidate successfully reconciled tooling.
      record.activeProfile = preparedProfile;
      record.preparation = {
        operationId: request.operationId,
        profile: preparedProfile,
        fence: { ...request.fence },
      };
    }
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
    const settlement = updateReliabilityOperation(request.identity, (record) => {
      if (!matchesFence(record, request.fence) || record.worker)
        throw new Error("Stop proof was superseded or an earlier worker remains.");
      if (record.version === 2) {
        if (record.capacity) record.capacity.validUntilMs = 0;
        return record.state.environmentId;
      }
      stepRecord(record, {
        ...request.fence,
        type: "stop-proof",
        workloadsStopped: true,
        routesRemoved: true,
      });
      return undefined;
    });
    if (settlement) {
      const capacity = new CapacityStore(path.join(DEVROUTER_HOME, "controller"));
      for (let attempt = 0; ; attempt++) {
        try {
          capacity.settleEnvironmentAfterStop(settlement, capacity.read().revision);
          break;
        } catch (error) {
          if (!(error instanceof CapacitySnapshotChangedError) || attempt >= 2) throw error;
        }
      }
      updateReliabilityOperation(request.identity, (record) => {
        if (
          !matchesFence(record, request.fence) ||
          record.worker ||
          record.state.environmentId !== settlement ||
          (record.capacity && record.capacity.validUntilMs !== 0)
        )
          throw new Error("Capacity settlement was superseded before journal confirmation.");
        record.capacity = null;
        if (record.enrollment) {
          record.phaseSettlement = null;
          record.activeProfile = null;
          record.preparation = null;
        }
        stepRecord(record, {
          ...request.fence,
          type: "stop-proof",
          workloadsStopped: true,
          routesRemoved: true,
        });
      });
    }
  };
  if (stopBaselineState)
    withDevsyMutationLock("Settle retained stop", stopBaselineState.repoPath, settle);
  else settle();
}
