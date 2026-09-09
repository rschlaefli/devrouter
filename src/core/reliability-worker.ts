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
  beforeAdmission?: () => void,
): Promise<unknown> {
  if (process.platform === "win32")
    throw new Error("Lifecycle workers require POSIX process-group ownership.");
  const workerPath = path.join(__dirname, "devrouter-lifecycle-worker.js");
  if (!fs.existsSync(workerPath))
    throw new Error("The packaged lifecycle worker is missing; rebuild the CLI.");
  const child = fork(workerPath, [], {
    detached: true,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
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
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

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
                  throw new Error(`Lifecycle admission is ${admitted.outcome}.`);
                record.state = admitted.state;
                record.outcome = null;
                request.fence = reliabilityFence(record.state);
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
  }
}

export function newLifecycleIds() {
  return { requestId: randomUUID(), operationId: randomUUID(), workerId: randomUUID() };
}
