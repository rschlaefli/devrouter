import fs from "node:fs";
import type { HostRouteState } from "../types";
import { isPidRunning, listHostRouteState, removeHostRoutesWhere } from "./host-routes";
import { sameWorkspacePath } from "./workspace";

type RouteRunConflict =
  | { kind: "same-app"; route: HostRouteState }
  | { kind: "hostname"; route: HostRouteState };

export function listRoutesForWorktreePath(
  worktreePath: string,
  routes: HostRouteState[] = listHostRouteState(),
): HostRouteState[] {
  return routes.filter((route) => sameWorkspacePath(route.repoPath, worktreePath));
}

export function listRoutesForWorktreePaths(worktreePaths: string[]): Map<string, HostRouteState[]> {
  const routes = listHostRouteState();
  const byWorktreePath = new Map<string, HostRouteState[]>();
  for (const worktreePath of worktreePaths) {
    byWorktreePath.set(worktreePath, []);
  }

  for (const route of routes) {
    for (const worktreePath of worktreePaths) {
      if (sameWorkspacePath(route.repoPath, worktreePath)) {
        byWorktreePath.get(worktreePath)?.push(route);
        break;
      }
    }
  }

  return byWorktreePath;
}

export function removeWorkspaceRoutesForWorktree(
  workspace: string,
  worktreePath: string,
): HostRouteState[] {
  return removeHostRoutesWhere(
    (route) => route.workspace === workspace && sameWorkspacePath(route.repoPath, worktreePath),
  );
}

export function removeRouteForApp(repoPath: string, appName: string): HostRouteState[] {
  return removeHostRoutesWhere(
    (route) => route.name === appName && sameWorkspacePath(route.repoPath, repoPath),
  );
}

function isStaleProcessRoute(route: HostRouteState): boolean {
  // Proxy routes have no backing process; their lifecycle is explicit route
  // removal or workspace-orphan GC, never PID liveness.
  if (route.mode === "proxy") {
    return false;
  }
  if (!route.pid) {
    return true;
  }
  return !isPidRunning(route.pid);
}

export function findStaleProcessRoutes(
  routes: HostRouteState[] = listHostRouteState(),
): HostRouteState[] {
  return routes.filter((route) => isStaleProcessRoute(route));
}

type StaleEvictionResult = "not-stale" | "evicted" | "changed";

function evictStaleRouteIfNeeded(route: HostRouteState): StaleEvictionResult {
  if (!isStaleProcessRoute(route)) {
    return "not-stale";
  }
  const removed = removeHostRoutesWhere(
    (candidate) => candidate.id === route.id && isStaleProcessRoute(candidate),
  );
  return removed.length > 0 ? "evicted" : "changed";
}

export function evictStaleProcessRoutes(): number {
  return removeHostRoutesWhere((route) => isStaleProcessRoute(route)).length;
}

export function reconcileRouteRunConflict(
  repoPath: string,
  app: { name: string; host: string },
): RouteRunConflict | undefined {
  for (;;) {
    const routes = listHostRouteState();
    let shouldRetry = false;

    for (const route of routes) {
      if (route.name === app.name && sameWorkspacePath(route.repoPath, repoPath)) {
        const staleEviction = evictStaleRouteIfNeeded(route);
        if (staleEviction === "evicted") {
          continue;
        }
        if (staleEviction === "changed") {
          shouldRetry = true;
          break;
        }
        return { kind: "same-app", route };
      }

      if (route.host === app.host) {
        const staleEviction = evictStaleRouteIfNeeded(route);
        if (staleEviction === "evicted") {
          continue;
        }
        if (staleEviction === "changed") {
          shouldRetry = true;
          break;
        }
        return { kind: "hostname", route };
      }
    }

    if (!shouldRetry) {
      return undefined;
    }
  }
}

export function evictOrphanedWorkspaceProxyRoutes(): number {
  return removeHostRoutesWhere((route) => isOrphanedWorkspaceProxyRoute(route)).length;
}

function isOrphanedWorkspaceProxyRoute(route: HostRouteState): boolean {
  return route.mode === "proxy" && route.workspace !== undefined && !fs.existsSync(route.repoPath);
}

export function findOrphanedWorkspaceProxyRoutes(
  routes: HostRouteState[] = listHostRouteState(),
): HostRouteState[] {
  return routes.filter((route) => isOrphanedWorkspaceProxyRoute(route));
}
