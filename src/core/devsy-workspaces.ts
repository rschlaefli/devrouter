import { spawnSync } from "node:child_process";
import { sameWorkspacePath } from "./workspace";

export type DevsyWorkspace = {
  id: string;
  source: { localFolder: string };
  /** Optional provider activity metadata. */
  lastUsed?: string;
  lastUsedMalformed?: boolean;
};

export type DevsyWorkspaceOwnership =
  | { status: "owned"; workspace: DevsyWorkspace }
  | { status: "absent" }
  | { status: "conflict"; reason: string };

export type DevsyRuntimeStatus = "running" | "stopped" | "busy" | "not-found" | "unknown";

export function listDevsyWorkspaces(): DevsyWorkspace[] {
  const result = spawnSync("devsy", ["workspace", "list", "--result-format", "json"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const details = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `devsy workspace list failed: ${details || "devsy is not installed or unavailable"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("devsy workspace list returned invalid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("devsy workspace list returned an unexpected response.");
  }

  return parsed.map((entry) => {
    const candidate = entry as Partial<DevsyWorkspace> & Record<string, unknown>;
    const source = candidate.source as { localFolder?: unknown } | undefined;
    if (typeof candidate.id !== "string" || !source || typeof source.localFolder !== "string") {
      throw new Error("devsy workspace list returned a workspace without id/source.localFolder.");
    }
    const workspace: DevsyWorkspace = {
      id: candidate.id,
      source: { localFolder: source.localFolder },
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

function parseDevsyRuntimeStatus(output: string, expectedId: string): DevsyRuntimeStatus {
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

export function inspectDevsyRuntimeStatus(devsyId: string): DevsyRuntimeStatus {
  const result = spawnSync("devsy", ["workspace", "status", devsyId, "--result-format", "json"], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error) return "unknown";
  return parseDevsyRuntimeStatus(result.stdout, devsyId);
}

export function inspectDevsyWorkspaceOwnership(
  workspaces: DevsyWorkspace[],
  devsyId: string,
  worktreePath: string,
): DevsyWorkspaceOwnership {
  const idOwners = workspaces.filter((workspace) => workspace.id === devsyId);
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
    (pathOwners[0] && pathOwners[0].id !== devsyId)
  ) {
    return {
      status: "conflict",
      reason: `Devsy workspace '${devsyId}' and worktree '${worktreePath}' do not have one exact owner.`,
    };
  }
  return exact[0] ? { status: "owned", workspace: exact[0] } : { status: "absent" };
}

export function selectDevsyWorkspace(
  workspaces: DevsyWorkspace[],
  repoPath: string,
): DevsyWorkspace | undefined {
  const matches = workspaces.filter((workspace) =>
    sameWorkspacePath(workspace.source.localFolder, repoPath),
  );
  if (matches.length > 1) {
    const ids = matches.map((match) => match.id).join(", ");
    throw new Error(`Multiple Devsy workspaces reference '${repoPath}': ${ids}`);
  }
  return matches[0];
}
