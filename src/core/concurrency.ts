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
