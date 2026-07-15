import { spawnSync } from "node:child_process";
import path from "node:path";
import { listHostRouteState } from "./host-routes";
import { resolveRepoPath } from "./repo-config";
import { removeWorkspaceRoutesForWorktree } from "./route-state";
import { comparableWorkspacePath, sameWorkspacePath } from "./workspace";
import { listDevpodWorkspaces } from "./workspace-ensure";
import {
  type DevpodOwnerStatus,
  inspectWorkspaceOwnership,
  listGitWorktrees,
  listWorkspaceOwnership,
  removeWorkspaceOwnershipIfMatches,
  type WorkspaceOwnerStatus,
  type WorkspaceOwnershipRecord,
} from "./workspace-ownership";

export type WorkspaceGcActionResource = "devpod" | "routes" | "record";
export type WorkspaceGcActionStatus =
  | "would-delete"
  | "deleted"
  | "already-absent"
  | "skipped"
  | "failed";

export type WorkspaceGcAction = {
  resource: WorkspaceGcActionResource;
  status: WorkspaceGcActionStatus;
  count?: number;
  error?: string;
};

export type WorkspaceGcCandidate = {
  kind: "owned" | "legacy";
  workspace: string;
  devpodId?: string;
  worktreePath: string;
  ownerStatus?: WorkspaceOwnerStatus;
  devpodStatus: DevpodOwnerStatus;
  routeCount: number;
  eligible: boolean;
  reason: string;
  actions: WorkspaceGcAction[];
};

export type WorkspaceGcReport = {
  generatedAt: string;
  repoPath: string;
  mode: "dry-run" | "apply";
  summary: {
    total: number;
    eligible: number;
    cleaned: number;
    blocked: number;
    errors: number;
  };
  candidates: WorkspaceGcCandidate[];
};

type GcOptions = { repoPath?: string; yes?: boolean };

function routesForOwner(
  routes: ReturnType<typeof listHostRouteState>,
  workspace: string,
  worktreePath: string,
) {
  return routes.filter(
    (route) => route.workspace === workspace && sameWorkspacePath(route.repoPath, worktreePath),
  );
}

function inRepositoryWorkspaceScope(
  repoPath: string,
  worktreePath: string,
  livePaths: string[],
): boolean {
  if (livePaths.some((candidate) => sameWorkspacePath(candidate, worktreePath))) return true;
  const comparableRepo = comparableWorkspacePath(repoPath);
  const comparableWorktree = comparableWorkspacePath(worktreePath);
  const localRoot = path.join(comparableRepo, "trees") + path.sep;
  if (comparableWorktree.startsWith(localRoot)) return true;
  const legacyPrefix = `${path.basename(comparableRepo)}-`;
  return (
    path.dirname(comparableWorktree) === path.dirname(comparableRepo) &&
    path.basename(comparableWorktree).startsWith(legacyPrefix)
  );
}

function previewActions(
  devpodStatus: DevpodOwnerStatus,
  routeCount: number,
  includeRecord: boolean,
): WorkspaceGcAction[] {
  const actions: WorkspaceGcAction[] = [
    {
      resource: "devpod",
      status: devpodStatus === "owned" ? "would-delete" : "already-absent",
    },
    {
      resource: "routes",
      status: routeCount > 0 ? "would-delete" : "already-absent",
      count: routeCount,
    },
  ];
  if (includeRecord) actions.push({ resource: "record", status: "would-delete" });
  return actions;
}

function ownedReason(ownerStatus: WorkspaceOwnerStatus): string {
  switch (ownerStatus) {
    case "missing":
      return "Ownership record is missing from live Git registration or marked prunable.";
    case "present":
      return "Registered worktree is present.";
    case "locked":
      return "Git worktree is locked and protected from garbage collection.";
    case "conflict":
      return "Ownership conflicts with live Git, persisted token, or DevPod source evidence.";
  }
}

