import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeFileAtomically } from "./atomic-file";
import { type CapacityReservation, CapacityStore } from "./capacity-store";
import { ControllerStore } from "./controller-store";
import type { ExecutionOutcome } from "./execution-outcome";
import { withFileLockSync } from "./file-lock";
import {
  assertReliabilityState,
  createReliabilityState,
  isReliabilityCounter,
  isReliabilityId,
  isReliabilityProfile,
  type ReliabilityFence,
  type ReliabilityState,
  reliabilityFence,
} from "./reliability-contract";
import { DEVROUTER_HOME } from "./router";

export type ReliabilityIdentity = {
  repoPath: string;
  workspace: string | null;
  provider: "devpod" | "devsy";
};

export type CapacityEnrollmentBinding = {
  policyRevision: number;
  gitCommonDir: string;
  providerId: string;
  hostDomain: string;
  runtimeDomain: string;
  endpoint: string;
  daemonId: string;
  estimatesDigest: string;
};

export type CapacityControllerIdentity = { store: string; epoch: number };

export type CapacityExecSteady = {
  profile: string;
  estimatesDigest: string;
  fence: ReliabilityFence;
  totals: Record<string, number>;
};

export type ReliabilityPreparationReceipt = {
  operationId: string;
  profile: string;
  fence: ReliabilityFence;
};

export type CapacityPhaseSettlement = {
  id: string;
  fence: ReliabilityFence;
  target: CapacityReservation;
  estimatesDigest: string;
};

/**
 * Intent-bound accounting evidence for a prepared startup generation. It proves
 * capacity ownership for population collection only: never stopped state,
 * readiness, settlement, or permission to mutate the workspace.
 */
export type CapacityStartupWitness = {
  operationId: string;
  fence: ReliabilityFence;
  provider: { id: string; context: string; uid: string; sourceContainer: string };
  profile: string;
  sourceConfigSha256: string;
  effectiveConfigSha256: string;
  composeFiles: string[];
  primaryService: string;
  startupServices: string[];
  retainedContainerIds: string[];
};

export type ReliabilityOperationRecord = {
  version: 1 | 2;
  identity: ReliabilityIdentity;
  revision: number;
  state: ReliabilityState;
  worker: { id: string; operationId: string; pid: number; birth: string } | null;
  effectSequence: number;
  outcome: (ExecutionOutcome & { operationId: string }) | null;
  enrollment?: CapacityEnrollmentBinding;
  activeProfile?: string | null;
  capacity?: {
    reservationId: string;
    operationId: string;
    workerId: string;
    policyRevision: number;
    validUntilMs: number;
    snapshotRevision?: number;
    controller?: CapacityControllerIdentity;
    execSteady?: CapacityExecSteady;
  } | null;
  preparation?: ReliabilityPreparationReceipt | null;
  phaseSettlement?: CapacityPhaseSettlement | null;
  startupWitness?: CapacityStartupWitness | null;
};

const MAX_RECORD_BYTES = 1_048_576;
const MAX_RELIABILITY_JOURNALS = 256;
const MAX_RELIABILITY_DIRECTORY_ENTRIES = MAX_RELIABILITY_JOURNALS * 2;
const MAX_RELIABILITY_ENUMERATION_MS = 2_000;
const RELIABILITY_JOURNAL_NAME_RE = /^([0-9a-f]{64})\.json$/;
const RELIABILITY_LOCK_NAME_RE =
  /^[0-9a-f]{64}\.json\.lock(?:\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.candidate(?:\.stale)?|\.queue\.[0-9]+\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.candidate)?)?$/;
const RELIABILITY_ATOMIC_TEMP_NAME_RE =
  /^\.[0-9a-f]{64}\.json\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

function identityKey(identity: ReliabilityIdentity): string {
  if (
    !path.isAbsolute(identity.repoPath) ||
    path.resolve(identity.repoPath) !== identity.repoPath ||
    identity.repoPath.includes("\0") ||
    (identity.workspace !== null && !isReliabilityId(identity.workspace)) ||
    !["devpod", "devsy"].includes(identity.provider)
  ) {
    throw new Error("Invalid reliability workspace identity.");
  }
  // Provider changes must encounter the same record and fail ownership comparison.
  return createHash("sha256").update(identity.repoPath).digest("hex");
}

