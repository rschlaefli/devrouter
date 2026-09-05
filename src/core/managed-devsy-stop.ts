import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertManagedContainerConfigUnchanged,
  inspectManagedDevcontainerConfig,
  inspectManagedDevcontainerGeneratedConfig,
  stopExactManagedService,
} from "./devcontainer-profile";
import {
  inspectManagedStopContainers,
  type ManagedStopContainerSnapshot,
} from "./devpod-environment";
import {
  inspectDevsyRuntimeStatus,
  inspectDevsyWorkspaceOwnership,
  listDevsyWorkspaces,
} from "./devsy-workspaces";
import { readManagedRuntimeState } from "./managed-runtime-state";
import { loadRuntimeConfig } from "./repo-config";
import { proxyAppsFromConfig } from "./route-publication";
import { isLinkedWorktree, resolveWorktreeWorkspace, sameWorkspacePath } from "./workspace";
import { readWorkspaceOwnership, resolveGitCommonDir } from "./workspace-ownership";
import { resetWorkspaceRuntimeCaches, resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

function sameSet(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function containerIdentity(container: ManagedStopContainerSnapshot): string {
  return JSON.stringify({ id: container.id, labels: container.labels, mounts: container.mounts });
}

/** Called only while the canonical caller holds the workspace and provider locks. */
export function stopRetainedManagedDevsyWorkspace(options: {
  repoPath: string;
  devsyId: string;
  stopProvider: () => void;
}): boolean {
  const { repoPath, devsyId } = options;
  const linked = isLinkedWorktree(repoPath);
  const workspace = linked ? resolveWorktreeWorkspace(repoPath) : undefined;
  const retainedState = readManagedRuntimeState(repoPath, workspace);
  if (!retainedState) return false;
  const state = retainedState;
  if (state.devpodId !== devsyId || (linked && !workspace)) {
    throw new Error("Managed stop requires the exact retained workspace identity.");
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
    const services = new Set<string>();
    for (const container of containers) {
      const service = container.labels["com.docker.compose.service"] ?? "";
      if (
        !plan.nativeRunServices.includes(service) ||
        services.has(service) ||
        container.labels["com.docker.compose.project"] !== state.composeProject ||
        !sameWorkspacePath(
          container.labels["com.docker.compose.project.working_dir"] ?? "",
          plan.composeDirectory,
        )
      ) {
        throw new Error("Managed stop found unexpected or duplicate project membership.");
      }
      services.add(service);
      const files = (container.labels["com.docker.compose.project.config_files"] ?? "")
        .split(",")
        .map((file) => file.trim());
      if (
        files.some((file) => !file || !path.isAbsolute(file)) ||
        new Set(files.map((file) => path.resolve(file))).size !== files.length ||
        files.length < plan.composeFiles.length ||
        plan.composeFiles.some((file, index) => !sameWorkspacePath(file, files[index]))
      ) {
        throw new Error("Managed stop Compose file identity changed.");
      }
      for (const file of files.slice(plan.composeFiles.length)) {
        if (
          path.dirname(file) !== featureDirectory ||
          !/^docker-compose\.devcontainer\.containerFeatures-[a-zA-Z0-9_-]+\.yml$/.test(
            path.basename(file),
          ) ||
          fs.realpathSync(file) !==
            path.join(fs.realpathSync(devsyRoot), path.relative(devsyRoot, file))
        ) {
          throw new Error("Managed stop refuses a foreign or escaped provider Compose file.");
        }
      }
      if (previous) {
        const retained = previous.find((entry) => entry.id === container.id);
        if (
          !retained ||
          containerIdentity(retained) !== containerIdentity(container) ||
          (!retained.state.Running && container.state.Running)
        ) {
          throw new Error("Managed stop container identity or quiescent state changed.");
        }
      }
    }
    if (
      plan.desiredServices.some((service) => !services.has(service)) ||
      (previous &&
        !sameSet(
          previous.map((c) => c.id),
          containers.map((c) => c.id),
        ))
    ) {
      throw new Error("Managed stop cannot prove the complete retained service population.");
    }
    const primary = containers.find(
      (c) => c.labels["com.docker.compose.service"] === plan.primaryService,
    );
    if (
      primary?.mounts.filter(
        (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, repoPath),
      ).length !== 1
    ) {
      throw new Error("Managed stop cannot prove the exact primary workspace mount.");
    }
    assertManagedContainerConfigUnchanged({ plan, containers, workspace: workspaceEnv });
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
