import { DevrouterApp, DoctorReport, HostRouteState, Route, RouterStatus } from "../types";
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
    ["TLS enabled", status.tlsEnabled ? "yes" : "no"],
    ["HTTP routing ready", status.insights.httpRoutingReady ? "yes" : "no"],
    ["TCP routing ready", status.insights.tcpRoutingReady ? "yes" : "no"]
  ];

  if (status.repo) {
    rows.push(["Repo path", status.repo.path]);
    rows.push(["Repo config", status.repo.exists ? status.repo.configPath : "missing"]);
    rows.push([
      "Repo config valid",
      status.repo.valid ? "yes" : `no (${status.repo.error ?? "validation failed"})`
    ]);
    rows.push(["Repo apps", String(status.repo.appCount)]);
  }

  process.stdout.write(`${renderTable(["FIELD", "VALUE"], rows)}\n`);

  if (status.insights.nextSteps.length > 0) {
    process.stdout.write("\nNext steps:\n");
    for (const step of status.insights.nextSteps) {
      process.stdout.write(`- ${step}\n`);
    }
  }
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

export function printDoctorReport(report: DoctorReport): void {
  const summaryRows = [
    ["Generated", report.generatedAt],
    ["Repo path", report.repoPath ?? "-"],
    ["OK", String(report.summary.ok)],
    ["WARN", String(report.summary.warn)],
    ["ERROR", String(report.summary.error)]
  ];
  process.stdout.write(`${renderTable(["FIELD", "VALUE"], summaryRows)}\n\n`);

  const rows = report.checks.map((check) => [
    check.id,
    check.level.toUpperCase(),
    check.summary,
    check.suggestion ?? "-"
  ]);

  process.stdout.write(
    `${renderTable(["CHECK", "LEVEL", "SUMMARY", "SUGGESTION"], rows)}\n`
  );

  const detailedChecks = report.checks.filter((check) => check.details);
  if (detailedChecks.length > 0) {
    process.stdout.write("\nDetails:\n");
    for (const check of detailedChecks) {
      process.stdout.write(`- ${check.id}: ${check.details}\n`);
    }
  }

  if (report.nextSteps.length > 0) {
    process.stdout.write("\nRecommended next steps:\n");
    for (const step of report.nextSteps) {
      process.stdout.write(`- ${step}\n`);
    }
  }
}