export function reliabilityOperationPath(identity: ReliabilityIdentity): string {
  return path.join(DEVROUTER_HOME, "reliability", `${identityKey(identity)}.json`);
}

function keys(value: unknown, expected: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new Error("Reliability record contains unsupported fields.");
  }
}

function exactKeys(value: unknown, expected: string[], message: string): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new Error(message);
  }
}

function validateCapacityPhaseSettlement(
  record: ReliabilityOperationRecord,
  state: ReliabilityState,
  enrollment: CapacityEnrollmentBinding | undefined,
): void {
  const settlement = record.phaseSettlement;
  if (settlement === undefined || settlement === null) return;
  if (record.version !== 2 || !enrollment || state.executionPolicy !== "capacity-managed")
    throw new Error("Phase settlement requires durable capacity enrollment.");

  exactKeys(
    settlement,
    ["id", "fence", "target", "estimatesDigest"],
    "Invalid capacity phase settlement fields.",
  );
  exactKeys(
    settlement.fence,
    ["environmentId", "intentRevision", "runtimeGeneration", "controllerEpoch"],
    "Invalid capacity phase settlement fence.",
  );
  exactKeys(
    settlement.target,
    [
      "environmentId",
      "operationId",
      "reservationId",
      "policyRevision",
      "totals",
      "startup",
      "heavy",
    ],
    "Invalid capacity phase settlement target fields.",
  );

  const target = settlement.target;
  const totals = target.totals;
  if (
    !isReliabilityId(settlement.id) ||
    !isReliabilityId(settlement.fence.environmentId) ||
    settlement.fence.environmentId !== state.environmentId ||
    !isReliabilityCounter(settlement.fence.intentRevision) ||
    !isReliabilityCounter(settlement.fence.runtimeGeneration) ||
    !isReliabilityCounter(settlement.fence.controllerEpoch) ||
    !isReliabilityId(target.environmentId) ||
    target.environmentId !== state.environmentId ||
    !isReliabilityId(target.operationId) ||
    !isReliabilityId(target.reservationId) ||
    !Number.isSafeInteger(target.policyRevision) ||
    target.policyRevision < 1 ||
    target.startup !== false ||
    target.heavy !== false ||
    typeof settlement.estimatesDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(settlement.estimatesDigest)
  )
    throw new Error("Invalid capacity phase settlement.");

  if (
    !totals ||
    typeof totals !== "object" ||
    Array.isArray(totals) ||
    Object.keys(totals).length < 1 ||
    Object.keys(totals).length > 256 ||
    Object.entries(totals).some(
      ([domain, bytes]) => !isReliabilityId(domain) || !Number.isSafeInteger(bytes) || bytes < 0,
    )
  )
    throw new Error("Invalid capacity phase settlement totals.");

  const capacity = record.capacity;
  if (
    capacity?.validUntilMs !== 0 ||
    target.operationId !== capacity?.operationId ||
    target.reservationId !== capacity?.reservationId ||
    target.policyRevision !== capacity?.policyRevision ||
    settlement.estimatesDigest !== enrollment.estimatesDigest
  )
    throw new Error("Capacity phase settlement does not match durable capacity authority.");

  const targetDomains = Object.keys(totals);
  if (
    targetDomains.length !== 2 ||
    !targetDomains.includes(enrollment.hostDomain) ||
    !targetDomains.includes(enrollment.runtimeDomain)
  )
    throw new Error("Capacity phase settlement domains do not match enrollment.");
}

