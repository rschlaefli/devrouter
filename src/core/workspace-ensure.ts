import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DevrouterProxyApp } from "../types";
import {
  inspectWorkspaceContainers,
  type WorkspaceContainerSnapshot,
  workspaceAppContainers,
} from "./devpod-environment";
import { DevpodStartPostconditionError, startDevpodWorkspace } from "./devpod-mutation";
import { listDevpodWorkspaces, selectDevpodWorkspace } from "./devpod-workspaces";
import { parseUpstream, replaceHostRoutesForRepo } from "./host-routes";
import { httpRouteUrl, probeHttpRoute } from "./http-route-probe";
import { resolveManagedPostStartPlan, runManagedPostStart } from "./managed-post-start";
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
  devpodId: string;
  urls: string[];
  recreated: boolean;
  tlsRefreshed: boolean;
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

type WorkspaceEnsureOptions = {
  open?: boolean;
  quiet?: boolean;
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

      const runtime = loadRuntimeConfig(
        repoPath,
        target.kind === "primary" ? "" : target.workspace,
      );
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
        if (!target.hadExactDevpod) {
          throw error;
        }
        container = await recreateAndPreflight();
        recreated = true;
      }
      if (!container) {
        try {
          container = await preflight(0);
        } catch (error) {
          if (!target.hadExactDevpod) {
            throw error;
          }
          container = await recreateAndPreflight();
          recreated = true;
        }
      }
      runManagedPostStart({
        plan: managedPostStart,
        container,
        quiet: options.quiet,
      });

      const publication = await replacePublishedProxyRoutes(
        repoPath,
        runtime.config,
        target.workspace,
      );
      try {
        await waitForHttpRoutes(
          repoPath,
          apps,
          options.httpTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        );
      } catch (error) {
        replaceHostRoutesForRepo(repoPath, []);
        if (!target.hadExactDevpod || recreated) {
          throw error;
        }
        const recoveredContainer = await recreateAndPreflight();
        runManagedPostStart({
          plan: managedPostStart,
          container: recoveredContainer,
          quiet: options.quiet,
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
      return {
        kind: target.kind,
        repoPath,
        workspace: target.workspace,
        devpodId,
        urls,
        recreated,
        tlsRefreshed: publication.tlsRefreshed,
      };
    } catch (error) {
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