function ownedCandidate(
  record: WorkspaceOwnershipRecord,
  worktrees: ReturnType<typeof listGitWorktrees>,
  devpods: ReturnType<typeof listDevpodWorkspaces>,
  routes: ReturnType<typeof listHostRouteState>,
): WorkspaceGcCandidate {
  const status = inspectWorkspaceOwnership(record, worktrees, devpods);
  const routeCount = routesForOwner(routes, record.workspace, record.worktreePath).length;
  const eligible = status.ownerStatus === "missing" && status.devpodStatus !== "conflict";
  return {
    kind: "owned",
    workspace: record.workspace,
    devpodId: record.devpodId,
    worktreePath: record.worktreePath,
    ownerStatus: status.ownerStatus,
    devpodStatus: status.devpodStatus,
    routeCount,
    eligible,
    reason: ownedReason(status.ownerStatus),
    actions: eligible
      ? previewActions(status.devpodStatus, routeCount, true)
      : [
          { resource: "devpod", status: "skipped" },
          { resource: "routes", status: "skipped", count: routeCount },
          { resource: "record", status: "skipped" },
        ],
  };
}

function legacyCandidates(
  repoPath: string,
  records: WorkspaceOwnershipRecord[],
  worktrees: ReturnType<typeof listGitWorktrees>,
  devpods: ReturnType<typeof listDevpodWorkspaces>,
  routes: ReturnType<typeof listHostRouteState>,
): WorkspaceGcCandidate[] {
  const livePaths = worktrees.map((worktree) => worktree.path);
  const evidence = new Map<
    string,
    { workspace: string; worktreePath: string; devpodStatus: DevpodOwnerStatus; routeCount: number }
  >();
  const isRecordedRoute = (workspace: string, worktreePath: string): boolean =>
    records.some(
      (record) =>
        record.workspace === workspace && sameWorkspacePath(record.worktreePath, worktreePath),
    );
  const isRecordedDevpod = (devpodId: string, worktreePath: string): boolean =>
    records.some(
      (record) =>
        record.devpodId === devpodId && sameWorkspacePath(record.worktreePath, worktreePath),
    );
  const key = (workspace: string, worktreePath: string): string =>
    `${workspace}\0${comparableWorkspacePath(worktreePath)}`;

  for (const devpod of devpods) {
    if (
      isRecordedDevpod(devpod.id, devpod.source.localFolder) ||
      !inRepositoryWorkspaceScope(repoPath, devpod.source.localFolder, livePaths)
    ) {
      continue;
    }
    evidence.set(key(devpod.id, devpod.source.localFolder), {
      workspace: devpod.id,
      worktreePath: comparableWorkspacePath(devpod.source.localFolder),
      devpodStatus: "owned",
      routeCount: 0,
    });
  }

  for (const route of routes) {
    if (
      !route.workspace ||
      isRecordedRoute(route.workspace, route.repoPath) ||
      !inRepositoryWorkspaceScope(repoPath, route.repoPath, livePaths)
    ) {
      continue;
    }
    const evidenceKey = key(route.workspace, route.repoPath);
    const existing = evidence.get(evidenceKey);
    evidence.set(evidenceKey, {
      workspace: route.workspace,
      worktreePath: comparableWorkspacePath(route.repoPath),
      devpodStatus: existing?.devpodStatus ?? "absent",
      routeCount: (existing?.routeCount ?? 0) + 1,
    });
  }

  return Array.from(evidence.values()).map((entry) => ({
    kind: "legacy",
    ...entry,
    eligible: false,
    reason:
      "Legacy workspace has no ownership record; use explicit workspace down or manual cleanup.",
    actions: [
      { resource: "devpod", status: "skipped" },
      { resource: "routes", status: "skipped", count: entry.routeCount },
    ],
  }));
}

function deleteDevpod(devpodId: string): void {
  const result = spawnSync("devpod", ["delete", devpodId, "--ignore-not-found"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`devpod delete failed for '${devpodId}': ${detail || "unknown error"}`);
  }
}

function revalidateCandidate(
  candidate: WorkspaceGcCandidate,
  report: WorkspaceGcReport,
): WorkspaceOwnershipRecord | undefined {
  const record = listWorkspaceOwnership(report.repoPath).find(
    (entry) => entry.workspace === candidate.workspace,
  );
  if (
    !record ||
    !sameWorkspacePath(record.worktreePath, candidate.worktreePath) ||
    record.devpodId !== candidate.devpodId
  ) {
    candidate.eligible = false;
    candidate.reason = "Ownership record disappeared or changed before cleanup.";
  } else {
    const fresh = ownedCandidate(
      record,
      listGitWorktrees(report.repoPath),
      listDevpodWorkspaces(),
      listHostRouteState(),
    );
    if (fresh.eligible) {
      Object.assign(candidate, fresh);
      return record;
    }
    Object.assign(candidate, fresh, {
      reason: `Ownership changed before cleanup: ${fresh.reason}`,
    });
  }

  candidate.actions = [
    { resource: "devpod", status: "skipped" },
    { resource: "routes", status: "skipped", count: candidate.routeCount },
    { resource: "record", status: "skipped" },
  ];
  report.summary.eligible -= 1;
  report.summary.blocked += 1;
  return undefined;
}