function validateStartupWitness(
  record: ReliabilityOperationRecord,
  state: ReliabilityState,
  enrollment: CapacityEnrollmentBinding | undefined,
): void {
  const witness = record.startupWitness;
  if (witness === undefined || witness === null) return;
  if (
    record.version !== 2 ||
    !enrollment ||
    state.executionPolicy !== "capacity-managed" ||
    state.operation === null
  )
    throw new Error("Startup witness requires current durable managed intent.");
  exactKeys(
    witness,
    [
      "operationId",
      "fence",
      "provider",
      "profile",
      "sourceConfigSha256",
      "effectiveConfigSha256",
      "composeFiles",
      "primaryService",
      "startupServices",
      "retainedContainerIds",
    ],
    "Invalid capacity startup witness fields.",
  );
  exactKeys(
    witness.fence,
    ["environmentId", "intentRevision", "runtimeGeneration", "controllerEpoch"],
    "Invalid capacity startup witness fence.",
  );
  exactKeys(
    witness.provider,
    ["id", "context", "uid", "sourceContainer"],
    "Invalid capacity startup witness provider fields.",
  );
  const digest = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const boundedText = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= 256 &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    );
  const absolutePath = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.resolve(value) === value;
  const unique = (values: string[]): boolean => new Set(values).size === values.length;
  const fence = witness.fence;
  if (
    !isReliabilityId(witness.operationId) ||
    witness.operationId !== state.operation.id ||
    !isReliabilityId(fence.environmentId) ||
    fence.environmentId !== state.environmentId ||
    !isReliabilityCounter(fence.intentRevision) ||
    fence.intentRevision !== state.intentRevision ||
    !isReliabilityCounter(fence.runtimeGeneration) ||
    fence.runtimeGeneration !== state.runtimeGeneration ||
    !isReliabilityCounter(fence.controllerEpoch) ||
    fence.controllerEpoch !== state.controllerEpoch ||
    !isReliabilityProfile(witness.profile) ||
    !digest(witness.sourceConfigSha256) ||
    !digest(witness.effectiveConfigSha256) ||
    !boundedText(witness.provider.id) ||
    witness.provider.id.trim() !== witness.provider.id ||
    witness.provider.id === "" ||
    witness.provider.id !== enrollment.providerId ||
    !boundedText(witness.provider.context) ||
    !boundedText(witness.provider.uid) ||
    !boundedText(witness.provider.sourceContainer) ||
    !Array.isArray(witness.composeFiles) ||
    witness.composeFiles.length < 1 ||
    witness.composeFiles.length > 16 ||
    !witness.composeFiles.every(absolutePath) ||
    !unique(witness.composeFiles) ||
    !Array.isArray(witness.startupServices) ||
    witness.startupServices.length < 1 ||
    witness.startupServices.length > 64 ||
    !witness.startupServices.every((service) => isReliabilityId(service) && service.length <= 64) ||
    !unique(witness.startupServices) ||
    !isReliabilityId(witness.primaryService) ||
    witness.primaryService.length > 64 ||
    !witness.startupServices.includes(witness.primaryService) ||
    !Array.isArray(witness.retainedContainerIds) ||
    witness.retainedContainerIds.length > 256 ||
    !witness.retainedContainerIds.every(digest) ||
    !unique(witness.retainedContainerIds)
  )
    throw new Error("Invalid capacity startup witness.");
}

