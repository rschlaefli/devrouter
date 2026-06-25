import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import {
  DevrouterApp,
  DevrouterDockerDependencyApp,
  DevrouterDockerTcpApp,
  DevrouterHostHttpApp,
  DevrouterProxyApp
} from "../types";
import {
  prepareDockerOverlay,
  runDockerComposeUp,
  runDockerComposeStop,
  runDockerComposeLogs,
  queryMappedPort,
  queryRunningComposeServices
} from "./docker-run";
import { resolveAppByName, resolveAppDependencies, resolveRepoPath } from "./repo-config";
import {
  buildHostRouteId,
  parseUpstream,
  removeHostRouteById,
  upsertHostRoute
} from "./host-routes";
import { assertAppNotRunning } from "./concurrency";
import { ensureNetwork } from "./docker";
import { DEVNET_NAME, TCP_PROTOCOL_REGISTRY, activateTcpProtocol, ensureRouterFiles, isTLSEnabled, startRouterStack } from "./router";
import { assertPathWithinRepo } from "./paths";
import { ensureTLSHostsCovered } from "./tls";

const POLL_INTERVAL_MS = 1000;
const DEFAULT_PORT_TIMEOUT_MS = 120_000;
const PROCESS_TERMINATION_GRACE_MS = 3_000;

type RunAppOptions = {
  name: string;
  repoPath?: string;
  yes?: boolean;
  env?: string;
  workspace?: string;
};

type DependencyStopPolicy = "always-stop-selected" | "stop-only-newly-started";

type StartAppDependenciesOptions = RunAppOptions & {
  stopPolicy?: DependencyStopPolicy;
};

type RunAppResult = {
  repoPath: string;
  appName: string;
  mode: "host" | "docker" | "proxy";
  startedServices: string[];
  dependencyApps: string[];
};

type ExecAppOptions = {
  name: string;
  repoPath?: string;
  yes?: boolean;
  shell?: boolean;
  env?: string;
  workspace?: string;
  command: string[];
};

type ExecAppResult = {
  exitCode: number;
};

type StartedDeps = {
  repoPath: string;
  app: DevrouterApp;
  workspace: string | undefined;
  depEnv: Record<string, string>;
  secretManager?: { command: string; defaultEnv?: string };
  overlay?: ReturnType<typeof prepareDockerOverlay>;
  startedServices: string[];
  dependencyApps: string[];
  stopDeps: () => void;
};

export function wrapWithSecretManager(
  smCommand: string,
  reinjectEnv: Record<string, string>,
  userCommand: string | string[],
  shell: boolean
): string | string[] {
  const envPairs = Object.entries(reinjectEnv).map(([k, v]) => `${k}=${v}`);

  if (shell) {
    const userCmd = typeof userCommand === "string" ? userCommand : userCommand[0];
    if (envPairs.length > 0) {
      return `${smCommand} env ${envPairs.join(" ")} ${userCmd}`;
    }
    return `${smCommand} ${userCmd}`;
  }

  const smParts = smCommand.split(/\s+/).filter(Boolean);
  const userParts = Array.isArray(userCommand) ? userCommand : [userCommand];
  if (envPairs.length > 0) {
    return [...smParts, "env", ...envPairs, ...userParts];
  }
  return [...smParts, ...userParts];
}

export function resolveSmCommand(
  command: string,
  defaultEnv?: string,
  overrideEnv?: string
): string {
  if (!command.includes("{env}")) {
    return command;
  }

  const env = overrideEnv ?? defaultEnv;
  if (!env) {
    throw new Error(
      "secretManager.command contains {env} but no environment was resolved. " +
      "Set secretManager.defaultEnv in .devrouter.yml or pass --env."
    );
  }

  return command.replace(/\{env\}/g, env);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function normalizeProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function buildExecEnvironment(
  depEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return {
    ...normalizeProcessEnv(processEnv),
    ...depEnv
  };
}

export function buildTcpDepUrl(tcpProtocol: string, port: number): string | undefined {
  switch (tcpProtocol) {
    case "postgres":
      return `postgres://prisma:prisma@localhost:${port}/prisma`;
    case "redis":
      return `redis://localhost:${port}`;
    case "mysql":
    case "mariadb":
      return `mysql://root@localhost:${port}`;
    default:
      return undefined;
  }
}

export function buildTcpDepShadowUrl(tcpProtocol: string, port: number): string | undefined {
  if (tcpProtocol === "postgres") {
    return `postgres://prisma:prisma@localhost:${port}/shadow`;
  }
  return undefined;
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessTree(rootPid: number): number[] {
  const result = spawnSync("ps", ["-ax", "-o", "pid=,ppid="], { encoding: "utf-8" });
  if (result.status !== 0) {
    return [rootPid];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) {
      continue;
    }

    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }

    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }

  const found = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }

    for (const child of childrenByParent.get(current) ?? []) {
      if (found.has(child)) {
        continue;
      }
      found.add(child);
      queue.push(child);
    }
  }

  return Array.from(found.values());
}

