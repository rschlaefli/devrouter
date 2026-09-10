import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DevsyExecProof } from "./devsy-exec-proof";
import { processBirthIdentity } from "./file-lock";
import {
  type ReliabilityConsumer,
  type ReliabilityFence,
  reliabilityFence,
} from "./reliability-contract";
import { stepReliability } from "./reliability-model";
import {
  assertCapacityEffect,
  type ReliabilityIdentity,
  type ReliabilityOperationRecord,
  readReliabilityOperation,
  updateReliabilityOperation,
} from "./reliability-operation-store";

export type LifecycleWorkerRequest = {
  kind: "ensure" | "exec" | "stop";
  repoPath: string;
  identity: ReliabilityIdentity;
  requestId: string;
  operationId: string;
  workerId: string;
  fence: ReliabilityFence;
  command?: string[];
  retainedExecProof?: DevsyExecProof;
  admission?: {
    expectedRevision: number;
    profile: string;
    consumer: ReliabilityConsumer;
    runtimeRunning: boolean;
    recoverInterruptedEnsure?: boolean;
  };
  options: {
    profile?: string;
    repair?: boolean;
    open?: boolean;
    quiet?: boolean;
    delete?: boolean;
  };
};

export type LifecycleWorkerResult = { ok: true; value: unknown } | { ok: false; message: string };

export type LifecycleSupervision = {
  signal: AbortSignal;
  output: LifecycleOutput;
};

const OUTPUT_BUFFER_LIMIT = 262_144;
const DEFAULT_OUTPUT_PAGE_BYTES = 48 * 1024;

export type LifecycleOutputCursor = { sequence: number; offset: number };
export type LifecycleOutputPageChunk = {
  stream: "stdout" | "stderr";
  data: string;
  sequence: number;
};
export type LifecycleOutputPage = {
  encoding: "base64";
  gap: boolean;
  sequence: LifecycleOutputCursor;
  chunks: LifecycleOutputPageChunk[];
};

function outputPageBytes(page: LifecycleOutputPage): number {
  return Buffer.byteLength(JSON.stringify(page), "utf8");
}

/** Transient output for controller-owned commands; client reads never pause pipes. */
export class LifecycleOutput {
  private chunks: { stream: "stdout" | "stderr"; data: Buffer; sequence: number }[] = [];
  private bytes = 0;
  private sequence = 0;
  private droppedThrough = 0;
  private partialSequences = new Set<number>();

  append(stream: "stdout" | "stderr", data: Buffer): void {
    const limit = OUTPUT_BUFFER_LIMIT;
    const sequence = ++this.sequence;
    if (data.byteLength > limit) {
      this.droppedThrough = sequence;
      this.partialSequences.add(sequence);
    }
    const kept = Buffer.from(data.subarray(-limit));
    this.chunks.push({ stream, data: kept, sequence });
    this.bytes += kept.byteLength;
    while (this.bytes > limit || this.chunks.length > 64) {
      const removed = this.chunks.shift();
      if (!removed) break;
      this.bytes -= removed.data.byteLength;
      this.droppedThrough = Math.max(this.droppedThrough, removed.sequence);
      this.partialSequences.delete(removed.sequence);
    }
  }

  read(afterSequence = 0) {
    return {
      gap: afterSequence < this.droppedThrough,
      sequence: this.sequence,
      chunks: this.chunks
        .filter((chunk) => chunk.sequence > afterSequence)
        .map((chunk) => ({ ...chunk, data: Buffer.from(chunk.data) })),
    };
  }

  /** Return a JSON-safe base64 page; the cursor offset counts raw bytes in one output chunk. */
  readPage(
    after: LifecycleOutputCursor = { sequence: 0, offset: 0 },
    maxJsonBytes = DEFAULT_OUTPUT_PAGE_BYTES,
  ): LifecycleOutputPage {
    const cursor = { ...after };
    if (
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence < 0 ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.sequence > this.sequence ||
      (cursor.sequence === 0 && cursor.offset !== 0)
    )
      throw new Error("Invalid output cursor.");
    const cursorChunk = this.chunks.find((chunk) => chunk.sequence === cursor.sequence);
    if (cursorChunk && cursor.offset > cursorChunk.data.byteLength)
      throw new Error("Invalid output cursor.");
    if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes <= 0)
      throw new Error("Invalid output page byte bound.");
    const cursorHasPartialChunk =
      cursorChunk !== undefined &&
      this.partialSequences.has(cursor.sequence) &&
      cursor.offset < cursorChunk.data.byteLength;

    let page: LifecycleOutputPage = {
      encoding: "base64",
      gap:
        cursor.sequence < this.droppedThrough ||
        (cursor.sequence > 0 && cursor.sequence <= this.droppedThrough && !cursorChunk) ||
        cursorHasPartialChunk,
      sequence: cursor,
      chunks: [],
    };
    if (outputPageBytes(page) > maxJsonBytes)
      throw new Error("Output page byte bound is too small.");

