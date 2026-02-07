import { DevrouterApp, HostRouteState, Route, RouterStatus } from "../types";
import { formatAge } from "../util/timeago";
import { renderTable } from "../util/table";

export function printJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printStatus(status: RouterStatus): void {
  const rows = [
    ["Docker context", status.dockerContext],
    ["Router running", status.routerRunning ? "yes" : "no"],
    ["Router container", status.routerContainerName],
    ["Port 80 bound", status.boundPorts.web80 ? "yes" : "no"],
    ["Port 443 bound", status.boundPorts.web443 ? "yes" : "no"],
    ["Port 5432 bound", status.boundPorts.postgres5432 ? "yes" : "no"],
    ["Dashboard 8080 bound", status.boundPorts.dashboard8080 ? "yes" : "no"],
    ["devnet exists", status.networkExists ? "yes" : "no"],
    ["TLS configured", status.tlsConfigured ? "yes" : "no"],
    ["TLS certs present", status.certPresent ? "yes" : "no"],
    ["TLS enabled", status.tlsEnabled ? "yes" : "no"]
  ];

  process.stdout.write(`${renderTable(["FIELD", "VALUE"], rows)}\n`);
}

export function printRoutes(routes: Route[], duplicateHosts: string[]): void {
  if (routes.length === 0) {
    process.stdout.write("No routes found.\n");
    return;
  }

  const rows = routes
    .slice()
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName) || a.source.localeCompare(b.source))
    .map((route) => [
      route.serviceName,
      route.projectName,
      route.protocol,
      route.urls.join(","),
      route.health === "unknown" ? route.status : `${route.status}/${route.health}`,
      formatAge(route.createdAt)
    ]);

  process.stdout.write(
    `${renderTable(["NAME", "PROJECT", "PROTOCOL", "ENDPOINTS", "STATUS", "AGE"], rows)}\n`
  );

  if (duplicateHosts.length > 0) {
    process.stdout.write(`\nWarning: duplicate hostnames detected: ${duplicateHosts.join(", ")}\n`);
  }
}

export function printHostRouteState(routes: HostRouteState[]): void {
  if (routes.length === 0) {
    process.stdout.write("No host routes found.\n");
    return;
  }

  const isRunning = (pid: number | undefined): boolean => {
    if (!pid || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const rows = routes
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.repoPath.localeCompare(b.repoPath))
    .map((route) => [
      route.name,
      route.repoPath,
      route.protocol ?? "http",
      route.host,
      String(route.port),
      route.mode,
      route.pid ? String(route.pid) : "-",
      isRunning(route.pid) ? "running" : "stopped",
      route.updatedAt
    ]);

  process.stdout.write(
    `${renderTable(["NAME", "REPO", "PROTOCOL", "HOST", "PORT", "MODE", "PID", "STATUS", "UPDATED"], rows)}\n`
  );
}

export function printConfigApps(repoPath: string, apps: DevrouterApp[]): void {
  if (apps.length === 0) {
    process.stdout.write(`No apps configured in ${repoPath}.\n`);
    return;
  }

  const rows = apps
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((app) => {
      if (app.runtime === "host") {
        return [
          app.name,
          app.protocol,
          app.runtime,
          app.host,
          app.hostRun.command,
          app.dependencies.map((dependency) => dependency.app).join(",")
        ];
      }

      const protocol = app.protocol === "tcp" ? `tcp/${app.tcpProtocol}` : app.protocol;
      return [
        app.name,
        protocol,
        app.runtime,
        app.host,
        `${app.docker.service}:${app.docker.internalPort}`,
        app.dependencies.map((dependency) => dependency.app).join(",")
      ];
    });

  process.stdout.write(
    `${renderTable(["NAME", "PROTOCOL", "RUNTIME", "HOST", "TARGET", "DEPS"], rows)}\n`
  );
}