function killProcessTree(rootPid: number, signal: NodeJS.Signals): void {
  const pids = readProcessTree(rootPid).sort((a, b) => b - a);
  for (const pid of pids) {
    if (!isProcessRunning(pid)) {
      continue;
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function terminateProcessTree(rootPid: number): Promise<void> {
  if (!isProcessRunning(rootPid)) {
    return;
  }

  killProcessTree(rootPid, "SIGTERM");
  const deadline = Date.now() + PROCESS_TERMINATION_GRACE_MS;

  while (Date.now() < deadline) {
    if (!isProcessRunning(rootPid)) {
      return;
    }
    await sleep(100);
  }

  if (isProcessRunning(rootPid)) {
    killProcessTree(rootPid, "SIGKILL");
  }
}

function parseListeningPorts(outputText: string): number[] {
  const ports = new Set<number>();
  for (const line of outputText.split("\n")) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)\s*$/);
    if (!match) {
      continue;
    }
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0) {
      ports.add(port);
    }
  }

  return Array.from(ports.values()).sort((a, b) => a - b);
}

function detectListeningPorts(pids: number[]): number[] {
  if (pids.length === 0) {
    return [];
  }

  const result = spawnSync(
    "lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")],
    { encoding: "utf-8" }
  );
  if (result.status !== 0) {
    return [];
  }

  return parseListeningPorts(result.stdout);
}

function parseAllowedPortRange(value: string): { min: number; max: number } {
  const match = value.trim().match(/^(\d+)-(\d+)$/);
  if (!match) {
    return { min: 1024, max: 65535 };
  }
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 65535 || min > max) {
    return { min: 1024, max: 65535 };
  }
  return { min, max };
}

