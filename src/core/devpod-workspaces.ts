import { spawnSync } from "node:child_process";
import {
  type DevsyWorkspace,
  inspectDevsyRuntimeStatus,
  listDevsyWorkspaces,
} from "./devsy-workspaces";
import { sameWorkspacePath } from "./workspace";
import { resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

export type DevpodWorkspace = {
  id: string;
  source: { localFolder: string };
  /** Optional provider activity metadata; older DevPod versions omit it. */
  lastUsed?: string;
  /** Set when the provider returned a non-string lastUsed value. */
  lastUsedMalformed?: boolean;
};

export type DevpodWorkspaceOwnership =
  | { status: "owned"; workspace: DevpodWorkspace }
  | { status: "absent" }
  | { status: "conflict"; reason: string };

export type DevpodRuntimeStatus = "running" | "stopped" | "busy" | "not-found" | "unknown";

export function listDevpodWorkspaces(): DevpodWorkspace[] {
  if (resolveWorkspaceRuntimeOrDefault() === "devsy") {
    return listDevsyWorkspaces().map((workspace: DevsyWorkspace) => ({
      id: workspace.id,
      source: workspace.source,
      ...(workspace.lastUsed ? { lastUsed: workspace.lastUsed } : {}),
    }));
  }
  const result = spawnSync("devpod", ["list", "--output", "json", "--skip-pro"], {
    encoding: "utf-8",
  });
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
    const candidate = entry as Partial<DevpodWorkspace> & Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      !candidate.source ||
      typeof candidate.source.localFolder !== "string"
    ) {
      throw new Error("devpod list returned a workspace without id/source.localFolder.");
    }
    const workspace: DevpodWorkspace = {
      id: candidate.id,
      source: { localFolder: candidate.source.localFolder },
    };
    if ("lastUsed" in candidate) {
      if (typeof candidate.lastUsed === "string") {
        workspace.lastUsed = candidate.lastUsed;
      } else {
        workspace.lastUsedMalformed = true;
      }
    }
    return workspace;
  });
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

export function inspectDevpodRuntimeStatus(devpodId: string): DevpodRuntimeStatus {
  if (resolveWorkspaceRuntimeOrDefault() === "devsy") {
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
