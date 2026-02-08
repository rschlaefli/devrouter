import path from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { DevrouterApp, DevrouterHostHttpApp } from "../types";
import { prepareDockerOverlay, runDockerComposeUp } from "./docker-run";
import { resolveAppByName, resolveAppDependencies, resolveRepoPath } from "./repo-config";
import { buildHostRouteId, removeHostRouteById, upsertHostRoute } from "./host-routes";
import { ensureNetwork } from "./docker";
import { DEVNET_NAME, ensureRouterFiles } from "./router";

const POLL_INTERVAL_MS = 1000;
const INITIAL_PORT_TIMEOUT_MS = 30_000;
const PROCESS_TERMINATION_GRACE_MS = 3_000;

type RunAppOptions = {
  name: string;
  repoPath?: string;
  yes?: boolean;
};

type RunAppResult = {
  repoPath: string;
  appName: string;
  mode: "host" | "docker";
  startedServices: string[];
  dependencyApps: string[];
};

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

async function runHostApp(repoPath: string, app: DevrouterHostHttpApp): Promise<void> {
  const routeId = buildHostRouteId(repoPath, app.name);
  const commandCwd = path.resolve(repoPath, app.hostRun.cwd);
  const child = spawn(app.hostRun.command, {
    cwd: commandCwd,
    stdio: "inherit",
    shell: true
  });

  if (!child.pid) {
    throw new Error(`Failed to start command '${app.hostRun.command}'.`);
  }

  process.stdout.write(`Started '${app.hostRun.command}' for '${app.name}' in ${commandCwd}\n`);

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
        process.stdout.write(`Route ${app.host} -> http://host.docker.internal:${selectedPort}\n`);
      } else if (!currentPort && Date.now() - startedAt > INITIAL_PORT_TIMEOUT_MS) {
        throw new Error(
          `No listening TCP port detected for '${app.name}' after ${Math.floor(
            INITIAL_PORT_TIMEOUT_MS / 1000
          )}s.`
        );
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

export async function runConfiguredApp(options: RunAppOptions): Promise<RunAppResult> {
  ensureRouterFiles();
  await ensureNetwork(DEVNET_NAME);

  const repoPath = resolveRepoPath(options.repoPath);
  const { config, app } = resolveAppByName(repoPath, options.name);
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

  const startedServices: string[] = [];
  if (selectedDockerApps.length > 0) {
    const overlay = prepareDockerOverlay(repoPath, app.name, selectedDockerApps);
    const services = selectedDockerApps.map((entry) => entry.docker.service);
    runDockerComposeUp(repoPath, overlay.composeFiles, overlay.overlayPath, services);
    startedServices.push(...services);
  }

  if (app.runtime === "host") {
    await runHostApp(repoPath, app);
  } else if (app.protocol === "tcp") {
    process.stdout.write(
      `TCP route ready: postgres://${app.host}:5432 (tls required, e.g. sslmode=require)\n`
    );
  }

  return {
    repoPath,
    appName: app.name,
    mode: app.runtime,
    startedServices,
    dependencyApps: startDependencies ? dependencyNames(dependencies) : []
  };
}
