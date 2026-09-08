import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  CONTROLLER_FRAME_BYTES,
  type ControllerOperationSubmitRequest,
  type ControllerOutputCursor,
  parseControllerRequest,
} from "./controller-protocol";
import type { LifecycleOperationStatus } from "./lifecycle-operation-status";
import type { LifecycleOutputPage } from "./reliability-worker";

const CONTROLLER_OPERATION_WATCH_SECONDS = 30;
const CONTROLLER_OPERATION_DEFAULT_WAIT_SECONDS = 300;
const CONTROLLER_OPERATION_MAX_WAIT_SECONDS = 900;
const CONTROLLER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

class ControllerResponseDeadlineError extends Error {
  constructor(readonly callerDeadline: boolean) {
    super("Controller response deadline exceeded.");
  }
}

export type ControllerOperationBinding = Pick<
  ControllerOperationSubmitRequest,
  "session" | "store" | "epoch" | "generation"
>;

export type ControllerOperationSubmitInput =
  | (ControllerOperationBinding & {
      requestId: string;
      kind: "ensure";
      operation?: string;
    })
  | (ControllerOperationBinding & {
      requestId: string;
      kind: "exec";
      operation?: string;
      command: string[];
    });

export type ControllerOperationFollowInput = ControllerOperationBinding & {
  operationId: string;
  output?: ControllerOutputCursor;
};

export type ControllerOperationWaitOptions = {
  waitSeconds?: number;
  onOutput?: (page: LifecycleOutputPage) => void;
};

export type ControllerOperationResult = {
  status: "terminal" | "pending" | "unknown";
  operationId: string;
  operation: LifecycleOperationStatus | null;
  output: LifecycleOutputPage | null;
  outputCursor: ControllerOutputCursor;
  outputGap: boolean;
  reason?: string;
};

export class ControllerOperationSubmissionError extends Error {
  readonly requestId: string;
  readonly acknowledged = false;

  constructor(requestId: string) {
    super(`Controller operation request ${requestId} was not acknowledged.`);
    this.name = "ControllerOperationSubmissionError";
    this.requestId = requestId;
  }
}

type ControllerOperationResponse = {
  operation: LifecycleOperationStatus | null;
  output?: LifecycleOutputPage | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isControllerId(value: unknown): value is string {
  return typeof value === "string" && CONTROLLER_ID_RE.test(value);
}

function isSafeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOperationStatus(value: unknown): LifecycleOperationStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["operationId", "phase", "outcome", "reason", "exitCode"])
  )
    throw new Error("Malformed controller operation status.");

  const operationId = value.operationId;
  if (!isControllerId(operationId)) throw new Error("Controller operation ID mismatch.");

  const phases = ["queued", "dispatching", "running", "terminal"] as const;
  const outcomes = ["NOT_STARTED", "COMPLETED", "INTERRUPTED", "COMPLETION_UNKNOWN"] as const;
  if (!phases.includes(value.phase as (typeof phases)[number]))
    throw new Error("Malformed controller operation phase.");
  if (value.outcome !== null && !outcomes.includes(value.outcome as (typeof outcomes)[number]))
    throw new Error("Malformed controller operation outcome.");
  if (value.reason !== null && typeof value.reason !== "string")
    throw new Error("Malformed controller operation reason.");
  if (value.exitCode !== null && !isSafeCounter(value.exitCode))
    throw new Error("Malformed controller operation exit code.");
  if (value.phase === "terminal" && value.outcome === null)
    throw new Error("Terminal controller operation has no outcome.");
  if (value.phase !== "terminal" && (value.outcome !== null || value.exitCode !== null))
    throw new Error("Non-terminal controller operation has a terminal result.");
  if (value.outcome === "COMPLETED" && value.exitCode === null)
    throw new Error("Completed controller operation has no exit code.");
  if (value.outcome !== "COMPLETED" && value.exitCode !== null)
    throw new Error("Non-completed controller operation has an exit code.");

  return {
    operationId,
    phase: value.phase,
    outcome: value.outcome,
    reason: value.reason,
    exitCode: value.exitCode,
  } as LifecycleOperationStatus;
}

function parseOutputCursor(value: unknown): ControllerOutputCursor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sequence", "offset"]) ||
    !isSafeCounter(value.sequence) ||
    !isSafeCounter(value.offset)
  )
    throw new Error("Malformed controller output cursor.");
  return { sequence: value.sequence, offset: value.offset };
}

