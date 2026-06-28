import { isTLSEnabled } from "./router";
import { reconcileRouteRunConflict } from "./route-state";

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

export function assertAppNotRunning(
  repoPath: string,
  app: { name: string; host: string }
): void {
  const conflict = reconcileRouteRunConflict(repoPath, app);
  if (!conflict) {
    return;
  }

  if (conflict.kind === "same-app") {
    throw new AppAlreadyRunningError(
      app.name,
      routeUrl(conflict.route.host),
      conflict.route.pid,
      conflict.route.repoPath
    );
  }

  throw new HostnameConflictError(
    app.host,
    conflict.route.name,
    conflict.route.repoPath,
    conflict.route.pid
  );
}