function selectAllowedPort(ports: number[], app: DevrouterHostHttpApp): number | undefined {
  const denyPorts = new Set<number>([80, 443, 5432, ...app.hostRun.strategy.denyPorts]);
  const deniedPort = ports.find((port) => denyPorts.has(port));
  if (deniedPort !== undefined) {
    throw new Error(
      `Detected forbidden host app port ${deniedPort}. Traefik owns 80/443/5432.`
    );
  }

  const range = parseAllowedPortRange(app.hostRun.strategy.allowPortRange);
  return ports.find((port) => port >= range.min && port <= range.max && !denyPorts.has(port));
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to obtain free port.")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function runHostApp(
  repoPath: string,
  app: DevrouterHostHttpApp,
  extraEnv: Record<string, string> = {},
  secretManager?: { command: string; defaultEnv?: string },
  env?: string,
  workspace?: string
): Promise<void> {
  assertAppNotRunning(repoPath, app);

  const routeId = buildHostRouteId(repoPath, app.name);
  const commandCwd = assertPathWithinRepo(app.hostRun.cwd, repoPath, "hostRun.cwd");
  const freePort = await findFreePort();
  const spawnCommand = secretManager
    ? wrapWithSecretManager(
        resolveSmCommand(secretManager.command, secretManager.defaultEnv, env),
        extraEnv, app.hostRun.command, true
      ) as string
    : app.hostRun.command;
  // shell:true is intentional — .devrouter.yml is a user-controlled local config file
  // with the same trust model as npm scripts or docker-compose commands. The user who
  // edits the config already has local shell access.
  const child = spawn(spawnCommand, {
    cwd: commandCwd,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, PORT: String(freePort), HOSTNAME: "0.0.0.0", HOST: "0.0.0.0", ...extraEnv }
  });

  if (!child.pid) {
    throw new Error(`Failed to start command '${app.hostRun.command}'.`);
  }

  process.stdout.write(`Started '${app.hostRun.command}' for '${app.name}' in ${commandCwd} (PORT=${freePort})\n`);

  const childExit = new Promise<{ code: number | null }>((resolve) => {
    child.once("exit", (code) => resolve({ code }));
  });

  let stopRequested = false;
  let fatalError: Error | null = null;
  let currentPort: number | undefined;
  const startedAt = Date.now();

  const onSignal = (signal: NodeJS.Signals) => {
    stopRequested = true;
    if (isProcessRunning(child.pid!)) {
      killProcessTree(child.pid!, signal);
    }
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    while (true) {
      if (stopRequested) {
        break;
      }

      if (!isProcessRunning(child.pid)) {
        break;
      }

      const ports = detectListeningPorts(readProcessTree(child.pid));
      const selectedPort = selectAllowedPort(ports, app);
      if (selectedPort !== undefined && selectedPort !== currentPort) {
        currentPort = selectedPort;
        upsertHostRoute({
          name: app.name,
          host: app.host,
          protocol: "http",
          repoPath,
          port: selectedPort,
          mode: "run",
          pid: child.pid,
          command: app.hostRun.command,
          workspace
        });
        process.stdout.write(`Route https://${app.host} -> localhost:${selectedPort}\n`);
      } else if (!currentPort) {
        const timeoutMs = app.hostRun.portTimeout
          ? app.hostRun.portTimeout * 1000
          : DEFAULT_PORT_TIMEOUT_MS;
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(
            `No listening TCP port detected for '${app.name}' after ${Math.floor(
              timeoutMs / 1000
            )}s.`
          );
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    fatalError = toError(error);
    stopRequested = true;
    await terminateProcessTree(child.pid);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    const processStillRunning = isProcessRunning(child.pid);
    if (stopRequested || fatalError || !processStillRunning) {
      removeHostRouteById(routeId);
    }
  }

  const exit = await childExit;
  if (fatalError) {
    throw fatalError;
  }

  if (exit.code !== null && exit.code !== 0) {
    throw new Error(`Host command for '${app.name}' exited with code ${exit.code}.`);
  }
}

function uniqueApps(apps: DevrouterApp[]): DevrouterApp[] {
  const byName = new Map<string, DevrouterApp>();
  for (const app of apps) {
    byName.set(app.name, app);
  }
  return Array.from(byName.values());
}

function dependencyNames(apps: DevrouterApp[]): string[] {
  return apps.map((entry) => entry.name).sort();
}

function isDependencyOnlyApp(app: DevrouterApp): app is DevrouterDockerDependencyApp {
  return app.kind === "dependency";
}

async function shouldStartDependencies(
  appName: string,
  dependencies: DevrouterApp[],
  yes: boolean
): Promise<boolean> {
  if (dependencies.length === 0) {
    return false;
  }

  if (yes) {
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `App '${appName}' has dependencies (${dependencyNames(
        dependencies
      ).join(", ")}). Re-run with --yes in non-interactive mode.`
    );
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Start dependencies for '${appName}' (${dependencyNames(dependencies).join(", ")})? [y/N] `
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function startAppDependencies(options: StartAppDependenciesOptions): Promise<StartedDeps> {
  ensureRouterFiles();
  await ensureNetwork(DEVNET_NAME);

  const repoPath = resolveRepoPath(options.repoPath);
  const { config, app, workspace } = resolveAppByName(repoPath, options.name, options.workspace);
  if (isDependencyOnlyApp(app)) {
    throw new Error(
      `App '${app.name}' is kind=dependency and cannot be run directly. ` +
      "Reference it from another app via dependencies and run that app instead."
    );
  }

  const routedHosts = config.apps
    .filter((entry): entry is Exclude<DevrouterApp, DevrouterDockerDependencyApp> => !isDependencyOnlyApp(entry))
    .map((entry) => entry.host);
  if (routedHosts.length > 0) {
    const tlsCoverage = await ensureTLSHostsCovered(routedHosts);
    if (tlsCoverage.refreshed) {
      process.stdout.write(
        `Refreshed TLS cert host coverage for: ${tlsCoverage.uncoveredHosts.join(", ")}\n`
      );
    }
  }

  const dependencies = resolveAppDependencies(config, app);
  const unsupportedDependencies = dependencies.filter((entry) => entry.runtime !== "docker");
  if (unsupportedDependencies.length > 0) {
    throw new Error(
      `App '${app.name}' has host-runtime dependencies (${dependencyNames(
        unsupportedDependencies
      ).join(", ")}). v1 only auto-starts docker dependencies. Start host dependencies manually before running this app.`
    );
  }

  // Always include all dependencies for overlay/env probing, regardless of
  // whether we actually start them (compose up). This ensures env injection
  // works even when containers are already running.
  const selectedApps = uniqueApps([app, ...dependencies]);
  const selectedDockerApps = selectedApps.filter(
    (entry): entry is Exclude<DevrouterApp, DevrouterHostHttpApp | DevrouterProxyApp> =>
      entry.runtime === "docker"
  );
  const stopPolicy = options.stopPolicy ?? "always-stop-selected";

  const startedServices: string[] = [];
  let overlay: ReturnType<typeof prepareDockerOverlay> | undefined;
  let startDependencies = false;

  const hasTcpDeps = app.runtime === "host" && selectedDockerApps.some(
    (entry) => entry.kind !== "dependency" && entry.protocol === "tcp"
  );

  if (selectedDockerApps.length > 0) {
    overlay = prepareDockerOverlay(repoPath, app.name, selectedDockerApps, hasTcpDeps);
    const services = selectedDockerApps.map((entry) => entry.docker.service);

    // Check which dep services are already running before deciding whether to prompt
    const depServices = dependencies
      .filter((entry) => entry.runtime === "docker")
      .map((entry) => entry.docker.service);
    let runningServicesBefore: Set<string> | null = null;
    let ownershipKnown = true;
    const preRunResult = depServices.length > 0
      ? queryRunningComposeServices(repoPath, overlay.composeFiles, overlay.overlayPath, depServices)
      : undefined;

    const allDepsRunning = preRunResult?.status === "known"
      && depServices.every((s) => preRunResult.runningServices.has(s));

    if (allDepsRunning) {
      // All deps already running — skip prompt and compose up
      startDependencies = false;
    } else if (dependencies.length > 0) {
      startDependencies = await shouldStartDependencies(
        app.name,
        dependencies,
        Boolean(options.yes)
      );
    } else {
      startDependencies = false;
    }

    if (startDependencies) {
      // Track ownership for stop policy
      if (stopPolicy === "stop-only-newly-started") {
        if (preRunResult?.status === "known") {
          runningServicesBefore = preRunResult.runningServices;
        } else if (preRunResult?.status === "unknown") {
          ownershipKnown = false;
          process.stderr.write(
            "Warning: unable to determine which dependencies were already running before 'dev app exec'; " +
              "leaving dependencies running after command exit to avoid stopping non-owned services. " +
              `Details: ${preRunResult.reason}\n`
          );
        }
      }

      runDockerComposeUp(repoPath, overlay.composeFiles, overlay.overlayPath, services);
      if (stopPolicy === "stop-only-newly-started") {
        const beforeSet = runningServicesBefore;
        if (ownershipKnown && beforeSet) {
          startedServices.push(...services.filter((service) => !beforeSet.has(service)));
        }
      } else {
        startedServices.push(...services);
      }
      runDockerComposeLogs(repoPath, overlay.composeFiles, overlay.overlayPath, services);
    }
  }

  const depEnv: Record<string, string> = {};
  if (hasTcpDeps && overlay) {
    const tcpDeps = selectedDockerApps.filter(
      (entry): entry is DevrouterDockerTcpApp => entry.kind !== "dependency" && entry.protocol === "tcp"
    );

    let routerRestarted = false;
    for (const dep of tcpDeps) {
      const needsRestart = activateTcpProtocol(dep.tcpProtocol);
      if (needsRestart && !routerRestarted) {
        process.stdout.write(`Restarting router for new TCP entrypoint: ${dep.tcpProtocol}\n`);
        startRouterStack();
        routerRestarted = true;
      }
    }

    for (const dep of tcpDeps) {
      const mappedPort = queryMappedPort(
        repoPath,
        overlay.composeFiles,
        overlay.overlayPath,
        dep.docker.service,
        dep.docker.internalPort
      );
      if (mappedPort !== undefined) {
        const envPrefix = dep.name.toUpperCase().replace(/-/g, "_");
        depEnv[`${envPrefix}_HOST`] = "localhost";
        depEnv[`${envPrefix}_PORT`] = String(mappedPort);
        const url = buildTcpDepUrl(dep.tcpProtocol, mappedPort);
        if (url) {
          depEnv[`${envPrefix}_URL`] = url;
        }
        const shadowUrl = buildTcpDepShadowUrl(dep.tcpProtocol, mappedPort);
        if (shadowUrl) {
          depEnv[`${envPrefix}_SHADOW_URL`] = shadowUrl;
        }
        process.stdout.write(`Dependency ${dep.name} available at localhost:${mappedPort}\n`);
        if (url) {
          process.stdout.write(`  ${envPrefix}_URL=${url}\n`);
        }
        if (shadowUrl) {
          process.stdout.write(`  ${envPrefix}_SHADOW_URL=${shadowUrl}\n`);
        }
      }
    }
  }

  // Apply config-level envMap from dependency references
  for (const depRef of app.dependencies) {
    if (depRef.envMap) {
      for (const [target, source] of Object.entries(depRef.envMap)) {
        if (!(source in depEnv)) {
          throw new Error(
            `envMap on dependency '${depRef.app}': source variable '${source}' not found in dependency env. ` +
            `Available: ${Object.keys(depEnv).join(", ") || "(none)"}`
          );
        }
        depEnv[target] = depEnv[source];
      }
    }
  }

  const stopDeps = () => {
    if (startedServices.length > 0 && overlay) {
      process.stdout.write(`Stopping dependencies (${startedServices.join(", ")})...\n`);
      try {
        runDockerComposeStop(repoPath, overlay.composeFiles, overlay.overlayPath, startedServices);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Warning: failed to stop dependencies: ${msg}\n`);
      }
    }
  };

  return {
    repoPath,
    app,
    workspace,
    depEnv,
    secretManager: config.secretManager,
    overlay,
    startedServices,
    dependencyApps: startDependencies ? dependencyNames(dependencies) : [],
    stopDeps
  };
}

