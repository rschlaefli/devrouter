import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ManagedDevcontainerPlan } from "./devcontainer-profile";
import {
  inspectManagedStopContainers,
  inspectManagedStopDaemon,
  inspectManagedStopRunnerId,
  inspectManagedStopWorkspaceIds,
  resolveManagedStopEndpoint,
  stopPinnedManagedContainer,
} from "./devpod-environment";
import { inspectDevsyWorkspaceOwnership, listDevsyWorkspaces } from "./devsy-workspaces";
import { proveManagedComposePopulation } from "./managed-compose-population";
import { type ManagedRuntimeState, readManagedRuntimeState } from "./managed-runtime-state";
import { type ManagedStopBaseline, validateManagedStopBaseline } from "./managed-stop-baseline";
import { claimLifecycleEffect } from "./reliability-context";
import { isLinkedWorktree, resolveWorktreeWorkspace, sameWorkspacePath } from "./workspace";
import { readWorkspaceOwnership, resolveGitCommonDir } from "./workspace-ownership";
import { resetWorkspaceRuntimeCaches, resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

function registration(state: ManagedRuntimeState) {
  resetWorkspaceRuntimeCaches();
  if (resolveWorkspaceRuntimeOrDefault(state.repoPath) !== "devsy")
    throw new Error("Stop provider changed.");
  const owner = inspectDevsyWorkspaceOwnership(
    listDevsyWorkspaces(),
    state.devpodId,
    state.repoPath,
  );
  if (owner.status !== "owned") throw new Error("Stop requires one exact provider registration.");
  if (isLinkedWorktree(state.repoPath)) {
    const workspace = resolveWorktreeWorkspace(state.repoPath);
    const record = workspace ? readWorkspaceOwnership(state.repoPath, workspace) : undefined;
    if (
      !workspace ||
      workspace !== state.workspace ||
      !record ||
      record.devpodId !== state.devpodId ||
      !sameWorkspacePath(record.worktreePath, state.repoPath)
    )
      throw new Error("Stop workspace identity changed.");
    resolveGitCommonDir(state.repoPath);
  } else if (state.workspace !== undefined) throw new Error("Stop checkout identity changed.");
  const value = owner.workspace;
  return {
    context: value.context ?? "",
    providerId: value.id,
    uid: value.uid ?? "",
    sourcePath: value.source.localFolder,
    sourceContainer: value.source.container ?? "",
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedMounts(mounts: ManagedStopBaseline["containers"][number]["mounts"]) {
  return mounts
    .map((mount) => ({ ...mount }))
    .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
}

function identity(container: ReturnType<typeof inspectManagedStopContainers>[number]) {
  return {
    id: container.id,
    service: container.labels["com.docker.compose.service"] ?? "",
    configFiles: (container.labels["com.docker.compose.project.config_files"] ?? "")
      .split(",")
      .map((file) => file.trim()),
    mounts: orderedMounts(container.mounts),
  };
}

function prove(state: ManagedRuntimeState, baseline: ManagedStopBaseline) {
  const owner = registration(state);
  if (
    Object.entries(owner).some(
      ([key, value]) => baseline[key as keyof ManagedStopBaseline] !== value,
    )
  ) {
    throw new Error("Retained provider identity changed.");
  }
  if (inspectManagedStopDaemon(baseline.endpoint) !== baseline.daemonId)
    throw new Error("Stop daemon changed.");
  const containers = inspectManagedStopContainers(baseline.project, baseline.endpoint);
  const expected = baseline.containers
    .map((container) => ({ ...container, mounts: orderedMounts(container.mounts) }))
    .sort((a, b) => compareText(a.id, b.id));
  const observed = containers.map(identity).sort((a, b) => compareText(a.id, b.id));
  if (
    !isDeepStrictEqual(expected, observed) ||
    containers.some(
      (container) =>
        container.labels["com.docker.compose.project.working_dir"] !== baseline.composeDirectory,
    )
  ) {
    throw new Error("Retained container population or immutable identity changed.");
  }
  const workspaceIds = inspectManagedStopWorkspaceIds(
    baseline.endpoint,
    baseline.composeDirectory,
  ).sort();
  if (!isDeepStrictEqual(workspaceIds, expected.map((container) => container.id).sort())) {
    throw new Error("Workspace contains an unrecorded container population.");
  }
  const primary = baseline.containers.find(
    (container) => container.service === baseline.primaryService,
  );
  if (!primary) throw new Error("Retained primary is missing.");
  // Devsy uses the workspace ID for legacy UIDs, otherwise its 16/40-byte UID.
  const uidBytes = Buffer.byteLength(baseline.uid);
  const runnerId = uidBytes === 16 || uidBytes === 40 ? baseline.uid : baseline.providerId;
  if (
    !baseline.sourceContainer &&
    inspectManagedStopRunnerId(baseline.endpoint, primary.id) !== runnerId
  ) {
    throw new Error("Provider-to-container binding changed.");
  }
  if (
    !isDeepStrictEqual(registration(state), owner) ||
    inspectManagedStopDaemon(baseline.endpoint) !== baseline.daemonId
  ) {
    throw new Error("Stop authority changed during inspection.");
  }
  return containers;
}

/** Caller holds the workspace and provider locks, including while persisting the result. */
export function captureManagedStopBaseline(
  state: ManagedRuntimeState,
  plan: ManagedDevcontainerPlan,
  primaryId: string,
  expectedEndpoint?: string,
): ManagedStopBaseline {
  const owner = registration(state);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(owner.context) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(owner.providerId)
  )
    throw new Error("Invalid capture provider identity.");
  const devsyRoot = path.resolve(process.env.DEVSY_HOME || path.join(os.homedir(), ".devsy"));
  const featureDirectory = path.join(
    devsyRoot,
    "contexts",
    owner.context,
    "workspaces",
    owner.providerId,
    "agent",
    ".docker-compose",
  );
  const endpoint = resolveManagedStopEndpoint();
  if (expectedEndpoint !== undefined && endpoint !== expectedEndpoint) {
    throw new Error("Docker endpoint changed before ownership capture.");
  }
  const daemonId = inspectManagedStopDaemon(endpoint);
  const containers = inspectManagedStopContainers(state.composeProject, endpoint);
  const primary = proveManagedComposePopulation({
    plan,
    repoPath: state.repoPath,
    composeProject: state.composeProject,
    featureDirectory,
    providerRoot: devsyRoot,
    containers,
  });
  if (primary.id !== primaryId)
    throw new Error("Prepared primary container changed before capture.");
  const baseline = validateManagedStopBaseline(
    {
      version: 1,
      provider: "devsy",
      ...owner,
      endpoint,
      daemonId,
      sourceConfigSha256: state.sourceConfigSha256,
      effectiveConfigSha256: state.effectiveConfigSha256,
      project: state.composeProject,
      primaryService: plan.primaryService,
      requiredServices: [...plan.desiredServices],
      allowedServices: [...plan.nativeRunServices],
      composeDirectory: plan.composeDirectory,
      composeFiles: [...plan.composeFiles],
      featureDirectory,
      containers: containers.map(identity),
    },
    state,
  );
  prove(state, baseline);
  return baseline;
}

/** Caller serializes with provider mutations; this proof never reads repository configuration. */
export function proveRetainedManagedStop(state: ManagedRuntimeState) {
  const baseline = validateManagedStopBaseline(state.stopBaseline, state);
  if (!isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state)) {
    throw new Error("Retained stop generation changed.");
  }
  const result = prove(state, baseline);
  if (!isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state)) {
    throw new Error("Retained stop generation changed during inspection.");
  }
  return result;
}

/** Caller holds the workspace and provider locks. Every effect claims the current stop fence. */
export function stopFromManagedBaseline(state: ManagedRuntimeState): void {
  const baseline = validateManagedStopBaseline(state.stopBaseline, state);
  const stopped = new Set<string>();
  for (const initial of proveRetainedManagedStop(state))
    if (!initial.state.Running) stopped.add(initial.id);
  const inspect = () => {
    const current = proveRetainedManagedStop(state);
    if (current.some((container) => stopped.has(container.id) && container.state.Running)) {
      throw new Error("Retained container restarted during stop.");
    }
    for (const container of current) if (!container.state.Running) stopped.add(container.id);
    return current;
  };
  for (const retained of baseline.containers) {
    if (inspect().find((container) => container.id === retained.id)?.state.Running) {
      claimLifecycleEffect();
      stopPinnedManagedContainer(baseline.endpoint, retained.id);
      if (inspect().find((container) => container.id === retained.id)?.state.Running)
        throw new Error("Container cessation is not proven.");
    }
  }
  if (inspect().some((container) => container.state.Running))
    throw new Error("Retained workloads remain running.");
}
