import { spawnSync } from "node:child_process";

export type WorkspaceRuntime = "devpod" | "devsy";

const SUPPORTED_RUNTIMES: readonly WorkspaceRuntime[] = ["devpod", "devsy"];

let cachedRuntime: WorkspaceRuntime | undefined;

export class UnsupportedWorkspaceRuntimeError extends Error {}

function detectInstalledRuntime(): WorkspaceRuntime | undefined {
  for (const runtime of SUPPORTED_RUNTIMES) {
    const probe = spawnSync(runtime, ["--version"], { encoding: "utf-8" });
    if (probe.status === 0 && !probe.error) return runtime;
  }
  return undefined;
}

/**
 * Resolve the workspace runtime backing devcontainer workspace flows.
 *
 * Precedence: explicit override argument > DEVROUTER_WORKSPACE_RUNTIME >
 * auto-detection of an installed CLI. The result is cached per process because
 * every call site runs the same CLI multiple times per command.
 */
export function resolveWorkspaceRuntime(override?: string): WorkspaceRuntime {
  if (override) {
    const requested = override.trim().toLowerCase();
    if (!SUPPORTED_RUNTIMES.includes(requested as WorkspaceRuntime)) {
      throw new UnsupportedWorkspaceRuntimeError(
        `Unsupported workspace runtime '${override}'. Supported: ${SUPPORTED_RUNTIMES.join(", ")}` +
          ".",
      );
    }
    return requested as WorkspaceRuntime;
  }
  if (cachedRuntime) return cachedRuntime;

  const envRaw = process.env.DEVROUTER_WORKSPACE_RUNTIME?.trim().toLowerCase();
  if (envRaw) {
    if (!SUPPORTED_RUNTIMES.includes(envRaw as WorkspaceRuntime)) {
      throw new UnsupportedWorkspaceRuntimeError(
        `Unsupported DEVROUTER_WORKSPACE_RUNTIME '${process.env.DEVROUTER_WORKSPACE_RUNTIME}'.` +
          ` Supported: ${SUPPORTED_RUNTIMES.join(", ")}.`,
      );
    }
    cachedRuntime = envRaw as WorkspaceRuntime;
    return cachedRuntime;
  }

  const detected = detectInstalledRuntime();
  if (detected) {
    cachedRuntime = detected;
    return cachedRuntime;
  }
  throw new Error(
    "No workspace runtime found. Install DevPod or Devsy, or set DEVROUTER_WORKSPACE_RUNTIME.",
  );
}

/**
 * Resolve the active runtime for dispatch sites that must keep working when no
 * runtime CLI is installed. An explicit unsupported override still fails
 * loudly; automatic detection with nothing installed falls back to the
 * historical DevPod default so devrouter keeps its previous behavior.
 */
export function resolveWorkspaceRuntimeOrDefault(): WorkspaceRuntime {
  try {
    return resolveWorkspaceRuntime();
  } catch (error) {
    if (error instanceof UnsupportedWorkspaceRuntimeError) throw error;
    return "devpod";
  }
}
