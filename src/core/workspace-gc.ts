import path from "node:path";
import { deleteOwnedDevpodWorkspace } from "./devpod-mutation";
import { listDevpodWorkspaces } from "./devpod-workspaces";
import { listHostRouteState } from "./host-routes";
import { resolveRepoPath } from "./repo-config";
import { removeWorkspaceRoutesForWorktree } from "./route-state";
import { comparableWorkspacePath, sameWorkspacePath } from "./workspace";
import {
  type DevpodOwnerStatus,
  inspectWorkspaceOwnership,
  listGitWorktrees,
  listWorkspaceOwnership,
  type WorkspaceOwnerStatus,
  type WorkspaceOwnershipRecord,
  type WorkspaceOwnershipTransaction,
  withWorkspaceOwnershipTransaction,
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

export type WorkspaceGcPlan = WorkspaceGcReport & { mode: "dry-run" };
export type WorkspaceGcApplyReport = WorkspaceGcReport & { mode: "apply" };

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
  // `git worktree list --porcelain` guarantees the main worktree first.
  const primaryPath = worktrees[0]?.path;
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
      (primaryPath && sameWorkspacePath(devpod.source.localFolder, primaryPath)) ||
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
      (primaryPath && sameWorkspacePath(route.repoPath, primaryPath)) ||
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

function revalidateCandidate(
  candidate: WorkspaceGcCandidate,
  repoPath: string,
  transaction: WorkspaceOwnershipTransaction,
):
  | { status: "ready"; candidate: WorkspaceGcCandidate; record: WorkspaceOwnershipRecord }
  | { status: "blocked"; candidate: WorkspaceGcCandidate } {
  const record = transaction.list().find((entry) => entry.workspace === candidate.workspace);
  if (
    !record ||
    !sameWorkspacePath(record.worktreePath, candidate.worktreePath) ||
    record.devpodId !== candidate.devpodId
  ) {
    return {
      status: "blocked",
      candidate: {
        ...candidate,
        eligible: false,
        reason: "Ownership record disappeared or changed before cleanup.",
        actions: [
          { resource: "devpod", status: "skipped" },
          { resource: "routes", status: "skipped", count: candidate.routeCount },
          { resource: "record", status: "skipped" },
        ],
      },
    };
  }

  const fresh = ownedCandidate(
    record,
    listGitWorktrees(repoPath),
    listDevpodWorkspaces(),
    listHostRouteState(),
  );
  if (fresh.eligible) return { status: "ready", candidate: fresh, record };
  return {
    status: "blocked",
    candidate: {
      ...fresh,
      reason: `Ownership changed before cleanup: ${fresh.reason}`,
    },
  };
}

function failedAction(resource: WorkspaceGcActionResource, error: unknown): WorkspaceGcAction {
  return {
    resource,
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  };
}

function applyCandidate(candidate: WorkspaceGcCandidate, repoPath: string): WorkspaceGcCandidate {
  try {
    return withWorkspaceOwnershipTransaction(repoPath, (transaction) => {
      let revalidated: ReturnType<typeof revalidateCandidate>;
      try {
        revalidated = revalidateCandidate(candidate, repoPath, transaction);
      } catch (error) {
        return {
          ...candidate,
          actions: [
            failedAction(
              "record",
              `Ownership revalidation failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ],
        };
      }
      if (revalidated.status === "blocked") return revalidated.candidate;

      const { candidate: fresh, record } = revalidated;
      const actions: WorkspaceGcAction[] = [];
      let devpodStatus: "owned" | "absent";
      try {
        const mutation = deleteOwnedDevpodWorkspace(record.devpodId, record.worktreePath);
        devpodStatus = mutation.status === "changed" ? "owned" : "absent";
      } catch (error) {
        return { ...fresh, actions: [failedAction("devpod", error)] };
      }
      actions.push({
        resource: "devpod",
        status: devpodStatus === "owned" ? "deleted" : "already-absent",
      });

      try {
        const routes = removeWorkspaceRoutesForWorktree(fresh.workspace, fresh.worktreePath);
        actions.push({
          resource: "routes",
          status: routes.length > 0 ? "deleted" : "already-absent",
          count: routes.length,
        });
      } catch (error) {
        return { ...fresh, actions: [...actions, failedAction("routes", error)] };
      }

      try {
        const removal = transaction.removeIfMatches(record);
        if (removal === "changed") {
          throw new Error("Ownership record changed during cleanup; record was retained.");
        }
        actions.push({
          resource: "record",
          status: removal === "removed" ? "deleted" : "already-absent",
        });
      } catch (error) {
        return { ...fresh, actions: [...actions, failedAction("record", error)] };
      }
      return { ...fresh, actions };
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...candidate,
      actions: [failedAction("record", `Ownership transaction failed: ${detail}`)],
    };
  }
}

function summarizeGc(mode: WorkspaceGcReport["mode"], candidates: WorkspaceGcCandidate[]) {
  return {
    total: candidates.length,
    eligible: candidates.filter((candidate) => candidate.eligible).length,
    cleaned:
      mode === "apply"
        ? candidates.filter((candidate) =>
            candidate.actions.some(
              (action) =>
                action.resource === "record" &&
                (action.status === "deleted" || action.status === "already-absent"),
            ),
          ).length
        : 0,
    blocked: candidates.filter((candidate) => !candidate.eligible).length,
    errors: candidates.filter((candidate) =>
      candidate.actions.some((action) => action.status === "failed"),
    ).length,
  };
}

export function inspectWorkspaceGc(repo?: string): WorkspaceGcPlan {
  const repoPath = comparableWorkspacePath(resolveRepoPath(repo));
  const worktrees = listGitWorktrees(repoPath);
  const records = listWorkspaceOwnership(repoPath);
  const devpods = listDevpodWorkspaces();
  const routes = listHostRouteState();
  const candidates = [
    ...records.map((record) => ownedCandidate(record, worktrees, devpods, routes)),
    ...legacyCandidates(repoPath, records, worktrees, devpods, routes),
  ];
  return {
    generatedAt: new Date().toISOString(),
    repoPath,
    mode: "dry-run",
    summary: summarizeGc("dry-run", candidates),
    candidates,
  };
}

export function applyWorkspaceGc(plan: WorkspaceGcPlan): WorkspaceGcApplyReport {
  const candidates = plan.candidates.map((candidate) =>
    candidate.eligible ? applyCandidate(candidate, plan.repoPath) : candidate,
  );
  return {
    generatedAt: new Date().toISOString(),
    repoPath: plan.repoPath,
    mode: "apply",
    summary: summarizeGc("apply", candidates),
    candidates,
  };
}
