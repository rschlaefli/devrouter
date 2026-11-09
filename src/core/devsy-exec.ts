import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDevcontainerConfig } from "./devcontainer-config";
import { resolveRunningWorkspaceContainer } from "./devpod-environment";
import { type DevsyExecProof, revalidateDevsyExecProof } from "./devsy-exec-proof";
import { withMutationLock } from "./devsy-mutation";
import { listDevsyWorkspaces, selectDevsyWorkspace } from "./devsy-workspaces";
import {
  type ExecutionOutcome,
  ExecutionOutcomeError,
  unwrapExecutionOutcome,
} from "./execution-outcome";
import { networkDockerOptions } from "./network-effect-scope";
import { claimLifecycleEffect, withLifecycleOperationLock } from "./reliability-lifecycle";

function ensureGuidance(repoPath: string): string {
  return `Run 'devrouter ensure ${repoPath}' first.`;
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

/**
 * The container workspace folder Devsy will chdir into, or undefined when its
 * recorded result carries none. A start that failed in a lifecycle hook leaves
 * `MergedConfig` null, and Devsy then falls back to `/workspaces/<id>`, which
 * does not exist for a Compose workspace with its own `workspaceFolder`.
 */
function devsyRecordedWorkspaceFolder(workspace: {
  id: string;
  context?: string;
}): string | undefined {
  if (!workspace.context) return undefined;
  try {
    const file = path.join(
      process.env.DEVSY_HOME || path.join(os.homedir(), ".devsy"),
      "contexts",
      workspace.context,
      "workspaces",
      workspace.id,
      "workspace_result.json",
    );
    if (fs.statSync(file).size > 16 * 1024 * 1024) return undefined;
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!result?.MergedConfig || typeof result.MergedConfig !== "object") return undefined;
    const folder =
      result.MergedConfig.workspaceFolder ?? result.SubstitutionContext?.ContainerWorkspaceFolder;
    return typeof folder === "string" ? folder : undefined;
  } catch {
    return undefined;
  }
}

/** Remote user and literal remote environment declared by the checkout's Dev Container source. */
function declaredRemoteIdentity(repoPath: string): { user?: string; env: string[] } {
  try {
    const { source } = readDevcontainerConfig(repoPath);
    const user = source.remoteUser ?? source.containerUser;
    const remoteEnv =
      source.remoteEnv && typeof source.remoteEnv === "object"
        ? Object.entries(source.remoteEnv as Record<string, unknown>)
        : [];
    return {
      ...(typeof user === "string" && user && !user.includes("${") ? { user } : {}),
      env: remoteEnv.flatMap(([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string" && !value.includes("${")
          ? ["--env", `${name}=${value}`]
          : [],
      ),
    };
  } catch {
    return { env: [] };
  }
}

/**
 * When Devsy's recorded workspace folder is missing or differs from where the
 * primary container really mounts the checkout, Devsy would chdir into a
 * folder that does not exist. Run on the exact primary container instead, in
 * the mount destination.
 */
function directExecCommand(
  repoPath: string,
  workspace: { id: string; context?: string },
  command: string[],
  retainedProof?: DevsyExecProof,
): { args: string[]; options: { env?: NodeJS.ProcessEnv } } | undefined {
  let container: { id: string; workspacePath: string } | undefined;
  try {
    container = retainedProof
      ? { id: retainedProof.containerId, workspacePath: retainedProof.workspacePath }
      : resolveRunningWorkspaceContainer(repoPath);
  } catch {
    return undefined;
  }
  if (!container || container.workspacePath === devsyRecordedWorkspaceFolder(workspace))
    return undefined;
  const identity = declaredRemoteIdentity(repoPath);
  return {
    args: [
      ...(retainedProof ? ["--host", retainedProof.endpoint] : []),
      "exec",
      "-i",
      ...(process.stdin.isTTY && process.stdout.isTTY ? ["-t"] : []),
      "--workdir",
      container.workspacePath,
      ...(identity.user ? ["--user", identity.user] : []),
      ...identity.env,
      container.id,
      ...command,
    ],
    options: retainedProof ? {} : networkDockerOptions(),
  };
}

export async function devsyExecOutcome(
  repoPath: string,
  command: string[],
  retainedProof?: DevsyExecProof,
): Promise<ExecutionOutcome> {
  if (command.length === 0) {
    throw new Error("No command provided. Use `devrouter exec [path] -- <command...>`.");
  }
  return withLifecycleOperationLock(repoPath, async () => {
    const workspace = selectDevsyWorkspace(listDevsyWorkspaces(), repoPath);
    if (!workspace) {
      throw new Error(
        `No exact Devsy workspace exists for '${repoPath}'. ${ensureGuidance(repoPath)}`,
      );
    }

    // Devsy resolves the workspace folder and remote user itself and forwards
    // the remote exit code as its own, so no status-marker wrapping is needed.
    const args = [
      "workspace",
      "exec",
      "--result-format",
      "plain",
      ...(retainedProof ? ["--context", retainedProof.context] : []),
      retainedProof?.id ?? workspace.id,
      "--",
      ...command,
    ];

    const direct = directExecCommand(repoPath, retainedProof ?? workspace, command, retainedProof);

    return new Promise<ExecutionOutcome>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        const launch = () => {
          if (retainedProof) revalidateDevsyExecProof(repoPath, retainedProof);
          claimLifecycleEffect();
          return direct
            ? spawn("docker", direct.args, { stdio: "inherit", ...direct.options })
            : spawn("devsy", args, { stdio: "inherit" });
        };
        child = retainedProof
          ? withMutationLock("Execute retained workspace", repoPath, launch)
          : launch();
      } catch (error) {
        reject(
          new ExecutionOutcomeError(`devsy exec failed: ${errorMessage(error)}`, {
            status: "not-started",
            exitCode: null,
            transport: { exitCode: null, signal: null },
          }),
        );
        return;
      }
      child.once("error", (error) =>
        reject(
          new ExecutionOutcomeError(`devsy exec failed: ${error.message}`, {
            status: child.pid === undefined ? "not-started" : "completion-unknown",
            exitCode: null,
            transport: { exitCode: null, signal: null },
          }),
        ),
      );
      child.once("close", (code, signal) => {
        const signalValue = signal ?? null;
        const executionTransport = { exitCode: code, signal: signalValue };
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
