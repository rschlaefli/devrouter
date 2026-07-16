import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DevrouterProxyApp } from "../types";
import {
  inspectWorkspaceContainers,
  type WorkspaceContainerSnapshot,
  workspaceAppContainers,
} from "./devpod-environment";
import { listDevpodWorkspaces, selectDevpodWorkspace } from "./devpod-workspaces";
import { parseUpstream, replaceHostRoutesForRepo } from "./host-routes";
import { httpRouteUrl, probeHttpRoute } from "./http-route-probe";
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
): Promise<void> {
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
      return;
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

function startDevpod(
  repoPath: string,
  target: EnvironmentTarget,
  recreate = false,
  quiet = false,
): void {
  const args = ["up", repoPath];
  if (target.devpodId) {
    args.push("--id", target.devpodId);
  }
  args.push("--open-ide=false");
  if (target.kind === "linked") {
    args.push(
      "--workspace-env",
      `WORKSPACE=${target.workspace}`,
      "--workspace-env",
      `DEVROUTER_WORKSPACE=${target.workspace}`,
    );
  }
  if (recreate) {
    if (!target.devpodId) {
      throw new Error("Cannot recreate a DevPod before its exact id is known.");
    }
    args.push("--recreate");
  }
  const env = { ...process.env };
  if (target.kind === "linked") {
    env.WORKSPACE = target.workspace;
    env.DEVROUTER_WORKSPACE = target.workspace;
    env.DEVROUTER_GIT_COMMON_DIR = target.gitCommonDir;
    env.DEVCONTAINER_COMPOSE_OVERLAY = DEVCONTAINER_OVERLAY;
  } else {
    delete env.WORKSPACE;
    delete env.DEVROUTER_WORKSPACE;
    delete env.DEVROUTER_GIT_COMMON_DIR;
    delete env.DEVCONTAINER_COMPOSE_OVERLAY;
  }
  const result = spawnSync("devpod", args, {
    stdio: quiet ? ["inherit", 2, "inherit"] : "inherit",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`devpod up failed for '${target.devpodId ?? repoPath}'.`);
  }
}

function assertDevpodAttachment(repoPath: string, expectedId?: string): string {
  const attached = selectDevpodWorkspace(listDevpodWorkspaces(), repoPath);
  if (!attached || (expectedId && attached.id !== expectedId)) {
    throw new Error(
      `DevPod did not attach '${repoPath}'${expectedId ? ` as '${expectedId}'` : ""} after startup.`,
    );
  }
  return attached.id;
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
        if (app.protocol === "tcp" && !parsedUpstreams[index].host.startsWith(`${aliasPrefix}-`)) {
          const owner = target.kind === "linked" ? "workspace" : "checkout";
          throw new Error(
            `TCP app '${app.name}' must use a ${owner}-owned upstream beginning with '${aliasPrefix}-'.`,
          );
        }
      }
      const upstreamHosts = parsedUpstreams
        .map((upstream) => upstream.host)
        .filter((host) => host.startsWith(`${aliasPrefix}-`));
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
        startDevpod(repoPath, currentTarget(), recreate, options.quiet);
        environmentStarted = true;
        devpodId = assertDevpodAttachment(repoPath, devpodId);
        if (ownership) {
          writeWorkspaceOwnership(repoPath, ownership);
        }
      };
      const recreateAndWait = async (): Promise<void> => {
        startAndProveAttachment(true);
        await waitForContainerPreflight(
          repoPath,
          currentTarget(),
          upstreamHosts,
          options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        );
      };

      let recreated = false;
      try {
        startAndProveAttachment();
      } catch (error) {
        if (!target.hadExactDevpod) {
          throw error;
        }
        await recreateAndWait();
        recreated = true;
      }
      if (!recreated) {
        try {
          await waitForContainerPreflight(repoPath, currentTarget(), upstreamHosts, 0);
        } catch (error) {
          if (!target.hadExactDevpod) {
            throw error;
          }
          await recreateAndWait();
          recreated = true;
        }
      }

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
        await recreateAndWait();
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
