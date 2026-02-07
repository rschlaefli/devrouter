import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HostRouteStrategy } from "../types";
import { resolveHostRoute } from "./host-config";
import {
  buildHostRouteId,
  ensureHostRouteStorage,
  listHostRouteState,
  removeHostRouteById,
  upsertHostRoute
} from "./host-routes";

const POLL_INTERVAL_MS = 1000;
const INITIAL_PORT_TIMEOUT_MS = 30_000;

type MonitorOptions = {
  name: string;
  host: string;
  repoPath: string;
  command: string;
  strategy: HostRouteStrategy;
  rootPid: number;
  mode: "run" | "attach";
  removeOnProcessExit: boolean;
  removeOnSignal: boolean;
  onSignal?: (signal: NodeJS.Signals) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
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
      // Best effort process cleanup.
    }
  }
}

function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>();
  const lines = output.split("\n");
  for (const line of lines) {
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

function selectAllowedPort(ports: number[], strategy: HostRouteStrategy): number | undefined {
  const deny = new Set<number>([80, 443, ...strategy.denyPorts]);
  const range = parseAllowedPortRange(strategy.allowPortRange);

  const deniedPort = ports.find((port) => deny.has(port));
  if (deniedPort) {
    throw new Error(
      `Detected forbidden port ${deniedPort}. Host apps must not bind 80/443 because Traefik owns those ports.`
    );
  }

  return ports.find((port) => port >= range.min && port <= range.max && !deny.has(port));
}

function readProcessCwd(pid: number): string | null {
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf-8"
  });

  if (result.status !== 0) {
    return null;
  }

  const line = result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("n"));
  if (!line) {
    return null;
  }

  const cwd = line.slice(1).trim();
  return cwd || null;
}

function findPidByCommand(command: string, routeCwd: string): number {
  const result = spawnSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error("Unable to inspect running processes.");
  }

  const commandMatches: number[] = [];
  const cwdMatches: number[] = [];

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace <= 0) {
      continue;
    }

    const pid = Number(trimmed.slice(0, firstSpace).trim());
    const cmd = trimmed.slice(firstSpace + 1);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    if (!cmd.includes(command)) {
      continue;
    }

    commandMatches.push(pid);
    const cwd = readProcessCwd(pid);
    if (cwd && path.resolve(cwd) === path.resolve(routeCwd)) {
      cwdMatches.push(pid);
    }
  }

  if (cwdMatches.length === 1) {
    return cwdMatches[0];
  }

  if (cwdMatches.length > 1) {
    throw new Error(
      `Found multiple matching processes for '${command}' in ${routeCwd}: ${cwdMatches.join(", ")}`
    );
  }

  if (commandMatches.length === 1) {
    return commandMatches[0];
  }

  if (commandMatches.length > 1) {
    throw new Error(
      `Found multiple processes matching '${command}'. Re-run after stopping extra processes.`
    );
  }

  throw new Error(`No running process found matching '${command}'.`);
}

async function monitorRoute(options: MonitorOptions): Promise<void> {
  const routeId = buildHostRouteId(options.repoPath, options.name);
  const startedAt = Date.now();
  let currentPort: number | undefined;
  let stopRequestedBySignal = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    stopRequestedBySignal = true;
    if (options.onSignal) {
      options.onSignal(signal);
    }
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    while (true) {
      if (stopRequestedBySignal) {
        break;
      }

      if (!isProcessRunning(options.rootPid)) {
        break;
      }

      const pids = readProcessTree(options.rootPid);
      const ports = detectListeningPorts(pids);
      const selectedPort = selectAllowedPort(ports, options.strategy);

      if (selectedPort !== undefined) {
        if (selectedPort !== currentPort) {
          currentPort = selectedPort;
          upsertHostRoute({
            name: options.name,
            host: options.host,
            repoPath: options.repoPath,
            port: selectedPort,
            mode: options.mode,
            pid: options.rootPid,
            command: options.command
          });

          process.stdout.write(
            `Route ${options.host} -> http://host.docker.internal:${selectedPort}\n`
          );
        }
      } else if (!currentPort && Date.now() - startedAt > INITIAL_PORT_TIMEOUT_MS) {
        throw new Error(
          `No listening TCP port detected for route '${options.name}' after ${Math.floor(
            INITIAL_PORT_TIMEOUT_MS / 1000
          )}s.`
        );
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);

    const processStillRunning = isProcessRunning(options.rootPid);

    if (stopRequestedBySignal && options.removeOnSignal) {
      removeHostRouteById(routeId);
    } else if (!stopRequestedBySignal && !processStillRunning && options.removeOnProcessExit) {
      removeHostRouteById(routeId);
    }
  }
}

export async function runHostRoute(name: string, repoPath?: string): Promise<void> {
  ensureHostRouteStorage();
  const resolved = resolveHostRoute(name, repoPath);

  const child = spawn(resolved.route.command, {
    cwd: resolved.routeCwd,
    stdio: "inherit",
    shell: true
  });

  if (!child.pid) {
    throw new Error(`Failed to start host route command '${resolved.route.command}'.`);
  }

  process.stdout.write(
    `Started '${resolved.route.command}' for route '${resolved.route.name}' in ${resolved.routeCwd}\n`
  );

  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  try {
    await monitorRoute({
      name: resolved.route.name,
      host: resolved.route.host,
      repoPath: resolved.repoPath,
      command: resolved.route.command,
      strategy: resolved.route.strategy,
      rootPid: child.pid,
      mode: "run",
      removeOnProcessExit: true,
      removeOnSignal: true,
      onSignal: (signal) => {
        if (isProcessRunning(child.pid!)) {
          killProcessTree(child.pid!, signal);
        }
      }
    });
  } catch (error) {
    if (isProcessRunning(child.pid)) {
      killProcessTree(child.pid, "SIGTERM");
    }

    await childExit;
    throw error;
  }

  const exit = await childExit;
  if (exit.code !== null && exit.code !== 0) {
    throw new Error(`Host route command exited with code ${exit.code}.`);
  }
}

export async function attachHostRoute(name: string, repoPath?: string): Promise<void> {
  ensureHostRouteStorage();
  const resolved = resolveHostRoute(name, repoPath);
  const routeId = buildHostRouteId(resolved.repoPath, resolved.route.name);
  const existing = listHostRouteState().find(
    (entry) => entry.id === routeId && entry.pid && isProcessRunning(entry.pid)
  );

  const pid =
    existing?.pid ??
    findPidByCommand(resolved.route.command, resolved.routeCwd);

  process.stdout.write(
    `Attached route '${resolved.route.name}' (${resolved.route.host}) to pid ${pid}\n`
  );

  await monitorRoute({
    name: resolved.route.name,
    host: resolved.route.host,
    repoPath: resolved.repoPath,
    command: resolved.route.command,
    strategy: resolved.route.strategy,
    rootPid: pid,
    mode: "attach",
    removeOnProcessExit: true,
    removeOnSignal: false
  });
}
