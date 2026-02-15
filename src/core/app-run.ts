import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { DevrouterApp, DevrouterDockerPostgresApp, DevrouterHostHttpApp } from "../types";
import {
  prepareDockerOverlay,
  runDockerComposeUp,
  runDockerComposeStop,
  runDockerComposeLogs,
  queryMappedPort,
  queryRunningComposeServices
} from "./docker-run";
import { resolveAppByName, resolveAppDependencies, resolveRepoPath } from "./repo-config";
import { buildHostRouteId, removeHostRouteById, upsertHostRoute } from "./host-routes";
import { ensureNetwork } from "./docker";
import { DEVNET_NAME, ensureRouterFiles } from "./router";
import { assertPathWithinRepo } from "./paths";
import { ensureTLSHostsCovered } from "./tls";

const POLL_INTERVAL_MS = 1000;
const DEFAULT_PORT_TIMEOUT_MS = 120_000;
const PROCESS_TERMINATION_GRACE_MS = 3_000;

type RunAppOptions = {
  name: string;
  repoPath?: string;
  yes?: boolean;
};

type DependencyStopPolicy = "always-stop-selected" | "stop-only-newly-started";

type StartAppDependenciesOptions = RunAppOptions & {
  stopPolicy?: DependencyStopPolicy;
};

type RunAppResult = {
  repoPath: string;
  appName: string;
  mode: "host" | "docker";
  startedServices: string[];
  dependencyApps: string[];
};

type ExecAppOptions = {
  name: string;
  repoPath?: string;
  yes?: boolean;
  shell?: boolean;
  envMap?: string[];
  command: string[];
};

type ExecAppResult = {
  exitCode: number;
};

type StartedDeps = {
  repoPath: string;
  app: DevrouterApp;
  depEnv: Record<string, string>;
  overlay?: ReturnType<typeof prepareDockerOverlay>;
  startedServices: string[];
  dependencyApps: string[];
  stopDeps: () => void;
};

type EnvMapEntry = {
  target: string;
  source: string;
};

const VALID_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export function parseEnvMapEntries(mappings: string[] = []): EnvMapEntry[] {
  return mappings.map((mapping) => {
    const separator = mapping.indexOf("=");
    if (separator <= 0 || separator === mapping.length - 1) {
      throw new Error(
        `Invalid --env-map value '${mapping}'. Expected TARGET=SOURCE with environment variable names.`
      );
    }

    const target = mapping.slice(0, separator).trim();
    const source = mapping.slice(separator + 1).trim();
    if (!VALID_ENV_NAME_RE.test(target) || !VALID_ENV_NAME_RE.test(source)) {
      throw new Error(
        `Invalid --env-map value '${mapping}'. TARGET and SOURCE must match ${VALID_ENV_NAME_RE.toString()}.`
      );
    }

    return { target, source };
  });
}

