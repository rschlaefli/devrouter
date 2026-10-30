import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertManagedContainerConfigUnchanged,
  inspectManagedDevcontainerConfig,
  inspectManagedDevcontainerGeneratedConfig,
  type ManagedDevcontainerPlan,
  managedComposeEnvironment,
} from "./devcontainer-profile";
import {
  type AppReplacementContainer,
  assertManagedStopContainersAbsent,
  assertNoAppNamespaceConsumers,
  inspectAppReplacementInventory,
  inspectManagedStopContainers,
  inspectManagedStopDaemon,
  inspectManagedStopRunnerId,
  inspectManagedStopWorkspaceIds,
  inspectProviderRunnerContainers,
  resolveManagedStopEndpoint,
  stopPinnedManagedContainer,
} from "./devpod-environment";
import { listDevpodWorkspacesRaw } from "./devpod-registry";
import { requireReadyDevsyAgent } from "./devsy-agent";
import { proveLocalDockerSelection } from "./devsy-exec-proof";
import { inspectDevsyWorkspaceOwnership, listDevsyWorkspaces } from "./devsy-workspaces";
import { proveManagedComposePopulation } from "./managed-compose-population";
import { resolveManagedPostStartPlan } from "./managed-post-start";
import {
  type ManagedRuntimeState,
  readManagedRuntimeState,
  writeManagedRuntimeState,
} from "./managed-runtime-state";
import { type ManagedStopBaseline, validateManagedStopBaseline } from "./managed-stop-baseline";
import type { NetworkProviderBinding } from "./network-provider-binding";
import { inspectNetworkProviderBinding } from "./network-provider-inspect";
import { claimLifecycleEffect } from "./reliability-context";
import { loadRuntimeConfig } from "./repo-config";
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

/** Explicit stop recovery; caller holds the checkout and provider mutation locks. */
export function recoverManagedStopBaseline(
  state: ManagedRuntimeState,
  readPlan: () => ManagedDevcontainerPlan,
  beforePersist: () => void,
): ManagedRuntimeState {
  const baseline = validateManagedStopBaseline(state.stopBaseline, state);
  const plan = readPlan();
  const owner = registration(state);
  if (
    Object.entries(owner).some(
      ([key, value]) => baseline[key as keyof ManagedStopBaseline] !== value,
    ) ||
    baseline.sourceContainer
  )
    throw new Error("Stop recovery requires the unchanged provider registration.");
  const observe = () => {
    if (
      !isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state) ||
      !isDeepStrictEqual(registration(state), owner) ||
      !isDeepStrictEqual(readPlan(), plan) ||
      resolveManagedStopEndpoint() !== baseline.endpoint ||
      inspectManagedStopDaemon(baseline.endpoint) !== baseline.daemonId ||
      listDevpodWorkspacesRaw({ allowMissingExecutable: true }).some(
        (entry) =>
          entry.id === state.devpodId ||
          sameWorkspacePath(entry.source.localFolder, state.repoPath),
      )
    )
      throw new Error("Stop recovery authority changed.");
    const currentOwner = inspectDevsyWorkspaceOwnership(
      listDevsyWorkspaces(),
      state.devpodId,
      state.repoPath,
    );
    if (currentOwner.status !== "owned") throw new Error("Stop recovery owner is unavailable.");
    proveLocalDockerSelection(currentOwner.workspace);
    const containers = inspectManagedStopContainers(baseline.project, baseline.endpoint);
    const missingIds: string[] = [];
    for (const recorded of baseline.containers) {
      const retained = containers.find((container) => container.id === recorded.id);
      if (!retained) {
        missingIds.push(recorded.id);
      } else if (
        !isDeepStrictEqual(
          { ...recorded, mounts: orderedMounts(recorded.mounts) },
          identity(retained),
        )
      ) {
        throw new Error("Stop recovery retained container identity changed.");
      }
    }
    if (missingIds.length > 0) assertManagedStopContainersAbsent(baseline.endpoint, missingIds);
    if (
      !isDeepStrictEqual(
        containers.map((container) => container.labels["com.docker.compose.service"]).sort(),
        [...plan.desiredServices].sort(),
      )
    )
      throw new Error("Stop recovery requires the complete selected service population.");
    const primary = containers.find(
      (container) => container.labels["com.docker.compose.service"] === plan.primaryService,
    );
    if (
      !primary ||
      !isDeepStrictEqual(
        inspectProviderRunnerContainers(
          baseline.endpoint,
          managedRunnerId(baseline.uid, baseline.providerId),
        ).sort(),
        [primary.id],
      )
    )
      throw new Error("Stop recovery provider runner population changed.");
    assertManagedContainerConfigUnchanged({
      plan,
      containers,
      endpoint: baseline.endpoint,
      workspace: state.workspace
        ? {
            token: state.workspace,
            gitCommonDir: resolveGitCommonDir(state.repoPath),
          }
        : undefined,
    });
    if (
      !isDeepStrictEqual(registration(state), owner) ||
      !isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state) ||
      !isDeepStrictEqual(readPlan(), plan) ||
      resolveManagedStopEndpoint() !== baseline.endpoint ||
      inspectManagedStopDaemon(baseline.endpoint) !== baseline.daemonId
    )
      throw new Error("Stop recovery authority changed during configuration inspection.");
    return containers;
  };
  const first = observe();
  const candidate: ManagedRuntimeState = {
    ...state,
    sourceConfigSha256: plan.sourceConfigSha256,
    effectiveConfigSha256: plan.effectiveConfigSha256,
    status: "degraded",
    transitionPhase: "stop-recovery",
    updatedAt: new Date().toISOString(),
    stopBaseline: undefined,
  };
  const primary = first.find(
    (container) => container.labels["com.docker.compose.service"] === plan.primaryService,
  );
  if (!primary) throw new Error("Stop recovery primary is unavailable.");
  candidate.stopBaseline = captureManagedStopBaseline(
    candidate,
    plan,
    primary.id,
    baseline.endpoint,
  );
  if (
    !isDeepStrictEqual(
      first.map(identity).sort((a, b) => compareText(a.id, b.id)),
      observe()
        .map(identity)
        .sort((a, b) => compareText(a.id, b.id)),
    )
  )
    throw new Error("Stop recovery population changed during inspection.");
  beforePersist();
  claimLifecycleEffect();
  writeManagedRuntimeState(candidate);
  return candidate;
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