function validate(record: ReliabilityOperationRecord, identity: ReliabilityIdentity): void {
  keys(record, [
    "version",
    "identity",
    "revision",
    "state",
    "worker",
    "effectSequence",
    "outcome",
    ...(record.version === 2
      ? [
          "capacity",
          "enrollment",
          "activeProfile",
          "preparation",
          "phaseSettlement",
          "startupWitness",
        ]
      : []),
  ]);
  keys(record.identity, ["repoPath", "workspace", "provider"]);
  if (
    (record.version !== 1 && record.version !== 2) ||
    record.identity.repoPath !== identity.repoPath ||
    record.identity.workspace !== identity.workspace ||
    record.identity.provider !== identity.provider ||
    !isReliabilityCounter(record.revision) ||
    !isReliabilityCounter(record.effectSequence)
  ) {
    throw new Error("Reliability record has invalid version, ownership, or counters.");
  }
  if (record.version === 2) {
    const capacity = record.capacity;
    if (capacity === undefined) throw new Error("Invalid capacity authority binding.");
    if (capacity !== null) {
      keys(capacity, [
        "reservationId",
        "operationId",
        "workerId",
        "policyRevision",
        "validUntilMs",
        "snapshotRevision",
        "controller",
        "execSteady",
      ]);
      if (capacity.controller !== undefined) {
        keys(capacity.controller, ["store", "epoch"]);
        if (
          !isReliabilityId(capacity.controller.store) ||
          !isReliabilityCounter(capacity.controller.epoch) ||
          capacity.controller.epoch < 1
        )
          throw new Error("Invalid capacity controller identity.");
      }
    }
    if (
      capacity !== null &&
      (!isReliabilityId(capacity.reservationId) ||
        !isReliabilityId(capacity.operationId) ||
        !isReliabilityId(capacity.workerId) ||
        !Number.isSafeInteger(capacity.policyRevision) ||
        capacity.policyRevision < 1 ||
        !isReliabilityCounter(capacity.validUntilMs) ||
        (capacity.snapshotRevision !== undefined &&
          (!isReliabilityCounter(capacity.snapshotRevision) || capacity.snapshotRevision < 1)))
    )
      throw new Error("Invalid capacity authority binding.");
  }
  const state = record.state;
  assertReliabilityState(state);
  if (state.environmentId !== identityKey(identity)) {
    throw new Error("Reliability record does not match this workspace.");
  }
  if (record.enrollment !== undefined) {
    const enrollment = record.enrollment;
    keys(enrollment, [
      "policyRevision",
      "gitCommonDir",
      "providerId",
      "hostDomain",
      "runtimeDomain",
      "endpoint",
      "daemonId",
      "estimatesDigest",
    ]);
    const absolute = (value: unknown): value is string =>
      typeof value === "string" &&
      value.length <= 4096 &&
      !value.includes("\0") &&
      path.isAbsolute(value) &&
      path.resolve(value) === value;
    const providerIdentity = (value: unknown): value is string =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      value.trim() === value &&
      ![...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      );
    if (
      record.version !== 2 ||
      state.executionPolicy !== "capacity-managed" ||
      !Number.isSafeInteger(enrollment.policyRevision) ||
      enrollment.policyRevision < 1 ||
      !absolute(enrollment.gitCommonDir) ||
      !absolute(enrollment.endpoint) ||
      !providerIdentity(enrollment.providerId) ||
      !providerIdentity(enrollment.daemonId) ||
      !isReliabilityId(enrollment.hostDomain) ||
      !isReliabilityId(enrollment.runtimeDomain) ||
      enrollment.hostDomain === enrollment.runtimeDomain ||
      typeof enrollment.estimatesDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(enrollment.estimatesDigest) ||
      (record.activeProfile !== null &&
        (typeof record.activeProfile !== "string" ||
          record.activeProfile.length > 256 ||
          !/^[a-z0-9,-]+$/.test(record.activeProfile)))
    )
      throw new Error("Invalid durable capacity enrollment.");
  } else if (state.executionPolicy !== "manual" || record.activeProfile !== undefined) {
    throw new Error("Managed lifecycle requires durable capacity enrollment.");
  }
  keys(state, [
    "contractVersion",
    "executionPolicy",
    "operationHistory",
    "environmentId",
    "intentRevision",
    "runtimeGeneration",
    "controllerEpoch",
    "observationsAfterMs",
    "desired",
    "phase",
    "profile",
    "admission",
    "chargeHeld",
    "stopProof",
    "consumers",
    "requests",
    "observations",
    "operation",
    "incident",
  ]);
  keys(state.stopProof, ["workloadsStopped", "routesRemoved"]);
  const operationKeys = ["id", "kind", "drained", "status", "exitCode"];
  if (state.operation) keys(state.operation, operationKeys);
  for (const entry of state.operationHistory) {
    keys(entry, [...operationKeys, "key", "profile", "consumer"]);
    keys(entry.consumer, ["id", "requiredCapabilities", "pinned"]);
  }
  for (const entry of state.consumers) keys(entry, ["id", "requiredCapabilities", "pinned"]);
  for (const entry of state.requests)
    keys(entry, ["key", "mode", "consumerId", "operationId", "profile", "intentRevision"]);
  for (const entry of state.observations)
    keys(entry, ["capability", "infrastructure", "application", "observedAtMs", "validForMs"]);
  if (record.preparation !== undefined && record.preparation !== null) {
    if (
      record.version !== 2 ||
      record.enrollment === undefined ||
      state.executionPolicy !== "capacity-managed"
    )
      throw new Error("Preparation receipt requires durable capacity enrollment.");
    const preparation = record.preparation;
    keys(preparation, ["operationId", "profile", "fence"]);
    keys(preparation.fence, [
      "environmentId",
      "intentRevision",
      "runtimeGeneration",
      "controllerEpoch",
    ]);
    if (
      !isReliabilityId(preparation.operationId) ||
      !isReliabilityProfile(preparation.profile) ||
      !isReliabilityId(preparation.fence.environmentId) ||
      preparation.fence.environmentId !== state.environmentId ||
      !isReliabilityCounter(preparation.fence.intentRevision) ||
      !isReliabilityCounter(preparation.fence.runtimeGeneration) ||
      !isReliabilityCounter(preparation.fence.controllerEpoch)
    )
      throw new Error("Invalid preparation receipt.");
    const preparedOperation = state.operationHistory.find(
      (entry) => entry.id === preparation.operationId,
    );
    if (
      preparedOperation?.kind !== "ensure" ||
      preparedOperation.profile !== preparation.profile ||
      preparedOperation.status !== "COMPLETED"
    )
      throw new Error("Preparation receipt does not match a completed ensure operation.");
  }
  validateCapacityPhaseSettlement(record, state, record.enrollment);
  validateStartupWitness(record, state, record.enrollment);
  const execSteady = record.capacity?.execSteady;
  if (execSteady !== undefined) {
    const enrollment = record.enrollment;
    if (record.version !== 2 || !enrollment || state.executionPolicy !== "capacity-managed")
      throw new Error("Exec steady receipt requires durable capacity enrollment.");
    exactKeys(
      execSteady,
      ["profile", "estimatesDigest", "fence", "totals"],
      "Invalid exec steady receipt fields.",
    );
    exactKeys(
      execSteady.fence,
      ["environmentId", "intentRevision", "runtimeGeneration", "controllerEpoch"],
      "Invalid exec steady receipt fence.",
    );
    if (
      !isReliabilityProfile(execSteady.profile) ||
      typeof execSteady.estimatesDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(execSteady.estimatesDigest) ||
      execSteady.estimatesDigest !== enrollment.estimatesDigest ||
      execSteady.fence.environmentId !== state.environmentId ||
      !isReliabilityCounter(execSteady.fence.intentRevision) ||
      !isReliabilityCounter(execSteady.fence.runtimeGeneration) ||
      !isReliabilityCounter(execSteady.fence.controllerEpoch)
    )
      throw new Error("Invalid exec steady receipt.");
    exactKeys(
      execSteady.totals,
      [enrollment.hostDomain, enrollment.runtimeDomain],
      "Exec steady receipt domains do not match enrollment.",
    );
    if (!Object.values(execSteady.totals).every(isReliabilityCounter))
      throw new Error("Invalid exec steady receipt totals.");
  }
  if (state.operation) {
    const current = state.operationHistory.find((entry) => entry.id === state.operation?.id);
    if (
      !current ||
      operationKeys.some(
        (key) =>
          current[key as keyof typeof current] !==
          state.operation?.[key as keyof typeof state.operation],
      )
    ) {
      throw new Error("Reliability operation and retained result disagree.");
    }
  }
  if (record.outcome !== null) {
    keys(record.outcome, ["operationId", "status", "exitCode", "transport"]);
    keys(record.outcome.transport, ["exitCode", "signal"]);
    const outcome = record.outcome;
    const validExit = (value: unknown) =>
      Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255;
    if (
      outcome.operationId !== state.operation?.id ||
      !["completed", "not-started", "completion-unknown"].includes(outcome.status) ||
      (outcome.status === "completed" ? !validExit(outcome.exitCode) : outcome.exitCode !== null) ||
      (outcome.transport.exitCode !== null && !validExit(outcome.transport.exitCode)) ||
      (outcome.transport.signal !== null &&
        (typeof outcome.transport.signal !== "string" ||
          !/^SIG[A-Z0-9]{1,16}$/.test(outcome.transport.signal)))
    ) {
      throw new Error("Reliability execution outcome is invalid.");
    }
  }
  if (record.worker !== null) {
    keys(record.worker, ["id", "operationId", "pid", "birth"]);
    if (
      !isReliabilityId(record.worker.id) ||
      !isReliabilityId(record.worker.operationId) ||
      typeof record.worker.birth !== "string" ||
      !/^(proc|ps):[a-zA-Z0-9]+$/.test(record.worker.birth) ||
      !isReliabilityCounter(record.worker.pid) ||
      record.worker.pid === 0 ||
      record.worker.operationId !== state.operation?.id
    ) {
      throw new Error("Reliability worker identity is invalid.");
    }
  }
}

