import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  inspectManagedStopContainers,
  inspectManagedStopDaemon,
  inspectManagedStopRunnerId,
  inspectProviderRunnerContainers,
  inspectWorkspaceContainers,
  resolveManagedStopEndpoint,
  supportsManagedStopBaseline,
  workspaceAppContainers,
} from "./devpod-environment";
import {
  type DevsyWorkspace,
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
  providerName: string;
  endpoint: string;
  daemon: string;
  containerId: string;
  workspacePath: string;
};

function proveLocalDockerSelection(workspace: DevsyWorkspace): string {
  const name = workspace.providerName;
  const context = workspace.context;
  if (
    !name ||
    !context ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(context)
  )
    throw new Error("Retained exec provider configuration identity is unavailable.");
  const file = path.join(
    process.env.DEVSY_HOME || path.join(os.homedir(), ".devsy"),
    "contexts",
    context,
    "providers",
    name,
    "provider.json",
  );
  try {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error();
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const driver = config.agent?.driver ?? "docker";
    const configuredPath = config.agent?.docker?.path ?? "";
    if (typeof configuredPath !== "string") throw new Error();
    // Devsy 1.16.2 expands provider options before ambient variables. Accept
    // only its plain Docker command; never redirect a custom provider command.
    const command =
      configuredPath === "${DOCKER_PATH}" || configuredPath === "$DOCKER_PATH"
        ? workspace.dockerPathOption || process.env.DOCKER_PATH || "docker"
        : configuredPath || "docker";
    if (config.name !== name || driver !== "docker" || command !== "docker") throw new Error();
  } catch {
    throw new Error("Retained exec requires a provider configured for the local Docker command.");
  }
  return name;
}

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
  const providerName = proveLocalDockerSelection(workspace);
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
  const runnerContainers = inspectProviderRunnerContainers(endpoint, runner);
  if (runnerContainers.length !== 1 || runnerContainers[0] !== candidate.id)
    throw new Error("Retained exec runner does not select the exact primary container.");
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
    providerName,
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
