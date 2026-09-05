import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  DevrouterConfig,
  DevrouterProxyApp,
  HostRouteState,
  ManagedRuntimeStatus,
} from "../types";
import {
  assertManagedContainerConfigUnchanged,
  inspectManagedDevcontainerConfig,
  inspectManagedDevcontainerGeneratedConfig,
  type ManagedDevcontainerPlan,
  removeManagedDevcontainerConfig,
  startExactManagedServices,
  stopExactManagedService,
  writeManagedDevcontainerConfig,
} from "./devcontainer-profile";
import {
  hasExactComposeIdentity,
  inspectWorkspaceContainers,
  type WorkspaceContainerSnapshot,
  workspaceAppContainers,
} from "./devpod-environment";
import { DevpodStartPostconditionError, startDevpodWorkspace } from "./devpod-mutation";
import { listDevpodWorkspaces, selectDevpodWorkspace } from "./devpod-workspaces";
import { createStderrWaitReporter, withFileLock } from "./file-lock";
import {
  type HostRouteInput,
  listHostRouteState,
  parseUpstream,
  replaceHostRoutesForRepo,
} from "./host-routes";
import { httpRouteUrl, probeHttpRoute } from "./http-route-probe";
import {
  type ManagedPostStartPlan,
  resolveManagedPostStartPlan,
  runManagedPostStart,
  runManagedProcessAction,
} from "./managed-post-start";
import {
  type ManagedRuntimeState,
  markManagedRuntimeDegraded,
  readManagedRuntimeState,
  writeManagedRuntimeState,
} from "./managed-runtime-state";
import { collectManagedRuntimeStatus } from "./managed-runtime-status";
import { loadRuntimeConfig, resolveRepoPath } from "./repo-config";
import { proxyAppsFromConfig, replacePublishedProxyRoutes } from "./route-publication";
import { DEVNET_NAME, DEVROUTER_HOME, TCP_PROTOCOL_REGISTRY } from "./router";
import {
  ensureTraefikRoutesLoaded,
  ensureTraefikRoutesMatch,
  ensureTraefikRoutesRemoved,
} from "./traefik-route-health";
import {
  comparableWorkspacePath,
  currentBranch,
  isLinkedWorktree,
  readPersistedWorkspace,
  sameWorkspacePath,
  withWorkspaceLifecycleLock,
  wsFromBranch,
} from "./workspace";
import {
  claimWorkspaceIdentity,
  listMissingWorkspaceOwnership,
  readWorkspaceOwnership,
  resolveGitCommonDir,
} from "./workspace-ownership";
import {
  getWorkspaceRegistrySnapshots,
  resetWorkspaceRuntimeCaches,
  resolveWorkspaceRuntimeOrDefault,
} from "./workspace-runtime";

const DEVCONTAINER_OVERLAY = "docker-compose.devrouter.yml";
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

export type WorkspaceEnsureResult = {
  kind: "primary" | "linked";
  repoPath: string;
  workspace?: string;
  profile: string;
  devpodId: string;
  urls: string[];
  recreated: boolean;
  tlsRefreshed: boolean;
  managedRuntime?: ManagedRuntimeStatus;
};

type EnvironmentTarget =
  | {
      kind: "linked";
      workspace: string;
      devpodId: string;
      hadExactDevpod: boolean;
      gitCommonDir: string;
    }
  | {
      kind: "primary";
      workspace?: undefined;
      devpodId?: string;
      hadExactDevpod: boolean;
    };

type ValidatedWorkspaceContainer = {
  id: string;
  workspacePath: string;
};

type ManagedTransitionPhase =
  | "validation"
  | "service-start"
  | "process-start"
  | "service-stop"
  | "route-publication"
  | "rollback";

type WorkspaceEnsureOptions = {
  open?: boolean;
  quiet?: boolean;
  profile?: string;
  repair?: boolean;
  containerTimeoutMs?: number;
  httpTimeoutMs?: number;
};

function assertOverlay(container: WorkspaceContainerSnapshot, repoPath: string): void {
  const workingDir = container.labels["com.docker.compose.project.working_dir"];
  if (!workingDir || !sameWorkspacePath(workingDir, path.join(repoPath, ".devcontainer"))) {
    throw new Error(`Container '${container.id}' does not belong to the exact worktree.`);
  }

  const configFiles = (container.labels["com.docker.compose.project.config_files"] ?? "")
    .split(",")
    .filter(Boolean);
  const expectedOverlay = path.join(repoPath, ".devcontainer", DEVCONTAINER_OVERLAY);
  if (!configFiles.some((configFile) => sameWorkspacePath(configFile, expectedOverlay))) {
    throw new Error(`Container '${container.id}' was not started with ${DEVCONTAINER_OVERLAY}.`);
  }
}

function assertReady(container: WorkspaceContainerSnapshot, label: string): void {
  if (!container.state.Running) {
    throw new Error(`${label} container '${container.id}' is not running.`);
  }
  const health = container.state.Health?.Status;
  if (health && health !== "healthy") {
    throw new Error(`${label} container '${container.id}' is not healthy (${health}).`);
  }
}

function exactWorkspaceServiceContainers(
  containers: WorkspaceContainerSnapshot[],
  repoPath: string,
  composeProject: string,
  service: string,
  composeFiles?: string[],
): WorkspaceContainerSnapshot[] {
  return containers.filter((container) =>
    hasExactComposeIdentity(container, {
      repoPath,
      composeProject,
      service,
      composeFiles,
    }),
  );
}

function resolveComposeProject(
  containers: WorkspaceContainerSnapshot[],
  repoPath: string,
  appContainerId: string,
  primaryService: string,
  composeFiles: string[],
): string {
  const app = containers.find((candidate) => candidate.id === appContainerId);
  if (!app) {
    throw new Error(
      `Workspace app container '${appContainerId}' disappeared during reconciliation.`,
    );
  }
  if (
    !hasExactComposeIdentity(app, {
      repoPath,
      service: primaryService,
      composeFiles,
    })
  ) {
    throw new Error(`Workspace app container '${appContainerId}' has an unexpected Compose model.`);
  }
  const project = app.labels["com.docker.compose.project"];
  if (!project) {
    throw new Error(`Workspace app container '${appContainerId}' has no Compose project label.`);
  }
  return project;
}

