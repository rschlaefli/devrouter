import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiagnosticCheck } from "../types";
import { DEVROUTER_HOME } from "./router";
import type { IdleStopOutcome } from "./workspace-idle";

export const IDLE_SWEEP_LABEL = "dev.devrouter.idle-stop";
const SWEEP_INTERVAL_SECONDS = 300;
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export type IdleSweepPaths = {
  plist: string;
  directory: string;
  log: string;
  lastSweep: string;
  lock: string;
};

export type LastIdleSweep = {
  finishedAt: string;
  idleFor: string;
  stopped: number;
  skipped: number;
  failed: number;
  error?: string;
};

export type LaunchctlRunner = (args: string[]) => { status: number | null; stderr: string };

export function idleSweepPaths(
  home = os.homedir(),
  devrouterHome = DEVROUTER_HOME,
): IdleSweepPaths {
  const directory = path.join(devrouterHome, "idle");
  return {
    plist: path.join(home, "Library", "LaunchAgents", `${IDLE_SWEEP_LABEL}.plist`),
    directory,
    log: path.join(directory, "sweep.log"),
    lastSweep: path.join(directory, "last-sweep.json"),
    lock: path.join(directory, "sweep.lock"),
  };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Render the launchd agent. launchd starts jobs without a login shell, so the
 * node binary, the CLI entry point and every tool directory are absolute.
 */
export function renderIdleSweepPlist(input: {
  nodePath: string;
  entryPath: string;
  idleFor: string;
  environment: Record<string, string>;
  logPath: string;
}): string {
  const args = [
    input.nodePath,
    input.entryPath,
    "workspace",
    "idle",
    "--stop",
    "--idle-for",
    input.idleFor,
  ];
  const env = Object.entries(input.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${IDLE_SWEEP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((arg) => `      <string>${xml(arg)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>StartInterval</key>
    <integer>${SWEEP_INTERVAL_SECONDS}</integer>
    <key>StandardOutPath</key>
    <string>${xml(input.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(input.logPath)}</string>
  </dict>
</plist>
`;
}

/** Read the `--idle-for` value of an installed agent, or undefined when absent. */
export function readInstalledIdleFor(plistPath: string): string | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(plistPath, "utf-8");
  } catch {
    return undefined;
  }
  return (
    /<string>--idle-for<\/string>\s*<string>([^<]+)<\/string>/.exec(contents)?.[1] ?? "unknown"
  );
}

function locateTool(name: string): string | undefined {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf-8" });
  const found = result.status === 0 ? result.stdout.trim() : "";
  return found.startsWith("/") ? found : undefined;
}

/**
 * The environment the sweep needs: tool directories for docker and the
 * workspace provider, plus any Docker endpoint selection of the current shell.
 */
export function resolveIdleSweepEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  locate: (name: string) => string | undefined = locateTool,
): Record<string, string> {
  const docker = locate("docker");
  if (!docker)
    throw new Error("docker is not on PATH; the idle sweep cannot inspect environments.");
  const toolDirs = [docker, locate("devsy"), locate("devpod"), process.execPath]
    .filter((tool): tool is string => Boolean(tool))
    .map((tool) => path.dirname(tool));
  const environment: Record<string, string> = {
    PATH: [...new Set([...toolDirs, ...SYSTEM_PATH])].join(":"),
  };
  if (env.HOME) environment.HOME = env.HOME;
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT"] as const) {
    if (env[key]) environment[key] = env[key] as string;
  }
  return environment;
}

const defaultLaunchctl: LaunchctlRunner = (args) => {
  const result = spawnSync("launchctl", args, { encoding: "utf-8" });
  return { status: result.status, stderr: result.stderr || result.error?.message || "" };
};

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/** Write (or rewrite) the agent and reload it into the user's launchd domain. */
export function installIdleSweep(input: {
  idleFor: string;
  paths?: IdleSweepPaths;
  environment?: Record<string, string>;
  entryPath?: string;
  launchctl?: LaunchctlRunner;
}): IdleSweepPaths {
  if (process.platform !== "darwin" && !input.launchctl)
    throw new Error("The idle sweep uses launchd and is only available on macOS.");
  const paths = input.paths ?? idleSweepPaths();
  const launchctl = input.launchctl ?? defaultLaunchctl;
  const entryPath = input.entryPath ?? fs.realpathSync(process.argv[1]);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
  const contents = renderIdleSweepPlist({
    nodePath: process.execPath,
    entryPath,
    idleFor: input.idleFor,
    environment: input.environment ?? resolveIdleSweepEnvironment(),
    logPath: paths.log,
  });
  launchctl(["bootout", `${launchDomain()}/${IDLE_SWEEP_LABEL}`]);
  fs.writeFileSync(paths.plist, contents, { mode: 0o644 });
  const loaded = launchctl(["bootstrap", launchDomain(), paths.plist]);
  if (loaded.status !== 0)
    throw new Error(
      `launchctl bootstrap failed: ${loaded.stderr.trim() || `exit ${loaded.status}`}`,
    );
  return paths;
}

