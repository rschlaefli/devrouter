import { isDeepStrictEqual } from "node:util";
import {
  inspectManagedStopContainers,
  inspectManagedStopDaemon,
  inspectManagedStopRunnerId,
  inspectWorkspaceContainers,
  resolveManagedStopEndpoint,
  supportsManagedStopBaseline,
  workspaceAppContainers,
} from "./devpod-environment";
import {
  inspectDevsyRuntimeStatus,
  inspectDevsyWorkspaceOwnership,
  listDevsyWorkspaces,
  selectDevsyWorkspace,
} from "./devsy-workspaces";
import { comparableWorkspacePath, sameWorkspacePath } from "./workspace";

export type DevsyExecProof = {
  repoPath: string;
  id: string;
  uid: string;
  context: string;
  endpoint: string;
  daemon: string;
  containerId: string;
  workspacePath: string;
};

/** A transient identity observation, never a replacement for retained managed state. */
export function captureDevsyExecProof(repoPath: string): DevsyExecProof {
  repoPath = comparableWorkspacePath(repoPath);
  const registry = listDevsyWorkspaces();
  const workspace = selectDevsyWorkspace(registry, repoPath);
  if (
    !workspace?.uid ||
    !workspace.context ||
    workspace.source.container ||
    inspectDevsyWorkspaceOwnership(registry, workspace.id, repoPath).status !== "owned" ||
    inspectDevsyRuntimeStatus(workspace.id) !== "running"
  )
    throw new Error("Retained exec requires one exact running Devsy registration.");
  const endpoint = resolveManagedStopEndpoint();
  if (!supportsManagedStopBaseline(endpoint))
    throw new Error("Retained exec requires an exact local Docker endpoint.");
  const daemon = inspectManagedStopDaemon(endpoint);
  const candidates = workspaceAppContainers(inspectWorkspaceContainers(), repoPath).filter(
    (container) => container.state.Running,
  );
  if (candidates.length !== 1)
    throw new Error("Retained exec requires one exact running primary container.");
  const candidate = candidates[0];
  const project = candidate.labels["com.docker.compose.project"];
  if (!project) throw new Error("Retained exec primary has no Compose identity.");
  const pinned = workspaceAppContainers(
    inspectManagedStopContainers(project, endpoint),
    repoPath,
  ).filter((container) => container.state.Running);
  if (pinned.length !== 1 || pinned[0].id !== candidate.id)
    throw new Error("Retained exec primary changed during inspection.");
  const mounts = pinned[0].mounts.filter(
    (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, repoPath),
  );
  if (mounts.length !== 1 || !mounts[0].Destination.startsWith("/"))
    throw new Error("Retained exec requires one exact source mount.");
  const uidBytes = Buffer.byteLength(workspace.uid);
  const runner = uidBytes === 16 || uidBytes === 40 ? workspace.uid : workspace.id;
  if (
    inspectManagedStopRunnerId(endpoint, candidate.id) !== runner ||
    inspectManagedStopDaemon(endpoint) !== daemon
  )
    throw new Error("Retained exec provider or Docker identity changed.");
  return {
    repoPath,
    id: workspace.id,
    uid: workspace.uid,
    context: workspace.context,
    endpoint,
    daemon,
    containerId: candidate.id,
    workspacePath: mounts[0].Destination,
  };
}

export function revalidateDevsyExecProof(repoPath: string, proof: DevsyExecProof): void {
  if (!isDeepStrictEqual(captureDevsyExecProof(repoPath), proof))
    throw new Error("Retained exec identity changed before command launch.");
}