function parseOutputPage(value: unknown): LifecycleOutputPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["encoding", "gap", "sequence", "chunks"]) ||
    value.encoding !== "base64" ||
    typeof value.gap !== "boolean" ||
    !Array.isArray(value.chunks) ||
    value.chunks.length > 64
  )
    throw new Error("Malformed controller operation output.");

  const sequence = parseOutputCursor(value.sequence);
  const chunks = value.chunks.map((chunk) => {
    if (
      !isRecord(chunk) ||
      !hasExactKeys(chunk, ["stream", "data", "sequence"]) ||
      (chunk.stream !== "stdout" && chunk.stream !== "stderr") ||
      typeof chunk.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data) ||
      !isSafeCounter(chunk.sequence)
    )
      throw new Error("Malformed controller operation output chunk.");
    return {
      stream: chunk.stream as "stdout" | "stderr",
      data: chunk.data,
      sequence: chunk.sequence,
    };
  });
  return { encoding: "base64", gap: value.gap, sequence, chunks };
}

function parseOperationResponse(value: unknown, watch: boolean): ControllerOperationResponse {
  if (!isRecord(value) || value.version !== 1 || value.ok !== true || !isRecord(value.result))
    throw new Error("Malformed controller operation response.");
  const result = value.result;
  if (
    !hasExactKeys(result, ["operation"], watch ? ["output"] : []) ||
    (result.operation !== null && !isRecord(result.operation))
  )
    throw new Error("Malformed controller operation response.");
  const operation = result.operation === null ? null : parseOperationStatus(result.operation);
  let output: LifecycleOutputPage | null | undefined;
  if (watch && Object.hasOwn(result, "output")) {
    output = result.output === null ? null : parseOutputPage(result.output);
  }
  return { operation, ...(watch ? { output } : {}) };
}

async function operationRequest(
  directory: string,
  input: object,
  timeoutMs?: number,
): Promise<unknown> {
  let response: unknown;
  await controllerRequest(
    directory,
    input,
    (value) => {
      response = value;
    },
    timeoutMs,
  );
  if (response === undefined) throw new Error("Controller returned no operation response.");
  return response;
}

function waitSeconds(value: number | undefined): number {
  const requested = value ?? CONTROLLER_OPERATION_DEFAULT_WAIT_SECONDS;
  if (!Number.isSafeInteger(requested) || requested < 0)
    throw new Error("Invalid controller operation wait.");
  return Math.min(requested, CONTROLLER_OPERATION_MAX_WAIT_SECONDS);
}

async function followAcceptedOperation(
  directory: string,
  binding: ControllerOperationBinding,
  operationId: string,
  options: ControllerOperationWaitOptions,
  initialOperation: LifecycleOperationStatus | null,
  initialOutput?: ControllerOutputCursor,
): Promise<ControllerOperationResult> {
  const deadline = performance.now() + waitSeconds(options.waitSeconds) * 1000;
  let operation = initialOperation;
  let output: LifecycleOutputPage | null = null;
  let outputCursor = initialOutput ? parseOutputCursor(initialOutput) : { sequence: 0, offset: 0 };
  let outputGap = false;
  const result = (
    status: ControllerOperationResult["status"],
    reason?: string,
  ): ControllerOperationResult => ({
    status,
    operationId,
    operation,
    output,
    outputCursor,
    outputGap,
    ...(reason ? { reason } : {}),
  });
  for (;;) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return result("pending", "caller-wait-expired");
    let response: ControllerOperationResponse;
    try {
      response = parseOperationResponse(
        await operationRequest(
          directory,
          {
            method: "operation-watch",
            session: binding.session,
            store: binding.store,
            epoch: binding.epoch,
            generation: binding.generation,
            operationId,
            timeout: Math.min(CONTROLLER_OPERATION_WATCH_SECONDS, Math.ceil(remainingMs / 1000)),
            output: outputCursor,
          },
          remainingMs,
        ),
        true,
      );
    } catch (error) {
      return (error instanceof ControllerResponseDeadlineError && error.callerDeadline) ||
        performance.now() >= deadline
        ? result("pending", "caller-wait-expired")
        : result("unknown", "controller-continuity-lost");
    }
    if (!response.operation) return result("unknown", "operation-status-unavailable");
    if (response.operation.operationId !== operationId)
      return result("unknown", "operation-id-mismatch");
    operation = response.operation;
    output = response.output ?? null;
    if (output) {
      if (
        output.sequence.sequence < outputCursor.sequence ||
        (output.sequence.sequence === outputCursor.sequence &&
          output.sequence.offset < outputCursor.offset)
      )
        return result("unknown", "output-cursor-regressed");
      // Deliver each page before advancing the reconnect cursor.
      try {
        options.onOutput?.(output);
      } catch {
        return result("unknown", "output-delivery-failed");
      }
      outputGap ||= output.gap;
      const advanced =
        output.sequence.sequence !== outputCursor.sequence ||
        output.sequence.offset !== outputCursor.offset;
      if (output.chunks.length && !advanced) return result("unknown", "output-cursor-stalled");
      outputCursor = output.sequence;
    }
    // A terminal worker can still have multiple bounded pages to drain.
    if (operation.phase === "terminal" && !output?.chunks.length) return result("terminal");
  }
}

