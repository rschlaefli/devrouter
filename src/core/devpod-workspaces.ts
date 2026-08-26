import { spawnSync } from "node:child_process";
import { type DevpodWorkspace, listDevpodWorkspacesRaw } from "./devpod-registry";
import {
  type DevsyWorkspace,
  inspectDevsyRuntimeStatus,
  listDevsyWorkspaces,
} from "./devsy-workspaces";
import { sameWorkspacePath } from "./workspace";
import {
  getWorkspaceRegistrySnapshots,
  resolveWorkspaceRuntimeOrDefault,
} from "./workspace-runtime";

export type { DevpodWorkspace } from "./devpod-registry";

export type DevpodWorkspaceOwnership =
  | { status: "owned"; workspace: DevpodWorkspace }
  | { status: "absent" }
  | { status: "conflict"; reason: string };

export type DevpodRuntimeStatus = "running" | "stopped" | "busy" | "not-found" | "unknown";

/**
 * List workspaces of the runtime that owns (or, for unknown paths, would
 * manage) the given checkout. Passing the path lets the dispatch honor
 * exact-path registry ownership in mixed DevPod+Devsy fleets.
 * Always reads the registry live: mutation postconditions depend on seeing
 * the provider state a mutation just produced.
 */
export function listDevpodWorkspaces(repoPath?: string): DevpodWorkspace[] {
  if (resolveWorkspaceRuntimeOrDefault(repoPath) === "devsy") {
    return listDevsyWorkspaces().map((workspace: DevsyWorkspace) => ({
      id: workspace.id,
      source: workspace.source,
      ...(workspace.lastUsed ? { lastUsed: workspace.lastUsed } : {}),
    }));
  }
  return listDevpodWorkspacesRaw();
}

/**
 * Snapshot-backed variant for read-only reports (workspace ls/gc/cleanup)
 * that resolve one runtime per checkout and must not spawn one registry read
 * per row. Returns undefined when the resolved runtime's registry could not
 * be read so reports can render that row as unknown.
 */
export function listDevpodWorkspacesFromSnapshots(
  repoPath?: string,
): DevpodWorkspace[] | undefined {
  const snapshots = getWorkspaceRegistrySnapshots();
  if (resolveWorkspaceRuntimeOrDefault(repoPath) === "devsy") {
    return snapshots.devsy?.map((workspace: DevsyWorkspace) => ({
      id: workspace.id,
      source: workspace.source,
      ...(workspace.lastUsed ? { lastUsed: workspace.lastUsed } : {}),
    }));
  }
  return snapshots.devpod;
}

/**
 * Workspaces from every installed runtime, shaped uniformly. Used by
 * whole-repository scans (workspace gc legacy detection) that must consider
 * both registries regardless of which runtime owns which path.
 */
export function listMergedRuntimeWorkspaces(): DevpodWorkspace[] {
  const snapshots = getWorkspaceRegistrySnapshots();
  return [
    ...(snapshots.devpod ?? []),
    ...(snapshots.devsy?.map((workspace: DevsyWorkspace) => ({
      id: workspace.id,
      source: workspace.source,
      ...(workspace.lastUsed ? { lastUsed: workspace.lastUsed } : {}),
    })) ?? []),
  ];
}

function parseDevpodRuntimeStatus(output: string, expectedId: string): DevpodRuntimeStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return "unknown";
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { id?: unknown }).id !== expectedId
  ) {
    return "unknown";
  }
  switch ((parsed as { state?: unknown }).state) {
    case "Running":
      return "running";
    case "Stopped":
      return "stopped";
    case "Busy":
      return "busy";
    case "NotFound":
      return "not-found";
    default:
      return "unknown";
  }
}

export function inspectDevpodRuntimeStatus(
  devpodId: string,
  repoPath?: string,
): DevpodRuntimeStatus {
  if (resolveWorkspaceRuntimeOrDefault(repoPath) === "devsy") {
    return inspectDevsyRuntimeStatus(devpodId);
  }
  const result = spawnSync("devpod", ["status", devpodId, "--output", "json", "--timeout", "5s"], {
    encoding: "utf-8",
  });
  if (result.status !== 0 || result.error) return "unknown";
  return parseDevpodRuntimeStatus(result.stdout, devpodId);
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