/** Called inside the journal transaction, before accepting a lifecycle effect. */
export function assertCapacityEffect(
  record: ReliabilityOperationRecord,
  workerId: string,
  nowMs: number,
  directory = path.join(DEVROUTER_HOME, "controller"),
): void {
  if (record.version === 1) return;
  const binding = record.capacity;
  if (
    !binding ||
    binding.workerId !== workerId ||
    binding.operationId !== record.state.operation?.id ||
    binding.validUntilMs <= nowMs
  )
    throw new Error("Capacity effect authority is absent or stale.");
  if (record.state.executionPolicy === "capacity-managed") {
    const controller = new ControllerStore(directory).read();
    if (
      !binding.controller ||
      !controller ||
      controller.store !== binding.controller.store ||
      controller.epoch !== binding.controller.epoch
    )
      throw new Error("Capacity controller incarnation changed.");
  }
  const snapshot = new CapacityStore(directory).read();
  if (binding.snapshotRevision === undefined || snapshot.revision !== binding.snapshotRevision)
    throw new Error("Capacity snapshot authority is absent or stale.");
  const reservation = snapshot.reservations.find(
    (entry) => entry.reservationId === binding.reservationId,
  );
  if (
    !reservation ||
    reservation.environmentId !== record.state.environmentId ||
    reservation.operationId !== binding.operationId ||
    reservation.policyRevision !== binding.policyRevision
  )
    throw new Error("Capacity effect reservation does not match lifecycle intent.");
}

