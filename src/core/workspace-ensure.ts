import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DevrouterApp } from "../types";
import { listDevpodWorkspaces, selectDevpodWorkspace } from "./devpod-workspaces";
import { ensureNetwork } from "./docker";
import { type HostRouteInput, parseUpstream, replaceHostRoutesForRepo } from "./host-routes";
import { loadRuntimeConfig, resolveRepoPath } from "./repo-config";
import {
  activateTcpProtocol,
  DEVNET_NAME,
  ensureRouterFiles,
  isTLSEnabled,
  startRouterStack,
  TCP_PROTOCOL_REGISTRY,
} from "./router";
import { ensureTLSHostsCovered } from "./tls";
import {
  comparableWorkspacePath,
  currentBranch,
  isLinkedWorktree,
  persistWorkspace,
  readPersistedWorkspace,
  resolveWorktreeWorkspace,
  sameWorkspacePath,
  withWorkspaceLifecycleLock,
} from "./workspace";
import {
  listMissingWorkspaceOwnership,
  resolveGitCommonDir,
  writeWorkspaceOwnership,
} from "./workspace-ownership";

const DEVCONTAINER_OVERLAY = "docker-compose.devrouter.yml";
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

type ProxyApp = Extract<DevrouterApp, { runtime: "proxy" }>;

export type WorkspaceContainerSnapshot = {
  id: string;
  state: {
    Running: boolean;
    Health?: { Status: string };
  };
  labels: Record<string, string | undefined>;
  mounts: Array<{ Type: string; Source: string; Destination: string }>;
  networks: Record<string, { Aliases?: string[] }>;
};

export type WorkspaceEnsureResult = {
  repoPath: string;
  workspace: string;
  devpodId: string;
  urls: string[];
};

type ValidatedWorkspaceContainer = {
  id: string;
  workspacePath: string;
};