    for (const chunk of this.chunks) {
      if (chunk.sequence < cursor.sequence) continue;
      let offset = chunk.sequence === cursor.sequence ? cursor.offset : 0;
      if (offset >= chunk.data.byteLength) {
        const nextPage = { ...page, sequence: { sequence: chunk.sequence, offset } };
        if (outputPageBytes(nextPage) > maxJsonBytes) {
          if (page.sequence.sequence === cursor.sequence && page.sequence.offset === cursor.offset)
            throw new Error("Output page byte bound is too small.");
          return page;
        }
        page = nextPage;
        continue;
      }
      while (offset < chunk.data.byteLength) {
        let low = offset + 1;
        let high = chunk.data.byteLength;
        let best: LifecycleOutputPage | undefined;
        while (low <= high) {
          const midpoint = Math.floor((low + high) / 2);
          const candidatePage: LifecycleOutputPage = {
            encoding: "base64",
            gap: page.gap,
            sequence: { sequence: chunk.sequence, offset: midpoint },
            chunks: [
              ...page.chunks,
              {
                stream: chunk.stream,
                data: chunk.data.subarray(offset, midpoint).toString("base64"),
                sequence: chunk.sequence,
              },
            ],
          };
          if (outputPageBytes(candidatePage) <= maxJsonBytes) {
            best = candidatePage;
            low = midpoint + 1;
          } else high = midpoint - 1;
        }
        if (!best) {
          if (page.sequence.sequence === cursor.sequence && page.sequence.offset === cursor.offset)
            throw new Error("Output page byte bound is too small.");
          return page;
        }
        page = best;
        offset = best.sequence.offset;
      }
    }
    return page;
  }
}

export class LifecycleWorkerAdmissionBusyError extends Error {
  constructor() {
    super("Lifecycle admission lost to another operation.");
    this.name = "LifecycleWorkerAdmissionBusyError";
  }
}

function sameFence(record: ReliabilityOperationRecord, fence: ReliabilityFence): boolean {
  return Object.entries(reliabilityFence(record.state)).every(
    ([key, value]) => value === fence[key as keyof ReliabilityFence],
  );
}

export function hasDuplicateOperation(
  record: ReliabilityOperationRecord,
  requestId: string,
  operationId: string,
): boolean {
  return record.state.operationHistory.some(
    (operation) => operation.key === requestId || operation.id === operationId,
  );
}