export async function submitControllerOperation(
  directory: string,
  input: ControllerOperationSubmitInput,
  options: ControllerOperationWaitOptions = {},
): Promise<ControllerOperationResult> {
  waitSeconds(options.waitSeconds);
  let response: ControllerOperationResponse;
  try {
    response = parseOperationResponse(
      await operationRequest(directory, { method: "operation-submit", ...input }),
      false,
    );
  } catch (error) {
    const wrapped = new ControllerOperationSubmissionError(input.requestId);
    wrapped.cause = error;
    throw wrapped;
  }
  if (!response.operation) {
    const error = new ControllerOperationSubmissionError(input.requestId);
    error.cause = new Error("Controller did not acknowledge the operation.");
    throw error;
  }
  return followAcceptedOperation(
    directory,
    {
      session: input.session,
      store: input.store,
      epoch: input.epoch,
      generation: input.generation,
    },
    response.operation.operationId,
    options,
    response.operation,
  );
}

export async function followControllerOperation(
  directory: string,
  input: ControllerOperationFollowInput,
  options: ControllerOperationWaitOptions = {},
): Promise<ControllerOperationResult> {
  if (!isControllerId(input.operationId)) throw new Error("Invalid controller operation ID.");
  return followAcceptedOperation(directory, input, input.operationId, options, null, input.output);
}

export async function controllerRequest(
  directory: string,
  input: object,
  emit: (value: unknown) => void,
  timeoutMs?: number,
): Promise<void> {
  const request = parseControllerRequest({ ...input, version: 1, id: randomUUID() });
  const socketPath = path.join(directory, "control.sock");
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("Controller socket is not private.");
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let handshake = false;
    let completed = false;
    const handshakeId = randomUUID();
    const timeout =
      request.method === "watch" || request.method === "operation-watch"
        ? Math.min(request.timeout + 5, 2_147_483) * 1000
        : 5000;
    const timer = setTimeout(
      () => {
        socket.destroy();
        reject(
          new ControllerResponseDeadlineError(timeoutMs !== undefined && timeoutMs <= timeout),
        );
      },
      Math.min(timeout, timeoutMs ?? timeout),
    );
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ version: 1, id: handshakeId, method: "handshake" })}\n`),
    );
    socket.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Controller unavailable."));
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!completed) reject(new Error("Controller continuity lost."));
    });
    socket.on("data", (chunk: Buffer) => {
      if (completed) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          if (buffer.length > CONTROLLER_FRAME_BYTES) socket.destroy();
          return;
        }
        if (newline > CONTROLLER_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          const response = JSON.parse(frame.toString("utf8"));
          if (
            response?.version !== 1 ||
            response.id !== (handshake ? request.id : handshakeId) ||
            response.ok !== true
          )
            throw new Error("Controller rejected request.");
          if (!handshake) {
            handshake = true;
            socket.write(`${JSON.stringify(request)}\n`);
          } else {
            emit(response);
            if (request.method !== "watch" || response.result?.kind === "end") {
              completed = true;
              clearTimeout(timer);
              socket.end();
              resolve();
              return;
            }
          }
        } catch {
          socket.destroy();
          reject(new Error("Controller response unavailable or invalid."));
          return;
        }
      }
    });
  });
}