/** Unload and delete the agent. Absence is success. */
export function removeIdleSweep(
  input: { paths?: IdleSweepPaths; launchctl?: LaunchctlRunner } = {},
): boolean {
  const paths = input.paths ?? idleSweepPaths();
  if (!fs.existsSync(paths.plist)) return false;
  (input.launchctl ?? defaultLaunchctl)(["bootout", `${launchDomain()}/${IDLE_SWEEP_LABEL}`]);
  fs.rmSync(paths.plist, { force: true });
  return true;
}

export function summarizeSweep(
  idleFor: string,
  stops: IdleStopOutcome[],
  error?: unknown,
): LastIdleSweep {
  const count = (outcome: IdleStopOutcome["outcome"]) =>
    stops.filter((stop) => stop.outcome === outcome).length;
  return {
    finishedAt: new Date().toISOString(),
    idleFor,
    stopped: count("stopped"),
    skipped: count("skipped"),
    failed: count("failed"),
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.message : String(error) }),
  };
}

export function writeLastSweep(
  record: LastIdleSweep,
  paths: IdleSweepPaths = idleSweepPaths(),
): void {
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.lastSweep, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function readLastSweep(paths: IdleSweepPaths): LastIdleSweep | undefined {
  try {
    return JSON.parse(fs.readFileSync(paths.lastSweep, "utf-8")) as LastIdleSweep;
  } catch {
    return undefined;
  }
}

/** Doctor check for the opt-in sweep: configuration and the last recorded run. */
export function idleSweepCheck(
  paths: IdleSweepPaths = idleSweepPaths(),
  nowMs = Date.now(),
): DiagnosticCheck {
  const idleFor = readInstalledIdleFor(paths.plist);
  if (!idleFor) {
    return {
      id: "global.idle-stop",
      level: "ok",
      summary: "Idle stop is off; idle environments keep running.",
      suggestion: "Enable it with: devrouter setup --yes --idle-stop 30m",
    };
  }
  const last = readLastSweep(paths);
  if (!last) {
    return {
      id: "global.idle-stop",
      level: "warn",
      summary: `Idle stop is installed (idle for ${idleFor}) but has not recorded a sweep yet.`,
      details: `Agent: ${paths.plist}. Log: ${paths.log}.`,
      suggestion: `Check the agent with: launchctl print ${launchDomain()}/${IDLE_SWEEP_LABEL}`,
    };
  }
  const ageMs = nowMs - Date.parse(last.finishedAt);
  const stale = !(ageMs <= SWEEP_INTERVAL_SECONDS * 3 * 1000);
  const counts = `stopped=${last.stopped}, skipped=${last.skipped}, failed=${last.failed}`;
  if (last.error) {
    return {
      id: "global.idle-stop",
      level: "warn",
      summary: "The last idle sweep could not inspect environments.",
      details: `finishedAt=${last.finishedAt}: ${last.error}`,
      suggestion:
        "Rewrite the agent with the current tool paths: devrouter setup --yes --idle-stop " +
        idleFor,
    };
  }
  return {
    id: "global.idle-stop",
    level: stale || last.failed > 0 ? "warn" : "ok",
    summary: stale
      ? `Idle stop is installed (idle for ${idleFor}) but has not swept since ${last.finishedAt}.`
      : `Idle stop is active (idle for ${idleFor}); last sweep ${last.finishedAt}.`,
    details: `${counts}. Log: ${paths.log}.`,
    ...(stale || last.failed > 0 ? { suggestion: `Inspect: ${paths.log}` } : {}),
  };
}
