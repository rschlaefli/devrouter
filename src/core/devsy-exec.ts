import { spawn, spawnSync } from "node:child_process";
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

type RecordedResult =
  | { state: "unreadable" }
  | { state: "no-merged-config" }
  | {
      state: "merged-config";
      folder?: string;
      remoteUser?: string;
      remoteEnv: Record<string, string>;
    };

function literalEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) &&
        typeof entry[1] === "string" &&
        !entry[1].includes("${"),
    ),
  );
}

/**
 * What Devsy recorded for its last start of this workspace. A start that failed
 * in a lifecycle hook leaves `MergedConfig` null, and Devsy then falls back to
 * `/workspaces/<id>`, which does not exist for a Compose workspace with its own
 * `workspaceFolder`.
 */
function devsyRecordedResult(workspace: { id: string; context?: string }): RecordedResult {
  if (!workspace.context) return { state: "unreadable" };
  try {
    const file = path.join(
      process.env.DEVSY_HOME || path.join(os.homedir(), ".devsy"),
      "contexts",
      workspace.context,
      "workspaces",
      workspace.id,
      "workspace_result.json",
    );
    if (fs.statSync(file).size > 16 * 1024 * 1024) return { state: "unreadable" };
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    if (result === null || typeof result !== "object") return { state: "unreadable" };
    const merged = result.MergedConfig;
    if (merged === null) return { state: "no-merged-config" };
    if (typeof merged !== "object") return { state: "unreadable" };
    const folder = merged.workspaceFolder ?? result.SubstitutionContext?.ContainerWorkspaceFolder;
    return {
      state: "merged-config",
      ...(typeof folder === "string" ? { folder } : {}),
      ...(typeof merged.remoteUser === "string" ? { remoteUser: merged.remoteUser } : {}),
      remoteEnv: literalEnvironment(merged.remoteEnv),
    };
  } catch {
    return { state: "unreadable" };
  }
}

/** The container's merged `devcontainer.metadata` label: last remoteUser wins, remoteEnv merges. */
function containerMetadataIdentity(
  containerId: string,
  endpoint?: string,
): { remoteUser?: string; remoteEnv: Record<string, string> } | undefined {
  const inspected = spawnSync(
    "docker",
    [
      ...(endpoint ? ["--host", endpoint] : []),
      "inspect",
      "--format",
      '{{json (index .Config.Labels "devcontainer.metadata")}}',
      containerId,
    ],
    { encoding: "utf8", ...(endpoint ? {} : networkDockerOptions()) },
  );
  if (inspected.status !== 0) return undefined;
  try {
    const label: unknown = JSON.parse(inspected.stdout);
    if (label === null) return undefined;
    const entries: unknown = JSON.parse(String(label));
    if (!Array.isArray(entries)) return undefined;
    let remoteUser: string | undefined;
    let remoteEnv: Record<string, string> = {};
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.remoteUser === "string") remoteUser = entry.remoteUser;
      remoteEnv = { ...remoteEnv, ...literalEnvironment(entry.remoteEnv) };
    }
    return { ...(remoteUser ? { remoteUser } : {}), remoteEnv };
  } catch {
    return undefined;
  }
}

/**
 * Remote user and environment Devsy would apply: its merged configuration when
 * it exists, otherwise the container's metadata label. A user the checkout's
 * Dev Container source declares but this cannot resolve refuses the fallback
 * instead of silently running as the container's default user.
 */
function resolveRemoteIdentity(
  repoPath: string,
  result: RecordedResult,
  container: { id: string },
  endpoint?: string,
): { user?: string; env: Record<string, string> } {
  if (result.state === "merged-config" && result.remoteUser)
    return { user: result.remoteUser, env: result.remoteEnv };
  const metadata = containerMetadataIdentity(container.id, endpoint);
  const env = {
    ...(result.state === "merged-config" ? result.remoteEnv : {}),
    ...(metadata?.remoteEnv ?? {}),
  };
  if (metadata?.remoteUser) return { user: metadata.remoteUser, env };
  let declared: unknown;
  try {
    const { source } = readDevcontainerConfig(repoPath);
    declared = source.remoteUser ?? source.containerUser;
    if (!metadata) Object.assign(env, literalEnvironment(source.remoteEnv));
  } catch {
    return { env };
  }
  if (declared === undefined) return { env };
  if (typeof declared === "string" && declared && !declared.includes("${"))
    return { user: declared, env };
  throw new Error(
    "Cannot resolve the remote user declared by the Dev Container source for a direct exec; run 'devrouter ensure' to repair the workspace first.",
  );
}

/**
 * Devsy would chdir into a folder that does not exist when its recorded result
 * has no merged configuration or names a folder other than where the primary
 * container mounts the checkout. Only that positive evidence selects a direct
 * `docker exec` on the exact primary container, in the mount destination.
 */
function directExecCommand(
  repoPath: string,
  workspace: { id: string; context?: string },
  command: string[],
  retainedProof?: DevsyExecProof,
): { args: string[]; options: { env?: NodeJS.ProcessEnv } } | undefined {
  const result = devsyRecordedResult(workspace);
  if (result.state === "unreadable") return undefined;
  let container: { id: string; workspacePath: string } | undefined;
  try {
    container = retainedProof
      ? { id: retainedProof.containerId, workspacePath: retainedProof.workspacePath }
      : resolveRunningWorkspaceContainer(repoPath);
  } catch {
    return undefined;
  }
  if (!container) return undefined;
  if (
    result.state === "merged-config" &&
    (result.folder === undefined || result.folder === container.workspacePath)
  )
    return undefined;
  const identity = resolveRemoteIdentity(repoPath, result, container, retainedProof?.endpoint);
  return {
    args: [
      ...(retainedProof ? ["--host", retainedProof.endpoint] : []),
      "exec",
      "-i",
      ...(process.stdin.isTTY && process.stdout.isTTY ? ["-t"] : []),
      "--workdir",
      container.workspacePath,
      ...(identity.user ? ["--user", identity.user] : []),
      ...Object.entries(identity.env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
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
