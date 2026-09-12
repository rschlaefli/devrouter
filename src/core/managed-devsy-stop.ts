import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertManagedContainerConfigUnchanged,
  inspectManagedDevcontainerConfig,
  inspectManagedDevcontainerGeneratedConfig,
  stopExactManagedService,
} from "./devcontainer-profile";
import {
  assertManagedStopCheckoutAbsent,
  inspectManagedStopContainers,
  inspectManagedStopDaemon,
  inspectManagedStopRunnerId,
  inspectManagedStopWorkspaceIds,
  inspectProviderRunnerContainers,
  inspectWorkspaceContainers,
  type ManagedStopContainerSnapshot,
  resolveManagedStopEndpoint,
  stopPinnedManagedContainer,
  supportsManagedStopBaseline,
} from "./devpod-environment";
import { devpodRegistryRoot, listDevpodWorkspacesRaw } from "./devpod-registry";
import { proveLocalDockerSelection } from "./devsy-exec-proof";
import {
  inspectDevsyRuntimeAbsence,
  inspectDevsyRuntimeStatus,
  inspectDevsyWorkspaceOwnership,
  listDevsyWorkspaces,
} from "./devsy-workspaces";
import { listHostRouteState } from "./host-routes";
import { proveManagedComposePopulation } from "./managed-compose-population";
import { readManagedRuntimeState } from "./managed-runtime-state";
import { stopFromManagedBaseline } from "./managed-stop-recovery";
import { claimLifecycleEffect } from "./reliability-context";
import { reliabilityFence } from "./reliability-contract";
import { readReliabilityOperation } from "./reliability-operation-store";
import { loadRepoConfig, loadRuntimeConfig, resolveProfile } from "./repo-config";
import { proxyAppsFromConfig } from "./route-publication";
import { assertTraefikRoutesRemoved } from "./traefik-route-health";
import { isLinkedWorktree, resolveWorktreeWorkspace, sameWorkspacePath } from "./workspace";
import {
  inspectWorkspaceOwnership,
  listGitWorktrees,
  readWorkspaceOwnership,
  resolveGitCommonDir,
} from "./workspace-ownership";
import { resetWorkspaceRuntimeCaches, resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

function sameSet(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function containerIdentity(container: ManagedStopContainerSnapshot): string {
  return JSON.stringify({
    id: container.id,
    labels: container.labels,
    // Docker does not preserve mount-array order between inspections.
    mounts: container.mounts.map((mount) => JSON.stringify(mount)).sort(),
  });
}

/** Called under workspace and provider locks; the receipt must survive final settlement. */
export function proveInitialManagedDevsyAbsence(repoPath: string, expectedId?: string) {
  if (!isLinkedWorktree(repoPath)) return undefined;
  const workspace = resolveWorktreeWorkspace(repoPath);
  if (!workspace || readManagedRuntimeState(repoPath, workspace)) return undefined;
  if (!fs.existsSync(path.join(repoPath, ".devrouter.yml"))) return undefined;
  const runtime = loadRuntimeConfig(repoPath, workspace);
  if (!runtime.config.managedRuntime) return undefined;
  const routes = proxyAppsFromConfig(runtime.config).flatMap((app) =>
    (["http", "tcp"] as const).map((protocol) => ({ repoPath, name: app.name, protocol })),
  );
  const record = readWorkspaceOwnership(repoPath, workspace);
  if (
    !record ||
    (expectedId !== undefined && record.devpodId !== expectedId) ||
    record.workspace !== workspace ||
    !sameWorkspacePath(record.worktreePath, repoPath)
  )
    throw new Error("Initial managed stop requires exact linked ownership.");
  const devsyId = record.devpodId;
  const ownership = inspectDevsyWorkspaceOwnership(listDevsyWorkspaces(), devsyId, repoPath);
  if (ownership.status === "conflict") throw new Error(ownership.reason);
  if (ownership.status !== "absent") return undefined;
  const gitCommonDir = resolveGitCommonDir(repoPath);
  const endpoint = resolveManagedStopEndpoint();
  if (!supportsManagedStopBaseline(endpoint))
    throw new Error("Initial managed stop requires a local Docker endpoint.");
  const daemon = inspectManagedStopDaemon(endpoint);
  const legacyHome = devpodRegistryRoot();
  const readLegacy = () =>
    listDevpodWorkspacesRaw({ readLocalWhenMissing: true })
      .map(({ id, source }) => ({ id, source: { localFolder: source.localFolder } }))
      .sort(
        (a, b) =>
          a.id.localeCompare(b.id) || a.source.localFolder.localeCompare(b.source.localFolder),
      );
  const legacyWorkspaces = readLegacy();
  const observe = () => {
    resetWorkspaceRuntimeCaches();
    if (
      resolveWorkspaceRuntimeOrDefault(repoPath) !== "devsy" ||
      !isLinkedWorktree(repoPath) ||
      resolveWorktreeWorkspace(repoPath) !== workspace ||
      resolveGitCommonDir(repoPath) !== gitCommonDir ||
      !isDeepStrictEqual(readWorkspaceOwnership(repoPath, workspace), record) ||
      inspectWorkspaceOwnership(record, listGitWorktrees(repoPath), undefined).ownerStatus !==
        "present" ||
      readManagedRuntimeState(repoPath, workspace)
    )
      throw new Error("Initial managed stop ownership or retained state changed.");
    if (devpodRegistryRoot() !== legacyHome || !isDeepStrictEqual(readLegacy(), legacyWorkspaces))
      throw new Error("Initial managed stop legacy registry evidence changed.");
    if (
      inspectDevsyWorkspaceOwnership(listDevsyWorkspaces(), devsyId, repoPath).status !==
        "absent" ||
      legacyWorkspaces.some(
        (entry) =>
          entry.id === devsyId ||
          (entry.source.localFolder !== "" &&
            sameWorkspacePath(entry.source.localFolder, repoPath)),
      )
    )
      throw new Error("Initial managed stop requires both provider registrations absent.");
    if (!inspectDevsyRuntimeAbsence(devsyId))
      throw new Error("Initial managed stop requires positive runtime not-found.");
    if (resolveManagedStopEndpoint() !== endpoint || inspectManagedStopDaemon(endpoint) !== daemon)
      throw new Error("Initial managed stop Docker identity changed.");
    if (inspectProviderRunnerContainers(endpoint, devsyId).length)
      throw new Error("Initial managed stop observed a remaining provider runner.");
    assertManagedStopCheckoutAbsent(endpoint, repoPath);
    if (listHostRouteState().some((route) => sameWorkspacePath(route.repoPath, repoPath)))
      throw new Error("Initial managed stop observed remaining workspace routes.");
    assertTraefikRoutesRemoved(routes);
    if (resolveManagedStopEndpoint() !== endpoint || inspectManagedStopDaemon(endpoint) !== daemon)
      throw new Error("Initial managed stop Docker identity changed.");
  };
  observe();
  observe();
  return {
    workspace,
    record,
    gitCommonDir,
    endpoint,
    daemon,
    routes,
    legacyHome,
    legacyWorkspaces,
  };
}

/** Recover a complete initial Compose population using the interrupted ensure's profile. */
function stopInitialManagedDevsyWorkspace(repoPath: string, devsyId: string): boolean {
  if (!fs.existsSync(path.join(repoPath, ".devrouter.yml"))) return false;
  if (!loadRepoConfig(repoPath).managedRuntime) return false;
  const linked = isLinkedWorktree(repoPath);
  const workspace = linked ? resolveWorktreeWorkspace(repoPath) : undefined;
  const identity = { repoPath, workspace: workspace ?? null, provider: "devsy" as const };
  // Stop clears active selection, but the current ensure history retains its
  // profile. Journal counters may advance as this stop claims its own effects.
  const readAuthority = () => {
    const record = readReliabilityOperation(identity);
    const operation = record?.state.operation;
    const entries = record?.state.operationHistory.filter((entry) => entry.id === operation?.id);
    const entry = entries?.[0];
    if (
      !record ||
      !isDeepStrictEqual(record.identity, identity) ||
      record.worker ||
      !operation ||
      operation.kind !== "ensure" ||
      !operation.drained ||
      !["COMPLETED", "INTERRUPTED", "COMPLETION_UNKNOWN"].includes(operation.status) ||
      record.state.phase !== "stopping" ||
      record.state.desired !== "stopped-by-user" ||
      entries?.length !== 1 ||
      !entry ||
      entry.kind !== "ensure" ||
      !entry.profile ||
      !entry.drained ||
      entry.status !== operation.status
    )
      throw new Error("Initial managed stop requires the drained ensure's recorded profile.");
    return {
      identity: record.identity,
      fence: reliabilityFence(record.state),
      operation,
      entry,
    };
  };
  const authority = readAuthority();
  const gitCommonDir = linked ? resolveGitCommonDir(repoPath) : undefined;
  const workspaceEnv = workspace && gitCommonDir ? { token: workspace, gitCommonDir } : undefined;
  // The journal records the raw ensure selection, which may combine, reorder or
  // duplicate profile names. Only the canonical name identifies the managed
  // selection, so resolve it through the config resolver against the current
  // profiles; a removed or renamed name refuses instead of widening selection.
  function canonicalProfile(recorded: string): string {
    return resolveProfile(loadRepoConfig(repoPath), recorded).name;
  }
  const registration = () => {
    resetWorkspaceRuntimeCaches();
    if (resolveWorkspaceRuntimeOrDefault(repoPath) !== "devsy")
      throw new Error("Initial managed stop provider selection changed.");
    const owner = inspectDevsyWorkspaceOwnership(listDevsyWorkspaces(), devsyId, repoPath);
    if (owner.status !== "owned")
      throw new Error("Initial managed stop requires one exact Devsy registration.");
    if (linked) {
      const record = workspace ? readWorkspaceOwnership(repoPath, workspace) : undefined;
      if (
        !record ||
        record.devpodId !== devsyId ||
        !sameWorkspacePath(record.worktreePath, repoPath) ||
        resolveWorktreeWorkspace(repoPath) !== workspace ||
        resolveGitCommonDir(repoPath) !== gitCommonDir ||
        inspectWorkspaceOwnership(record, listGitWorktrees(repoPath), undefined).ownerStatus !==
          "present"
      )
        throw new Error("Initial managed stop workspace ownership changed.");
    }
    return owner.workspace;
  };
  const canonicalName = canonicalProfile(authority.entry.profile);
  const runtime = loadRuntimeConfig(repoPath, workspace ?? "", canonicalName);
  if (!runtime.config.managedRuntime || runtime.profile !== canonicalName)
    throw new Error("Initial managed stop requires the recorded managed profile.");
  const owner = registration();
  proveLocalDockerSelection(owner);
  const endpoint = resolveManagedStopEndpoint();
  if (!supportsManagedStopBaseline(endpoint))
    throw new Error("Initial managed stop requires a pinned local Docker endpoint.");
  const daemon = inspectManagedStopDaemon(endpoint);
  if (
    !owner.context ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(owner.context) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(devsyId)
  )
    throw new Error("Initial managed stop requires exact provider context.");
  const plan = inspectManagedDevcontainerConfig({
    repoPath,
    config: runtime.config,
    profile: runtime.resolvedProfile,
    linked,
  });
  const providerRoot = path.resolve(process.env.DEVSY_HOME || path.join(os.homedir(), ".devsy"));
  const featureDirectory = path.join(
    providerRoot,
    "contexts",
    owner.context,
    "workspaces",
    devsyId,
    "agent",
    ".docker-compose",
  );
  const observe = () => {
    if (
      !isDeepStrictEqual(readAuthority(), authority) ||
      !isDeepStrictEqual(registration(), owner) ||
      readManagedRuntimeState(repoPath, workspace) ||
      resolveManagedStopEndpoint() !== endpoint ||
      inspectManagedStopDaemon(endpoint) !== daemon
    )
      throw new Error("Initial managed stop authority or runtime state changed.");
    proveLocalDockerSelection(owner);
    if (
      listDevpodWorkspacesRaw({ readLocalWhenMissing: true }).some(
        (entry) =>
          entry.id === devsyId ||
          (entry.source.localFolder !== "" &&
            sameWorkspacePath(entry.source.localFolder, repoPath)),
      )
    )
      throw new Error("Initial managed stop found conflicting provider ownership.");
    // Re-resolve to reject removed profile names; the comparison defensively
    // asserts canonical identity. Resource dimensions are compared below.
    if (canonicalProfile(authority.entry.profile) !== canonicalName)
      throw new Error("Initial managed stop configuration changed.");
    const currentRuntime = loadRuntimeConfig(repoPath, workspace ?? "", canonicalName);
    const currentPlan = inspectManagedDevcontainerConfig({
      repoPath,
      config: currentRuntime.config,
      profile: currentRuntime.resolvedProfile,
      linked,
    });
    if (
      currentRuntime.profile !== canonicalName ||
      !isDeepStrictEqual(currentRuntime.resolvedProfile, runtime.resolvedProfile) ||
      !isDeepStrictEqual(currentPlan, plan) ||
      inspectManagedDevcontainerGeneratedConfig(currentPlan).status !== "valid"
    )
      throw new Error("Initial managed stop configuration changed.");
    const matches = inspectWorkspaceContainers().filter((c) =>
      sameWorkspacePath(
        c.labels["com.docker.compose.project.working_dir"] ?? "",
        plan.composeDirectory,
      ),
    );
    if (!matches.length)
      throw new Error("Initial managed stop requires its complete selected population.");
    const projects = new Set(matches.map((c) => c.labels["com.docker.compose.project"]));
    if (projects.size !== 1 || !matches[0]?.labels["com.docker.compose.project"])
      throw new Error("Initial managed stop requires one exact Compose project.");
    const population = inspectManagedStopContainers(
      matches[0].labels["com.docker.compose.project"],
      endpoint,
    );
    if (
      !sameSet(
        inspectManagedStopWorkspaceIds(endpoint, plan.composeDirectory),
        population.map((c) => c.id),
      ) ||
      !sameSet(
        matches.map((c) => c.id),
        population.map((c) => c.id),
      )
    )
      throw new Error("Initial managed stop population changed.");
    if (
      !sameSet(
        population.map((c) => c.labels["com.docker.compose.service"] ?? ""),
        plan.desiredServices,
      )
    )
      throw new Error("Initial managed stop requires its complete selected population.");
    const primary = proveManagedComposePopulation({
      plan,
      repoPath,
      composeProject: matches[0].labels["com.docker.compose.project"],
      providerRoot,
      featureDirectory,
      containers: population,
    });
    const uidBytes = Buffer.byteLength(owner.uid ?? "");
    const runnerId = (uidBytes === 16 || uidBytes === 40 ? owner.uid : undefined) ?? devsyId;
    if (
      (owner.source.container && owner.source.container !== primary.id) ||
      (!owner.source.container && inspectManagedStopRunnerId(endpoint, primary.id) !== runnerId)
    )
      throw new Error("Initial managed stop provider-to-container binding changed.");
    if (
      !owner.source.container &&
      !sameSet(inspectProviderRunnerContainers(endpoint, runnerId), [primary.id])
    )
      throw new Error("Initial managed stop provider runner population changed.");
    assertManagedContainerConfigUnchanged({
      plan,
      containers: population,
      workspace: workspaceEnv,
    });
    if (
      !isDeepStrictEqual(readAuthority(), authority) ||
      !isDeepStrictEqual(registration(), owner) ||
      resolveManagedStopEndpoint() !== endpoint ||
      inspectManagedStopDaemon(endpoint) !== daemon
    )
      throw new Error("Initial managed stop authority changed during inspection.");
    return population;
  };
  const initial = observe();
  const stopped = new Set(initial.filter((c) => !c.state.Running).map((c) => c.id));
  const stable = () => {
    const current = observe();
    if (
      !sameSet(
        initial.map((c) => c.id),
        current.map((c) => c.id),
      ) ||
      current.some((c) => {
        const prior = initial.find((p) => p.id === c.id);
        return (
          !prior ||
          containerIdentity(prior) !== containerIdentity(c) ||
          (stopped.has(c.id) && c.state.Running)
        );
      })
    )
      throw new Error("Initial managed stop population or identity changed.");
    for (const c of current) if (!c.state.Running) stopped.add(c.id);
    return current;
  };
  stable();
  for (const container of initial) {
    const current = stable().find((c) => c.id === container.id);
    if (current?.state.Running) {
      claimLifecycleEffect();
      stopPinnedManagedContainer(endpoint, current.id);
      if (stable().find((c) => c.id === current.id)?.state.Running)
        throw new Error("Initial managed stop container cessation is not proven.");
    }
  }
  if (stable().some((c) => c.state.Running))
    throw new Error("Initial managed stop left a workload running.");
  return true;
}

/** Called only while the canonical caller holds the workspace and provider locks. */
export function stopRetainedManagedDevsyWorkspace(options: {
  repoPath: string;
  devsyId: string;
  stopProvider: () => void;
}): boolean | "proven-absent" {
  const { repoPath, devsyId } = options;
  const linked = isLinkedWorktree(repoPath);
  const workspace = linked ? resolveWorktreeWorkspace(repoPath) : undefined;
  const retainedState = readManagedRuntimeState(repoPath, workspace);
  if (!retainedState) {
    if (proveInitialManagedDevsyAbsence(repoPath, devsyId)) return "proven-absent";
    return stopInitialManagedDevsyWorkspace(repoPath, devsyId);
  }
  const state = retainedState;
  if (state.devpodId !== devsyId || (linked && !workspace)) {
    throw new Error("Managed stop requires the exact retained workspace identity.");
  }
  if (state.stopBaseline) {
    return stopFromManagedBaseline(state) === "proven-absent" ? "proven-absent" : true;
  }
  const workspaceEnv = workspace
    ? { token: workspace, gitCommonDir: resolveGitCommonDir(repoPath) }
    : undefined;

  function registration() {
    resetWorkspaceRuntimeCaches();
    if (resolveWorkspaceRuntimeOrDefault(repoPath) !== "devsy") {
      throw new Error("Managed stop provider selection changed.");
    }
    const owner = inspectDevsyWorkspaceOwnership(listDevsyWorkspaces(), devsyId, repoPath);
    if (owner.status !== "owned") {
      throw new Error("Managed stop requires one exact retained Devsy registration.");
    }
    if (workspace) {
      const record = readWorkspaceOwnership(repoPath, workspace);
      if (
        !record ||
        record.devpodId !== devsyId ||
        !sameWorkspacePath(record.worktreePath, repoPath) ||
        resolveWorktreeWorkspace(repoPath) !== workspace ||
        resolveGitCommonDir(repoPath) !== workspaceEnv?.gitCommonDir
      ) {
        throw new Error("Managed stop workspace ownership changed.");
      }
    }
    return owner.workspace;
  }

  function registrationStatus() {
    resetWorkspaceRuntimeCaches();
    if (resolveWorkspaceRuntimeOrDefault(repoPath) !== "devsy") {
      throw new Error("Managed stop provider selection changed.");
    }
    return inspectDevsyWorkspaceOwnership(listDevsyWorkspaces(), devsyId, repoPath);
  }

  /**
   * A guard-ordered `stop --delete` or an external teardown may have removed the
   * Devsy registration while every workload is positively gone. Stop is then
   * symmetric to the baseline absence proof: two stable observations of an
   * absent registration in both provider registries, a not-found Devsy runtime,
   * and empty workload populations settle the stop without the registration
   * precondition. Nothing is mutated; routes are freed by the caller.
   */
  function proveAbsentRegistrationStop(): void {
    const observe = () => {
      const owner = registrationStatus();
      if (owner.status === "conflict") throw new Error(owner.reason);
      if (owner.status !== "absent") {
        throw new Error("Managed stop absence proof requires the registration to remain absent.");
      }
      if (
        listDevpodWorkspacesRaw({ allowMissingExecutable: true }).some(
          (entry) => entry.id === devsyId || sameWorkspacePath(entry.source.localFolder, repoPath),
        )
      ) {
        throw new Error(
          "Managed stop absence proof requires both provider registrations to remain absent.",
        );
      }
      if (!inspectDevsyRuntimeAbsence(devsyId)) {
        throw new Error(
          "Managed stop absence proof requires Devsy to report the runtime not-found.",
        );
      }
      if (inspectManagedStopContainers(state.composeProject).length !== 0) {
        throw new Error("Managed stop absence proof observed a remaining compose population.");
      }
      if (inspectProviderRunnerContainers(resolveManagedStopEndpoint(), devsyId).length !== 0) {
        throw new Error("Managed stop absence proof observed a remaining runner population.");
      }
      const owned = inspectWorkspaceContainers().filter((container) =>
        sameWorkspacePath(
          container.labels["com.docker.compose.project.working_dir"] ?? "",
          path.join(repoPath, ".devcontainer"),
        ),
      );
      if (owned.length !== 0) {
        throw new Error("Managed stop absence proof observed a remaining workspace container.");
      }
      if (workspace) {
        const record = readWorkspaceOwnership(repoPath, workspace);
        if (
          !record ||
          record.devpodId !== devsyId ||
          !sameWorkspacePath(record.worktreePath, repoPath) ||
          resolveWorktreeWorkspace(repoPath) !== workspace ||
          resolveGitCommonDir(repoPath) !== workspaceEnv?.gitCommonDir ||
          inspectWorkspaceOwnership(record, listGitWorktrees(repoPath), undefined).ownerStatus !==
            "present"
        ) {
          throw new Error("Managed stop workspace ownership changed during absence proof.");
        }
      }
      if (!isDeepStrictEqual(readManagedRuntimeState(repoPath, workspace), state)) {
        throw new Error("Managed stop retained state changed during absence proof.");
      }
    };
    observe();
    observe();
  }

  const initialOwner = registrationStatus();
  if (initialOwner.status === "conflict") throw new Error(initialOwner.reason);
  if (initialOwner.status === "absent") {
    proveAbsentRegistrationStop();
    return "proven-absent";
  }
  const context = registration().context;
  if (
    !context ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(context) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(devsyId)
  ) {
    throw new Error("Managed stop requires a valid exact Devsy context and workspace ID.");
  }
  const devsyRoot = path.resolve(process.env.DEVSY_HOME || path.join(os.homedir(), ".devsy"));
  const featureDirectory = path.join(
    devsyRoot,
    "contexts",
    context,
    "workspaces",
    devsyId,
    "agent",
    ".docker-compose",
  );

  function prove(previous?: ManagedStopContainerSnapshot[]) {
    if (
      registration().context !== context ||
      JSON.stringify(readManagedRuntimeState(repoPath, workspace)) !== JSON.stringify(state)
    ) {
      throw new Error("Managed stop retained context or runtime record changed.");
    }
    const runtime = loadRuntimeConfig(repoPath, workspace ?? "", state.profile);
    const managed = runtime.config.managedRuntime;
    if (!managed || runtime.profile !== state.profile || runtime.workspace !== workspace) {
      throw new Error("Managed stop requires the recorded managed profile.");
    }
    const plan = inspectManagedDevcontainerConfig({
      repoPath,
      config: runtime.config,
      profile: runtime.resolvedProfile,
      linked,
    });
    const selectedProcesses = runtime.resolvedProfile?.processes;
    const processes =
      !runtime.resolvedProfile || (selectedProcesses?.length === 1 && selectedProcesses[0] === "*")
        ? managed.processes
        : (selectedProcesses ?? []);
    if (
      state.sourceConfigSha256 !== plan.sourceConfigSha256 ||
      state.effectiveConfigSha256 !== plan.effectiveConfigSha256 ||
      !sameSet(
        state.desired.apps,
        proxyAppsFromConfig(runtime.config).map((app) => app.name),
      ) ||
      !sameSet(state.desired.services, plan.desiredProfileServices) ||
      !sameSet(state.desired.processes, processes) ||
      inspectManagedDevcontainerGeneratedConfig(plan).status !== "valid"
    ) {
      throw new Error("Managed stop requires unchanged recorded resources and configuration.");
    }
    const containers = inspectManagedStopContainers(state.composeProject);
    const primary = proveManagedComposePopulation({
      plan,
      repoPath,
      composeProject: state.composeProject,
      featureDirectory,
      providerRoot: devsyRoot,
      containers,
    });
    if (
      previous &&
      (!sameSet(
        previous.map((c) => c.id),
        containers.map((c) => c.id),
      ) ||
        containers.some((container) => {
          const retained = previous.find((entry) => entry.id === container.id);
          return (
            !retained ||
            containerIdentity(retained) !== containerIdentity(container) ||
            (!retained.state.Running && container.state.Running)
          );
        }))
    ) {
      throw new Error("Managed stop container identity or quiescent state changed.");
    }
    if (registration().context !== context) {
      throw new Error("Managed stop provider context changed during inspection.");
    }
    const status = inspectDevsyRuntimeStatus(devsyId);
    if (
      (status !== "running" && status !== "stopped") ||
      (status === "running") !== primary.state.Running
    ) {
      throw new Error("Managed stop requires consistent provider and primary container state.");
    }
    return { containers, primary, status };
  }

  const initial = prove();
  let providerError: unknown;
  let providerFailed = false;
  if (initial.status === "running") {
    try {
      options.stopProvider();
    } catch (error) {
      providerFailed = true;
      providerError = error;
    }
  }

  try {
    const stopped = () => {
      const current = prove(initial.containers);
      if (current.status !== "stopped" || current.primary.state.Running) {
        throw new Error("Managed stop has not stopped the exact primary container.");
      }
      return current.containers;
    };
    stopped();
    for (const retained of initial.containers) {
      if (!retained.state.Running || retained.id === initial.primary.id) continue;
      const current = stopped().find((entry) => entry.id === retained.id);
      if (current?.state.Running) {
        stopExactManagedService(current.id, current.labels["com.docker.compose.service"] ?? "", {
          timeoutMs: 30_000,
        });
      }
    }
    if (stopped().some((container) => container.state.Running)) {
      throw new Error("Managed stop left a retained service running.");
    }
  } catch (error) {
    if (providerFailed) {
      throw new AggregateError(
        [providerError, error],
        "Devsy provider stop failed; complete retained shutdown could not be verified.",
        { cause: providerError },
      );
    }
    throw error;
  }
  if (providerFailed) throw providerError;
  return true;
}