async function waitForManagedServices(
  plan: ManagedDevcontainerPlan,
  repoPath: string,
  composeProject: string,
  expectedServices: string[],
  expectedAppId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const containers = inspectWorkspaceContainers();
      for (const service of expectedServices) {
        const matches = exactWorkspaceServiceContainers(
          containers,
          repoPath,
          composeProject,
          service,
          plan.composeFiles,
        );
        if (matches.length !== 1) {
          throw new Error(
            `Managed service '${service}' must have exactly one exact workspace container; found ${matches.length}.`,
          );
        }
        if (service === plan.primaryService && matches[0].id !== expectedAppId) {
          throw new Error(
            `Managed primary service '${service}' changed container identity during profile transition.`,
          );
        }
        assertReady(matches[0], `Managed service '${service}'`);
      }
      return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() < deadline) await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function stopDroppedManagedServices(
  plan: ManagedDevcontainerPlan,
  repoPath: string,
  composeProject: string,
): void {
  const desired = new Set(plan.desiredProfileServices);
  const containers = inspectWorkspaceContainers();
  for (const service of plan.profileServices) {
    if (desired.has(service)) continue;
    const matches = exactWorkspaceServiceContainers(
      containers,
      repoPath,
      composeProject,
      service,
      plan.composeFiles,
    );
    if (matches.length > 1) {
      throw new Error(
        `Managed service '${service}' has multiple exact workspace containers; refusing to stop any.`,
      );
    }
    const match = matches[0];
    if (match?.state.Running) stopExactManagedService(match.id, service);
  }
}

function assertDroppedManagedServicesStopped(
  plan: ManagedDevcontainerPlan,
  repoPath: string,
  composeProject: string,
): void {
  const desired = new Set(plan.desiredProfileServices);
  const containers = inspectWorkspaceContainers();
  for (const service of plan.profileServices) {
    if (desired.has(service)) continue;
    const matches = exactWorkspaceServiceContainers(
      containers,
      repoPath,
      composeProject,
      service,
      plan.composeFiles,
    );
    if (matches.some((match) => match.state.Running)) {
      throw new Error(`Managed service '${service}' remains running after exact stop.`);
    }
  }
}

function routeInputFromState(route: HostRouteState): HostRouteInput {
  return {
    name: route.name,
    host: route.host,
    protocol: route.protocol,
    tcpProtocol: route.tcpProtocol,
    repoPath: route.repoPath,
    port: route.port,
    mode: route.mode,
    upstreamHost: route.upstreamHost,
    pid: route.pid,
    command: route.command,
    workspace: route.workspace,
  };
}

function routeReferenceKey(route: HostRouteInput): string {
  return `${route.repoPath}\u0000${route.name}\u0000${route.protocol ?? "http"}`;
}

function removedRoutesForReplacement(
  previousRoutes: HostRouteInput[],
  nextRoutes: HostRouteInput[],
): HostRouteInput[] {
  const nextKeys = new Set(nextRoutes.map(routeReferenceKey));
  return previousRoutes.filter((route) => !nextKeys.has(routeReferenceKey(route)));
}

function isWildcard(values: string[] | undefined): boolean {
  return values?.length === 1 && values[0] === "*";
}

function desiredManagedProcesses(
  managedRuntime: NonNullable<ReturnType<typeof loadRuntimeConfig>["config"]["managedRuntime"]>,
  profile: ReturnType<typeof loadRuntimeConfig>["resolvedProfile"],
): string[] {
  if (!profile || isWildcard(profile.processes)) return [...managedRuntime.processes];
  return [...(profile.processes ?? [])];
}

function restorePreviousManagedConfig(options: {
  repoPath: string;
  config: DevrouterConfig;
  linked: boolean;
  previousState: ManagedRuntimeState;
}): void {
  const restoredPlan = inspectManagedDevcontainerConfig({
    repoPath: options.repoPath,
    config: options.config,
    profile: {
      apps: [],
      devcontainerServices: [...options.previousState.desired.services],
    },
    linked: options.linked,
  });
  if (restoredPlan.effectiveConfigSha256 !== options.previousState.effectiveConfigSha256) {
    throw new Error(
      "The previous managed Dev Container configuration fingerprint no longer matches the current source.",
    );
  }
  writeManagedDevcontainerConfig(restoredPlan);
}

function restoreFirstTransitionManagedConfig(options: {
  repoPath: string;
  config: DevrouterConfig;
  linked: boolean;
  services: string[];
}): void {
  const restoredPlan = inspectManagedDevcontainerConfig({
    repoPath: options.repoPath,
    config: options.config,
    profile: {
      apps: [],
      devcontainerServices: [...options.services],
    },
    linked: options.linked,
  });
  writeManagedDevcontainerConfig(restoredPlan);
}

type FirstTransitionBaseline = {
  services: string[];
  processes: string[];
};

function isWarmWorkspaceActive(repoPath: string): boolean {
  try {
    return workspaceAppContainers(inspectWorkspaceContainers(), repoPath).some(
      (container) => container.state.Running,
    );
  } catch {
    // Warm-start detection must fail closed: when Docker state cannot be read,
    // proceed as if the workspace were warm so the fingerprint gate below can
    // report the concrete failure instead of silently assuming a cold start.
    return true;
  }
}

function hasExactManagedComposeProject(repoPath: string, state: ManagedRuntimeState): boolean {
  try {
    return inspectWorkspaceContainers({
      composeProject: state.composeProject,
    }).some((container) => {
      const workingDir = container.labels["com.docker.compose.project.working_dir"];
      return Boolean(
        workingDir && sameWorkspacePath(workingDir, path.join(repoPath, ".devcontainer")),
      );
    });
  } catch {
    // State recovery must fail closed when Docker cannot prove that the
    // previous exact Compose project has disappeared.
    return true;
  }
}

// Before the first managed mutation on an already-running native workspace,
// prove which optional services and process markers are actually active. That
// observed set is the only honest rollback baseline when no successful managed
// state exists; a stopped or absent workspace has nothing to lose and keeps the
// empty rollback set.
function captureFirstTransitionBaseline(options: {
  repoPath: string;
  plan: ManagedDevcontainerPlan;
  processes: string[];
}): FirstTransitionBaseline | undefined {
  const containers = inspectWorkspaceContainers();
  const runningPrimary = workspaceAppContainers(containers, options.repoPath).filter(
    (container) => container.state.Running,
  );
  if (runningPrimary.length === 0) return undefined;
  if (runningPrimary.length > 1) {
    throw new Error(
      "Cannot start the first managed transition while multiple workspace app containers are running.",
    );
  }
  const primary = runningPrimary[0];
  const composeProject = primary.labels["com.docker.compose.project"];
  const workspacePath = primary.mounts.find(
    (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, options.repoPath),
  )?.Destination;
  if (!composeProject || !workspacePath) {
    throw new Error(
      "Cannot prove the exact pre-transition Compose identity for the first managed transition.",
    );
  }
  const services = options.plan.profileServices.filter((service) =>
    containers.some(
      (container) =>
        container.state.Running &&
        hasExactComposeIdentity(container, { repoPath: options.repoPath, service, composeProject }),
    ),
  );
  const activeProcesses: string[] = [];
  for (const process of options.processes) {
    const status = runManagedProcessAction({
      container: { id: primary.id, workspacePath },
      name: process,
      action: "status",
      quiet: true,
    });
    if (status === "running") activeProcesses.push(process);
  }
  return {
    services,
    processes: activeProcesses,
  };
}