/**
 * Register a Traefik route for a proxy app pointing at its externally-managed
 * upstream. No process is started and the route is not torn down on exit — it
 * persists until `dev app rm`. Re-running the same app is an idempotent upsert;
 * a different live app already claiming the host throws a conflict.
 */
function registerProxyRoute(repoPath: string, app: DevrouterProxyApp, workspace?: string): void {
  const { port, upstreamHost } = parseUpstream(app.upstream);

  // TCP proxy routes are SNI-routed, and Traefik reads SNI only from a TLS
  // ClientHello — so TLS must be installed or the route can never match.
  if (app.protocol === "tcp" && !isTLSEnabled()) {
    throw new Error(
      `App "${app.name}" is a TCP proxy route, which requires TLS (SNI). Run \`dev tls install\` first.`
    );
  }

  // A TCP proxy needs the shared protocol entrypoint (and its published host
  // port) to exist on Traefik; activate it and restart the router if it was not
  // already active.
  if (app.protocol === "tcp") {
    const needsRestart = activateTcpProtocol(app.tcpProtocol);
    if (needsRestart) {
      process.stdout.write(`Restarting router for new TCP entrypoint: ${app.tcpProtocol}\n`);
      startRouterStack();
    }
  }

  // Re-running a proxy app is an idempotent re-register: drop our own prior route
  // first so the shared guard doesn't treat it as "already running", then reuse
  // assertAppNotRunning to evict stale routes and reject a live hostname conflict.
  removeHostRouteById(buildHostRouteId(repoPath, app.name));
  assertAppNotRunning(repoPath, { name: app.name, host: app.host });

  upsertHostRoute({
    name: app.name,
    host: app.host,
    protocol: app.protocol,
    tcpProtocol: app.protocol === "tcp" ? app.tcpProtocol : undefined,
    repoPath,
    port,
    upstreamHost,
    mode: "proxy",
    workspace
  });

  if (app.protocol === "tcp") {
    const entryPort = TCP_PROTOCOL_REGISTRY[app.tcpProtocol]?.port ?? port;
    process.stdout.write(
      `TCP proxy route ready: ${app.tcpProtocol}://${app.host}:${entryPort} -> ${app.upstream} (tls required)\n`
    );
    return;
  }

  const scheme = isTLSEnabled() ? "https" : "http";
  process.stdout.write(`Proxy route ready: ${scheme}://${app.host} -> ${app.upstream}\n`);
}

