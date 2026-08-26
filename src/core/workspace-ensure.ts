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
  inspectManagedDevcontainerConfig,
  type ManagedDevcontainerPlan,
  removeManagedDevcontainerConfig,
  startExactManagedServices,
  stopExactManagedService,
  writeManagedDevcontainerConfig,
} from "./devcontainer-profile";
import {
  inspectWorkspaceContainers,
  type WorkspaceContainerSnapshot,
  workspaceAppContainers,
} from "./devpod-environment";
import { DevpodStartPostconditionError, startDevpodWorkspace } from "./devpod-mutation";
import { listDevpodWorkspaces, selectDevpodWorkspace } from "./devpod-workspaces";
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
import { DEVNET_NAME, TCP_PROTOCOL_REGISTRY } from "./router";
import {
  comparableWorkspacePath,
  currentBranch,
  isLinkedWorktree,
  persistWorkspace,
  readPersistedWorkspace,
  resolveWorktreeWorkspace,
  sameWorkspacePath,
  withWorkspaceLifecycleLock,
  wsFromBranch,
} from "./workspace";
import {
  listMissingWorkspaceOwnership,
  resolveGitCommonDir,
  writeWorkspaceOwnership,
} from "./workspace-ownership";

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
  return containers.filter((container) => {
    if (
      container.labels["com.docker.compose.project"] !== composeProject ||
      container.labels["com.docker.compose.service"] !== service ||
      !sameWorkspacePath(
        container.labels["com.docker.compose.project.working_dir"] ?? "",
        path.join(repoPath, ".devcontainer"),
      )
    ) {
      return false;
    }
    if (!composeFiles) return true;
    const actualFiles = (container.labels["com.docker.compose.project.config_files"] ?? "")
      .split(",")
      .filter(Boolean);
    return (
      actualFiles.length === composeFiles.length &&
      composeFiles.every((expected) =>
        actualFiles.some((actual) => sameWorkspacePath(actual, expected)),
      )
    );
  });
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
  const workingDir = app.labels["com.docker.compose.project.working_dir"];
  if (!workingDir || !sameWorkspacePath(workingDir, path.join(repoPath, ".devcontainer"))) {
    throw new Error(
      `Workspace app container '${appContainerId}' has an unexpected Compose directory.`,
    );
  }
  if (app.labels["com.docker.compose.service"] !== primaryService) {
    throw new Error(
      `Workspace app container '${appContainerId}' is not Compose service '${primaryService}'.`,
    );
  }
  const appConfigFiles = (app.labels["com.docker.compose.project.config_files"] ?? "")
    .split(",")
    .filter(Boolean);
  if (
    appConfigFiles.length !== composeFiles.length ||
    !composeFiles.every((expected) =>
      appConfigFiles.some((actual) => sameWorkspacePath(actual, expected)),
    )
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

export function validateWorkspaceContainers(
  containers: WorkspaceContainerSnapshot[],
  options: {
    repoPath: string;
    upstreamHosts: string[];
    target: EnvironmentTarget;
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
  assertReady(appContainer, "Workspace app");
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
  const devpods = listDevpodWorkspaces();
  const existingDevpod = selectDevpodWorkspace(devpods, repoPath);
  const persisted = readPersistedWorkspace(repoPath);
  const candidate = existingDevpod?.id ?? persisted ?? resolveWorktreeWorkspace(repoPath);
  if (!candidate) {
    throw new Error(`Could not resolve a workspace identity for '${repoPath}'.`);
  }
  const otherOwner = devpods.find(
    (devpod) => devpod.id === candidate && !sameWorkspacePath(devpod.source.localFolder, repoPath),
  );
  if (otherOwner) {
    throw new Error(
      `DevPod identity '${candidate}' already belongs to '${otherOwner.source.localFolder}'.`,
    );
  }
  return {
    kind: "linked",
    workspace: persistWorkspace(repoPath, candidate),
    devpodId: candidate,
    hadExactDevpod: Boolean(existingDevpod),
    gitCommonDir: resolveGitCommonDir(repoPath),
  };
}

function resolvePrimaryTarget(repoPath: string): EnvironmentTarget {
  const existingDevpod = selectDevpodWorkspace(listDevpodWorkspaces(), repoPath);
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

  return withWorkspaceLifecycleLock(repoPath, async () => {
    let environmentStarted = false;
    let managedPlan: ManagedDevcontainerPlan | undefined;
    let previousManagedState: ManagedRuntimeState | undefined;
    let managedComposeProject: string | undefined;
    let managedContainer: ValidatedWorkspaceContainer | undefined;
    let previousRoutes: HostRouteState[] = [];
    let candidateRoutesPublished = false;
    let transitionPhase: ManagedTransitionPhase = "validation";
    let managedProcessRegistry: string[] = [];
    let managedPostStartPlan: ManagedPostStartPlan | undefined;
    let managedRuntimeConfig: DevrouterConfig | undefined;
    let managedConfigWritten = false;
    try {
      const target = linked ? resolveLinkedTarget(repoPath) : resolvePrimaryTarget(repoPath);
      let devpodId = target.devpodId;
      if (target.kind === "linked") {
        const overlayPath = path.join(repoPath, ".devcontainer", DEVCONTAINER_OVERLAY);
        if (!fs.existsSync(overlayPath)) {
          throw new Error(`Missing required DevPod compose overlay: ${overlayPath}`);
        }
      }
      const managedPostStart = resolveManagedPostStartPlan(repoPath);
      managedPostStartPlan = managedPostStart;

      const runtime = loadRuntimeConfig(
        repoPath,
        target.kind === "primary" ? "" : target.workspace,
        options.profile,
      );
      const managedRuntime = runtime.config.managedRuntime;
      managedRuntimeConfig = managedRuntime ? runtime.config : undefined;
      managedProcessRegistry = managedRuntime?.processes ?? [];
      const desiredProcesses = managedRuntime
        ? desiredManagedProcesses(managedRuntime, runtime.resolvedProfile)
        : [];
      if (managedRuntime) {
        previousManagedState = readManagedRuntimeState(repoPath, target.workspace);
        if (previousManagedState?.status === "degraded") {
          throw new Error(
            "Managed runtime state is degraded; refusing a new profile transition until drift is repaired.",
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
        previousRoutes = listHostRouteState().filter((route) =>
          sameWorkspacePath(route.repoPath, repoPath),
        );
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
      if (managedPlan) {
        writeManagedDevcontainerConfig(managedPlan);
        managedConfigWritten = true;
      }
      const upstreamHosts = parsedUpstreams.map((upstream) => upstream.host);
      const ownership =
        target.kind === "linked"
          ? {
              workspace: target.workspace,
              worktreePath: repoPath,
              branch: currentBranch(repoPath),
              devpodId: target.devpodId,
            }
          : undefined;
      if (ownership) {
        writeWorkspaceOwnership(repoPath, ownership);
      }

      const currentTarget = (): EnvironmentTarget =>
        target.kind === "linked" ? target : { ...target, devpodId };

      const startAndProveAttachment = (recreate = false): void => {
        const requestedTarget = currentTarget();
        try {
          devpodId = startDevpodWorkspace({
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
        if (ownership) {
          writeWorkspaceOwnership(repoPath, ownership);
        }
      };
      const preflight = (timeoutMs: number): Promise<ValidatedWorkspaceContainer> =>
        waitForContainerPreflight(repoPath, currentTarget(), upstreamHosts, timeoutMs);
      const recreateAndPreflight = async (): Promise<ValidatedWorkspaceContainer> => {
        startAndProveAttachment(true);
        return preflight(options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
      };

      let recreated = false;
      let container: ValidatedWorkspaceContainer | undefined;
      try {
        startAndProveAttachment();
      } catch (error) {
        if (managedPlan || !target.hadExactDevpod) {
          throw error;
        }
        container = await recreateAndPreflight();
        recreated = true;
      }
      if (!container) {
        try {
          container = await preflight(0);
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
        startExactManagedServices({
          plan: managedPlan,
          composeProject: managedComposeProject,
          services: missingServices,
          quiet: options.quiet,
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
      );
      candidateRoutesPublished = true;
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
      if (managedPlan && managedComposeProject) {
        writeManagedRuntimeState({
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
        });
      }
      const managedRuntimeStatus = managedPlan
        ? collectManagedRuntimeStatus({
            repoPath,
            workspace: target.workspace,
            config: runtime.config,
            profile: runtime.profile,
            resolvedProfile: runtime.resolvedProfile,
          })
        : undefined;
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
      if (managedPlan && managedContainer && managedComposeProject) {
        const rollbackErrors: string[] = [];
        const failedPhase = transitionPhase;
        transitionPhase = "rollback";
        const previousServices = previousManagedState?.desired.services ?? [];
        const previousProcesses = previousManagedState?.desired.processes ?? [];
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
            } else {
              removeManagedDevcontainerConfig(managedPlan);
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
            replaceHostRoutesForRepo(repoPath, previousRoutes.map(routeInputFromState));
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
            } else {
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
            replaceHostRoutesForRepo(repoPath, previousRoutes.map(routeInputFromState));
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
        } catch (cleanupError) {
          const original = error instanceof Error ? error.message : String(error);
          const cleanup =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          throw new Error(`${original} Route cleanup also failed: ${cleanup}`);
        }
      }
      throw error;
    }
  });
}