type WorkspaceEnsureOptions = {
  open?: boolean;
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
    gitCommonDir: string;
    workspace: string;
    upstreamHosts: string[];
  },
): ValidatedWorkspaceContainer {
  const owned = containers.filter((container) => {
    const workingDir = container.labels["com.docker.compose.project.working_dir"];
    return Boolean(
      workingDir && sameWorkspacePath(workingDir, path.join(options.repoPath, ".devcontainer")),
    );
  });
  const appContainers = owned.filter((container) =>
    container.mounts.some(
      (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, options.repoPath),
    ),
  );
  if (appContainers.length !== 1) {
    throw new Error(
      `Expected exactly one container mounted from '${options.repoPath}', found ${appContainers.length}.`,
    );
  }
  const appContainer = appContainers[0];
  assertOverlay(appContainer, options.repoPath);
  assertReady(appContainer, "Workspace app");
  const gitMount = appContainer.mounts.find(
    (mount) =>
      mount.Type === "bind" &&
      sameWorkspacePath(mount.Source, options.gitCommonDir) &&
      sameWorkspacePath(mount.Destination, options.gitCommonDir),
  );
  if (!gitMount) {
    throw new Error(
      `Workspace app container does not mount Git common directory '${options.gitCommonDir}'.`,
    );
  }

  const devnetHosts = Array.from(new Set(options.upstreamHosts)).filter((host) =>
    host.startsWith(`${options.workspace}-`),
  );
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
    assertOverlay(matches[0], options.repoPath);
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

const SAFE_INSPECT_TEMPLATE =
  '{"id":{{json .Id}},"state":{"Running":{{json .State.Running}},"Health":{{with (index .State "Health")}}{"Status":{{json .Status}}}{{else}}null{{end}}},"labels":{"com.docker.compose.project.working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"com.docker.compose.project.config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}';

export function inspectWorkspaceContainers(): WorkspaceContainerSnapshot[] {
  const listed = spawnSync("docker", ["ps", "-a", "--format", "{{.ID}}"], {
    encoding: "utf-8",
  });
  if (listed.status !== 0) {
    throw new Error(
      `docker ps failed: ${(listed.stderr || listed.stdout || "unknown error").trim()}`,
    );
  }
  const ids = listed.stdout
    .split(/\r?\n/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return [];
  }

  const inspected = spawnSync("docker", ["inspect", "--format", SAFE_INSPECT_TEMPLATE, ...ids], {
    encoding: "utf-8",
  });
  if (inspected.status !== 0) {
    throw new Error(
      `docker inspect failed: ${(inspected.stderr || inspected.stdout || "unknown error").trim()}`,
    );
  }
  return inspected.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkspaceContainerSnapshot);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContainerPreflight(
  repoPath: string,
  gitCommonDir: string,
  workspace: string,
  upstreamHosts: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const appContainer = validateWorkspaceContainers(inspectWorkspaceContainers(), {
        repoPath,
        gitCommonDir,
        workspace,
        upstreamHosts,
      });
      const workspaceEnv = spawnSync("docker", ["exec", appContainer.id, "printenv", "WORKSPACE"], {
        encoding: "utf-8",
      });
      if (workspaceEnv.status !== 0 || workspaceEnv.stdout.trim() !== workspace) {
        throw new Error(
          `Workspace app container must expose WORKSPACE='${workspace}' (got '${workspaceEnv.stdout.trim() || "(empty)"}').`,
        );
      }
      const devrouterWorkspaceEnv = spawnSync(
        "docker",
        ["exec", appContainer.id, "printenv", "DEVROUTER_WORKSPACE"],
        { encoding: "utf-8" },
      );
      if (devrouterWorkspaceEnv.status !== 0 || devrouterWorkspaceEnv.stdout.trim() !== workspace) {
        throw new Error(`Workspace app container must expose DEVROUTER_WORKSPACE='${workspace}'.`);
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
          "--is-inside-work-tree",
        ],
        { encoding: "utf-8" },
      );
      if (gitCheck.status !== 0 || gitCheck.stdout.trim() !== "true") {
        throw new Error("Git is not usable inside the workspace app container.");
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

function proxyApps(config: { apps: DevrouterApp[] }): ProxyApp[] {
  const unsupported = config.apps.filter(
    (app) => app.kind !== "dependency" && app.runtime !== "host" && app.runtime !== "proxy",
  );
  if (unsupported.length > 0) {
    throw new Error(
      `workspace ensure only reconciles proxy routes; unsupported app(s): ${unsupported.map((app) => app.name).join(", ")}`,
    );
  }
  return config.apps.filter(
    (app): app is ProxyApp => app.kind !== "dependency" && app.runtime === "proxy",
  );
}

function routeInputs(repoPath: string, workspace: string, apps: ProxyApp[]): HostRouteInput[] {
  return apps.map((app) => {
    const { port, upstreamHost } = parseUpstream(app.upstream);
    return {
      name: app.name,
      host: app.host,
      protocol: app.protocol,
      tcpProtocol: app.protocol === "tcp" ? app.tcpProtocol : undefined,
      repoPath,
      port,
      upstreamHost,
      mode: "proxy",
      workspace,
    };
  });
}

function routeUrl(host: string): string {
  return `${isTLSEnabled() ? "https" : "http"}://${host}`;
}

async function waitForHttpRoutes(apps: ProxyApp[], timeoutMs: number): Promise<void> {
  const pending = new Map(
    apps.filter((app) => app.protocol === "http").map((app) => [app.name, app] as const),
  );
  const failures = new Map<string, string>();
  const deadline = Date.now() + timeoutMs;

  do {
    for (const [name, app] of pending) {
      const result = spawnSync(
        "curl",
        [
          "-k",
          "--silent",
          "--show-error",
          "--output",
          "/dev/null",
          "--write-out",
          "%{http_code}",
          "--max-time",
          "5",
          routeUrl(app.host),
        ],
        { encoding: "utf-8" },
      );
      const status = Number(result.stdout.trim());
      if (result.status === 0 && status >= 100 && status < 500) {
        pending.delete(name);
        failures.delete(name);
      } else {
        failures.set(
          name,
          (result.stderr || result.stdout || `curl exited with ${String(result.status)}`).trim(),
        );
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

function resolveIdentity(repoPath: string): {
  workspace: string;
  hadExactDevpod: boolean;
} {
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
    workspace: persistWorkspace(repoPath, candidate),
    hadExactDevpod: Boolean(existingDevpod),
  };
}

function startDevpod(
  repoPath: string,
  workspace: string,
  commonDir: string,
  recreate = false,
): void {
  const args = [
    "up",
    repoPath,
    "--id",
    workspace,
    "--open-ide=false",
    "--workspace-env",
    `WORKSPACE=${workspace}`,
    "--workspace-env",
    `DEVROUTER_WORKSPACE=${workspace}`,
  ];
  if (recreate) {
    args.push("--recreate");
  }
  const result = spawnSync("devpod", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      WORKSPACE: workspace,
      DEVROUTER_WORKSPACE: workspace,
      DEVROUTER_GIT_COMMON_DIR: commonDir,
      DEVCONTAINER_COMPOSE_OVERLAY: DEVCONTAINER_OVERLAY,
    },
  });
  if (result.status !== 0) {
    throw new Error(`devpod up failed for '${workspace}'.`);
  }
}

function assertDevpodAttachment(repoPath: string, workspace: string): void {
  const attached = selectDevpodWorkspace(listDevpodWorkspaces(), repoPath);
  if (!attached || attached.id !== workspace) {
    throw new Error(`DevPod did not attach '${repoPath}' as '${workspace}' after startup.`);
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
  if (!isLinkedWorktree(repoPath)) {
    throw new Error(`workspace ensure requires a linked Git worktree (got '${repoPath}').`);
  }
  const missingOwners = listMissingWorkspaceOwnership(repoPath);
  if (missingOwners.length > 0) {
    process.stderr.write(
      `Warning: ${missingOwners.length} managed workspace owner${missingOwners.length === 1 ? " is" : "s are"} missing. Review: dev workspace gc --repo ${repoPath}\n`,
    );
  }

  return withWorkspaceLifecycleLock(repoPath, async () => {
    let environmentStarted = false;
    try {
      const { workspace, hadExactDevpod } = resolveIdentity(repoPath);
      const overlayPath = path.join(repoPath, ".devcontainer", DEVCONTAINER_OVERLAY);
      if (!fs.existsSync(overlayPath)) {
        throw new Error(`Missing required DevPod compose overlay: ${overlayPath}`);
      }

      const runtime = loadRuntimeConfig(repoPath, workspace);
      const apps = proxyApps(runtime.config);
      const parsedUpstreams = apps.map((app) => parseUpstream(app.upstream));
      for (const [index, app] of apps.entries()) {
        if (app.protocol === "tcp" && !parsedUpstreams[index].host.startsWith(`${workspace}-`)) {
          throw new Error(
            `TCP app '${app.name}' must use a workspace-owned upstream beginning with '${workspace}-'.`,
          );
        }
      }
      const commonDir = resolveGitCommonDir(repoPath);
      const upstreamHosts = parsedUpstreams.map((upstream) => upstream.host);
      const ownership = {
        workspace,
        worktreePath: repoPath,
        branch: currentBranch(repoPath),
        devpodId: workspace,
      };
      writeWorkspaceOwnership(repoPath, ownership);

      const startAndProveAttachment = (recreate = false): void => {
        startDevpod(repoPath, workspace, commonDir, recreate);
        environmentStarted = true;
        assertDevpodAttachment(repoPath, workspace);
        writeWorkspaceOwnership(repoPath, ownership);
      };
      const recreateAndWait = async (): Promise<void> => {
        startAndProveAttachment(true);
        await waitForContainerPreflight(
          repoPath,
          commonDir,
          workspace,
          upstreamHosts,
          options.containerTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        );
      };

      let recreated = false;
      try {
        startAndProveAttachment();
      } catch (error) {
        if (!hadExactDevpod) {
          throw error;
        }
        await recreateAndWait();
        recreated = true;
      }
      if (!recreated) {
        try {
          await waitForContainerPreflight(repoPath, commonDir, workspace, upstreamHosts, 0);
        } catch {
          await recreateAndWait();
          recreated = true;
        }
      }

      ensureRouterFiles();
      await ensureNetwork(DEVNET_NAME);
      await ensureTLSHostsCovered(apps.map((app) => app.host));
      for (const app of apps) {
        if (app.protocol === "tcp") {
          if (!isTLSEnabled()) {
            throw new Error(
              `App '${app.name}' is a TCP proxy route and requires TLS. Run 'dev tls install'.`,
            );
          }
          activateTcpProtocol(app.tcpProtocol);
        }
      }
      startRouterStack();
      const routes = routeInputs(repoPath, workspace, apps);
      replaceHostRoutesForRepo(repoPath, routes);
      try {
        await waitForHttpRoutes(apps, options.httpTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
      } catch (error) {
        replaceHostRoutesForRepo(repoPath, []);
        if (!hadExactDevpod || recreated) {
          throw error;
        }
        await recreateAndWait();
        replaceHostRoutesForRepo(repoPath, routes);
        await waitForHttpRoutes(apps, options.httpTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
      }

      const urls = apps.map((app) =>
        app.protocol === "tcp"
          ? `${app.tcpProtocol}://${app.host}:${String(TCP_PROTOCOL_REGISTRY[app.tcpProtocol].port)}`
          : routeUrl(app.host),
      );
      if (options.open) {
        openUrls(apps.filter((app) => app.protocol === "http").map((app) => routeUrl(app.host)));
      }
      return { repoPath, workspace, devpodId: workspace, urls };
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