export function workerGroupAbsent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function signalOwnedGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function runLifecycleWorker(
  request: LifecycleWorkerRequest,
  supervision?: LifecycleSupervision,
  beforeAdmission?: () => void,
): Promise<unknown> {
  if (supervision?.signal.aborted)
    throw new Error("Lifecycle invocation was cancelled before dispatch.");
  if (process.platform === "win32")
    throw new Error("Lifecycle workers require POSIX process-group ownership.");
  const workerPath = path.join(__dirname, "devrouter-lifecycle-worker.js");
  if (!fs.existsSync(workerPath))
    throw new Error("The packaged lifecycle worker is missing; rebuild the CLI.");
  const child = fork(workerPath, [], {
    detached: true,
    stdio: supervision
      ? ["ignore", "pipe", "pipe", "ipc"]
      : ["inherit", "inherit", "inherit", "ipc"],
    execArgv: [],
  });
  let ready = false;
  let closed = false;
  let registered = false;
  let dispatchAcknowledged = false;
  let sendAttempted = false;
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  let result: LifecycleWorkerResult | undefined;
  let cancelled = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let failure: Error | undefined;
  const cancel = () => {
    if (cancelled || closed) return;
    cancelled = true;
    try {
      signalOwnedGroup(child, "SIGTERM");
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    forceTimer = setTimeout(() => {
      try {
        signalOwnedGroup(child, "SIGKILL");
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }, 2_000);
  };
  const onSignal = () => cancel();
  const stdout = (data: Buffer) => supervision?.output.append("stdout", data);
  const stderr = (data: Buffer) => supervision?.output.append("stderr", data);
  if (supervision) {
    child.stdout?.on("data", stdout);
    child.stderr?.on("data", stderr);
    supervision.signal.addEventListener("abort", onSignal, { once: true });
    if (supervision.signal.aborted) cancel();
  } else {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  try {
    return await new Promise<unknown>((resolve, reject) => {
      child.once("error", (error) => {
        failure = error;
      });
      readinessTimer = setTimeout(() => {
        failure = new Error("Lifecycle worker readiness timed out before dispatch.");
        cancel();
      }, 30_000);
      child.on("message", async (message: unknown) => {
        if (!message || typeof message !== "object") return;
        if ("ready" in message && message.ready === true && !ready) {
          ready = true;
          if (readinessTimer) clearTimeout(readinessTimer);
          try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (closed) return;
            if (cancelled || !child.pid)
              throw new Error("Lifecycle invocation was cancelled before dispatch.");
            if (request.kind !== "stop") {
              const birth = processBirthIdentity(child.pid);
              if (!birth) throw new Error("Could not prove lifecycle worker incarnation.");
              updateReliabilityOperation(request.identity, (record) => {
                if (request.admission) {
                  beforeAdmission?.();
                  if (!request.admission)
                    throw new Error("Lifecycle operation admission is required.");
                  if (hasDuplicateOperation(record, request.requestId, request.operationId))
                    throw new Error(
                      "Lifecycle operation request conflicts with an existing operation.",
                    );
                  if (!sameFence(record, request.fence))
                    throw new Error("Lifecycle intent changed before dispatch.");
                  if (record.worker || record.revision !== request.admission.expectedRevision) {
                    throw new LifecycleWorkerAdmissionBusyError();
                  }
                  const admitted = stepReliability(
                    record.state,
                    {
                      ...request.fence,
                      type: "operation-request",
                      kind: request.kind === "exec" ? "exec" : "ensure",
                      key: request.requestId,
                      operationId: request.operationId,
                      profile: request.admission.profile,
                      consumer: request.admission.consumer,
                      runtimeRunning: request.admission.runtimeRunning,
                      ...(request.admission.recoverInterruptedEnsure
                        ? { recoverInterruptedEnsure: true }
                        : {}),
                    },
                    Date.now(),
                  );
                  if (admitted.outcome !== "accepted")
                    throw new Error(
                      `Lifecycle admission is ${admitted.outcome}.${
                        admitted.reason ? ` ${admitted.reason}` : ""
                      }`,
                    );
                  record.state = admitted.state;
                  record.outcome = null;
                  request.fence = reliabilityFence(record.state);
                } else {
                  if (
                    record.state.executionPolicy === "manual" ||
                    !sameFence(record, request.fence) ||
                    record.worker ||
                    record.state.operation?.id !== request.operationId
                  )
                    throw new Error("Controller lifecycle admission is required.");
                }
                assertCapacityEffect(record, request.workerId, Date.now());
                record.worker = {
                  id: request.workerId,
                  operationId: request.operationId,
                  pid: child.pid as number,
                  birth,
                };
                const transition = stepReliability(
                  record.state,
                  { ...request.fence, type: "dispatch" },
                  Date.now(),
                );
                if (transition.outcome !== "accepted")
                  throw new Error("Lifecycle dispatch is blocked.");
                record.state = transition.state;
              });
              registered = true;
              updateReliabilityOperation(request.identity, (record) => {
                assertCapacityEffect(record, request.workerId, Date.now());
                const transition = stepReliability(
                  record.state,
                  {
                    ...request.fence,
                    type: "dispatch-persisted",
                    operationId: request.operationId,
                  },
                  Date.now(),
                );
                if (!transition.effects.some((effect) => effect.kind === "launch")) {
                  throw new Error("Lifecycle dispatch persistence was not acknowledged.");
                }
                record.state = transition.state;
              });
              dispatchAcknowledged = true;
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (closed) return;
            beforeAdmission?.();
            if (cancelled) throw new Error("Lifecycle invocation was cancelled before dispatch.");
            sendAttempted = true;
            child.send({ request }, (error) => {
              if (error) {
                failure = error;
                cancel();
              }
            });
            monitor = setInterval(() => {
              try {
                const record = readReliabilityOperation(request.identity);
                if (!record || !sameFence(record, request.fence)) cancel();
              } catch (error) {
                failure = error instanceof Error ? error : new Error(String(error));
                cancel();
              }
            }, 100);
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            cancel();
          }
        } else if ("ok" in message && typeof message.ok === "boolean") {
          result = message as LifecycleWorkerResult;
        }
      });
      child.once("close", () => {
        closed = true;
        try {
          if (request.kind !== "stop" && registered) {
            updateReliabilityOperation(request.identity, (record) => {
              if (record.worker?.id !== request.workerId || record.worker.pid !== child.pid) return;
              if (!result) {
                record.state = stepReliability(
                  record.state,
                  {
                    ...reliabilityFence(record.state),
                    type:
                      request.kind === "exec" && dispatchAcknowledged && !sendAttempted
                        ? "not-started"
                        : "interrupted",
                    operationId: request.operationId,
                  },
                  Date.now(),
                ).state;
              }
              if (child.pid && workerGroupAbsent(child.pid)) {
                record.state = stepReliability(
                  record.state,
                  {
                    ...reliabilityFence(record.state),
                    type: "drained",
                    operationId: request.operationId,
                  },
                  Date.now(),
                ).state;
                record.worker = null;
              }
            });
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        if (failure) reject(failure);
        else if (!result?.ok)
          reject(
            new Error(
              result && !result.ok ? result.message : "Lifecycle worker completion is unknown.",
            ),
          );
        else resolve(result.value);
      });
    });
  } finally {
    if (readinessTimer) clearTimeout(readinessTimer);
    if (monitor) clearInterval(monitor);
    if (forceTimer) clearTimeout(forceTimer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    supervision?.signal.removeEventListener("abort", onSignal);
    child.stdout?.removeListener("data", stdout);
    child.stderr?.removeListener("data", stderr);
  }
}

export function newLifecycleIds() {
  return { requestId: randomUUID(), operationId: randomUUID(), workerId: randomUUID() };
}
