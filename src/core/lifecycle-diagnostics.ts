import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { writeFileAtomically } from "./atomic-file";
import { isLifecycleProgressPhase, type LifecycleProgressPhase } from "./lifecycle-progress";
import { reliabilityFence } from "./reliability-contract";
import { type ReliabilityIdentity, readReliabilityOperation } from "./reliability-operation-store";
import type { LifecycleWorkerRequest } from "./reliability-worker";
import { DEVROUTER_HOME } from "./router";

const MAX_TAIL_BYTES = 32_768;
const MAX_RECEIPT_BYTES = 65_536;
const PACKAGE_TASK = /(?:^|\s)((?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+):build:/;

type OutputChunk = { stream: "stdout" | "stderr"; data: Buffer };

function privateDirectory(directory: string): boolean {
  const stat = fs.lstatSync(directory);
  return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}
type Receipt = {
  version: 1;
  identity: ReliabilityIdentity;
  operationId: string;
  workerId: string;
  fence: LifecycleWorkerRequest["fence"];
  startedAtMs: number;
  updatedAtMs: number;
  phase: LifecycleProgressPhase | null;
  phaseAtMs: number | null;
  lastOutputAtMs: number | null;
  lastProgressAtMs: number | null;
  buildPackage: string | null;
  cancellationRequested: boolean;
  closed: boolean;
  output: { stream: "stdout" | "stderr"; data: string }[];
};

export type LifecycleDiagnostics = {
  stage: LifecycleProgressPhase | "unknown";
  elapsedMs: number;
  stageAgeMs: number | null;
  outputAgeMs: number | null;
  progressAgeMs: number | null;
  evidence: "recent" | "stale";
  buildPackage: string | null;
  liveness: "unknown";
  executionDeadlineAtMs: null;
  handshakeTimeoutMs: 30_000;
  cancellationGraceMs: 2_000;
  cancellationRequested: boolean;
  workerDrained: boolean;
};

export function lifecycleDiagnosticsPath(identity: ReliabilityIdentity): string {
  return path.join(
    DEVROUTER_HOME,
    "lifecycle-diagnostics",
    `${createHash("sha256").update(identity.repoPath).digest("hex")}.json`,
  );
}

/** Diagnostic files are optional witnesses, never lifecycle mutation authority. */
function readReceipt(identity: ReliabilityIdentity): Receipt | undefined {
  let descriptor: number | undefined;
  try {
    if (!privateDirectory(path.dirname(lifecycleDiagnosticsPath(identity)))) return undefined;
    descriptor = fs.openSync(
      lifecycleDiagnosticsPath(identity),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > MAX_RECEIPT_BYTES
    )
      return undefined;
    const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (size > MAX_RECEIPT_BYTES) return undefined;
    const receipt: Receipt = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    const timestamp = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const optionalTime = (value: unknown) => value === null || timestamp(value);
    if (
      receipt.version !== 1 ||
      !isDeepStrictEqual(receipt.identity, identity) ||
      typeof receipt.operationId !== "string" ||
      typeof receipt.workerId !== "string" ||
      !timestamp(receipt.startedAtMs) ||
      !timestamp(receipt.updatedAtMs) ||
      receipt.updatedAtMs < receipt.startedAtMs ||
      !(receipt.phase === null || isLifecycleProgressPhase(receipt.phase)) ||
      !optionalTime(receipt.phaseAtMs) ||
      !optionalTime(receipt.lastOutputAtMs) ||
      !optionalTime(receipt.lastProgressAtMs) ||
      !(
        receipt.buildPackage === null ||
        (typeof receipt.buildPackage === "string" &&
          receipt.buildPackage.length <= 128 &&
          /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(receipt.buildPackage))
      ) ||
      typeof receipt.cancellationRequested !== "boolean" ||
      typeof receipt.closed !== "boolean" ||
      !Array.isArray(receipt.output) ||
      receipt.output.length > 64
    )
      return undefined;
    let bytes = 0;
    for (const chunk of receipt.output) {
      if (
        !chunk ||
        !["stdout", "stderr"].includes(chunk.stream) ||
        typeof chunk.data !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
      )
        return undefined;
      bytes += Buffer.byteLength(chunk.data, "base64");
    }
    return bytes <= MAX_TAIL_BYTES ? receipt : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Read without acquiring the worker's lifecycle lock or launching a container command. */
export function readLifecycleDiagnostics(identity: ReliabilityIdentity, now = Date.now()) {
  try {
    const before = readReliabilityOperation(identity);
    const receipt = readReceipt(identity);
    const after = readReliabilityOperation(identity);
    if (
      !before ||
      !after ||
      !receipt ||
      before.revision !== after.revision ||
      !isDeepStrictEqual(before, after) ||
      !isDeepStrictEqual(receipt.fence, reliabilityFence(after.state)) ||
      after.state.operation?.id !== receipt.operationId ||
      after.state.operation.kind !== "ensure" ||
      (after.worker !== null && after.worker.id !== receipt.workerId) ||
      (!receipt.closed && !after.worker) ||
      now < receipt.updatedAtMs ||
      [receipt.phaseAtMs, receipt.lastOutputAtMs, receipt.lastProgressAtMs].some(
        (time) => time !== null && (time < receipt.startedAtMs || time > receipt.updatedAtMs),
      )
    )
      return undefined;
    const age = (time: number | null) => (time === null ? null : now - time);
    const metadata: LifecycleDiagnostics = {
      stage: receipt.phase ?? "unknown",
      elapsedMs: Math.max(0, (receipt.closed ? receipt.updatedAtMs : now) - receipt.startedAtMs),
      stageAgeMs: age(receipt.phaseAtMs),
      outputAgeMs: age(receipt.lastOutputAtMs),
      progressAgeMs: age(receipt.lastProgressAtMs),
      evidence: now - receipt.updatedAtMs < 30_000 ? "recent" : "stale",
      buildPackage: receipt.buildPackage,
      liveness: "unknown",
      executionDeadlineAtMs: null,
      handshakeTimeoutMs: 30_000,
      cancellationGraceMs: 2_000,
      cancellationRequested: receipt.cancellationRequested,
      workerDrained: after.state.operation.drained,
    };
    return { operationId: receipt.operationId, metadata, output: receipt.output };
  } catch {
    return undefined;
  }
}

/** Own one coalesced receipt; raw output stays outside the reliability journal. */
export class LifecycleDiagnosticRecorder {
  private receipt: Receipt;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private lastLine = "";
  private fragments = { stdout: "", stderr: "" };

  constructor(
    private request: LifecycleWorkerRequest,
    private output: () => { chunks: OutputChunk[] },
  ) {
    const now = Date.now();
    this.receipt = {
      version: 1,
      identity: request.identity,
      operationId: request.operationId,
      workerId: request.workerId,
      fence: request.fence,
      startedAtMs: now,
      updatedAtMs: now,
      phase: null,
      phaseAtMs: null,
      lastOutputAtMs: null,
      lastProgressAtMs: null,
      buildPackage: null,
      cancellationRequested: false,
      closed: false,
      output: [],
    };
    this.flush();
  }

  phase(phase: LifecycleProgressPhase): void {
    if (this.receipt.closed) return;
    if (this.receipt.phase !== phase) this.receipt.buildPackage = null;
    this.receipt.phase = phase;
    this.receipt.phaseAtMs = Date.now();
    this.flush();
  }

  append(stream: "stdout" | "stderr", data: Buffer): void {
    if (this.receipt.closed) return;
    const now = Date.now();
    this.receipt.lastOutputAtMs = now;
    const text = `${this.fragments[stream]}${data.subarray(-MAX_TAIL_BYTES).toString("utf8")}`;
    const lines = text.split(/[\r\n]/);
    this.fragments[stream] = (lines.pop() ?? "").slice(-4096);
    for (const raw of lines) {
      const line = stripVTControlCharacters(raw).trim();
      const digest = createHash("sha256").update(line).digest("hex");
      if (
        !line ||
        digest === this.lastLine ||
        [...line].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        line.startsWith('{"type":"lifecycle-progress"')
      )
        continue;
      this.lastLine = digest;
      this.receipt.lastProgressAtMs = now;
      const buildPackage = PACKAGE_TASK.exec(line)?.[1];
      if (buildPackage && buildPackage.length <= 128) this.receipt.buildPackage = buildPackage;
    }
    if (!this.pending) {
      this.pending = setTimeout(() => this.flush(), 250);
      this.pending.unref();
    }
  }

  cancel(): void {
    this.receipt.cancellationRequested = true;
    this.flush();
  }

  close(): void {
    if (this.receipt.closed) return;
    this.receipt.closed = true;
    this.flush();
  }

  private flush(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    try {
      const record = readReliabilityOperation(this.request.identity);
      if (
        !record ||
        record.state.operation?.id !== this.request.operationId ||
        !isDeepStrictEqual(reliabilityFence(record.state), this.request.fence) ||
        (record.worker && record.worker.id !== this.request.workerId)
      )
        return;
      let remaining = MAX_TAIL_BYTES;
      const chunks: Receipt["output"] = [];
      for (const chunk of this.output().chunks.slice().reverse()) {
        const data = chunk.data.subarray(-remaining);
        if (data.length) chunks.unshift({ stream: chunk.stream, data: data.toString("base64") });
        remaining -= data.length;
        if (remaining === 0) break;
      }
      this.receipt.output = chunks;
      this.receipt.updatedAtMs = Date.now();
      const file = lifecycleDiagnosticsPath(this.request.identity);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (!privateDirectory(path.dirname(file))) return;
      writeFileAtomically(file, `${JSON.stringify(this.receipt)}\n`);
    } catch {
      // Missing diagnostics cannot alter dispatch, cancellation, drainage or effects.
    }
  }
}
