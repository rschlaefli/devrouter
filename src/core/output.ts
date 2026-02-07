import { Route, RouterStatus } from "../types";
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
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName))
    .map((route) => [
      route.serviceName,
      route.projectName,
      route.urls.join(","),
      route.health === "unknown" ? route.status : `${route.status}/${route.health}`,
      formatAge(route.createdAt)
    ]);

  process.stdout.write(
    `${renderTable(["NAME", "PROJECT", "URLS", "STATUS", "AGE"], rows)}\n`
  );

  if (duplicateHosts.length > 0) {
    process.stdout.write(`\nWarning: duplicate hostnames detected: ${duplicateHosts.join(", ")}\n`);
  }
}
