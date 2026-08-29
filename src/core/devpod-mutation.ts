import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  inspectDevpodRuntimeStatus,
  inspectDevpodWorkspaceOwnership,
  listDevpodWorkspaces,
  selectDevpodWorkspace,
} from "./devpod-workspaces";
import {
  DevsyStartPostconditionError,
  deleteOwnedDevsyWorkspace,
  startDevsyWorkspace,
  stopOwnedDevsyWorkspace,
} from "./devsy-mutation";
import { createStderrWaitReporter, withFileLockSync } from "./file-lock";
import { DEVROUTER_HOME } from "./router";
import {
  readWorkspaceRuntimeConfig,
  resetWorkspaceRuntimeCaches,
  resolveWorkspaceRuntimeOrDefault,
} from "./workspace-runtime";

const DEVPOD_MUTATION_LOCK_FILE = path.join(DEVROUTER_HOME, "devpod-mutation.lock");
/**
 * Matches the Devsy provider wait so mixed fleets behave identically under
 * parallel agent load; waits report throttled stderr progress.
 */
const DEVPOD_MUTATION_WAIT_MS = 1_800_000;

export type OwnedDevpodMutationResult = { status: "changed" } | { status: "absent" };

export type DevpodStartOptions = {
  repoPath: string;
  devpodId?: string;
  devcontainerPath?: string;
  recreate?: boolean;
  quiet?: boolean;
  workspace?: { token: string; gitCommonDir: string };
};

export class DevpodStartPostconditionError extends Error {}

function withMutationLock<T>(activity: string, target: string, operation: () => T): T {
  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  return withFileLockSync(
    DEVPOD_MUTATION_LOCK_FILE,
    {
      activity,
      target: `'${target}'`,
      waitMs: DEVPOD_MUTATION_WAIT_MS,
      fair: true,
      onWait: createStderrWaitReporter(activity, `'${target}'`),
    },
    operation,
  );
}

function commandFailure(result: ReturnType<typeof spawnSync>): string {
  return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function runDevpodAction(action: "stop" | "delete", devpodId: string, force = false): void {
  const args =
    action === "delete"
      ? [action, devpodId, ...(force ? ["--force"] : []), "--ignore-not-found"]
      : [action, devpodId];
  const result = spawnSync("devpod", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `devpod ${action}${force ? " --force" : ""} failed for '${devpodId}': ${commandFailure(result) || "unknown error"}`,
    );
  }
}

function inspectExactOwnership(devpodId: string, worktreePath: string) {
  const ownership = inspectDevpodWorkspaceOwnership(
    listDevpodWorkspaces(worktreePath),
    devpodId,
    worktreePath,
  );
  if (ownership.status === "conflict") throw new Error(ownership.reason);
  return ownership;
}

function mutateOwnedDevpodWorkspace(
  action: "stop" | "delete",
  devpodId: string,
  worktreePath: string,
): OwnedDevpodMutationResult {
  return withMutationLock(`DevPod ${action}`, worktreePath, () => {
    const before = inspectExactOwnership(devpodId, worktreePath);
    if (before.status === "absent") return { status: "absent" };

    runDevpodAction(action, devpodId);

    let after = inspectExactOwnership(devpodId, worktreePath);
    if (action === "stop" && after.status !== "owned") {
      throw new Error(`DevPod '${devpodId}' no longer owns '${worktreePath}' after provider stop.`);
    }
    if (action === "delete" && after.status === "owned") {
      const runtime = inspectDevpodRuntimeStatus(devpodId, worktreePath);
      if (runtime !== "not-found") {
        throw new Error(
          `DevPod '${devpodId}' still owns '${worktreePath}' after provider delete (runtime=${runtime}).`,
        );
      }
      after = inspectExactOwnership(devpodId, worktreePath);
      if (after.status === "owned") {
        runDevpodAction("delete", devpodId, true);
        after = inspectExactOwnership(devpodId, worktreePath);
      }
      if (after.status !== "absent") {
        throw new Error(
          `DevPod '${devpodId}' still owns '${worktreePath}' after forced provider delete.`,
        );
      }
    }
    return { status: "changed" };
  });
}

export function stopOwnedDevpodWorkspace(
  devpodId: string,
  worktreePath: string,
): OwnedDevpodMutationResult {
  if (resolveWorkspaceRuntimeOrDefault(worktreePath) === "devsy") {
    const result = stopOwnedDevsyWorkspace(devpodId, worktreePath);
    resetWorkspaceRuntimeCaches();
    return result;
  }
  const result = mutateOwnedDevpodWorkspace("stop", devpodId, worktreePath);
  resetWorkspaceRuntimeCaches();
  return result;
}

