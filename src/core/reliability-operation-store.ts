import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";
import type { ExecutionOutcome } from "./execution-outcome";
import { withFileLockSync } from "./file-lock";
import {
  assertReliabilityState,
  createReliabilityState,
  isReliabilityCounter,
  isReliabilityId,
  type ReliabilityState,
} from "./reliability-contract";
import { DEVROUTER_HOME } from "./router";

export type ReliabilityIdentity = {
  repoPath: string;
  workspace: string | null;
  provider: "devpod" | "devsy";
};

export type ReliabilityOperationRecord = {
  version: 1;
  identity: ReliabilityIdentity;
  revision: number;
  state: ReliabilityState;
  worker: { id: string; operationId: string; pid: number; birth: string } | null;
  effectSequence: number;
  outcome: (ExecutionOutcome & { operationId: string }) | null;
  /** CLI version that last wrote this record; absent in pre-0.0.67 records. */
  writtenByVersion?: string;
};

declare const __VERSION__: string;

function installedCliVersion(): string {
  return typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";
}

function compareCliVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = parts(left);
  const rightParts = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const MAX_RECORD_BYTES = 1_048_576;

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

function validate(record: ReliabilityOperationRecord, identity: ReliabilityIdentity): void {
  keys(record, [
    "version",
    "identity",
    "revision",
    "state",
    "worker",
    "effectSequence",
    "outcome",
    "writtenByVersion",
  ]);
  if (
    record.writtenByVersion !== undefined &&
    compareCliVersions(record.writtenByVersion, installedCliVersion()) > 0
  ) {
    throw new Error(
      `Reliability record was last written by devrouter ${record.writtenByVersion}, which is newer than the installed ${installedCliVersion()}; upgrade devrouter (devrouter upgrade) before running lifecycle commands.`,
    );
  }
  keys(record.identity, ["repoPath", "workspace", "provider"]);
  if (
    record.version !== 1 ||
    record.identity.repoPath !== identity.repoPath ||
    record.identity.workspace !== identity.workspace ||
    record.identity.provider !== identity.provider ||
    !isReliabilityCounter(record.revision) ||
    !isReliabilityCounter(record.effectSequence)
  ) {
    throw new Error("Reliability record has invalid version, ownership, or counters.");
  }
  const state = record.state;
  assertReliabilityState(state);
  if (state.environmentId !== identityKey(identity) || state.executionPolicy !== "manual") {
    throw new Error("Reliability record does not grant manual authority for this workspace.");
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

export function readReliabilityOperation(
  identity: ReliabilityIdentity,
): ReliabilityOperationRecord | undefined {
  const file = reliabilityOperationPath(identity);
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
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || (stat.mode & 0o077) !== 0) {
      throw new Error("Reliability record is not a bounded private file.");
    }
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > MAX_RECORD_BYTES) throw new Error("Reliability record exceeds its byte limit.");
    const record = JSON.parse(
      bytes.subarray(0, count).toString("utf8"),
    ) as ReliabilityOperationRecord;
    validate(record, identity);
    return record;
  } finally {
    fs.closeSync(descriptor);
  }
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
    const result = operation(record);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("Reliability record updates must be synchronous.");
    }
    record.writtenByVersion = installedCliVersion();
    validate(record, identity);
    record.revision += 1;
    persist(record);
    return result;
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
