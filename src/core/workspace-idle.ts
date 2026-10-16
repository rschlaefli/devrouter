import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HostRouteState } from "../types";
import {
  inspectWorkspaceContainers,
  type WorkspaceContainerSnapshot,
  workspaceAppContainers,
} from "./devpod-environment";
import { listMergedRuntimeWorkspaces } from "./devpod-workspaces";
import { parseInactiveFor } from "./duration";
import { buildHostRouteRouterName, readHostRouteStateReadOnly } from "./host-routes";
import { networkDockerOptions } from "./network-effect-scope";
import {
  listReliabilityOperations,
  type ReliabilityIdleProtection,
  type ReliabilityOperationRecord,
  reliabilityOperationPath,
  setReliabilityIdlePin,
} from "./reliability-operation-store";
import { ROUTER_CONTAINER_NAME } from "./router";
import {
  comparableWorkspacePath,
  isLinkedWorktree,
  readPersistedWorkspace,
  resolveWorktreeWorkspace,
} from "./workspace";
import { resolveGitCommonDir } from "./workspace-ownership";
import { resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

const DEFAULT_IDLE_FOR = "30m";
// Devsy touches the first file; DevPod agents use the second.
const ACTIVITY_FILES = ["/tmp/devsy.activity", "/tmp/devpod.activity"];

export type IdleSignalSource =
  | "http.request"
  | "devsy.activity"
  | "journal.write"
  | "route.updatedAt";

/**
 * `valid` carries the newest activity time. `quiet` proves no activity inside
 * the evidence window without a timestamp. `missing` means the source exists
 * but never recorded activity. `unavailable` means the source could not be
 * read, which never counts as idle.
 */
export type IdleSignal = {
  source: IdleSignalSource;
  status: "valid" | "quiet" | "missing" | "not-applicable" | "unavailable";
  timestamp?: string;
  reason?: string;
};

export type IdleStatus = "active" | "idle" | "unknown" | "protected";

export type IdleClassification = {
  status: IdleStatus;
  latestActivity: string | null;
  reasons: string[];
};

export type WorkspaceIdleRow = IdleClassification & {
  repoPath: string;
  workspace: string | null;
  containerIds: string[];
  signals: IdleSignal[];
  /** Journal revision the evidence was read at; null when no journal exists. */
  journalRevision: number | null;
};

export type WorkspaceIdleReport = {
  generatedAt: string;
  idleFor: string;
  cutoff: string;
  rows: WorkspaceIdleRow[];
  notRunning: string[];
  warnings: string[];
};

export type TraefikRequestWindow =
  | { status: "ok"; newestByRouter: Map<string, number> }
  | { status: "unavailable"; reason: string };

export type CommandResult = { status: number | null; stdout: string; stderr: string };

export type WorkspaceIdleDependencies = {
  now: () => number;
  readRoutes: () => HostRouteState[];
  readJournals: () => ReliabilityOperationRecord[];
  journalModifiedMs: (record: ReliabilityOperationRecord) => number | undefined;
  registryPaths: () => string[];
  inspectContainers: () => WorkspaceContainerSnapshot[];
  statActivity: (containerId: string) => CommandResult;
  readTraefik: (cutoffMs: number) => TraefikRequestWindow;
  isConfiguredCheckout: (repoPath: string) => boolean;
  gitCommonDir: (repoPath: string) => string | undefined;
};

export type WorkspaceIdleOptions = {
  repo?: string;
  idleFor?: string;
  /** Restrict the report to this exact checkout. */
  only?: string;
};

export type IdleStopOutcome = {
  repoPath: string;
  outcome: "stopped" | "skipped" | "failed";
  reason?: string;
};

export type IdleStopResult = WorkspaceIdleReport & { stops: IdleStopOutcome[] };

/**
 * Stops one checkout through the supervised lifecycle stop. The assertion runs
 * inside the journal transaction that records the stop intent.
 */
export type IdleStopper = (
  repoPath: string,
  assertStopIntent: (record: ReliabilityOperationRecord) => void,
) => Promise<unknown>;

class IdleStopSkipped extends Error {}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Classify one running environment. Only complete, readable evidence that is
 * older than the cutoff yields `idle`; a veto always wins.
 */
export function classifyIdle(
  signals: IdleSignal[],
  vetoes: string[],
  cutoffMs: number,
): IdleClassification {
  const times = signals
    .filter((signal) => signal.status === "valid" && signal.timestamp)
    .map((signal) => ({ source: signal.source, ms: Date.parse(signal.timestamp as string) }));
  const newest = times.reduce<number | undefined>(
    (latest, entry) => (latest === undefined || entry.ms > latest ? entry.ms : latest),
    undefined,
  );
  const latestActivity = newest === undefined ? null : iso(newest);
  if (vetoes.length > 0) return { status: "protected", latestActivity, reasons: vetoes };

  const recent = times.filter((entry) => entry.ms >= cutoffMs).map((entry) => entry.source);
  if (recent.length > 0) return { status: "active", latestActivity, reasons: recent };

  const unavailable = signals.filter((signal) => signal.status === "unavailable");
  if (unavailable.length > 0) {
    return {
      status: "unknown",
      latestActivity,
      reasons: unavailable.map((signal) => `${signal.source}: ${signal.reason ?? "unavailable"}`),
    };
  }
  if (!signals.some((signal) => signal.status === "valid" || signal.status === "quiet")) {
    return { status: "unknown", latestActivity, reasons: ["no activity evidence"] };
  }
  return { status: "idle", latestActivity, reasons: [] };
}

/**
 * Newest request time per `@file` router from `docker logs --timestamps`
 * output of Traefik's common-log-format access log. Internal routers such as
 * `api@internal` never match.
 */
export function parseTraefikAccessLog(output: string): Map<string, number> {
  const newest = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s.*"([^"\s]+@file)" "[^"]*" \d+ms\s*$/.exec(line);
    if (!match) continue;
    const ms = Date.parse(match[1]);
    if (Number.isNaN(ms)) continue;
    const router = match[2];
    if ((newest.get(router) ?? Number.NEGATIVE_INFINITY) < ms) newest.set(router, ms);
  }
  return newest;
}