export function readReliabilityOperation(
  identity: ReliabilityIdentity,
): ReliabilityOperationRecord | undefined {
  const file = reliabilityOperationPath(identity);
  const parsed = readBoundedPrivateJson(file, "Reliability record");
  if (parsed === undefined) return undefined;
  const record = parsed as ReliabilityOperationRecord;
  validate(record, identity);
  return record;
}

function readBoundedPrivateJson(file: string, label: string): unknown | undefined {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.size > MAX_RECORD_BYTES ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error(`${label} is not a bounded private file.`);
    }
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > MAX_RECORD_BYTES) throw new Error(`${label} exceeds its byte limit.`);
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertReliabilityEnumerationTime(startedAtMs: number): void {
  if (performance.now() - startedAtMs > MAX_RELIABILITY_ENUMERATION_MS)
    throw new Error("Reliability journal enumeration exceeded its time limit.");
}

function reliabilityDirectory(): string {
  return path.join(DEVROUTER_HOME, "reliability");
}

function journalIdentity(value: unknown): ReliabilityIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Reliability journal identity is invalid.");
  const identity = (value as { identity?: unknown }).identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity))
    throw new Error("Reliability journal identity is invalid.");
  return identity as ReliabilityIdentity;
}

/** Read every validated private journal without consulting controller policy or runtime state. */
export function listReliabilityOperations(): ReliabilityOperationRecord[] {
  const startedAtMs = performance.now();
  const directory = reliabilityDirectory();
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Reliability journal directory is unsafe.");
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("Reliability journal directory is not private.");

  const entries: fs.Dirent[] = [];
  const handle = fs.opendirSync(directory);
  try {
    for (;;) {
      assertReliabilityEnumerationTime(startedAtMs);
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry);
      if (entries.length > MAX_RELIABILITY_DIRECTORY_ENTRIES)
        throw new Error("Reliability journal directory exceeds its entry limit.");
    }
  } finally {
    handle.closeSync();
  }

  const journals: Array<{ name: string; key: string }> = [];
  for (const entry of entries) {
    assertReliabilityEnumerationTime(startedAtMs);
    if (entry.isSymbolicLink())
      throw new Error("Reliability journal directory contains a symlink.");
    if (!entry.isFile())
      throw new Error("Reliability journal directory contains an unsupported entry.");
    if (
      RELIABILITY_LOCK_NAME_RE.test(entry.name) ||
      RELIABILITY_ATOMIC_TEMP_NAME_RE.test(entry.name)
    )
      continue;
    const match = RELIABILITY_JOURNAL_NAME_RE.exec(entry.name);
    if (!match) throw new Error("Reliability journal directory contains an unsupported entry.");
    journals.push({ name: entry.name, key: match[1] });
  }
  if (journals.length > MAX_RELIABILITY_JOURNALS)
    throw new Error("Reliability journal directory exceeds its journal limit.");
  journals.sort((left, right) => left.name.localeCompare(right.name));

  const records: ReliabilityOperationRecord[] = [];
  for (const journal of journals) {
    assertReliabilityEnumerationTime(startedAtMs);
    const file = path.join(directory, journal.name);
    const identity = journalIdentity(readBoundedPrivateJson(file, "Reliability journal"));
    if (identityKey(identity) !== journal.key)
      throw new Error("Reliability journal filename does not match its identity.");
    const record = readReliabilityOperation(identity);
    if (!record) throw new Error("Reliability journal disappeared during enumeration.");
    records.push(record);
    assertReliabilityEnumerationTime(startedAtMs);
  }
  return records;
}