export function validateWorkspaceContainers(
  containers: WorkspaceContainerSnapshot[],
  options: {
    repoPath: string;
    upstreamHosts: string[];
    target: EnvironmentTarget;
    allowStopped?: boolean;
  },
): ValidatedWorkspaceContainer {
  const appContainers = workspaceAppContainers(containers, options.repoPath);
  if (appContainers.length !== 1) {
    throw new Error(
      `Expected exactly one container mounted from '${options.repoPath}', found ${appContainers.length}.`,
    );
  }
  const appContainer = appContainers[0];
  if (options.target.kind === "linked") {
    assertOverlay(appContainer, options.repoPath);
  }
  if (!options.allowStopped) assertReady(appContainer, "Workspace app");
  if (options.target.kind === "linked") {
    const gitCommonDir = options.target.gitCommonDir;
    const gitMount = appContainer.mounts.find(
      (mount) =>
        mount.Type === "bind" &&
        sameWorkspacePath(mount.Source, gitCommonDir) &&
        sameWorkspacePath(mount.Destination, gitCommonDir),
    );
    if (!gitMount) {
      throw new Error(
        `Workspace app container does not mount Git common directory '${gitCommonDir}'.`,
      );
    }
  }

  const devnetHosts = Array.from(new Set(options.upstreamHosts));
  for (const host of devnetHosts) {
    const matches = containers.filter(
      (container) =>
        container.state.Running && container.networks[DEVNET_NAME]?.Aliases?.includes(host),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Workspace upstream '${host}' must resolve to exactly one running container; found ${matches.length}.`,
      );
    }
    if (options.target.kind === "linked") {
      assertOverlay(matches[0], options.repoPath);
    }
    assertReady(matches[0], `Workspace upstream '${host}'`);
  }

  const repoMount = appContainer.mounts.find(
    (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, options.repoPath),
  );
  if (!repoMount) {
    throw new Error(`Workspace app container no longer mounts '${options.repoPath}'.`);
  }
  return { id: appContainer.id, workspacePath: repoMount.Destination };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContainerPreflight(
  repoPath: string,
  target: EnvironmentTarget,
  upstreamHosts: string[],
  timeoutMs: number,
): Promise<ValidatedWorkspaceContainer> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const appContainer = validateWorkspaceContainers(inspectWorkspaceContainers(), {
        repoPath,
        upstreamHosts,
        target,
      });
      if (target.kind === "linked") {
        const workspaceEnv = spawnSync(
          "docker",
          ["exec", appContainer.id, "printenv", "WORKSPACE"],
          { encoding: "utf-8" },
        );
        if (workspaceEnv.status !== 0 || workspaceEnv.stdout.trim() !== target.workspace) {
          throw new Error(
            `Workspace app container must expose WORKSPACE='${target.workspace}' (got '${workspaceEnv.stdout.trim() || "(empty)"}').`,
          );
        }
        const devrouterWorkspaceEnv = spawnSync(
          "docker",
          ["exec", appContainer.id, "printenv", "DEVROUTER_WORKSPACE"],
          { encoding: "utf-8" },
        );
        if (
          devrouterWorkspaceEnv.status !== 0 ||
          devrouterWorkspaceEnv.stdout.trim() !== target.workspace
        ) {
          throw new Error(
            `Workspace app container must expose DEVROUTER_WORKSPACE='${target.workspace}'.`,
          );
        }
      }
      const gitCheck = spawnSync(
        "docker",
        [
          "exec",
          appContainer.id,
          "git",
          "-C",
          appContainer.workspacePath,
          "rev-parse",
          "--show-toplevel",
        ],
        { encoding: "utf-8" },
      );
      if (
        gitCheck.status !== 0 ||
        !sameWorkspacePath(gitCheck.stdout.trim(), appContainer.workspacePath)
      ) {
        throw new Error("Git does not resolve the expected checkout inside the app container.");
      }
      return appContainer;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
    }
  } while (Date.now() < deadline);

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForHttpRoutes(
  repoPath: string,
  apps: DevrouterProxyApp[],
  timeoutMs: number,
): Promise<void> {
  const pending = new Map(
    apps.filter((app) => app.protocol === "http").map((app) => [app.name, app] as const),
  );
  const failures = new Map<string, string>();
  const deadline = Date.now() + timeoutMs;

  do {
    for (const [name, app] of pending) {
      const result = probeHttpRoute(app.host, { repoPath });
      if (result.ok) {
        pending.delete(name);
        failures.delete(name);
      } else {
        failures.set(name, result.details);
      }
    }
    if (pending.size === 0) {
      return;
    }
    if (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
    }
  } while (Date.now() < deadline);

  throw new Error(
    `HTTP route readiness timed out: ${Array.from(pending.keys())
      .map((name) => `${name} (${failures.get(name) ?? "not reachable"})`)
      .join(", ")}`,
  );
}

function resolveLinkedTarget(repoPath: string): EnvironmentTarget {
  const snapshots = getWorkspaceRegistrySnapshots();
  const providerWorkspaces = [
    ...(snapshots.devpod ?? []),
    ...(snapshots.devsy?.map((workspace) => ({
      id: workspace.id,
      source: workspace.source,
      ...(workspace.lastUsed ? { lastUsed: workspace.lastUsed } : {}),
      ...(workspace.lastUsedMalformed ? { lastUsedMalformed: true } : {}),
    })) ?? []),
  ];
  const branch = currentBranch(repoPath);
  const claim = claimWorkspaceIdentity(repoPath, {
    source: branch ?? repoPath,
    branch: branch ?? null,
    providerWorkspaces,
    unavailableRuntimes: snapshots.unavailable,
  });
  const existingDevpod = providerWorkspaces.find(
    (workspace) =>
      workspace.id === claim.devpodId && sameWorkspacePath(workspace.source.localFolder, repoPath),
  );
  return {
    kind: "linked",
    workspace: claim.workspace,
    devpodId: claim.devpodId,
    hadExactDevpod: Boolean(existingDevpod),
    gitCommonDir: resolveGitCommonDir(repoPath),
  };
}

function resolveRepairTarget(repoPath: string, linked: boolean): EnvironmentTarget {
  const workspace = linked ? readPersistedWorkspace(repoPath) : undefined;
  if (linked && !workspace) throw new Error("Repair requires an existing workspace identity.");
  const state = readManagedRuntimeState(repoPath, workspace);
  if (state?.status !== "degraded") {
    throw new Error("Repair requires a persisted degraded managed runtime.");
  }
  resetWorkspaceRuntimeCaches();
  const snapshots = getWorkspaceRegistrySnapshots();
  if (snapshots.unavailable.length) throw new Error("Repair cannot read every provider registry.");
  const matches = [...(snapshots.devpod ?? []), ...(snapshots.devsy ?? [])].filter(
    (entry) => entry.id === state.devpodId || sameWorkspacePath(entry.source.localFolder, repoPath),
  );
  if (
    matches.length !== 1 ||
    matches[0].id !== state.devpodId ||
    !sameWorkspacePath(matches[0].source.localFolder, repoPath)
  ) {
    throw new Error("Repair requires one exact retained provider registration.");
  }
  const selected = snapshots[resolveWorkspaceRuntimeOrDefault(repoPath)] ?? [];
  if (
    !selected.some(
      (entry) =>
        entry.id === state.devpodId && sameWorkspacePath(entry.source.localFolder, repoPath),
    )
  ) {
    throw new Error("Repair provider selection does not own the retained workspace.");
  }
  if (workspace) {
    const owner = readWorkspaceOwnership(repoPath, workspace);
    if (
      !owner ||
      owner.devpodId !== state.devpodId ||
      !sameWorkspacePath(owner.worktreePath, repoPath)
    ) {
      throw new Error("Repair requires the existing exact workspace owner record.");
    }
    return {
      kind: "linked",
      workspace,
      devpodId: state.devpodId,
      hadExactDevpod: true,
      gitCommonDir: resolveGitCommonDir(repoPath),
    };
  }
  return { kind: "primary", devpodId: state.devpodId, hadExactDevpod: true };
}

function assertRepairBaseline(options: {
  repoPath: string;
  target: EnvironmentTarget;
  state: ManagedRuntimeState;
  plan: ManagedDevcontainerPlan;
  config: DevrouterConfig;
  profile: string;
  processes: string[];
  routes: HostRouteState[];
  workspace?: { token: string; gitCommonDir: string };
}): WorkspaceContainerSnapshot[] {
  const { repoPath, target, state, plan, config, profile, processes } = options;
  const desired = {
    apps: proxyAppsFromConfig(config).map((app) => app.name),
    services: plan.desiredProfileServices,
    processes,
  };
  if (
    state.profile !== profile ||
    state.sourceConfigSha256 !== plan.sourceConfigSha256 ||
    state.effectiveConfigSha256 !== plan.effectiveConfigSha256 ||
    Object.keys(desired).some((key) => {
      const resource = key as keyof typeof desired;
      return (
        JSON.stringify([...desired[resource]].sort()) !==
        JSON.stringify([...state.desired[resource]].sort())
      );
    }) ||
    inspectManagedDevcontainerGeneratedConfig(plan).status !== "valid"
  ) {
    throw new Error(
      "Repair requires the recorded profile, resource sets, and unchanged managed configuration.",
    );
  }
  if (
    options.routes.some(
      (route) => route.workspace !== target.workspace || !desired.apps.includes(route.name),
    )
  ) {
    throw new Error("Repair refuses unexpected active routes.");
  }
  const containers = inspectWorkspaceContainers();
  const retained = plan.desiredServices.map((service) => {
    const matches = exactWorkspaceServiceContainers(
      containers,
      repoPath,
      state.composeProject,
      service,
      plan.composeFiles,
    );
    if (matches.length !== 1)
      throw new Error(`Repair requires one retained container for '${service}'.`);
    return matches[0];
  });
  const primary = retained.find(
    (c) => c.labels["com.docker.compose.service"] === plan.primaryService,
  );
  if (!primary) throw new Error("Repair cannot identify the retained primary container.");
  if (
    !primary.state.Running &&
    (options.routes.length > 0 ||
      containers.some(
        (container) =>
          container.labels["com.docker.compose.project"] === state.composeProject &&
          container.state.Running !== false,
      ))
  ) {
    throw new Error(
      "Repair of a stopped primary requires all exact project containers stopped and no checkout routes.",
    );
  }
  validateWorkspaceContainers(containers, {
    repoPath,
    target,
    upstreamHosts: [],
    allowStopped: !primary.state.Running,
  });
  for (const container of containers) {
    if (container.labels["com.docker.compose.project"] !== state.composeProject) continue;
    const service = container.labels["com.docker.compose.service"] ?? "";
    if (
      typeof container.state.Running !== "boolean" ||
      !hasExactComposeIdentity(container, {
        repoPath,
        service,
        composeProject: state.composeProject,
        composeFiles: plan.composeFiles,
      }) ||
      (container.state.Running && !plan.desiredServices.includes(service))
    ) {
      throw new Error("Repair refuses foreign or unexpected active Compose resources.");
    }
  }
  const workspacePath = primary.mounts.find(
    (m) => m.Type === "bind" && sameWorkspacePath(m.Source, repoPath),
  )?.Destination;
  if (!workspacePath) throw new Error("Repair cannot prove the primary workspace mount.");
  for (const name of primary.state.Running ? (config.managedRuntime?.processes ?? []) : []) {
    if (
      !processes.includes(name) &&
      runManagedProcessAction({
        container: { id: primary.id, workspacePath },
        name,
        action: "status",
        quiet: true,
      }) !== "stopped"
    ) {
      throw new Error(`Repair refuses unexpected or unproven process '${name}'.`);
    }
  }
  assertManagedContainerConfigUnchanged({
    plan,
    containers: retained,
    workspace: options.workspace,
  });
  return retained;
}

function assertRetainedRepairContainers(
  repoPath: string,
  plan: ManagedDevcontainerPlan,
  retained: WorkspaceContainerSnapshot[],
): void {
  const current = inspectWorkspaceContainers();
  for (const previous of retained) {
    const service = previous.labels["com.docker.compose.service"] ?? "";
    const matches = exactWorkspaceServiceContainers(
      current,
      repoPath,
      previous.labels["com.docker.compose.project"] ?? "",
      service,
      plan.composeFiles,
    );
    if (matches.length !== 1 || matches[0].id !== previous.id) {
      throw new Error(`Repair lost retained container identity for '${service}'.`);
    }
  }
}

function resolvePrimaryTarget(repoPath: string): EnvironmentTarget {
  const existingDevpod = selectDevpodWorkspace(listDevpodWorkspaces(repoPath), repoPath);
  return {
    kind: "primary",
    devpodId: existingDevpod?.id,
    hadExactDevpod: Boolean(existingDevpod),
  };
}

function isPrimaryCheckout(repoPath: string): boolean {
  try {
    return fs.statSync(path.join(repoPath, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function openUrls(urls: string[]): void {
  for (const url of urls) {
    const opened = spawnSync("open", [url], { encoding: "utf-8" });
    if (opened.status !== 0) {
      process.stderr.write(`Warning: could not open '${url}'.\n`);
    }
  }
}

export async function workspaceEnsure(
  requestedRepoPath?: string,
  options: WorkspaceEnsureOptions = {},
): Promise<WorkspaceEnsureResult> {
  const repoPath = comparableWorkspacePath(resolveRepoPath(requestedRepoPath));
  const linked = isLinkedWorktree(repoPath);
  if (!linked && !isPrimaryCheckout(repoPath)) {
    throw new Error(
      `workspace ensure requires a primary or linked Git checkout (got '${repoPath}').`,
    );
  }
  if (linked) {
    const missingOwners = listMissingWorkspaceOwnership(repoPath);
    if (missingOwners.length > 0) {
      process.stderr.write(
        `Warning: ${missingOwners.length} managed workspace owner${missingOwners.length === 1 ? " is" : "s are"} missing. Review: dev workspace gc --repo ${repoPath}\n`,
      );
    }
  }

  const ensureLocked = async (): Promise<WorkspaceEnsureResult> => {
    let repairMutationStarted = false;
    let retainedRepairContainers: WorkspaceContainerSnapshot[] = [];
    let environmentStarted = false;
    let managedPlan: ManagedDevcontainerPlan | undefined;
    let previousManagedState: ManagedRuntimeState | undefined;
    let managedComposeProject: string | undefined;
    let managedContainer: ValidatedWorkspaceContainer | undefined;
    let previousRoutes: HostRouteState[] = [];
    let candidateRoutes: HostRouteInput[] = [];
    let candidateRoutesPublished = false;
    let transitionPhase: ManagedTransitionPhase = "validation";
    let managedProcessRegistry: string[] = [];
    let managedPostStartPlan: ManagedPostStartPlan | undefined;
    let managedRuntimeConfig: DevrouterConfig | undefined;
    let managedConfigWritten = false;
    let managedWorkspaceEnv: { token: string; gitCommonDir: string } | undefined;
    let firstTransitionBaseline: FirstTransitionBaseline | undefined;
    const routeLoadOptions = {
      initialTimeoutMs: Math.min(options.httpTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS, 3_000),
      recoveryTimeoutMs: Math.min(options.httpTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS, 10_000),
      ...(options.repair ? { allowRestart: false } : {}),
    };
    try {
      const target = options.repair
        ? resolveRepairTarget(repoPath, linked)
        : linked
          ? resolveLinkedTarget(repoPath)
          : resolvePrimaryTarget(repoPath);
      let devpodId = target.devpodId;
      if (target.kind === "linked") {
        const overlayPath = path.join(repoPath, ".devcontainer", DEVCONTAINER_OVERLAY);
        if (!fs.existsSync(overlayPath)) {
          throw new Error(`Missing required DevPod compose overlay: ${overlayPath}`);
        }
      }
      const managedPostStart = resolveManagedPostStartPlan(repoPath);
      managedPostStartPlan = managedPostStart;

      if (options.repair)
        previousManagedState = readManagedRuntimeState(repoPath, target.workspace);
      const runtime = loadRuntimeConfig(
        repoPath,
        target.kind === "primary" ? "" : target.workspace,
        options.profile ?? (options.repair ? previousManagedState?.profile : undefined),
      );
      const managedRuntime = runtime.config.managedRuntime;
      if (options.repair && !managedRuntime)
        throw new Error("Repair requires managedRuntime configuration.");
      previousRoutes = listHostRouteState().filter((route) =>
        sameWorkspacePath(route.repoPath, repoPath),
      );
      managedRuntimeConfig = managedRuntime ? runtime.config : undefined;
      managedProcessRegistry = managedRuntime?.processes ?? [];
      const desiredProcesses = managedRuntime
        ? desiredManagedProcesses(managedRuntime, runtime.resolvedProfile)
        : [];
      if (managedRuntime) {
        previousManagedState = readManagedRuntimeState(repoPath, target.workspace);
        if (
          !options.repair &&
          previousManagedState &&
          !hasExactManagedComposeProject(repoPath, previousManagedState)
        ) {
          previousManagedState = undefined;
        }
        if (!options.repair && previousManagedState?.status === "degraded") {
          throw new Error(
            "Managed runtime state is degraded; refusing a new profile transition until drift is repaired. Inspect status, then use ensure --repair for the recorded profile.",
          );
        }
        if (previousManagedState && previousManagedState.devpodId !== target.devpodId) {
          throw new Error(
            `Managed runtime state names DevPod '${previousManagedState.devpodId}', not the exact target '${target.devpodId ?? "(absent)"}'.`,
          );
        }
        if (
          previousManagedState?.desired.services.some(
            (service) => !managedRuntime.devcontainer.profileServices.includes(service),
          )
        ) {
          throw new Error("Managed runtime state contains an unregistered profile service.");
        }
        if (
          previousManagedState?.desired.processes.some(
            (process) => !managedRuntime.processes.includes(process),
          )
        ) {
          throw new Error("Managed runtime state contains an unregistered process marker.");
        }
        if (managedPostStart.kind !== "runtime") {
          throw new Error(
            "managedRuntime requires the runtime managed post-start adapter for exact process reconciliation.",
          );
        }
        managedPlan = inspectManagedDevcontainerConfig({
          repoPath,
          config: runtime.config,
          profile: runtime.resolvedProfile,
          linked: target.kind === "linked",
        });
        managedWorkspaceEnv =
          target.kind === "linked"
            ? { token: target.workspace, gitCommonDir: target.gitCommonDir }
            : undefined;
        if (
          previousManagedState &&
          isWarmWorkspaceActive(repoPath) &&
          previousManagedState.sourceConfigSha256 !== managedPlan.sourceConfigSha256
        ) {
          throw new Error(
            `Managed Dev Container source configuration changed since the last successful transition; a warm ensure cannot apply it to the existing runtime for '${repoPath}'. Stop and delete the exact runtime, then run ensure again to recreate it from the current source configuration.`,
          );
        }
        if (!previousManagedState) {
          firstTransitionBaseline = captureFirstTransitionBaseline({
            repoPath,
            plan: managedPlan,
            processes: managedRuntime.processes,
          });
        }
      }
      const apps = proxyAppsFromConfig(runtime.config);
      const parsedUpstreams = apps.map((app) => parseUpstream(app.upstream));
      const aliasPrefix =
        target.kind === "linked"
          ? target.workspace
          : (wsFromBranch(runtime.config.project?.name ?? path.basename(repoPath)) ?? "app");
      for (const [index, app] of apps.entries()) {
        if (!parsedUpstreams[index].host.startsWith(`${aliasPrefix}-`)) {
          const owner = target.kind === "linked" ? "workspace" : "checkout";
          throw new Error(
            `Proxy app '${app.name}' must use a ${owner}-owned upstream beginning with '${aliasPrefix}-'.`,
          );
        }
      }
      if (options.repair && managedPlan && previousManagedState) {
        retainedRepairContainers = assertRepairBaseline({
          repoPath,
          target,
          state: previousManagedState,
          plan: managedPlan,
          config: runtime.config,
          profile: runtime.profile,
          processes: desiredProcesses,
          routes: previousRoutes,
          workspace: managedWorkspaceEnv,
        });
      }
      if (managedPlan && !options.repair) {
        writeManagedDevcontainerConfig(managedPlan);
        managedConfigWritten = true;
      }
      const upstreamHosts = parsedUpstreams.map((upstream) => upstream.host);
      const currentTarget = (): EnvironmentTarget =>
        target.kind === "linked" ? target : { ...target, devpodId };

      const startAndProveAttachment = async (recreate = false): Promise<void> => {
        const requestedTarget = currentTarget();
        try {
          devpodId = await startDevpodWorkspace({
            repoPath,
            devpodId: requestedTarget.devpodId,
            devcontainerPath: managedPlan?.generatedRelativePath,
            recreate,
            quiet: options.quiet,
            ...(requestedTarget.kind === "linked"
              ? {
                  workspace: {
                    token: requestedTarget.workspace,
                    gitCommonDir: requestedTarget.gitCommonDir,
                  },
                }
              : {}),
          });
          environmentStarted = true;
        } catch (error) {
          if (error instanceof DevpodStartPostconditionError) environmentStarted = true;
          throw error;
        }
      };
      const preflight = (timeoutMs: number): Promise<ValidatedWorkspaceContainer> =>
        waitForContainerPreflight(repoPath, currentTarget(), upstreamHosts, timeoutMs);
      const recreateAndPreflight = async (): Promise<ValidatedWorkspaceContainer> => {
        await startAndProveAttachment(true);
        return preflight(options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
      };

      let recreated = false;
      let container: ValidatedWorkspaceContainer | undefined;
      try {
        if (!options.repair) await startAndProveAttachment();
      } catch (error) {
        if (managedPlan || !target.hadExactDevpod) {
          throw error;
        }
        container = await recreateAndPreflight();
        recreated = true;
      }
      if (!container) {
        try {
          if (options.repair && managedPlan && previousManagedState) {
            assertRetainedRepairContainers(repoPath, managedPlan, retainedRepairContainers);
            const primaryService = managedPlan.primaryService;
            const primary = retainedRepairContainers.find(
              (entry) => entry.labels["com.docker.compose.service"] === primaryService,
            );
            if (!primary) throw new Error("Repair lost its retained primary container.");
            const stopped = retainedRepairContainers.filter((entry) => !entry.state.Running);
            for (const entry of stopped) {
              if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.id))
                throw new Error("Repair found an invalid retained container ID.");
            }
            if (stopped.length > 0) {
              repairMutationStarted = true;
              transitionPhase = "service-start";
              const result = spawnSync("docker", ["start", ...stopped.map((entry) => entry.id)], {
                encoding: "utf-8",
                timeout: DEFAULT_READINESS_TIMEOUT_MS,
                stdio: options.quiet ? ["ignore", 2, "inherit"] : "inherit",
              });
              if (result.status !== 0)
                throw new Error("Could not start retained repair containers.");
              assertRetainedRepairContainers(repoPath, managedPlan, retainedRepairContainers);
            }
            await waitForManagedServices(
              managedPlan,
              repoPath,
              previousManagedState.composeProject,
              managedPlan.desiredServices,
              primary.id,
              options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
            );
          }
          container = options.repair
            ? await waitForContainerPreflight(
                repoPath,
                currentTarget(),
                [],
                options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
              )
            : await preflight(0);
        } catch (error) {
          if (managedPlan || !target.hadExactDevpod) {
            throw error;
          }
          container = await recreateAndPreflight();
          recreated = true;
        }
      }
      managedContainer = container;
      if (managedPlan) {
        transitionPhase = "service-start";
        const initialContainers = inspectWorkspaceContainers();
        managedComposeProject = resolveComposeProject(
          initialContainers,
          repoPath,
          container.id,
          managedPlan.primaryService,
          managedPlan.composeFiles,
        );
        if (previousManagedState && previousManagedState.composeProject !== managedComposeProject) {
          throw new Error(
            `Managed runtime state names Compose project '${previousManagedState.composeProject}', not '${managedComposeProject}'.`,
          );
        }

        const missingServices: string[] = [];
        for (const service of managedPlan.desiredServices) {
          const matches = exactWorkspaceServiceContainers(
            initialContainers,
            repoPath,
            managedComposeProject,
            service,
            managedPlan.composeFiles,
          );
          if (matches.length > 1) {
            throw new Error(
              `Managed service '${service}' has multiple exact workspace containers; refusing to reconcile it.`,
            );
          }
          if (!matches[0]?.state.Running) missingServices.push(service);
        }
        if (options.repair) {
          assertRetainedRepairContainers(repoPath, managedPlan, retainedRepairContainers);
          repairMutationStarted = true;
        }
        if (!options.repair)
          startExactManagedServices({
            plan: managedPlan,
            composeProject: managedComposeProject,
            services: missingServices,
            quiet: options.quiet,
            workspace: managedWorkspaceEnv,
          });
        await waitForManagedServices(
          managedPlan,
          repoPath,
          managedComposeProject,
          managedPlan.desiredServices,
          container.id,
          options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        );
        container = await preflight(options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
        managedContainer = container;
      }

      if (options.repair && managedPlan)
        assertRetainedRepairContainers(repoPath, managedPlan, retainedRepairContainers);
      transitionPhase = "process-start";
      runManagedPostStart({
        plan: managedPostStart,
        container,
        quiet: options.quiet,
        profile: runtime.profile,
        ...(managedPlan ? { processes: desiredProcesses } : {}),
      });

      if (managedPlan && managedComposeProject) {
        const processRegistry = runtime.config.managedRuntime?.processes ?? [];
        const desiredProcessSet = new Set(desiredProcesses);
        for (const process of processRegistry) {
          if (desiredProcessSet.has(process)) continue;
          if (options.repair) {
            if (
              runManagedProcessAction({
                container,
                name: process,
                action: "status",
                quiet: options.quiet,
              }) !== "stopped"
            ) {
              throw new Error(`Repair found unexpected process '${process}' after adapter replay.`);
            }
            continue;
          }
          runManagedProcessAction({
            container,
            name: process,
            action: "stop",
            quiet: options.quiet,
          });
        }
        for (const process of desiredProcesses) {
          const status = runManagedProcessAction({
            container,
            name: process,
            action: "status",
            quiet: options.quiet,
          });
          if (status !== "running") {
            throw new Error(`Managed process '${process}' is not running (${status}).`);
          }
        }

        transitionPhase = "service-stop";
        if (!options.repair)
          stopDroppedManagedServices(managedPlan, repoPath, managedComposeProject);
        assertDroppedManagedServicesStopped(managedPlan, repoPath, managedComposeProject);
        await waitForManagedServices(
          managedPlan,
          repoPath,
          managedComposeProject,
          managedPlan.desiredServices,
          container.id,
          options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        );
      }

      transitionPhase = "route-publication";
      const publication = await replacePublishedProxyRoutes(
        repoPath,
        runtime.config,
        target.workspace,
        options.repair ? { prepareInfrastructure: false } : undefined,
      );
      candidateRoutes = publication.routes;
      candidateRoutesPublished = true;
      if (options.repair) await ensureTraefikRoutesMatch(publication.routes, routeLoadOptions);
      else await ensureTraefikRoutesLoaded(publication.routes, routeLoadOptions);
      await ensureTraefikRoutesRemoved(
        removedRoutesForReplacement(previousRoutes.map(routeInputFromState), publication.routes),
        routeLoadOptions,
      );
      try {
        await waitForHttpRoutes(
          repoPath,
          apps,
          options.httpTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        );
      } catch (error) {
        if (managedPlan) {
          throw error;
        }
        replaceHostRoutesForRepo(repoPath, []);
        await ensureTraefikRoutesRemoved(candidateRoutes, routeLoadOptions);
        if (!target.hadExactDevpod || recreated) {
          throw error;
        }
        const recoveredContainer = await recreateAndPreflight();
        runManagedPostStart({
          plan: managedPostStart,
          container: recoveredContainer,
          quiet: options.quiet,
          profile: runtime.profile,
        });
        recreated = true;
        replaceHostRoutesForRepo(repoPath, publication.routes);
        await ensureTraefikRoutesLoaded(publication.routes, routeLoadOptions);
        await waitForHttpRoutes(
          repoPath,
          apps,
          options.httpTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        );
      }

      const urls = apps.map((app) =>
        app.protocol === "tcp"
          ? `${app.tcpProtocol}://${app.host}:${String(TCP_PROTOCOL_REGISTRY[app.tcpProtocol].port)}`
          : httpRouteUrl(app.host),
      );
      if (options.open) {
        openUrls(
          apps.filter((app) => app.protocol === "http").map((app) => httpRouteUrl(app.host)),
        );
      }
      if (!devpodId) {
        throw new Error(`DevPod id for '${repoPath}' was not resolved after startup.`);
      }
      let candidateState: ManagedRuntimeState | undefined;
      if (managedPlan && managedComposeProject) {
        candidateState = {
          version: 1,
          repoPath,
          ...(target.workspace !== undefined ? { workspace: target.workspace } : {}),
          devpodId,
          composeProject: managedComposeProject,
          profile: runtime.profile,
          desired: {
            apps: apps.map((app) => app.name).sort(),
            services: [...managedPlan.desiredProfileServices].sort(),
            processes: [...desiredProcesses].sort(),
          },
          sourceConfigSha256: managedPlan.sourceConfigSha256,
          effectiveConfigSha256: managedPlan.effectiveConfigSha256,
          status: "ready",
          updatedAt: new Date().toISOString(),
        };
        if (!options.repair) writeManagedRuntimeState(candidateState);
      }
      const managedRuntimeStatus = managedPlan
        ? collectManagedRuntimeStatus({
            repoPath,
            workspace: target.workspace,
            config: runtime.config,
            profile: runtime.profile,
            resolvedProfile: runtime.resolvedProfile,
            ...(options.repair ? { candidateState } : {}),
          })
        : undefined;
      if (options.repair && candidateState && managedPlan) {
        assertRetainedRepairContainers(repoPath, managedPlan, retainedRepairContainers);
        resolveRepairTarget(repoPath, linked);
        if (managedRuntimeStatus?.status !== "ready")
          throw new Error("Repaired candidate runtime did not pass final readiness validation.");
        writeManagedRuntimeState(candidateState);
      }
      return {
        kind: target.kind,
        repoPath,
        workspace: target.workspace,
        profile: runtime.profile,
        devpodId,
        urls,
        recreated,
        tlsRefreshed: publication.tlsRefreshed,
        ...(managedRuntimeStatus ? { managedRuntime: managedRuntimeStatus } : {}),
      };
    } catch (error) {
      if (options.repair && !repairMutationStarted) throw error;
      if (options.repair && repairMutationStarted && previousManagedState && managedPlan) {
        const failures: string[] = [];
        // A repair has no previous healthy process version to restore. Keep its
        // owned resources for diagnosis rather than replaying a failing adapter.
        if (transitionPhase === "route-publication") {
          try {
            const currentRoutes = listHostRouteState()
              .filter((route) => sameWorkspacePath(route.repoPath, repoPath))
              .map(routeInputFromState);
            const rollbackRoutes = previousRoutes.map(routeInputFromState);
            replaceHostRoutesForRepo(repoPath, rollbackRoutes);
            await ensureTraefikRoutesMatch(rollbackRoutes, routeLoadOptions);
            await ensureTraefikRoutesRemoved(
              removedRoutesForReplacement(currentRoutes, rollbackRoutes),
              routeLoadOptions,
            );
          } catch (rollbackError) {
            failures.push(
              `routes: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        try {
          markManagedRuntimeDegraded(previousManagedState, transitionPhase);
        } catch (stateError) {
          failures.push(
            `state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
        const original = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${original} Repair failed; owned resources may remain running.${failures.length ? ` Recovery errors: ${failures.join("; ")}.` : " State remains degraded."}`,
        );
      }
      if (managedPlan && managedContainer && managedComposeProject) {
        const rollbackErrors: string[] = [];
        const failedPhase = transitionPhase;
        transitionPhase = "rollback";
        const previousServices =
          previousManagedState?.desired.services ?? firstTransitionBaseline?.services ?? [];
        const previousProcesses =
          previousManagedState?.desired.processes ?? firstTransitionBaseline?.processes ?? [];
        const previousServiceSet = new Set(previousServices);
        const previousProcessSet = new Set(previousProcesses);
        try {
          if (managedConfigWritten) {
            if (previousManagedState && managedRuntimeConfig) {
              restorePreviousManagedConfig({
                repoPath,
                config: managedRuntimeConfig,
                linked,
                previousState: previousManagedState,
              });
            } else if (managedRuntimeConfig) {
              restoreFirstTransitionManagedConfig({
                repoPath,
                config: managedRuntimeConfig,
                linked,
                services: previousServices,
              });
            }
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            `configuration: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
        try {
          const previousAllServices = [
            managedPlan.primaryService,
            ...managedPlan.baseServices,
            ...previousServices,
          ];
          startExactManagedServices({
            plan: managedPlan,
            composeProject: managedComposeProject,
            services: previousAllServices,
            quiet: options.quiet,
            workspace: managedWorkspaceEnv,
          });
          await waitForManagedServices(
            managedPlan,
            repoPath,
            managedComposeProject,
            previousAllServices,
            managedContainer.id,
            options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
          );
        } catch (rollbackError) {
          rollbackErrors.push(
            `services: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }

        try {
          if (!managedPostStartPlan) {
            throw new Error("Managed post-start plan disappeared during rollback.");
          }
          runManagedPostStart({
            plan: managedPostStartPlan,
            container: managedContainer,
            quiet: options.quiet,
            profile: previousManagedState?.profile ?? "full",
            processes: previousProcesses,
          });
          for (const process of managedProcessRegistry) {
            if (previousProcessSet.has(process)) continue;
            runManagedProcessAction({
              container: managedContainer,
              name: process,
              action: "stop",
              quiet: options.quiet,
            });
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            `processes: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }

        try {
          const containers = inspectWorkspaceContainers();
          for (const service of managedPlan.profileServices) {
            if (previousServiceSet.has(service)) continue;
            const matches = exactWorkspaceServiceContainers(
              containers,
              repoPath,
              managedComposeProject,
              service,
              managedPlan.composeFiles,
            );
            if (matches.length > 1) {
              throw new Error(`service '${service}' has multiple exact containers`);
            }
            if (matches[0]?.state.Running) stopExactManagedService(matches[0].id, service);
          }
          assertDroppedManagedServicesStopped(
            {
              ...managedPlan,
              desiredProfileServices: previousServices,
              desiredServices: [
                managedPlan.primaryService,
                ...managedPlan.baseServices,
                ...previousServices,
              ],
            },
            repoPath,
            managedComposeProject,
          );
        } catch (rollbackError) {
          rollbackErrors.push(
            `service cleanup: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }

        if (candidateRoutesPublished) {
          try {
            const rollbackRoutes = previousRoutes.map(routeInputFromState);
            replaceHostRoutesForRepo(repoPath, rollbackRoutes);
            await ensureTraefikRoutesLoaded(rollbackRoutes, routeLoadOptions);
            await ensureTraefikRoutesRemoved(
              removedRoutesForReplacement(candidateRoutes, rollbackRoutes),
              routeLoadOptions,
            );
          } catch (rollbackError) {
            rollbackErrors.push(
              `routes: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        if (rollbackErrors.length > 0 && previousManagedState) {
          try {
            markManagedRuntimeDegraded(previousManagedState, failedPhase);
          } catch (stateError) {
            rollbackErrors.push(
              `state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
            );
          }
        }
        const original = error instanceof Error ? error.message : String(error);
        const suffix =
          rollbackErrors.length > 0
            ? ` Rollback left degraded drift: ${rollbackErrors.join("; ")}.`
            : " Candidate runtime was rolled back.";
        throw new Error(`${original}${suffix}`);
      }
      if (managedPlan) {
        const original = error instanceof Error ? error.message : String(error);
        const rollbackErrors: string[] = [];
        if (managedConfigWritten) {
          try {
            if (previousManagedState && managedRuntimeConfig) {
              restorePreviousManagedConfig({
                repoPath,
                config: managedRuntimeConfig,
                linked,
                previousState: previousManagedState,
              });
            } else if (!environmentStarted) {
              removeManagedDevcontainerConfig(managedPlan);
            }
          } catch (rollbackError) {
            rollbackErrors.push(
              `configuration: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        if (candidateRoutesPublished) {
          try {
            const rollbackRoutes = previousRoutes.map(routeInputFromState);
            replaceHostRoutesForRepo(repoPath, rollbackRoutes);
            await ensureTraefikRoutesLoaded(rollbackRoutes, routeLoadOptions);
            await ensureTraefikRoutesRemoved(
              removedRoutesForReplacement(candidateRoutes, rollbackRoutes),
              routeLoadOptions,
            );
          } catch (rollbackError) {
            rollbackErrors.push(
              `routes: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        if (rollbackErrors.length > 0) {
          throw new Error(
            `${original} Rollback left degraded drift: ${rollbackErrors.join("; ")}.`,
          );
        }
        throw new Error(
          `${original} Managed runtime transition did not reach a rollback boundary.`,
        );
      }
      if (environmentStarted) {
        try {
          replaceHostRoutesForRepo(repoPath, []);
          await ensureTraefikRoutesRemoved(candidateRoutes, routeLoadOptions);
        } catch (cleanupError) {
          const original = error instanceof Error ? error.message : String(error);
          const cleanup =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          throw new Error(`${original} Route cleanup also failed: ${cleanup}`);
        }
      }
      throw error;
    }
  };
  return withWorkspaceLifecycleLock(repoPath, async () => {
    if (!options.repair) return ensureLocked();
    const runtime = resolveWorkspaceRuntimeOrDefault(repoPath);
    fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
    return withFileLock(
      path.join(DEVROUTER_HOME, `${runtime}-mutation.lock`),
      {
        activity: "Managed runtime repair",
        target: repoPath,
        fair: true,
        waitMs: 1_800_000,
        onWait: createStderrWaitReporter("Managed runtime repair", repoPath),
      },
      ensureLocked,
    );
  });
}
