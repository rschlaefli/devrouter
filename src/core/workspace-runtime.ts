import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";
import { type DevpodWorkspace, listDevpodWorkspacesRaw } from "./devpod-registry";
import { type DevsyWorkspace, listDevsyWorkspaces } from "./devsy-workspaces";
import { DEVROUTER_HOME } from "./router";
import { sameWorkspacePath } from "./workspace";

export type WorkspaceRuntime = "devpod" | "devsy";

const SUPPORTED_RUNTIMES: readonly WorkspaceRuntime[] = ["devpod", "devsy"];
const RUNTIME_CONFIG_FILE = path.join(DEVROUTER_HOME, "workspace-runtime.json");
const INACTIVITY_TIMEOUT_PATTERN = /^(?:\d+(?:ms|s|m|h))+$/;

export type WorkspaceRuntimeConfig = {
  runtime?: WorkspaceRuntime;
  devsyInactivityTimeout?: string;
};

export type WorkspaceRuntimeSource =
  | "override"
  | "env"
  | "path-owner"
  | "machine-config"
  | "auto-detect"
  | "default";

export type WorkspaceRuntimeResolution = {
  runtime: WorkspaceRuntime;
  source: WorkspaceRuntimeSource;
};

export type WorkspaceRegistrySnapshots = {
  devpod?: DevpodWorkspace[];
  devsy?: DevsyWorkspace[];
  /** Runtimes whose CLI is installed but whose registry could not be read. */
  unavailable: WorkspaceRuntime[];
  /** Failure detail for unavailable registries, keyed by runtime. */
  errors: Partial<Record<WorkspaceRuntime, string>>;
};

let cachedRuntime: WorkspaceRuntimeResolution | undefined;
let cachedSnapshots: WorkspaceRegistrySnapshots | undefined;

export class UnsupportedWorkspaceRuntimeError extends Error {}

export class WorkspaceRuntimeOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRuntimeOwnershipError";
  }
}

export function parseWorkspaceRuntime(value: string): WorkspaceRuntime {
  const requested = value.trim().toLowerCase();
  if (!SUPPORTED_RUNTIMES.includes(requested as WorkspaceRuntime)) {
    throw new UnsupportedWorkspaceRuntimeError(
      `Unsupported workspace runtime '${value}'. Supported: ${SUPPORTED_RUNTIMES.join(", ")}.`,
    );
  }
  return requested as WorkspaceRuntime;
}

function isRuntimeInstalled(runtime: WorkspaceRuntime): boolean {
  // Each runtime only accepts one spelling: Devsy answers the global
  // --version flag, DevPod answers the version subcommand and rejects the
  // flag. Neither probe touches a workspace registry.
  const probeArgs = runtime === "devsy" ? ["--version"] : ["version"];
  const probe = spawnSync(runtime, probeArgs, { encoding: "utf-8" });
  return probe.status === 0 && !probe.error;
}

/**
 * Read the persisted machine-level workspace runtime preference. Corrupt or
 * partially invalid files degrade to the valid subset; doctor surfaces the
 * problem separately so a damaged file never bricks every command.
 */
export function readWorkspaceRuntimeConfig(): WorkspaceRuntimeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const candidate = raw as Record<string, unknown>;
  const config: WorkspaceRuntimeConfig = {};
  if (typeof candidate.runtime === "string") {
    try {
      config.runtime = parseWorkspaceRuntime(candidate.runtime);
    } catch {
      // Invalid persisted runtime is ignored; doctor reports it.
    }
  }
  if (
    typeof candidate.devsyInactivityTimeout === "string" &&
    INACTIVITY_TIMEOUT_PATTERN.test(candidate.devsyInactivityTimeout)
  ) {
    config.devsyInactivityTimeout = candidate.devsyInactivityTimeout;
  }
  return config;
}

export type WorkspaceRuntimeConfigInspection = {
  exists: boolean;
  config: WorkspaceRuntimeConfig;
  problems: string[];
};

/**
 * Inspect the persisted machine preference including invalid content, for
 * diagnostics. readWorkspaceRuntimeConfig deliberately drops invalid values;
 * doctor needs to report them instead.
 */