function persist(record: ReliabilityOperationRecord): void {
  validate(record, record.identity);
  const contents = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(contents) > MAX_RECORD_BYTES)
    throw new Error("Reliability record exceeds its byte limit.");
  const file = reliabilityOperationPath(record.identity);
  try {
    writeFileAtomically(file, contents);
  } catch (error) {
    // Rename may have succeeded. Re-read and sync the exact new record before
    // treating persistence as acknowledged; readable bytes alone are not durability.
    const reread = readReliabilityOperation(record.identity);
    if (!reread || JSON.stringify(reread) !== JSON.stringify(record)) throw error;
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const directory = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }
}

export function updateReliabilityOperation<T>(
  identity: ReliabilityIdentity,
  operation: (record: ReliabilityOperationRecord) => T,
): T {
  const file = reliabilityOperationPath(identity);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.lock`, { activity: "reliability intent", waitMs: 2_000 }, () => {
    const record = readReliabilityOperation(identity) ?? {
      version: 1 as const,
      identity: { ...identity },
      revision: 0,
      state: createReliabilityState(identityKey(identity), 0, "manual"),
      worker: null,
      effectSequence: 0,
      outcome: null,
    };
    if (record.revision === Number.MAX_SAFE_INTEGER)
      throw new Error("Reliability record revision is exhausted.");
    const previousVersion = record.version;
    const previousEnrollment = record.enrollment && { ...record.enrollment };
    const result = operation(record);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("Reliability record updates must be synchronous.");
    }
    if (
      record.version < previousVersion ||
      (previousEnrollment && !isDeepStrictEqual(record.enrollment, previousEnrollment))
    )
      throw new Error("Durable capacity enrollment cannot be downgraded or replaced.");
    validate(record, identity);
    record.revision += 1;
    persist(record);
    return result;
  });
}

/** Caller supplies canonical operator enrollment; conversion consumes prior exact stop proof. */
export function enrollStoppedLifecycle(
  identity: ReliabilityIdentity,
  expectedRevision: number,
  enrollment: CapacityEnrollmentBinding,
): void {
  updateReliabilityOperation(identity, (record) => {
    if (record.revision !== expectedRevision)
      throw new Error("Enrollment journal revision changed.");
    if (record.enrollment) {
      if (
        Object.entries(record.enrollment).some(
          ([key, value]) => enrollment[key as keyof CapacityEnrollmentBinding] !== value,
        )
      )
        throw new Error("Lifecycle already has a different capacity enrollment.");
      return;
    }
    if (
      record.worker ||
      record.capacity ||
      record.state.desired !== "stopped-by-user" ||
      record.state.phase !== "idle" ||
      !record.state.stopProof.workloadsStopped ||
      !record.state.stopProof.routesRemoved ||
      (record.state.operation && !record.state.operation.drained) ||
      record.state.operationHistory.some((operation) => !operation.drained)
    )
      throw new Error("Capacity enrollment requires stopped and drained proof.");
    record.version = 2;
    record.capacity = null;
    record.enrollment = structuredClone(enrollment);
    record.activeProfile = null;
    record.state.executionPolicy = "capacity-managed";
    record.state.admission = "unknown";
  });
}

/**
 * Publish the bounded startup witness inside the journal transaction. The
 * caller constructs the full evidence beforehand; this writer accepts the
 * witness only while the live fence still matches the bound one and never
 * replaces a witness bound to a different fence or operation.
 */
export function publishStartupWitness(
  identity: ReliabilityIdentity,
  witness: CapacityStartupWitness,
): void {
  updateReliabilityOperation(identity, (record) => {
    if (record.version !== 2)
      throw new Error("Startup witness requires durable capacity enrollment.");
    const live = reliabilityFence(record.state);
    if (
      Object.entries(witness.fence).some(
        ([key, value]) => value !== live[key as keyof ReliabilityFence],
      )
    )
      throw new Error("Startup witness publication fence changed.");
    if (
      record.startupWitness &&
      !isDeepStrictEqual(record.startupWitness, witness) &&
      (record.startupWitness.operationId !== witness.operationId ||
        !isDeepStrictEqual(record.startupWitness.fence, witness.fence))
    )
      throw new Error("Startup witness already exists for a different generation.");
    record.startupWitness = structuredClone(witness);
  });
}

/**
 * Clear a superseded witness without leaving a stale generation behind. A
 * different live fence is a failure, not an opportunity to forget evidence.
 */
export function clearStartupWitness(identity: ReliabilityIdentity, fence: ReliabilityFence): void {
  updateReliabilityOperation(identity, (record) => {
    if (record.startupWitness === undefined || record.startupWitness === null) return;
    const live = reliabilityFence(record.state);
    if (Object.entries(fence).some(([key, value]) => value !== live[key as keyof ReliabilityFence]))
      throw new Error("Startup witness clearing fence changed.");
    record.startupWitness = null;
  });
}

/** Coordinate an observer publication against manual intent without updating it. */
export function withReliabilityObservationFence<T>(
  identity: ReliabilityIdentity,
  expectedRevision: number,
  publish: (record: ReliabilityOperationRecord) => T,
): T {
  const file = reliabilityOperationPath(identity);
  // Missing state remains unknown; observation never initializes manual intent.
  const before = readReliabilityOperation(identity);
  if (!before || before.revision !== expectedRevision)
    throw new Error("Reliability observation fence changed or is absent.");
  return withFileLockSync(`${file}.lock`, { activity: "observer publication", waitMs: 100 }, () => {
    const current = readReliabilityOperation(identity);
    if (!current || current.revision !== expectedRevision)
      throw new Error("Reliability observation fence changed or is absent.");
    const result = publish(current);
    if (result && typeof (result as { then?: unknown }).then === "function")
      throw new Error("Observer publication must be synchronous.");
    return result;
  });
}