export type ManagedAppReplacementProof = {
  state: ManagedRuntimeState;
  plan: ManagedDevcontainerPlan;
  primary: AppReplacementContainer;
  binding: NetworkProviderBinding;
  sourceSha256: string;
  digest: string;
};

function replacementSourceDigest(
  state: ManagedRuntimeState,
  plan: ManagedDevcontainerPlan,
): string {
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", state.repoPath, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error)
      throw new Error("Replacement cannot freeze the source checkout.");
    return result.stdout;
  };
  if (
    git(["status", "--porcelain", "--untracked-files=no"]).trim() ||
    git([
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ".devcontainer",
      ".devrouter.yml",
    ]).trim()
  )
    throw new Error("Replacement requires committed, unchanged managed source and hooks.");
  const adapter = resolveManagedPostStartPlan(state.repoPath);
  if (adapter.kind !== "runtime")
    throw new Error("Replacement requires a preserving managed adapter.");
  const files = [
    path.join(state.repoPath, ".devrouter.yml"),
    plan.sourcePath,
    ...plan.composeFiles,
  ];
  return createHash("sha256")
    .update(
      JSON.stringify([
        git(["rev-parse", "HEAD"]).trim(),
        adapter.adapterSha256,
        ...files.map((file) => [
          file,
          createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        ]),
      ]),
    )
    .digest("hex");
}