export function inspectWorkspaceRuntimeConfig(): WorkspaceRuntimeConfigInspection {
  let rawText: string;
  try {
    rawText = fs.readFileSync(RUNTIME_CONFIG_FILE, "utf-8");
  } catch {
    return { exists: false, config: {}, problems: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { exists: true, config: {}, problems: ["workspace-runtime.json is not valid JSON."] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      exists: true,
      config: {},
      problems: ["workspace-runtime.json must contain a JSON object."],
    };
  }
  const candidate = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (candidate.runtime !== undefined) {
    try {
      parseWorkspaceRuntime(String(candidate.runtime));
    } catch {
      problems.push(`runtime='${String(candidate.runtime)}' is not a supported workspace runtime.`);
    }
  }
  if (candidate.devsyInactivityTimeout !== undefined) {
    const timeout = String(candidate.devsyInactivityTimeout);
    if (!isValidInactivityTimeout(timeout)) {
      problems.push(
        `devsyInactivityTimeout='${timeout}' is not a Go duration such as 30s, 10m, or 1h30m.`,
      );
    }
  }
  return { exists: true, config: readWorkspaceRuntimeConfig(), problems };
}

export function isValidInactivityTimeout(value: string): boolean {
  return INACTIVITY_TIMEOUT_PATTERN.test(value.trim());
}

export function writeWorkspaceRuntimeConfig(config: WorkspaceRuntimeConfig): void {
  const next: WorkspaceRuntimeConfig = {};
  if (config.runtime !== undefined) next.runtime = parseWorkspaceRuntime(config.runtime);
  if (config.devsyInactivityTimeout !== undefined) {
    const timeout = config.devsyInactivityTimeout.trim();
    if (!isValidInactivityTimeout(timeout)) {
      throw new Error(
        `Invalid Devsy inactivity timeout '${config.devsyInactivityTimeout}': use a duration such as 30s, 10m, or 1h30m.`,
      );
    }
    next.devsyInactivityTimeout = timeout;
  }
  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  writeFileAtomically(RUNTIME_CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * List both installed runtimes' registries once per process. Runtimes whose
 * CLI is missing are simply absent; a CLI that exists but cannot list its
 * registry is recorded as unavailable so callers can degrade deliberately.
 */
export function getWorkspaceRegistrySnapshots(): WorkspaceRegistrySnapshots {
  if (cachedSnapshots) return cachedSnapshots;
  const snapshots: WorkspaceRegistrySnapshots = { unavailable: [], errors: {} };
  if (isRuntimeInstalled("devsy")) {
    try {
      snapshots.devsy = listDevsyWorkspaces();
    } catch (error) {
      snapshots.unavailable.push("devsy");
      snapshots.errors.devsy = error instanceof Error ? error.message : String(error);
    }
  }
  if (isRuntimeInstalled("devpod")) {
    try {
      snapshots.devpod = listDevpodWorkspacesRaw();
    } catch (error) {
      snapshots.unavailable.push("devpod");
      snapshots.errors.devpod = error instanceof Error ? error.message : String(error);
    }
  }
  cachedSnapshots = snapshots;
  return snapshots;
}

type PathOwnerResolution =
  | { status: "owner"; runtime: WorkspaceRuntime }
  | { status: "none" }
  | { status: "conflict" }
  | { status: "unavailable"; runtimes: WorkspaceRuntime[] };

function pathOwnerRuntime(
  repoPath: string,
  snapshots: WorkspaceRegistrySnapshots,
): PathOwnerResolution {
  if (snapshots.unavailable.length > 0) {
    return { status: "unavailable", runtimes: snapshots.unavailable };
  }
  const devsyOwners = snapshots.devsy?.filter((workspace) =>
    sameWorkspacePath(workspace.source.localFolder, repoPath),
  );
  const devpodOwners = snapshots.devpod?.filter((workspace) =>
    sameWorkspacePath(workspace.source.localFolder, repoPath),
  );
  if (devsyOwners?.length && devpodOwners?.length) return { status: "conflict" };
  if (devsyOwners?.length) return { status: "owner", runtime: "devsy" };
  if (devpodOwners?.length) return { status: "owner", runtime: "devpod" };
  return { status: "none" };
}

function autoDetectedRuntime(): WorkspaceRuntime | undefined {
  for (const runtime of SUPPORTED_RUNTIMES) {
    if (isRuntimeInstalled(runtime)) return runtime;
  }
  return undefined;
}

/**
 * Resolve the workspace runtime backing devcontainer workspace flows.
 *
 * Precedence: explicit override argument > DEVROUTER_WORKSPACE_RUNTIME >
 * exact-path registry ownership (when both runtimes are installed) > persisted
 * machine preference > auto-detection of an installed CLI > historical DevPod
 * default. The path-owner rule keeps mixed DevPod+Devsy fleets correct: a
 * checkout is always managed by the runtime that registered it, and the
 * machine preference only decides which runtime creates NEW workspaces.
 */
export function resolveWorkspaceRuntimeDetailed(
  repoPath?: string,
  override?: string,
): WorkspaceRuntimeResolution {
  if (override) {
    return { runtime: parseWorkspaceRuntime(override), source: "override" };
  }
  const envRaw = process.env.DEVROUTER_WORKSPACE_RUNTIME?.trim();
  if (envRaw) {
    return { runtime: parseWorkspaceRuntime(envRaw), source: "env" };
  }

  if (repoPath) {
    const snapshots = getWorkspaceRegistrySnapshots();
    const owner = pathOwnerRuntime(repoPath, snapshots);
    if (owner.status === "conflict") {
      throw new WorkspaceRuntimeOwnershipError(
        "Both DevPod and Devsy claim this checkout. Remove the stale registration before running a workspace lifecycle command.",
      );
    }
    if (owner.status === "unavailable") {
      throw new WorkspaceRuntimeOwnershipError(
        `Cannot prove checkout ownership because the ${owner.runtimes.join(
          " and ",
        )} workspace registry is unavailable. Restore registry access before running a workspace lifecycle command.`,
      );
    }
    if (owner.status === "owner") {
      // Path-owner answers are per checkout and derived from cached registry
      // snapshots, so they are computed per call and never cached: an earlier
      // fallback for one path must not mask another path's owner.
      return { runtime: owner.runtime, source: "path-owner" };
    }
  }
  if (cachedRuntime) return cachedRuntime;

  let resolution: WorkspaceRuntimeResolution;
  const machine = readWorkspaceRuntimeConfig().runtime;
  if (machine) {
    resolution = { runtime: machine, source: "machine-config" };
  } else {
    const detected = autoDetectedRuntime();
    resolution = detected
      ? { runtime: detected, source: "auto-detect" }
      : { runtime: "devpod", source: "default" };
  }
  cachedRuntime = resolution;
  return resolution;
}

/**
 * Resolve the active runtime for dispatch sites that must keep working when no
 * runtime CLI is installed. An explicit unsupported override still fails
 * loudly; automatic detection with nothing installed falls back to the
 * historical DevPod default so devrouter keeps its previous behavior.
 */
export function resolveWorkspaceRuntimeOrDefault(repoPath?: string): WorkspaceRuntime {
  return resolveWorkspaceRuntimeDetailed(repoPath).runtime;
}

/**
 * Resolve a runtime from cached registry evidence for report-only callers.
 * Ambiguous or unreadable registry evidence returns undefined so reports can
 * render unknown state without borrowing the mutation path's exception.
 */
export function resolveWorkspaceRuntimeForReport(repoPath?: string): WorkspaceRuntime | undefined {
  const snapshots = getWorkspaceRegistrySnapshots();
  const envRaw = process.env.DEVROUTER_WORKSPACE_RUNTIME?.trim();
  if (envRaw) {
    const runtime = parseWorkspaceRuntime(envRaw);
    return snapshots[runtime] ? runtime : undefined;
  }
  if (repoPath) {
    const owner = pathOwnerRuntime(repoPath, snapshots);
    if (owner.status === "conflict" || owner.status === "unavailable") return undefined;
    if (owner.status === "owner") return owner.runtime;
  }
  const runtime = resolveWorkspaceRuntimeDetailed().runtime;
  return snapshots[runtime] ? runtime : undefined;
}

/**
 * Drop per-process caches. Called after runtime mutations (workspace
 * start/delete) so later resolution in the same process observes the new
 * registry state instead of a stale pre-mutation snapshot.
 */
export function resetWorkspaceRuntimeCaches(): void {
  cachedRuntime = undefined;
  cachedSnapshots = undefined;
}
