import fs from "node:fs";
import { HostRouteState } from "../types";
import { isTLSEnabled } from "./router";
import {
  buildHostRouteId,
  isPidRunning,
  listHostRouteState,
  removeHostRouteById
} from "./host-routes";

export class AppAlreadyRunningError extends Error {
  constructor(
    public readonly appName: string,
    public readonly url: string,
    public readonly pid: number | undefined,
    public readonly repoPath: string
  ) {
    const lines = [
      `App "${appName}" is already running.`,
      `  URL:  ${url}`,
      pid ? `  PID:  ${pid}` : null,
      `  Repo: ${repoPath}`
    ].filter(Boolean);
    super(lines.join("\n"));
    this.name = "AppAlreadyRunningError";
  }
}

export class HostnameConflictError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly existingApp: string,
    public readonly existingRepoPath: string,
    public readonly existingPid: number | undefined
  ) {
    const lines = [
      `Hostname "${hostname}" is already claimed by app "${existingApp}".`,
      existingPid ? `  PID:  ${existingPid}` : null,
      `  Repo: ${existingRepoPath}`
    ].filter(Boolean);
    super(lines.join("\n"));
    this.name = "HostnameConflictError";
  }
}

function routeUrl(host: string): string {
  const scheme = isTLSEnabled() ? "https" : "http";
  return `${scheme}://${host}`;
}

function evictIfStale(route: HostRouteState): boolean {
  // Proxy routes have no backing process (no pid); they front an externally
  // managed upstream and stay live until `dev app rm`. Never evict them as stale.
  if (route.mode === "proxy") {
    return false;
  }
  if (isPidRunning(route.pid)) {
    return false;
  }
  removeHostRouteById(route.id);
  return true;
}

export function assertAppNotRunning(
  repoPath: string,
  app: { name: string; host: string }
): void {
  const routes = listHostRouteState();
  const targetId = buildHostRouteId(repoPath, app.name);

  for (const route of routes) {
    if (route.id === targetId) {
      if (evictIfStale(route)) {
        continue;
      }
      throw new AppAlreadyRunningError(
        app.name,
        routeUrl(route.host),
        route.pid,
        route.repoPath
      );
    }

    if (route.host === app.host) {
      if (evictIfStale(route)) {
        continue;
      }
      throw new HostnameConflictError(
        app.host,
        route.name,
        route.repoPath,
        route.pid
      );
    }
  }
}

export function evictStaleHostRoutes(): number {
  const routes = listHostRouteState();
  let evicted = 0;
  for (const route of routes) {
    if (evictIfStale(route)) {
      evicted += 1;
    }
  }
  return evicted;
}

/**
 * Reclaim proxy routes orphaned by a removed worktree — the lifecycle gap the
 * workspace feature introduces. A workspace-tagged proxy route fronts a container
 * reachable by a worktree-scoped alias; when the worktree directory is deleted
 * WITHOUT `dev workspace down` (manual `git worktree remove`, aborted teardown),
 * the route leaks with nothing left to restore it.
 *
 * Worktree existence is the only unambiguous orphan signal. Container/alias
 * liveness is deliberately NOT used: a stopped-but-restartable devcontainer is
 * indistinguishable from a gone-forever one at the alias level, so evicting on
 * "alias absent" would falsely tear down stable proxy routes whose devpod is
 * merely paused. We therefore reclaim ONLY when the backing worktree is provably
 * gone, and never touch primary-checkout routes (no `workspace` token).
 */
export function evictOrphanedWorkspaceRoutes(): number {
  const orphans = listHostRouteState().filter(
    (route) =>
      route.mode === "proxy" &&
      route.workspace !== undefined &&
      !fs.existsSync(route.repoPath)
  );
  for (const route of orphans) {
    removeHostRouteById(route.id);
  }
  return orphans.length;
}
