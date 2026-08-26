import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  inspectDevsyRuntimeStatus,
  inspectDevsyWorkspaceOwnership,
  listDevsyWorkspaces,
  selectDevsyWorkspace,
} from "./devsy-workspaces";
import { withFileLockSync } from "./file-lock";
import { DEVROUTER_HOME } from "./router";

const DEVSY_MUTATION_LOCK_FILE = path.join(DEVROUTER_HOME, "devsy-mutation.lock");
const DEVSY_MUTATION_WAIT_MS = 60_000;

export type OwnedDevsyMutationResult = { status: "changed" } | { status: "absent" };

export type DevsyStartOptions = {
  repoPath: string;
  devsyId?: string;
  devcontainerPath?: string;
  recreate?: boolean;
  quiet?: boolean;
  workspace?: { token: string; gitCommonDir: string };
  /**
   * Machine-configured inactivity shutdown forwarded as a Devsy provider
   * option. Omitted when unset so Devsy keeps any per-workspace option the
   * desktop app already stored for this workspace.
   */
  inactivityTimeout?: string;
};

export class DevsyStartPostconditionError extends Error {}

function failedStartMayHaveAttached(devsyId: string | undefined, repoPath: string): boolean {
  try {
    const attached = listDevsyWorkspaces();
    const attachedId = devsyId ?? selectDevsyWorkspace(attached, repoPath)?.id;
    if (!attachedId) return false;
    return inspectDevsyWorkspaceOwnership(attached, attachedId, repoPath).status !== "absent";
  } catch {
    // A failed registry read cannot prove that the provider left no recovery state.
    return true;
  }
}

function withMutationLock<T>(activity: string, target: string, operation: () => T): T {
  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  return withFileLockSync(
    DEVSY_MUTATION_LOCK_FILE,
    { activity, target: `'${target}'`, waitMs: DEVSY_MUTATION_WAIT_MS },
    operation,
  );
}

function commandFailure(result: ReturnType<typeof spawnSync>): string {
  return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function runDevsyAction(action: "stop" | "delete", devsyId: string, force = false): void {
  const args =
    action === "delete"
      ? ["delete", devsyId, ...(force ? ["--force"] : []), "--ignore-not-found"]
      : ["stop", devsyId];
  const result = spawnSync("devsy", ["workspace", ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `devsy workspace ${action}${force ? " --force" : ""} failed for '${devsyId}': ${commandFailure(result) || "unknown error"}`,
    );
  }
}

function inspectExactOwnership(devsyId: string, worktreePath: string) {
  const ownership = inspectDevsyWorkspaceOwnership(listDevsyWorkspaces(), devsyId, worktreePath);
  if (ownership.status === "conflict") throw new Error(ownership.reason);
  return ownership;
}

function mutateOwnedDevsyWorkspace(
  action: "stop" | "delete",
  devsyId: string,
  worktreePath: string,
): OwnedDevsyMutationResult {
  return withMutationLock(`Devsy ${action}`, worktreePath, () => {
    const before = inspectExactOwnership(devsyId, worktreePath);
    if (before.status === "absent") return { status: "absent" as const };

    runDevsyAction(action, devsyId);

    let after = inspectExactOwnership(devsyId, worktreePath);
    if (action === "stop" && after.status !== "owned") {
      throw new Error(
        `Devsy workspace '${devsyId}' no longer owns '${worktreePath}' after provider stop.`,
      );
    }
    if (action === "delete" && after.status === "owned") {
      const runtime = inspectDevsyRuntimeStatus(devsyId);
      if (runtime !== "not-found") {
        throw new Error(
          `Devsy workspace '${devsyId}' still owns '${worktreePath}' after provider delete (runtime=${runtime}).`,
        );
      }
      after = inspectExactOwnership(devsyId, worktreePath);
      if (after.status === "owned") {
        runDevsyAction("delete", devsyId, true);
        after = inspectExactOwnership(devsyId, worktreePath);
      }
      if (after.status !== "absent") {
        throw new Error(
          `Devsy workspace '${devsyId}' still owns '${worktreePath}' after forced provider delete.`,
        );
      }
    }
    return { status: "changed" as const };
  });
}

export function stopOwnedDevsyWorkspace(
  devsyId: string,
  worktreePath: string,
): OwnedDevsyMutationResult {
  return mutateOwnedDevsyWorkspace("stop", devsyId, worktreePath);
}

export function deleteOwnedDevsyWorkspace(
  devsyId: string,
  worktreePath: string,
): OwnedDevsyMutationResult {
  return mutateOwnedDevsyWorkspace("delete", devsyId, worktreePath);
}

function assertDevsyTarget(devsyId: string | undefined, repoPath: string): string | undefined {
  const workspaces = listDevsyWorkspaces();
  const existing = selectDevsyWorkspace(workspaces, repoPath);
  const id = devsyId ?? existing?.id;
  if (id) {
    const before = inspectDevsyWorkspaceOwnership(workspaces, id, repoPath);
    if (before.status === "conflict") throw new Error(before.reason);
  }
  return id;
}

export function startDevsyWorkspace(options: DevsyStartOptions): string {
  const activity = options.recreate ? "Devsy recreate" : "Devsy start";
  return withMutationLock(activity, options.repoPath, () => {
    let devsyId = assertDevsyTarget(options.devsyId, options.repoPath);
    if (devsyId && options.recreate) {
      const attached = listDevsyWorkspaces();
      const ownership = inspectDevsyWorkspaceOwnership(attached, devsyId, options.repoPath);
      if (ownership.status !== "owned") {
        throw new Error(`Cannot recreate Devsy workspace '${devsyId}' without one exact owner.`);
      }
    }
    if (!devsyId && options.recreate) {
      throw new Error("Cannot recreate a Devsy workspace before its exact id is known.");
    }

    // Devsy derives the workspace id from the folder name on first use; the
    // explicit --id keeps linked-worktree identities stable across restarts.
    const args = ["workspace", "up", options.repoPath];
    if (devsyId) args.push("--id", devsyId);
    if (options.devcontainerPath) args.push("--devcontainer", options.devcontainerPath);
    args.push("--ide-launch", "skip");
    if (options.workspace) {
      args.push(
        "--workspace-env",
        `WORKSPACE=${options.workspace.token}`,
        "--workspace-env",
        `DEVROUTER_WORKSPACE=${options.workspace.token}`,
      );
    }
    if (options.inactivityTimeout) {
      args.push("--provider-option", `INACTIVITY_TIMEOUT=${options.inactivityTimeout}`);
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

    const result = spawnSync("devsy", args, {
      stdio: options.quiet ? ["inherit", 2, "inherit"] : "inherit",
      env,
    });
    if (result.status !== 0) {
      const message = `devsy workspace up failed for '${devsyId ?? options.repoPath}'.`;
      if (failedStartMayHaveAttached(devsyId, options.repoPath)) {
        throw new DevsyStartPostconditionError(message);
      }
      throw new Error(message);
    }

    try {
      const attached = listDevsyWorkspaces();
      devsyId ??= selectDevsyWorkspace(attached, options.repoPath)?.id;
      if (!devsyId) {
        throw new Error(`Devsy did not attach '${options.repoPath}' after startup.`);
      }
      const ownership = inspectDevsyWorkspaceOwnership(attached, devsyId, options.repoPath);
      if (ownership.status === "conflict") throw new Error(ownership.reason);
      if (ownership.status !== "owned") {
        throw new Error(
          `Devsy did not attach '${options.repoPath}' as '${devsyId}' after startup.`,
        );
      }
      return devsyId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DevsyStartPostconditionError(message);
    }
  });
}