function recheckDevpodOwnership(record: WorkspaceOwnershipRecord): "owned" | "absent" {
  const devpods = listDevpodWorkspaces();
  const byId = devpods.find((devpod) => devpod.id === record.devpodId);
  if (byId && !sameWorkspacePath(byId.source.localFolder, record.worktreePath)) {
    throw new Error(
      `DevPod identity '${record.devpodId}' changed owner to '${byId.source.localFolder}'.`,
    );
  }
  const byPath = devpods.filter((devpod) =>
    sameWorkspacePath(devpod.source.localFolder, record.worktreePath),
  );
  if (byPath.length > 1 || (byPath[0] && byPath[0].id !== record.devpodId)) {
    throw new Error(
      `Worktree '${record.worktreePath}' gained conflicting DevPod ownership before cleanup.`,
    );
  }
  return byId ? "owned" : "absent";
}

function applyCandidate(candidate: WorkspaceGcCandidate, report: WorkspaceGcReport): void {
  let record: WorkspaceOwnershipRecord | undefined;
  try {
    record = revalidateCandidate(candidate, report);
  } catch (error) {
    candidate.actions = [
      {
        resource: "record",
        status: "failed",
        error: `Ownership revalidation failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
    report.summary.errors += 1;
    return;
  }
  if (!record) return;
  const actions: WorkspaceGcAction[] = [];
  try {
    const devpodStatus = recheckDevpodOwnership(record);
    if (devpodStatus === "owned") {
      deleteDevpod(record.devpodId);
      actions.push({ resource: "devpod", status: "deleted" });
    } else {
      actions.push({ resource: "devpod", status: "already-absent" });
    }

    const routes = removeWorkspaceRoutesForWorktree(candidate.workspace, candidate.worktreePath);
    actions.push({
      resource: "routes",
      status: routes.length > 0 ? "deleted" : "already-absent",
      count: routes.length,
    });

    const removal = removeWorkspaceOwnershipIfMatches(report.repoPath, record);
    if (removal === "changed") {
      throw new Error("Ownership record changed during cleanup; record was retained.");
    }
    actions.push({
      resource: "record",
      status: removal === "removed" ? "deleted" : "already-absent",
    });
    report.summary.cleaned += 1;
  } catch (error) {
    const resource: WorkspaceGcActionResource =
      actions.length === 0 ? "devpod" : actions.length === 1 ? "routes" : "record";
    actions.push({
      resource,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    report.summary.errors += 1;
  }
  candidate.actions = actions;
}

export function workspaceGc(options: GcOptions = {}): WorkspaceGcReport {
  const repoPath = comparableWorkspacePath(resolveRepoPath(options.repoPath));
  const worktrees = listGitWorktrees(repoPath);
  const records = listWorkspaceOwnership(repoPath);
  const devpods = listDevpodWorkspaces();
  const routes = listHostRouteState();
  const candidates = [
    ...records.map((record) => ownedCandidate(record, worktrees, devpods, routes)),
    ...legacyCandidates(repoPath, records, worktrees, devpods, routes),
  ];
  const report: WorkspaceGcReport = {
    generatedAt: new Date().toISOString(),
    repoPath,
    mode: options.yes ? "apply" : "dry-run",
    summary: {
      total: candidates.length,
      eligible: candidates.filter((candidate) => candidate.eligible).length,
      cleaned: 0,
      blocked: candidates.filter((candidate) => !candidate.eligible).length,
      errors: 0,
    },
    candidates,
  };

  if (options.yes) {
    for (const candidate of candidates) {
      if (candidate.eligible) applyCandidate(candidate, report);
    }
  }
  return report;
}