/** Read-only proof, repeated under the provider lock immediately before the one dispatch. */
export function captureManagedAppReplacementProof(
  state: ManagedRuntimeState,
): ManagedAppReplacementProof {
  if (state.status !== "ready" || requireReadyDevsyAgent().version !== "1.24.0")
    throw new Error("App replacement requires a successful retained generation and Devsy 1.24.0.");
  const baseline = validateManagedStopBaseline(state.stopBaseline, state);
  if (baseline.sourceContainer)
    throw new Error("Replacement refuses a container-sourced provider.");
  const runtime = loadRuntimeConfig(state.repoPath, state.workspace ?? "", state.profile);
  if (!runtime.config.managedRuntime || runtime.config.managedRuntime.network)
    throw new Error("Replacement requires manual managed Compose without network allocation.");
  const plan = inspectManagedDevcontainerConfig({
    repoPath: state.repoPath,
    config: runtime.config,
    profile: runtime.resolvedProfile,
    linked: isLinkedWorktree(state.repoPath),
  });
  if (
    state.sourceConfigSha256 !== plan.sourceConfigSha256 ||
    state.effectiveConfigSha256 !== plan.effectiveConfigSha256 ||
    inspectManagedDevcontainerGeneratedConfig(plan).status !== "valid"
  )
    throw new Error("Replacement refuses changed or unavailable managed configuration.");
  const containers = proveRetainedManagedStop(state);
  if (!baseline.containers.some((c) => c.service !== baseline.primaryService))
    throw new Error(
      "App replacement requires a retained dependency to preserve released-client recovery proof.",
    );
  if (containers.some((c) => c.state.Running || !["created", "exited"].includes(c.state.Status)))
    throw new Error("App replacement requires every retained container stopped.");
  const workspace = state.workspace
    ? { token: state.workspace, gitCommonDir: resolveGitCommonDir(state.repoPath) }
    : undefined;
  assertManagedContainerConfigUnchanged({ plan, containers, workspace });
  const source = replacementSourceDigest(state, plan);
  const evidence = inspectNetworkProviderBinding({
    provider: "devsy",
    providerId: state.devpodId,
    repoPath: state.repoPath,
    endpoint: baseline.endpoint,
    providerContext: baseline.context,
  });
  if (
    !evidence.versionQualified ||
    evidence.registration !== "owned" ||
    evidence.providerName !== "docker" ||
    evidence.dockerPath !== "docker" ||
    evidence.persistedContext !== null ||
    (evidence.persistedEndpoint !== null && evidence.persistedEndpoint !== baseline.endpoint) ||
    evidence.daemonId !== baseline.daemonId
  )
    throw new Error("Replacement provider destination is unqualified or changed.");
  const inventory = inspectAppReplacementInventory(baseline.endpoint);
  const primaryId = baseline.containers.find((c) => c.service === baseline.primaryService)?.id;
  if (!primaryId) throw new Error("Replacement has no exact retained primary.");
  assertNoAppNamespaceConsumers(inventory, primaryId);
  const primary = inventory.find((c) => c.id === primaryId) as AppReplacementContainer;
  const env = managedComposeEnvironment(workspace);
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_HOST;
  const result = spawnSync(
    "docker",
    [
      "--host",
      baseline.endpoint,
      "compose",
      "--project-name",
      baseline.project,
      "--project-directory",
      plan.composeDirectory,
      ...baseline.composeFiles.flatMap((f) => ["-f", f]),
      "config",
      "--format",
      "json",
      "--no-env-resolution",
    ],
    {
      cwd: plan.composeDirectory,
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error)
    throw new Error("Replacement Compose evidence is unavailable.");
  const model = JSON.parse(result.stdout);
  const service = model?.services?.[plan.primaryService];
  if (!service || !Array.isArray(service.volumes))
    throw new Error("Replacement requires declared persistent mounts.");
  for (const mount of primary.mounts) {
    if (!["bind", "volume"].includes(mount.Type))
      throw new Error("Replacement refuses unattributed primary mounts.");
    if (
      mount.Type === "volume" &&
      !service.volumes.some(
        (v: { type?: string; source?: string; target?: string }) =>
          v.type === "volume" &&
          v.source &&
          v.target === mount.Destination &&
          model.volumes?.[v.source]?.name === mount.Name,
      )
    )
      throw new Error("Replacement refuses anonymous or undeclared primary volumes.");
  }
  const binding: NetworkProviderBinding = {
    provider: "devsy",
    providerId: state.devpodId,
    endpoint: baseline.endpoint,
    daemonId: baseline.daemonId,
    definitionSha256: evidence.definitionSha256,
    providerContext: baseline.context,
  };
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        state,
        plan,
        source,
        binding,
        primary,
        population: containers,
        modelSha256: createHash("sha256").update(result.stdout).digest("hex"),
      }),
    )
    .digest("hex");
  return { state, plan, primary, binding, sourceSha256: source, digest };
}

