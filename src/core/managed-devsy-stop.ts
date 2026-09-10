import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  inspectManagedDevcontainerConfig,
  inspectManagedDevcontainerGeneratedConfig,
  stopExactManagedService,
} from "./devcontainer-profile";
import {
  inspectManagedStopContainers,
  inspectProviderRunnerContainers,
  inspectWorkspaceContainers,
  type ManagedStopContainerSnapshot,
  resolveManagedStopEndpoint,
} from "./devpod-environment";
import { listDevpodWorkspacesRaw } from "./devpod-registry";
import {
  inspectDevsyRuntimeAbsence,
  inspectDevsyRuntimeStatus,
  inspectDevsyWorkspaceOwnership,
  listDevsyWorkspaces,
} from "./devsy-workspaces";
import { proveManagedComposePopulation } from "./managed-compose-population";
import { readManagedRuntimeState } from "./managed-runtime-state";
import { stopFromManagedBaseline } from "./managed-stop-recovery";
import { loadRuntimeConfig } from "./repo-config";
import { proxyAppsFromConfig } from "./route-publication";
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
  if (!retainedState) return false;
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
