import fs from "node:fs";
import path from "node:path";
import type { HostRouteState } from "../types";
import { isPidRunning, listHostRouteState, removeHostRouteById } from "./host-routes";

type RouteRunConflict =
  | { kind: "same-app"; route: HostRouteState }
  | { kind: "hostname"; route: HostRouteState };

function comparablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameRoutePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

export function listRoutesForWorktreePath(
  worktreePath: string,
  routes: HostRouteState[] = listHostRouteState()
): HostRouteState[] {
  return routes.filter((route) => sameRoutePath(route.repoPath, worktreePath));
}

export function listRoutesForWorktreePaths(
  worktreePaths: string[]
): Map<string, HostRouteState[]> {
  const routes = listHostRouteState();
  const byWorktreePath = new Map<string, HostRouteState[]>();
  for (const worktreePath of worktreePaths) {
    byWorktreePath.set(worktreePath, []);
  }

  for (const route of routes) {
    for (const worktreePath of worktreePaths) {
      if (sameRoutePath(route.repoPath, worktreePath)) {
        byWorktreePath.get(worktreePath)?.push(route);
        break;
      }
    }
  }

  return byWorktreePath;
}

export function removeWorkspaceRoutesForWorktree(
  workspace: string,
  worktreePath: string
): HostRouteState[] {
  const matches = listHostRouteState().filter(
    (route) => route.workspace === workspace && sameRoutePath(route.repoPath, worktreePath)
  );
  for (const route of matches) {
    removeHostRouteById(route.id);
  }
  return matches;
}

export function removeRouteForApp(repoPath: string, appName: string): HostRouteState[] {
  const matches = listHostRouteState().filter(
    (route) => route.name === appName && sameRoutePath(route.repoPath, repoPath)
  );
  for (const route of matches) {
    removeHostRouteById(route.id);
  }
  return matches;
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
  routes: HostRouteState[] = listHostRouteState()
): HostRouteState[] {
  return routes.filter((route) => isStaleProcessRoute(route));
}

function evictStaleRouteIfNeeded(route: HostRouteState): boolean {
  if (!isStaleProcessRoute(route)) {
    return false;
  }
  removeHostRouteById(route.id);
  return true;
}

export function evictStaleProcessRoutes(): number {
  const staleRoutes = findStaleProcessRoutes();
  for (const route of staleRoutes) {
    removeHostRouteById(route.id);
  }
  return staleRoutes.length;
}

export function reconcileRouteRunConflict(
  repoPath: string,
  app: { name: string; host: string }
): RouteRunConflict | undefined {
  const routes = listHostRouteState();

  for (const route of routes) {
    if (route.name === app.name && sameRoutePath(route.repoPath, repoPath)) {
      if (evictStaleRouteIfNeeded(route)) {
        continue;
      }
      return { kind: "same-app", route };
    }

    if (route.host === app.host) {
      if (evictStaleRouteIfNeeded(route)) {
        continue;
      }
      return { kind: "hostname", route };
    }
  }

  return undefined;
}

function findOrphanedWorkspaceProxyRoutes(
  routes: HostRouteState[] = listHostRouteState()
): HostRouteState[] {
  return routes.filter((route) => {
    if (route.mode !== "proxy" || route.workspace === undefined) {
      return false;
    }
    return !fs.existsSync(route.repoPath);
  });
}

export function evictOrphanedWorkspaceProxyRoutes(): number {
  const orphans = findOrphanedWorkspaceProxyRoutes();
  for (const route of orphans) {
    removeHostRouteById(route.id);
  }
  return orphans.length;
}