export function deleteOwnedDevpodWorkspace(
  devpodId: string,
  worktreePath: string,
): OwnedDevpodMutationResult {
  if (resolveWorkspaceRuntimeOrDefault(worktreePath) === "devsy") {
    const result = deleteOwnedDevsyWorkspace(devpodId, worktreePath);
    resetWorkspaceRuntimeCaches();
    return result;
  }
  const result = mutateOwnedDevpodWorkspace("delete", devpodId, worktreePath);
  resetWorkspaceRuntimeCaches();
  return result;
}

export function startDevpodWorkspace(options: DevpodStartOptions): string {
  if (resolveWorkspaceRuntimeOrDefault(options.repoPath) === "devsy") {
    try {
      const result = startDevsyWorkspace({
        repoPath: options.repoPath,
        devsyId: options.devpodId,
        devcontainerPath: options.devcontainerPath,
        recreate: options.recreate,
        quiet: options.quiet,
        workspace: options.workspace,
        inactivityTimeout: readWorkspaceRuntimeConfig().devsyInactivityTimeout,
      });
      resetWorkspaceRuntimeCaches();
      return result;
    } catch (error) {
      if (error instanceof DevsyStartPostconditionError) {
        resetWorkspaceRuntimeCaches();
        throw new DevpodStartPostconditionError(error.message);
      }
      throw error;
    }
  }
  const activity = options.recreate ? "DevPod recreate" : "DevPod start";
  return withMutationLock(activity, options.repoPath, () => {
    const workspaces = listDevpodWorkspaces(options.repoPath);
    let devpodId = options.devpodId ?? selectDevpodWorkspace(workspaces, options.repoPath)?.id;
    if (devpodId) {
      const before = inspectDevpodWorkspaceOwnership(workspaces, devpodId, options.repoPath);
      if (before.status === "conflict") throw new Error(before.reason);
      if (options.recreate && before.status !== "owned") {
        throw new Error(`Cannot recreate DevPod '${devpodId}' without one exact owner.`);
      }
    } else if (options.recreate) {
      throw new Error("Cannot recreate a DevPod before its exact id is known.");
    }

    const args = ["up", options.repoPath];
    if (devpodId) args.push("--id", devpodId);
    if (options.devcontainerPath) {
      args.push("--devcontainer-path", options.devcontainerPath);
    }
    args.push("--open-ide=false");
    if (options.workspace) {
      args.push(
        "--workspace-env",
        `WORKSPACE=${options.workspace.token}`,
        "--workspace-env",
        `DEVROUTER_WORKSPACE=${options.workspace.token}`,
      );
    }
    if (options.recreate) args.push("--recreate");

    const env = { ...process.env };
    if (options.workspace) {
      env.WORKSPACE = options.workspace.token;
      env.DEVROUTER_WORKSPACE = options.workspace.token;
      env.DEVROUTER_GIT_COMMON_DIR = options.workspace.gitCommonDir;
      env.DEVCONTAINER_COMPOSE_OVERLAY = "docker-compose.devrouter.yml";
    } else {
      delete env.WORKSPACE;
      delete env.DEVROUTER_WORKSPACE;
      delete env.DEVROUTER_GIT_COMMON_DIR;
      delete env.DEVCONTAINER_COMPOSE_OVERLAY;
    }

    const result = spawnSync("devpod", args, {
      stdio: options.quiet ? ["inherit", 2, "inherit"] : "inherit",
      env,
    });
    if (result.status !== 0) {
      throw new Error(`devpod up failed for '${devpodId ?? options.repoPath}'.`);
    }

    try {
      const attached = listDevpodWorkspaces(options.repoPath);
      devpodId ??= selectDevpodWorkspace(attached, options.repoPath)?.id;
      if (!devpodId) {
        throw new Error(`DevPod did not attach '${options.repoPath}' after startup.`);
      }
      const ownership = inspectDevpodWorkspaceOwnership(attached, devpodId, options.repoPath);
      if (ownership.status === "conflict") throw new Error(ownership.reason);
      if (ownership.status !== "owned") {
        throw new Error(
          `DevPod did not attach '${options.repoPath}' as '${devpodId}' after startup.`,
        );
      }
      resetWorkspaceRuntimeCaches();
      return devpodId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DevpodStartPostconditionError(message);
    }
  });
}
