import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ManagedDevcontainerPlan } from "./devcontainer-profile";
import {
  assertManagedStopContainersAbsent,
  inspectManagedStopContainers,
  inspectManagedStopDaemon,
  inspectManagedStopRunnerId,
  inspectManagedStopWorkspaceIds,
  inspectProviderRunnerContainers,
  resolveManagedStopEndpoint,
  stopPinnedManagedContainer,
} from "./devpod-environment";
import { listDevpodWorkspacesRaw } from "./devpod-registry";
import { proveLocalDockerSelection } from "./devsy-exec-proof";
import { inspectDevsyWorkspaceOwnership, listDevsyWorkspaces } from "./devsy-workspaces";
import { proveManagedComposePopulation } from "./managed-compose-population";
import { type ManagedRuntimeState, readManagedRuntimeState } from "./managed-runtime-state";
import { type ManagedStopBaseline, validateManagedStopBaseline } from "./managed-stop-baseline";
import { claimLifecycleEffect } from "./reliability-context";
import { isLinkedWorktree, resolveWorktreeWorkspace, sameWorkspacePath } from "./workspace";
import {
  inspectWorkspaceOwnership,
  listGitWorktrees,
  readWorkspaceOwnership,
  resolveGitCommonDir,
} from "./workspace-ownership";
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
  return identityOf(owner.workspace);
}

/** Devsy uses the workspace ID for legacy UIDs, otherwise its 16/40-byte UID. */
function managedRunnerId(uid: string | undefined, providerId: string): string {
  if (uid === undefined) {
    return providerId;
  }
  const bytes = Buffer.byteLength(uid);
  return bytes === 16 || bytes === 40 ? uid : providerId;
}

function identityOf(value: {
  context?: string;
  id: string;
  uid?: string;
  source: { localFolder: string; container?: string };
}) {
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
    devsyRoot,
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

export type ManagedStopProof =
  | { status: "retained"; containers: ReturnType<typeof proveRetainedManagedStop> }
  | { status: "proven-absent"; containers: [] };

function absentRegistrationIdentity(state: ManagedRuntimeState) {
  resetWorkspaceRuntimeCaches();
  if (resolveWorkspaceRuntimeOrDefault(state.repoPath) !== "devsy")
    throw new Error("Stop provider changed.");
  if (!state.workspace || !isLinkedWorktree(state.repoPath))
    throw new Error("Absent stop requires a linked workspace.");
  const record = readWorkspaceOwnership(state.repoPath, state.workspace);
  if (
    !record ||
    record.workspace !== state.workspace ||
    record.devpodId !== state.devpodId ||
    !sameWorkspacePath(record.worktreePath, state.repoPath) ||
    resolveWorktreeWorkspace(state.repoPath) !== state.workspace ||
    inspectWorkspaceOwnership(record, listGitWorktrees(state.repoPath), undefined).ownerStatus !==
      "present"
  )
    throw new Error("Absent stop workspace ownership changed.");
  for (const entries of [
    listDevsyWorkspaces(),
    listDevpodWorkspacesRaw({ allowMissingExecutable: true }),
  ]) {
    if (
      entries.some(
        (entry) =>
          entry.id === state.devpodId ||
          sameWorkspacePath(entry.source.localFolder, state.repoPath),
      )
    )
      throw new Error("Absent stop requires both provider registrations to remain absent.");
  }
  return { record, gitCommonDir: resolveGitCommonDir(state.repoPath) };
}

function replacementObservation(state: ManagedRuntimeState) {
  resetWorkspaceRuntimeCaches();
  if (resolveWorkspaceRuntimeOrDefault(state.repoPath) !== "devsy")
    throw new Error("Stop provider changed.");
  if (!state.workspace || !isLinkedWorktree(state.repoPath))
    throw new Error("Replacement stop requires a linked workspace.");
  const record = readWorkspaceOwnership(state.repoPath, state.workspace);
  if (
    !record ||
    record.workspace !== state.workspace ||
    record.devpodId !== state.devpodId ||
    !sameWorkspacePath(record.worktreePath, state.repoPath) ||
    resolveWorktreeWorkspace(state.repoPath) !== state.workspace ||
    inspectWorkspaceOwnership(record, listGitWorktrees(state.repoPath), undefined).ownerStatus !==
      "present"
  )
    throw new Error("Replacement stop workspace ownership changed.");
  const owner = inspectDevsyWorkspaceOwnership(
    listDevsyWorkspaces(),
    state.devpodId,
    state.repoPath,
  );
  if (owner.status !== "owned")
    throw new Error("Replacement stop requires one exact provider registration.");
  if (
    listDevpodWorkspacesRaw({ allowMissingExecutable: true }).some(
      (entry) =>
        entry.id === state.devpodId || sameWorkspacePath(entry.source.localFolder, state.repoPath),
    )
  )
    throw new Error("Replacement stop requires no competing provider registration.");
  proveLocalDockerSelection(owner.workspace);
  return owner.workspace;
}

/** Prove an exact replaced registration has no workload on the pinned daemon. */
function proveReplacementStopAbsence(
  state: ManagedRuntimeState,
  baseline: ManagedStopBaseline,
  replacement: { uid?: string },
): void {
  const observation = () => {
    const workspace = replacementObservation(state);
    if (workspace.uid !== replacement.uid)
      throw new Error("Replacement stop registration changed during inspection.");
    if (inspectManagedStopDaemon(baseline.endpoint) !== baseline.daemonId)
      throw new Error("Stop daemon changed.");
    return workspace;
  };
  const before = observation();
  if (!isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state))
    throw new Error("Retained stop generation changed.");
  assertManagedStopContainersAbsent(
    baseline.endpoint,
    baseline.containers.map((container) => container.id),
  );
  const oldRunner = managedRunnerId(baseline.uid, baseline.providerId);
  const newRunner = managedRunnerId(before.uid, baseline.providerId);
  const runners = oldRunner === newRunner ? [oldRunner] : [oldRunner, newRunner];
  const assertEmptyPopulation = () => {
    if (
      inspectManagedStopContainers(baseline.project, baseline.endpoint).length !== 0 ||
      inspectManagedStopWorkspaceIds(baseline.endpoint, baseline.composeDirectory).length !== 0 ||
      runners.some((id) => inspectProviderRunnerContainers(baseline.endpoint, id).length !== 0)
    )
      throw new Error("Replacement stop observed a remaining workspace population.");
  };
  assertEmptyPopulation();
  const after = observation();
  if (
    after.uid !== before.uid ||
    !isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state)
  )
    throw new Error("Replacement stop authority changed during inspection.");
  assertManagedStopContainersAbsent(
    baseline.endpoint,
    baseline.containers.map((container) => container.id),
  );
  assertEmptyPopulation();
}

