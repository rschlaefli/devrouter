import { spawn } from "node:child_process";
import { listDevsyWorkspaces, selectDevsyWorkspace } from "./devsy-workspaces";
import {
  type ExecutionOutcome,
  ExecutionOutcomeError,
  unwrapExecutionOutcome,
} from "./execution-outcome";
import { withWorkspaceLifecycleLock } from "./workspace";

function ensureGuidance(repoPath: string): string {
  return `Run 'devrouter ensure ${repoPath}' first.`;
}

function transport(exitCode: number | null, signal: string | null) {
  return { exitCode, signal };
}

function devsyUnknownMessage(outcome: ExecutionOutcome): string {
  if (outcome.transport.signal !== null) {
    return `Devsy command did not report its exit status (devsy terminated by signal ${outcome.transport.signal}).`;
  }
  return `Devsy command did not report its exit status (devsy exited ${outcome.transport.exitCode ?? "unknown"}).`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function devsyExecOutcome(
  repoPath: string,
  command: string[],
): Promise<ExecutionOutcome> {
  if (command.length === 0) {
    throw new Error("No command provided. Use `devrouter exec [path] -- <command...>`.");
  }
  return withWorkspaceLifecycleLock(repoPath, async () => {
    const workspace = selectDevsyWorkspace(listDevsyWorkspaces(), repoPath);
    if (!workspace) {
      throw new Error(
        `No exact Devsy workspace exists for '${repoPath}'. ${ensureGuidance(repoPath)}`,
      );
    }

    // Devsy resolves the workspace folder and remote user itself and forwards
    // the remote exit code as its own, so no status-marker wrapping is needed.
    const args = ["workspace", "exec", "--result-format", "plain", workspace.id, "--", ...command];

    return new Promise<ExecutionOutcome>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("devsy", args, { stdio: "inherit" });
      } catch (error) {
        reject(
          new ExecutionOutcomeError(`devsy exec failed: ${errorMessage(error)}`, {
            status: "not-started",
            exitCode: null,
            transport: transport(null, null),
          }),
        );
        return;
      }
      child.once("error", (error) =>
        reject(
          new ExecutionOutcomeError(`devsy exec failed: ${error.message}`, {
            status: child.pid === undefined ? "not-started" : "completion-unknown",
            exitCode: null,
            transport: transport(null, null),
          }),
        ),
      );
      child.once("close", (code, signal) => {
        const signalValue = signal ?? null;
        const executionTransport = transport(code, signalValue);
        if (code === null) {
          resolve({ status: "completion-unknown", exitCode: null, transport: executionTransport });
          return;
        }
        resolve({ status: "completed", exitCode: code, transport: executionTransport });
      });
    });
  });
}

export async function devsyExec(repoPath: string, command: string[]): Promise<number> {
  const outcome = await devsyExecOutcome(repoPath, command);
  return unwrapExecutionOutcome(
    outcome,
    outcome.status === "completion-unknown" ? devsyUnknownMessage(outcome) : undefined,
  );
}
