import { spawnSync } from "node:child_process";
import { withDevpodMutationLockSync } from "./devpod-mutation";
import { sameWorkspacePath } from "./workspace";

export type DevpodWorkspace = {
  id: string;
  source: { localFolder: string };
};

export type DevpodWorkspaceOwnership =
  | { status: "owned"; workspace: DevpodWorkspace }
  | { status: "absent" }
  | { status: "conflict"; reason: string };

export function listDevpodWorkspaces(): DevpodWorkspace[] {
  const result = spawnSync("devpod", ["list", "--output", "json"], { encoding: "utf-8" });
  if (result.status !== 0) {
    const details = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`devpod list failed: ${details || "devpod is not installed or unavailable"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("devpod list returned invalid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("devpod list returned an unexpected response.");
  }

  return parsed.map((entry) => {
    const candidate = entry as Partial<DevpodWorkspace>;
    if (
      typeof candidate.id !== "string" ||
      !candidate.source ||
      typeof candidate.source.localFolder !== "string"
    ) {
      throw new Error("devpod list returned a workspace without id/source.localFolder.");
    }
    return candidate as DevpodWorkspace;
  });
}

export function inspectDevpodWorkspaceOwnership(
  workspaces: DevpodWorkspace[],
  devpodId: string,
  worktreePath: string,
): DevpodWorkspaceOwnership {
  const idOwners = workspaces.filter((workspace) => workspace.id === devpodId);
  const pathOwners = workspaces.filter((workspace) =>
    sameWorkspacePath(workspace.source.localFolder, worktreePath),
  );
  const exact = idOwners.filter((workspace) =>
    sameWorkspacePath(workspace.source.localFolder, worktreePath),
  );
  if (
    idOwners.length > 1 ||
    pathOwners.length > 1 ||
    (idOwners[0] && exact.length === 0) ||
    (pathOwners[0] && pathOwners[0].id !== devpodId)
  ) {
    return {
      status: "conflict",
      reason: `DevPod '${devpodId}' and worktree '${worktreePath}' do not have one exact owner.`,
    };
  }
  return exact[0] ? { status: "owned", workspace: exact[0] } : { status: "absent" };
}

export function selectDevpodWorkspace(
  workspaces: DevpodWorkspace[],
  repoPath: string,
): DevpodWorkspace | undefined {
  const matches = workspaces.filter((workspace) =>
    sameWorkspacePath(workspace.source.localFolder, repoPath),
  );
  if (matches.length > 1) {
    throw new Error(
      `Multiple DevPod workspaces reference '${repoPath}': ${matches.map((match) => match.id).join(", ")}`,
    );
  }
  return matches[0];
}

function runDevpodWorkspaceAction(action: "stop" | "delete", devpodId: string): void {
  const args = action === "delete" ? [action, devpodId, "--ignore-not-found"] : [action, devpodId];
  const result = spawnSync("devpod", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`devpod ${action} failed for '${devpodId}': ${detail || "unknown error"}`);
  }
}

export type OwnedDevpodMutationResult = { status: "changed" } | { status: "absent" };

export function mutateOwnedDevpodWorkspace(
  action: "stop" | "delete",
  devpodId: string,
  worktreePath: string,
): OwnedDevpodMutationResult {
  return withDevpodMutationLockSync(`DevPod ${action}`, worktreePath, () => {
    const before = inspectDevpodWorkspaceOwnership(listDevpodWorkspaces(), devpodId, worktreePath);
    if (before.status === "conflict") throw new Error(before.reason);
    if (before.status === "absent") return { status: "absent" };

    runDevpodWorkspaceAction(action, devpodId);

    const after = inspectDevpodWorkspaceOwnership(listDevpodWorkspaces(), devpodId, worktreePath);
    if (after.status === "conflict") throw new Error(after.reason);
    if (action === "stop" && after.status !== "owned") {
      throw new Error(`DevPod '${devpodId}' no longer owns '${worktreePath}' after provider stop.`);
    }
    if (action === "delete" && after.status !== "absent") {
      throw new Error(`DevPod '${devpodId}' still owns '${worktreePath}' after provider delete.`);
    }
    return { status: "changed" };
  });
}