/** Establish a new stop baseline before application checks, retaining dependency and mount identities. */
export function captureReplacedAppStopState(
  proof: ManagedAppReplacementProof,
): ManagedRuntimeState {
  const { state, plan, primary } = proof;
  if (replacementSourceDigest(state, plan) !== proof.sourceSha256)
    throw new Error("Replacement source changed.");
  const baseline = validateManagedStopBaseline(state.stopBaseline, state);
  if (inspectManagedDevcontainerGeneratedConfig(plan).status !== "valid")
    throw new Error("Replacement generated configuration changed after dispatch.");
  const evidence = inspectNetworkProviderBinding({
    provider: "devsy",
    providerId: state.devpodId,
    repoPath: state.repoPath,
    endpoint: baseline.endpoint,
    providerContext: baseline.context,
  });
  if (
    evidence.registration !== "owned" ||
    evidence.providerName !== "docker" ||
    evidence.dockerPath !== "docker" ||
    !evidence.versionQualified ||
    evidence.definitionSha256 !== proof.binding.definitionSha256 ||
    evidence.daemonId !== proof.binding.daemonId ||
    evidence.persistedContext !== null ||
    (evidence.persistedEndpoint !== null && evidence.persistedEndpoint !== proof.binding.endpoint)
  )
    throw new Error("Replacement provider definition or destination changed after dispatch.");
  const containers = inspectManagedStopContainers(baseline.project, baseline.endpoint);
  const next = containers.find(
    (c) => c.labels["com.docker.compose.service"] === baseline.primaryService,
  );
  if (!next || next.id === primary.id)
    throw new Error("Provider did not replace the exact application container.");
  const after = inspectAppReplacementInventory(baseline.endpoint).find((c) => c.id === next.id);
  const mountIdentity = (mounts: AppReplacementContainer["mounts"]) =>
    mounts
      .map((m) => ({ Type: m.Type, Source: m.Source, Destination: m.Destination }))
      .sort((a, b) => compareText(a.Destination, b.Destination));
  if (
    !after ||
    after.image !== primary.image ||
    !isDeepStrictEqual(mountIdentity(after.mounts), mountIdentity(primary.mounts))
  )
    throw new Error("Replacement changed the primary image or persistent mount identities.");
  const deps = (items: typeof baseline.containers) =>
    items
      .filter((c) => c.service !== baseline.primaryService)
      .sort((a, b) => compareText(a.id, b.id));
  if (
    !isDeepStrictEqual(
      deps(containers.map(identity)),
      deps(baseline.containers.map((c) => ({ ...c, mounts: orderedMounts(c.mounts) }))),
    )
  )
    throw new Error("Replacement changed the retained dependency population.");
  const candidate: ManagedRuntimeState = {
    ...state,
    status: "degraded",
    transitionPhase: "app-replacement",
    updatedAt: new Date().toISOString(),
  };
  candidate.stopBaseline = captureManagedStopBaseline(candidate, plan, next.id, baseline.endpoint);
  claimLifecycleEffect();
  writeManagedRuntimeState(candidate);
  return candidate;
}

export type ManagedStopProof =
  | { status: "retained"; containers: ReturnType<typeof proveRetainedManagedStop> }
  | { status: "proven-absent"; containers: [] };

type AbsentStopRegistrationIdentity =
  | {
      kind: "linked";
      record: NonNullable<ReturnType<typeof readWorkspaceOwnership>>;
      gitCommonDir: string;
    }
  | { kind: "primary"; repoPath: string; devpodId: string };

/**
 * Identity evidence for a registration that is already gone. Linked checkouts
 * prove it through their workspace-ownership ledger; a primary checkout has no
 * ledger entry by construction, so its retained state's exact checkout and
 * provider identity are the equivalent evidence. Both still require every
 * registration and workload population for that exact identity to stay absent.
 */