export function buildExecEnvironment(
  depEnv: Record<string, string>,
  envMap: string[] = [],
  processEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const mergedEnv: Record<string, string> = {
    ...normalizeProcessEnv(processEnv),
    ...depEnv
  };

  for (const mapping of parseEnvMapEntries(envMap)) {
    const sourceValue = mergedEnv[mapping.source];
    if (sourceValue === undefined) {
      throw new Error(
        `--env-map '${mapping.target}=${mapping.source}' references missing source variable '${mapping.source}'.`
      );
    }
    mergedEnv[mapping.target] = sourceValue;
  }

  return mergedEnv;
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
  extraEnv: Record<string, string> = {}
): Promise<void> {
  const routeId = buildHostRouteId(repoPath, app.name);
  const commandCwd = assertPathWithinRepo(app.hostRun.cwd, repoPath, "hostRun.cwd");
  const freePort = await findFreePort();
  // shell:true is intentional — .devrouter.yml is a user-controlled local config file
  // with the same trust model as npm scripts or docker-compose commands. The user who
  // edits the config already has local shell access.
  const child = spawn(app.hostRun.command, {
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
          command: app.hostRun.command
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
  const { config, app } = resolveAppByName(repoPath, options.name);
  const tlsCoverage = await ensureTLSHostsCovered(config.apps.map((entry) => entry.host));
  if (tlsCoverage.refreshed) {
    process.stdout.write(
      `Refreshed TLS cert host coverage for: ${tlsCoverage.uncoveredHosts.join(", ")}\n`
    );
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

  const startDependencies = await shouldStartDependencies(
    app.name,
    dependencies,
    Boolean(options.yes)
  );

  const selectedApps = uniqueApps(
    startDependencies ? [app, ...dependencies] : [app]
  );
  const selectedDockerApps = selectedApps.filter(
    (entry): entry is Exclude<DevrouterApp, DevrouterHostHttpApp> => entry.runtime === "docker"
  );
  const stopPolicy = options.stopPolicy ?? "always-stop-selected";

  const startedServices: string[] = [];
  let overlay: ReturnType<typeof prepareDockerOverlay> | undefined;

  const hasTcpDeps = app.runtime === "host" && selectedDockerApps.some(
    (entry) => entry.protocol === "tcp"
  );

  if (selectedDockerApps.length > 0) {
    overlay = prepareDockerOverlay(repoPath, app.name, selectedDockerApps, hasTcpDeps);
    const services = selectedDockerApps.map((entry) => entry.docker.service);
    let runningServicesBefore: Set<string> | null = null;
    let ownershipKnown = true;
    if (stopPolicy === "stop-only-newly-started") {
      const preRunServices = queryRunningComposeServices(
        repoPath,
        overlay.composeFiles,
        overlay.overlayPath,
        services
      );
      if (preRunServices.status === "known") {
        runningServicesBefore = preRunServices.runningServices;
      } else {
        ownershipKnown = false;
        process.stderr.write(
          "Warning: unable to determine which dependencies were already running before 'dev app exec'; " +
            "leaving dependencies running after command exit to avoid stopping non-owned services. " +
            `Details: ${preRunServices.reason}\n`
        );
      }
    }

    runDockerComposeUp(repoPath, overlay.composeFiles, overlay.overlayPath, services);
    if (stopPolicy === "stop-only-newly-started") {
      if (ownershipKnown && runningServicesBefore) {
        startedServices.push(...services.filter((service) => !runningServicesBefore.has(service)));
      }
    } else {
      startedServices.push(...services);
    }
    runDockerComposeLogs(repoPath, overlay.composeFiles, overlay.overlayPath, services);
  }

  const depEnv: Record<string, string> = {};
  if (hasTcpDeps && overlay) {
    const tcpDeps = selectedDockerApps.filter(
      (entry): entry is DevrouterDockerPostgresApp => entry.protocol === "tcp"
    );
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
        if (dep.tcpProtocol === "postgres") {
          depEnv["DATABASE_URL"] = `postgres://prisma:prisma@localhost:${mappedPort}/prisma`;
          depEnv["SHADOW_DATABASE_URL"] = `postgres://prisma:prisma@localhost:${mappedPort}/shadow`;
        }
        process.stdout.write(`Dependency ${dep.name} available at localhost:${mappedPort}\n`);
        if (dep.tcpProtocol === "postgres") {
          process.stdout.write(`  DATABASE_URL=postgres://prisma:prisma@localhost:${mappedPort}/prisma\n`);
          process.stdout.write(`  SHADOW_DATABASE_URL=postgres://prisma:prisma@localhost:${mappedPort}/shadow\n`);
        }
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
    depEnv,
    overlay,
    startedServices,
    dependencyApps: startDependencies ? dependencyNames(dependencies) : [],
    stopDeps
  };
}

export async function runConfiguredApp(options: RunAppOptions): Promise<RunAppResult> {
  const deps = await startAppDependencies(options);

  try {
    if (deps.app.runtime === "host") {
      await runHostApp(deps.repoPath, deps.app, deps.depEnv);
    } else if (deps.app.protocol === "tcp") {
      process.stdout.write(
        `TCP route ready: postgres://${deps.app.host}:5432 (tls required, e.g. sslmode=require)\n`
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

    const env = buildExecEnvironment(deps.depEnv, options.envMap);
    let child: ReturnType<typeof spawn>;

    if (options.shell) {
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