export function httpSignal(routerNames: string[], window: TraefikRequestWindow): IdleSignal {
  if (routerNames.length === 0) return { source: "http.request", status: "not-applicable" };
  if (window.status === "unavailable") {
    return { source: "http.request", status: "unavailable", reason: window.reason };
  }
  const newest = routerNames
    .map((name) => window.newestByRouter.get(name))
    .filter((ms): ms is number => ms !== undefined)
    .sort((left, right) => right - left)[0];
  return newest === undefined
    ? { source: "http.request", status: "quiet" }
    : { source: "http.request", status: "valid", timestamp: iso(newest) };
}

/** Interpret `stat -c %Y` output for the provider activity files of one container. */
export function activitySignal(results: CommandResult[]): IdleSignal {
  if (results.length === 0) {
    return { source: "devsy.activity", status: "unavailable", reason: "no running container" };
  }
  let newest: number | undefined;
  for (const result of results) {
    const seconds = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
    const stderrLines = result.stderr.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const missing =
      stderrLines.length > 0 && stderrLines.every((line) => /no such file/i.test(line));
    if (seconds.length === 0 && (result.status === 0 || !missing)) {
      return {
        source: "devsy.activity",
        status: "unavailable",
        reason: result.stderr.trim().split(/\r?\n/)[0] || "stat failed",
      };
    }
    for (const value of seconds) {
      if (newest === undefined || value * 1000 > newest) newest = value * 1000;
    }
  }
  return newest === undefined
    ? { source: "devsy.activity", status: "missing" }
    : { source: "devsy.activity", status: "valid", timestamp: iso(newest) };
}