function absentRegistrationIdentity(state: ManagedRuntimeState): AbsentStopRegistrationIdentity {
  resetWorkspaceRuntimeCaches();
  if (resolveWorkspaceRuntimeOrDefault(state.repoPath) !== "devsy")
    throw new Error("Stop provider changed.");
  const linked = isLinkedWorktree(state.repoPath);
  if (linked !== (state.workspace !== undefined))
    throw new Error("Absent stop requires the exact workspace identity.");
  let identity: AbsentStopRegistrationIdentity;
  if (linked) {
    const workspace = state.workspace as string;
    const record = readWorkspaceOwnership(state.repoPath, workspace);
    if (
      !record ||
      record.workspace !== workspace ||
      record.devpodId !== state.devpodId ||
      !sameWorkspacePath(record.worktreePath, state.repoPath) ||
      resolveWorktreeWorkspace(state.repoPath) !== workspace ||
      inspectWorkspaceOwnership(record, listGitWorktrees(state.repoPath), undefined).ownerStatus !==
        "present"
    )
      throw new Error("Absent stop workspace ownership changed.");
    identity = { kind: "linked", record, gitCommonDir: resolveGitCommonDir(state.repoPath) };
  } else {
    identity = { kind: "primary", repoPath: state.repoPath, devpodId: state.devpodId };
  }
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
  return identity;
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
    if (resolveManagedStopEndpoint() !== baseline.endpoint)
      throw new Error("Stop endpoint changed.");
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

/**
 * An external prune or teardown can remove every managed workload while the
 * Devsy registration survives. The retained proof cannot accept the resulting
 * population and no proof may adopt replacements, so an unchanged registration
 * settles only through repeated positive absence of the exact baselined
 * containers, the checkout's container population and the provider runner.
 */
function proveAbsentPopulationStop(
  state: ManagedRuntimeState,
  baseline: ManagedStopBaseline,
  expected: ReturnType<typeof identityOf>,
): void {
  const observation = () => {
    const owner = inspectDevsyWorkspaceOwnership(
      listDevsyWorkspaces(),
      state.devpodId,
      state.repoPath,
    );
    if (owner.status !== "owned")
      throw new Error("Absent stop registration changed during inspection.");
    const current = identityOf(owner.workspace);
    if (!isDeepStrictEqual(current, expected))
      throw new Error("Absent stop registration identity changed during inspection.");
    if (resolveManagedStopEndpoint() !== baseline.endpoint)
      throw new Error("Stop endpoint changed.");
    if (inspectManagedStopDaemon(baseline.endpoint) !== baseline.daemonId)
      throw new Error("Stop daemon changed.");
    proveLocalDockerSelection(owner.workspace);
    return current;
  };
  const assertAbsentPopulation = () => {
    assertManagedStopContainersAbsent(
      baseline.endpoint,
      baseline.containers.map((container) => container.id),
    );
    if (
      inspectManagedStopContainers(baseline.project, baseline.endpoint).length !== 0 ||
      inspectManagedStopWorkspaceIds(baseline.endpoint, baseline.composeDirectory).length !== 0 ||
      inspectProviderRunnerContainers(
        baseline.endpoint,
        managedRunnerId(baseline.uid, baseline.providerId),
      ).length !== 0
    )
      throw new Error("Absent stop observed a remaining workspace population.");
  };
  const before = observation();
  if (!isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state))
    throw new Error("Retained stop generation changed.");
  assertAbsentPopulation();
  const after = observation();
  if (
    !isDeepStrictEqual(after, before) ||
    !isDeepStrictEqual(readManagedRuntimeState(state.repoPath, state.workspace), state)
  )
    throw new Error("Absent stop authority changed during inspection.");
  assertAbsentPopulation();
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
    // An unchanged registration whose whole population is gone is the prune
    // case, not a replacement: prove absence before the retained proof demands
    // the containers a prune already deleted. Primary checkouts qualify here as
    // well, because the proof below still requires the exact registration,
    // Compose project, Compose directory and provider-runner populations to be
    // empty on the saved daemon.
    if (
      changed.length === 0 &&
      inspectManagedStopContainers(baseline.project, baseline.endpoint).length === 0
    ) {
      proveAbsentPopulationStop(state, baseline, current);
      return { status: "proven-absent", containers: [] };
    }
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
