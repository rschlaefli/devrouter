import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveRunningWorkspaceContainer } from "./devpod-environment";
import { listDevpodWorkspaces, selectDevpodWorkspace } from "./devpod-workspaces";
import { devsyExecOutcome } from "./devsy-exec";
import {
  type ExecutionOutcome,
  ExecutionOutcomeError,
  unwrapExecutionOutcome,
} from "./execution-outcome";
import { claimLifecycleEffect, withLifecycleOperationLock } from "./reliability-lifecycle";
import { resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

const DEVPOD_MISSING_EXIT_STATUS_DIAGNOSTIC = Buffer.from(
  "Error tunneling to container: wait: remote command exited without exit status or exit signal\n",
);
const MAX_REMOTE_STATUS_DIGITS = 3;

export function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function ensureGuidance(repoPath: string): string {
  return `Run 'devrouter ensure ${repoPath}' first.`;
}

function assertRunningDevpod(devpodId: string, repoPath: string): void {
  const result = spawnSync("devpod", ["status", devpodId, "--output", "json"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const details = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `Could not prove DevPod '${devpodId}' is running${details ? `: ${details}` : "."} ${ensureGuidance(repoPath)}`,
    );
  }

  let status: { id?: unknown; state?: unknown };
  try {
    status = JSON.parse(result.stdout) as { id?: unknown; state?: unknown };
  } catch {
    throw new Error(`DevPod '${devpodId}' returned invalid status. ${ensureGuidance(repoPath)}`);
  }
  if (status.id !== devpodId || status.state !== "Running") {
    throw new Error(`DevPod '${devpodId}' is not running. ${ensureGuidance(repoPath)}`);
  }
}

function resolveWorkspaceDirectory(repoPath: string): string {
  try {
    return resolveRunningWorkspaceContainer(repoPath).workspacePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} ${ensureGuidance(repoPath)}`);
  }
}

function notStartedOutcome(): ExecutionOutcome {
  return { status: "not-started", exitCode: null, transport: { exitCode: null, signal: null } };
}

function devpodUnknownMessage(outcome: ExecutionOutcome): string {
  if (outcome.transport.signal !== null) {
    return `DevPod command did not report its exit status (devpod terminated by signal ${outcome.transport.signal}).`;
  }
  return `DevPod command did not report its exit status (devpod exited ${outcome.transport.exitCode ?? "unknown"}).`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function devpodExecOutcome(
  repoPath: string,
  command: string[],
): Promise<ExecutionOutcome> {
  if (resolveWorkspaceRuntimeOrDefault(repoPath) === "devsy") {
    return devsyExecOutcome(repoPath, command);
  }
  if (command.length === 0) {
    throw new Error("No command provided. Use `devrouter exec [path] -- <command...>`.");
  }
  return withLifecycleOperationLock(repoPath, async () => {
    const devpod = selectDevpodWorkspace(listDevpodWorkspaces(repoPath), repoPath);
    if (!devpod) {
      throw new Error(`No exact DevPod exists for '${repoPath}'. ${ensureGuidance(repoPath)}`);
    }
    assertRunningDevpod(devpod.id, repoPath);
    const workspaceDirectory = resolveWorkspaceDirectory(repoPath);
    const statusMarker = `__DEVROUTER_EXIT_${randomUUID()}__:`;
    const statusMarkerBytes = Buffer.from(statusMarker, "ascii");
    const literalCommand = command.map(quotePosixArg).join(" ");
    const wrappedCommand =
      `${literalCommand}; __devrouter_status=$?; ` +
      `printf '${statusMarker}%s\\n' "$__devrouter_status" >&2; exit 0`;

    const args = [
      "--log-output",
      "raw",
      "ssh",
      devpod.id,
      "--agent-forwarding=false",
      "--gpg-agent-forwarding=false",
      "--start-services=false",
      "--workdir",
      workspaceDirectory,
      "--command",
      wrappedCommand,
    ];

    return new Promise<ExecutionOutcome>((resolve, reject) => {
      let pending = Buffer.alloc(0);
      let statusBytes = Buffer.alloc(0);
      let readingStatus = false;
      let invalidStatus = false;
      let remoteStatus: number | undefined;
      let postStatusPending = Buffer.alloc(0);
      let diagnosticFiltered = false;
      let settled = false;
      const forward = (value: Buffer): void => {
        if (value.length > 0) process.stderr.write(value);
      };

      const forwardAfterStatus = (value: Buffer, final = false): void => {
        if (value.length === 0 && !final) return;
        if (diagnosticFiltered) {
          forward(value);
          return;
        }
        const combined = Buffer.concat([postStatusPending, value]);
        const diagnosticIndex = combined.indexOf(DEVPOD_MISSING_EXIT_STATUS_DIAGNOSTIC);
        if (diagnosticIndex >= 0) {
          forward(combined.subarray(0, diagnosticIndex));
          diagnosticFiltered = true;
          forward(
            combined.subarray(diagnosticIndex + DEVPOD_MISSING_EXIT_STATUS_DIAGNOSTIC.length),
          );
          postStatusPending = Buffer.alloc(0);
          return;
        }
        if (final) {
          forward(combined);
          postStatusPending = Buffer.alloc(0);
          return;
        }
        const retainedLength = Math.min(
          combined.length,
          DEVPOD_MISSING_EXIT_STATUS_DIAGNOSTIC.length - 1,
        );
        forward(combined.subarray(0, combined.length - retainedLength));
        postStatusPending = Buffer.from(combined.subarray(combined.length - retainedLength));
      };

      const consumePending = (): void => {
        for (;;) {
          if (remoteStatus !== undefined) {
            forwardAfterStatus(pending);
            pending = Buffer.alloc(0);
            return;
          }

          if (readingStatus) {
            const newline = pending.indexOf(0x0a);
            if (invalidStatus) {
              if (newline < 0) {
                forward(pending);
                pending = Buffer.alloc(0);
                return;
              }
              forward(pending.subarray(0, newline + 1));
              pending = pending.subarray(newline + 1);
              statusBytes = Buffer.alloc(0);
              invalidStatus = false;
              readingStatus = false;
              continue;
            }

            if (newline < 0) {
              const remainingDigits = MAX_REMOTE_STATUS_DIGITS - statusBytes.length;
              if (pending.length <= remainingDigits) {
                statusBytes = Buffer.concat([statusBytes, pending]);
                pending = Buffer.alloc(0);
                return;
              }
              statusBytes = Buffer.concat([statusBytes, pending.subarray(0, remainingDigits)]);
              forward(Buffer.concat([statusMarkerBytes, statusBytes]));
              forward(pending.subarray(remainingDigits));
              statusBytes = Buffer.alloc(0);
              invalidStatus = true;
              pending = Buffer.alloc(0);
              return;
            }

            const candidate = pending.subarray(0, newline);
            const previousStatusBytes = statusBytes;
            const candidateLength = previousStatusBytes.length + candidate.length;
            if (candidateLength <= MAX_REMOTE_STATUS_DIGITS) {
              statusBytes = Buffer.concat([previousStatusBytes, candidate]);
            }
            const value = statusBytes.toString("ascii");
            const numericStatus =
              candidateLength <= MAX_REMOTE_STATUS_DIGITS &&
              /^\d{1,3}$/.test(value) &&
              Number(value) >= 0 &&
              Number(value) <= 255
                ? Number(value)
                : undefined;
            if (numericStatus === undefined) {
              forward(Buffer.concat([statusMarkerBytes, previousStatusBytes, candidate]));
              forward(Buffer.from("\n"));
            } else {
              remoteStatus = numericStatus;
            }
            pending = pending.subarray(newline + 1);
            statusBytes = Buffer.alloc(0);
            readingStatus = false;
            continue;
          }

          const markerIndex = pending.indexOf(statusMarkerBytes);
          if (markerIndex >= 0) {
            forward(pending.subarray(0, markerIndex));
            pending = pending.subarray(markerIndex + statusMarkerBytes.length);
            readingStatus = true;
            statusBytes = Buffer.alloc(0);
            invalidStatus = false;
            continue;
          }

          const retainedLength = Math.min(pending.length, statusMarkerBytes.length - 1);
          forward(pending.subarray(0, pending.length - retainedLength));
          pending = Buffer.from(pending.subarray(pending.length - retainedLength));
          return;
        }
      };

      let child: ReturnType<typeof spawn>;
      try {
        claimLifecycleEffect();
        child = spawn("devpod", args, { stdio: ["inherit", "inherit", "pipe"] });
      } catch (error) {
        settled = true;
        reject(
          new ExecutionOutcomeError(
            `devpod ssh failed: ${errorMessage(error)}`,
            notStartedOutcome(),
          ),
        );
        return;
      }
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        consumePending();
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(
          new ExecutionOutcomeError(
            `devpod ssh failed: ${error.message}`,
            child.pid === undefined
              ? notStartedOutcome()
              : {
                  status: "completion-unknown",
                  exitCode: null,
                  transport: { exitCode: null, signal: null },
                },
          ),
        );
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        const signalValue = signal ?? null;
        const executionTransport = { exitCode: code, signal: signalValue };
        consumePending();
        if (remoteStatus !== undefined) {
          forwardAfterStatus(Buffer.alloc(0), true);
          resolve({ status: "completed", exitCode: remoteStatus, transport: executionTransport });
          return;
        }
        if (readingStatus) {
          if (invalidStatus) {
            forward(pending);
          } else {
            forward(Buffer.concat([statusMarkerBytes, statusBytes, pending]));
          }
        } else {
          forward(pending);
        }
        resolve({ status: "completion-unknown", exitCode: null, transport: executionTransport });
      });
    });
  });
}

export async function devpodExec(repoPath: string, command: string[]): Promise<number> {
  const outcome = await devpodExecOutcome(repoPath, command);
  return unwrapExecutionOutcome(
    outcome,
    outcome.status === "completion-unknown" ? devpodUnknownMessage(outcome) : undefined,
  );
}