export function routeSignal(routes: HostRouteState[] | undefined): IdleSignal {
  if (!routes)
    return { source: "route.updatedAt", status: "unavailable", reason: "route state unreadable" };
  if (routes.length === 0) return { source: "route.updatedAt", status: "not-applicable" };
  const times = routes.map((route) => Date.parse(route.updatedAt));
  if (times.some(Number.isNaN)) {
    return {
      source: "route.updatedAt",
      status: "unavailable",
      reason: "malformed route timestamp",
    };
  }
  return { source: "route.updatedAt", status: "valid", timestamp: iso(Math.max(...times)) };
}

export function journalSignal(
  record: ReliabilityOperationRecord | undefined,
  journals: "ok" | "unreadable",
  modifiedMs: number | undefined,
): IdleSignal {
  if (journals === "unreadable") {
    return { source: "journal.write", status: "unavailable", reason: "journals unreadable" };
  }
  if (!record) return { source: "journal.write", status: "not-applicable" };
  return modifiedMs === undefined
    ? {
        source: "journal.write",
        status: "unavailable",
        reason: "journal modification time unreadable",
      }
    : { source: "journal.write", status: "valid", timestamp: iso(modifiedMs) };
}

/**
 * Lifecycle states that make a stop unsafe or unwanted. Settled manual
 * journals keep their single consumer and request, so those alone never veto.
 */
export function journalVetoes(record: ReliabilityOperationRecord | undefined): string[] {
  if (!record) return [];
  const vetoes: string[] = [];
  const state = record.state;
  if (record.worker) vetoes.push("lifecycle worker running");
  if (state.phase !== "idle" && state.phase !== "stable") vetoes.push(`lifecycle ${state.phase}`);
  if (state.operation && !state.operation.drained) vetoes.push("lifecycle operation unsettled");
  if (state.executionPolicy === "capacity-managed")
    vetoes.push("capacity-managed by the controller");
  if (state.desired === "parked-for-capacity") vetoes.push("parked for capacity");
  if (record.consumerProtection?.humanPinned) vetoes.push("pinned by a person");
  if (record.idleProtection?.pinned) vetoes.push("pinned against idle stop");
  return vetoes;
}