export async function runConfiguredApp(options: RunAppOptions): Promise<RunAppResult> {
  const deps = await startAppDependencies(options);

  try {
    if (deps.app.runtime === "host") {
      await runHostApp(deps.repoPath, deps.app, deps.depEnv, deps.secretManager, options.env, deps.workspace);
    } else if (deps.app.runtime === "proxy") {
      registerProxyRoute(deps.repoPath, deps.app, deps.workspace);
    } else if (deps.app.kind !== "dependency" && deps.app.protocol === "tcp") {
      const registryEntry = TCP_PROTOCOL_REGISTRY[deps.app.tcpProtocol];
      const port = registryEntry?.port ?? "?";
      process.stdout.write(
        `TCP route ready: ${deps.app.tcpProtocol}://${deps.app.host}:${port} (tls required)\n`
      );
    }
  } finally {
    deps.stopDeps();
  }

  return {
    repoPath: deps.repoPath,
    appName: deps.app.name,
    mode: deps.app.runtime,
    startedServices: deps.startedServices,
    dependencyApps: deps.dependencyApps
  };
}

export async function execWithAppEnv(options: ExecAppOptions): Promise<ExecAppResult> {
  const deps = await startAppDependencies({
    name: options.name,
    repoPath: options.repoPath,
    yes: options.yes,
    workspace: options.workspace,
    stopPolicy: "stop-only-newly-started"
  });

  try {
    if (options.command.length === 0) {
      throw new Error("No command provided to dev app exec. Use `dev app exec <name> -- <command>`.");
    }

    if (options.shell && options.command.length !== 1) {
      throw new Error(
        "--shell requires exactly one command string after `--` (example: dev app exec web --shell -- \"echo $DATABASE_URL\")."
      );
    }

    const env = buildExecEnvironment(deps.depEnv);
    let child: ReturnType<typeof spawn>;

    if (deps.secretManager) {
      const resolvedSmCmd = resolveSmCommand(deps.secretManager.command, deps.secretManager.defaultEnv, options.env);
      if (options.shell) {
        const wrapped = wrapWithSecretManager(
          resolvedSmCmd, deps.depEnv, options.command[0], true
        ) as string;
        child = spawn(wrapped, {
          cwd: deps.repoPath,
          stdio: "inherit",
          shell: true,
          env
        });
      } else {
        const wrapped = wrapWithSecretManager(
          resolvedSmCmd, deps.depEnv, options.command, false
        ) as string[];
        const [cmd, ...wrappedArgs] = wrapped;
        child = spawn(cmd, wrappedArgs, {
          cwd: deps.repoPath,
          stdio: "inherit",
          shell: false,
          env
        });
      }
    } else if (options.shell) {
      child = spawn(options.command[0], {
        cwd: deps.repoPath,
        stdio: "inherit",
        shell: true,
        env
      });
    } else {
      const [command, ...args] = options.command;
      child = spawn(command, args, {
        cwd: deps.repoPath,
        stdio: "inherit",
        shell: false,
        env
      });
    }

    const renderedCommand = options.command.join(" ");
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", (error) => {
        reject(new Error(`Failed to start command '${renderedCommand}': ${toError(error).message}`));
      });
      child.once("exit", (code) => resolve(code ?? 1));
    });

    return { exitCode };
  } finally {
    deps.stopDeps();
  }
}