/** Caller holds the workspace and provider locks. No current config is used as historical evidence. */
export function proveManagedStop(state: ManagedRuntimeState): ManagedStopProof {
  const baseline = validateManagedStopBaseline(state.stopBaseline, state);
  const owner = inspectDevsyWorkspaceOwnership(
    listDevsyWorkspaces(),
    state.devpodId,
    state.repoPath,
  );
  if (owner.status === "owned") {
    const identityKeys = ["context", "providerId", "uid", "sourcePath", "sourceContainer"] as const;
    const current = identityOf(owner.workspace);
    const changed = identityKeys.filter((key) => baseline[key] !== current[key]);
    if (
      changed.length === 1 &&
      changed[0] === "uid" &&
      !baseline.sourceContainer &&
      !current.sourceContainer &&
      state.workspace !== undefined &&
      isLinkedWorktree(state.repoPath)
    ) {
      proveReplacementStopAbsence(state, baseline, { uid: current.uid || undefined });
      return { status: "proven-absent", containers: [] };
    }
  }
  if (owner.status !== "absent")
    return { status: "retained", containers: proveRetainedManagedStop(state) };
  if (baseline.sourceContainer) throw new Error("Absent stop cannot prove a source container.");
  const before = absentRegistrationIdentity(state);
  if (!isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state))
    throw new Error("Retained stop generation changed.");
  if (inspectManagedStopDaemon(baseline.endpoint) !== baseline.daemonId)
    throw new Error("Stop daemon changed.");
  assertManagedStopContainersAbsent(
    baseline.endpoint,
    baseline.containers.map((container) => container.id),
  );
  const uidBytes = Buffer.byteLength(baseline.uid);
  const runnerId = uidBytes === 16 || uidBytes === 40 ? baseline.uid : baseline.providerId;
  if (
    inspectManagedStopContainers(baseline.project, baseline.endpoint).length !== 0 ||
    inspectManagedStopWorkspaceIds(baseline.endpoint, baseline.composeDirectory).length !== 0 ||
    inspectProviderRunnerContainers(baseline.endpoint, runnerId).length !== 0
  )
    throw new Error("Absent stop observed a remaining workspace population.");
  if (
    inspectManagedStopDaemon(baseline.endpoint) !== baseline.daemonId ||
    !isDeepStrictEqual(absentRegistrationIdentity(state), before) ||
    !isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state)
  )
    throw new Error("Absent stop authority changed during inspection.");
  return { status: "proven-absent", containers: [] };
}

/** Caller holds the workspace and provider locks. Every effect claims the current stop fence. */
export function stopFromManagedBaseline(state: ManagedRuntimeState): "retained" | "proven-absent" {
  const proof = proveManagedStop(state);
  if (proof.status === "proven-absent") return proof.status;
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
  return "retained";
}

/** Both protocols are checked because the retained desired set does not encode protocols. */
export function managedStopRouteReferences(state: ManagedRuntimeState) {
  return state.desired.apps.flatMap((name) =>
    (["http", "tcp"] as const).map((protocol) => ({ repoPath: state.repoPath, name, protocol })),
  );
}