function readTraefikWindow(cutoffMs: number): TraefikRequestWindow {
  const since = String(Math.floor(cutoffMs / 1000));
  const run = (args: string[], maxBuffer: number) =>
    spawnSync("docker", ["logs", "--timestamps", ...args, ROUTER_CONTAINER_NAME], {
      encoding: "utf-8",
      maxBuffer,
      ...networkDockerOptions(),
    });
  // Traefik logs its own startup lines, so any retained output from before the
  // cutoff proves the access log covers the whole window. Docker applies
  // `--tail` before `--until`, so the read is bounded by the buffer instead:
  // exceeding it ends the command early and still proves coverage.
  const coverage = run(["--until", since], 4096);
  const truncated = (coverage.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
  if (!truncated && coverage.status !== 0) {
    return {
      status: "unavailable",
      reason: (coverage.stderr || coverage.error?.message || "docker logs failed").trim(),
    };
  }
  if (!truncated && `${coverage.stdout}${coverage.stderr}`.trim().length === 0) {
    return { status: "unavailable", reason: "Traefik logs do not reach back to the cutoff" };
  }
  const window = run(["--since", since], 256 * 1024 * 1024);
  if (window.status !== 0) {
    return {
      status: "unavailable",
      reason: (window.stderr || window.error?.message || "docker logs failed").trim(),
    };
  }
  return {
    status: "ok",
    newestByRouter: parseTraefikAccessLog(`${window.stdout}\n${window.stderr}`),
  };
}

const defaultDependencies: WorkspaceIdleDependencies = {
  now: () => Date.now(),
  readRoutes: () => readHostRouteStateReadOnly(),
  readJournals: () => listReliabilityOperations(),
  journalModifiedMs: (record) => {
    try {
      return fs.statSync(reliabilityOperationPath(record.identity)).mtimeMs;
    } catch {
      return undefined;
    }
  },
  registryPaths: () =>
    listMergedRuntimeWorkspaces().map((workspace) => workspace.source.localFolder),
  inspectContainers: () => inspectWorkspaceContainers(),
  statActivity: (containerId) => {
    const result = spawnSync(
      "docker",
      ["exec", containerId, "stat", "-c", "%Y", ...ACTIVITY_FILES],
      {
        encoding: "utf-8",
        ...networkDockerOptions(),
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr || result.error?.message || "",
    };
  },
  readTraefik: readTraefikWindow,
  isConfiguredCheckout: (repoPath) => fs.existsSync(path.join(repoPath, ".devrouter.yml")),
  gitCommonDir: (repoPath) => {
    try {
      return resolveGitCommonDir(repoPath);
    } catch {
      return undefined;
    }
  },
};

/**
 * Read-only idle report for every running managed environment on this machine,
 * or only the checkouts of one repository. Candidates come from published
 * routes, reliability journals and provider registries; nothing is mutated.
 */
export function buildWorkspaceIdleReport(
  options: WorkspaceIdleOptions = {},
  dependencies: WorkspaceIdleDependencies = defaultDependencies,
): WorkspaceIdleReport {
  const idleFor = parseInactiveFor(options.idleFor ?? DEFAULT_IDLE_FOR, "--idle-for");
  const nowMs = dependencies.now();
  const cutoffMs = nowMs - idleFor.seconds * 1000;
  const warnings: string[] = [];

  let routes: HostRouteState[] | undefined;
  try {
    routes = dependencies.readRoutes();
  } catch (error) {
    warnings.push(`Route state unreadable: ${(error as Error).message}`);
  }
  let journals: ReliabilityOperationRecord[] = [];
  let journalState: "ok" | "unreadable" = "ok";
  try {
    journals = dependencies.readJournals();
  } catch (error) {
    journalState = "unreadable";
    warnings.push(`Reliability journals unreadable: ${(error as Error).message}`);
  }
  let registryPaths: string[] = [];
  try {
    registryPaths = dependencies.registryPaths();
  } catch (error) {
    warnings.push(`Provider registries unreadable: ${(error as Error).message}`);
  }

  const candidates = new Map<string, string>();
  for (const candidate of [
    ...(routes ?? []).map((route) => route.repoPath),
    ...journals.map((record) => record.identity.repoPath),
    ...registryPaths,
  ]) {
    const key = comparableWorkspacePath(candidate);
    if (!candidates.has(key)) candidates.set(key, candidate);
  }

  const onlyKey = options.only ? comparableWorkspacePath(options.only) : undefined;
  const repoCommonDir = options.repo ? dependencies.gitCommonDir(options.repo) : undefined;
  if (options.repo && !repoCommonDir) {
    throw new Error(`'${options.repo}' is not a Git repository.`);
  }

  const containers = dependencies.inspectContainers();
  let traefik: TraefikRequestWindow | undefined;
  const rows: WorkspaceIdleRow[] = [];
  const notRunning: string[] = [];

  for (const [key, repoPath] of [...candidates].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (onlyKey && key !== onlyKey) continue;
    if (!dependencies.isConfiguredCheckout(repoPath)) continue;
    if (repoCommonDir && dependencies.gitCommonDir(repoPath) !== repoCommonDir) continue;
    const running = workspaceAppContainers(containers, repoPath).filter(
      (container) => container.state.Running,
    );
    if (running.length === 0) {
      notRunning.push(repoPath);
      continue;
    }

    const ownRoutes = routes?.filter((route) => comparableWorkspacePath(route.repoPath) === key);
    const record = journals.find(
      (entry) => comparableWorkspacePath(entry.identity.repoPath) === key,
    );
    const routerNames = (ownRoutes ?? [])
      .filter((route) => (route.protocol ?? "http") === "http")
      .map((route) => buildHostRouteRouterName(route.repoPath, route.name));
    if (routerNames.length > 0 && traefik === undefined)
      traefik = dependencies.readTraefik(cutoffMs);
    const signals: IdleSignal[] = [
      ownRoutes
        ? httpSignal(routerNames, traefik ?? { status: "ok", newestByRouter: new Map() })
        : { source: "http.request", status: "unavailable", reason: "route state unreadable" },
      activitySignal(running.map((container) => dependencies.statActivity(container.id))),
      journalSignal(
        record,
        journalState,
        record ? dependencies.journalModifiedMs(record) : undefined,
      ),
      routeSignal(ownRoutes),
    ];
    rows.push({
      repoPath,
      workspace:
        record?.identity.workspace ??
        ownRoutes?.find((route) => route.workspace)?.workspace ??
        null,
      containerIds: running.map((container) => container.id),
      signals,
      journalRevision: record?.revision ?? null,
      ...classifyIdle(signals, journalVetoes(record), cutoffMs),
    });
  }

  return {
    generatedAt: iso(nowMs),
    idleFor: idleFor.input,
    cutoff: iso(cutoffMs),
    rows,
    notRunning,
    warnings,
  };
}

/**
 * Stop every idle environment of the report. Each candidate's evidence is read
 * again immediately before its stop, and the stop intent is only recorded when
 * the journal is unchanged since that read and still carries no veto. A skip
 * or failure never blocks the remaining candidates.
 */
export async function stopIdleEnvironments(
  options: WorkspaceIdleOptions,
  stop: IdleStopper,
  dependencies: WorkspaceIdleDependencies = defaultDependencies,
): Promise<IdleStopResult> {
  const report = buildWorkspaceIdleReport(options, dependencies);
  const stops: IdleStopOutcome[] = [];
  for (const candidate of report.rows.filter((row) => row.status === "idle")) {
    const repoPath = candidate.repoPath;
    try {
      const fresh = buildWorkspaceIdleReport(
        { idleFor: options.idleFor, only: repoPath },
        dependencies,
      ).rows[0];
      if (fresh?.status !== "idle") {
        stops.push({
          repoPath,
          outcome: "skipped",
          reason: fresh ? `now ${fresh.status}` : "no longer running",
        });
        continue;
      }
      await stop(repoPath, (record) => {
        if (record.revision !== (fresh.journalRevision ?? 0)) {
          throw new IdleStopSkipped("lifecycle journal changed since the idle check");
        }
        const vetoes = journalVetoes(record);
        if (vetoes.length > 0) throw new IdleStopSkipped(vetoes.join("; "));
      });
      stops.push({ repoPath, outcome: "stopped" });
    } catch (error) {
      stops.push({
        repoPath,
        outcome: error instanceof IdleStopSkipped ? "skipped" : "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ...report, stops };
}

/**
 * Pin or unpin one checkout against idle stop. The pin lives in the checkout's
 * lifecycle journal and is written only while a linked worktree still holds the
 * workspace identity the journal was recorded under.
 */
export function setIdlePin(repoPath: string, pinned: boolean): ReliabilityIdleProtection {
  const checkout = comparableWorkspacePath(repoPath);
  const workspace = resolveWorktreeWorkspace(checkout) ?? null;
  const linked = isLinkedWorktree(checkout);
  return setReliabilityIdlePin(
    { repoPath: checkout, workspace, provider: resolveWorkspaceRuntimeOrDefault(checkout) },
    pinned,
    () => {
      if (linked && readPersistedWorkspace(checkout) !== workspace)
        throw new Error(`Checkout '${checkout}' no longer holds workspace '${workspace}'.`);
    },
  );
}
