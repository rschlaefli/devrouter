import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { processBirthIdentity } from "./file-lock";
import { type ReliabilityFence, reliabilityFence } from "./reliability-contract";
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

/** Transient output for controller-owned commands; client reads never pause pipes. */
export class LifecycleOutput {
  private chunks: { stream: "stdout" | "stderr"; data: Buffer; sequence: number }[] = [];
  private bytes = 0;
  private sequence = 0;
  private droppedThrough = 0;

  append(stream: "stdout" | "stderr", data: Buffer): void {
    const limit = 262_144;
    const sequence = ++this.sequence;
    if (data.byteLength > limit) this.droppedThrough = sequence;
    const kept = Buffer.from(data.subarray(-limit));
    this.chunks.push({ stream, data: kept, sequence });
    this.bytes += kept.byteLength;
    while (this.bytes > limit || this.chunks.length > 64) {
      const removed = this.chunks.shift();
      if (!removed) break;
      this.bytes -= removed.data.byteLength;
      this.droppedThrough = Math.max(this.droppedThrough, removed.sequence);
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
}

function sameFence(record: ReliabilityOperationRecord, fence: ReliabilityFence): boolean {
  return Object.entries(reliabilityFence(record.state)).every(
    ([key, value]) => value === fence[key as keyof ReliabilityFence],
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
  let result: LifecycleWorkerResult | undefined;
  let cancelled = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let failure: Error | undefined;
  const cancel = () => {
    if (cancelled) return;
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
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        if ("ready" in message && message.ready === true && !ready) {
          ready = true;
          try {
            if (cancelled || !child.pid)
              throw new Error("Lifecycle invocation was cancelled before dispatch.");
            if (request.kind !== "stop") {
              const birth = processBirthIdentity(child.pid);
              if (!birth) throw new Error("Could not prove lifecycle worker incarnation.");
              updateReliabilityOperation(request.identity, (record) => {
                if (
                  !sameFence(record, request.fence) ||
                  record.worker ||
                  record.state.operation?.id !== request.operationId
                ) {
                  throw new Error("Lifecycle intent changed before dispatch.");
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
                record.state = transition.state;
                if (!transition.effects.some((effect) => effect.kind === "launch")) {
                  throw new Error("Lifecycle dispatch persistence was not acknowledged.");
                }
              });
            }
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
        try {
          if (request.kind !== "stop") {
            updateReliabilityOperation(request.identity, (record) => {
              if (record.worker?.id !== request.workerId || record.worker.pid !== child.pid) return;
              if (!result) {
                record.state = stepReliability(
                  record.state,
                  {
                    ...reliabilityFence(record.state),
                    type: "interrupted",
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
