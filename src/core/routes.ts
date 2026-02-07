import type { ContainerInfo } from "dockerode";
import { Route } from "../types";

const ROUTER_RULE_KEY = /^traefik\.http\.routers\.([^.]+)\.rule$/;

function normalizeContainerName(name: string | undefined): string {
  if (!name) {
    return "unknown";
  }
  return name.startsWith("/") ? name.slice(1) : name;
}

export function parseHostsFromRule(rule: string): string[] {
  const hosts: string[] = [];
  const hostBlocks = rule.matchAll(/Host\(([^)]+)\)/g);

  for (const block of hostBlocks) {
    const inner = block[1];
    const parts = inner.split(",");
    for (const part of parts) {
      const clean = part.trim().replaceAll("`", "").replaceAll("\"", "").replaceAll("'", "");
      if (clean.length > 0) {
        hosts.push(clean);
      }
    }
  }

  return Array.from(new Set(hosts));
}

function isOnNetwork(container: ContainerInfo, networkName: string): boolean {
  const networks = container.NetworkSettings?.Networks ?? {};
  return Object.prototype.hasOwnProperty.call(networks, networkName);
}

function buildRoute(
  container: ContainerInfo,
  routerId: string,
  hosts: string[],
  tlsEnabled: boolean
): Route {
  const labels = container.Labels ?? {};
  const containerName = normalizeContainerName(container.Names?.[0]);
  const serviceName = labels["com.docker.compose.service"] ?? containerName;
  const projectName = labels["com.docker.compose.project"] ?? "-";

  const status = container.State ?? "unknown";
  const statusText = container.Status ?? "";
  let health = "unknown";
  if (statusText.includes("healthy")) {
    health = "healthy";
  } else if (statusText.includes("unhealthy")) {
    health = "unhealthy";
  }

  return {
    id: routerId,
    containerId: container.Id,
    containerName,
    serviceName,
    projectName,
    hosts,
    urls: hosts.map((host) => `${tlsEnabled ? "https" : "http"}://${host}`),
    status,
    health,
    createdAt: container.Created
  };
}

export function discoverRoutes(
  containers: ContainerInfo[],
  tlsEnabled: boolean,
  networkName: string
): { routes: Route[]; duplicateHosts: string[] } {
  const routes: Route[] = [];

  for (const container of containers) {
    if (!isOnNetwork(container, networkName)) {
      continue;
    }

    const labels = container.Labels ?? {};
    if (labels["traefik.enable"] !== "true") {
      continue;
    }

    for (const [key, value] of Object.entries(labels)) {
      const match = key.match(ROUTER_RULE_KEY);
      if (!match || !value) {
        continue;
      }

      const routerId = match[1];
      const hosts = parseHostsFromRule(value);
      if (hosts.length === 0) {
        continue;
      }

      routes.push(buildRoute(container, routerId, hosts, tlsEnabled));
    }
  }

  const hostCount = new Map<string, number>();
  for (const route of routes) {
    for (const host of route.hosts) {
      hostCount.set(host, (hostCount.get(host) ?? 0) + 1);
    }
  }

  const duplicateHosts = Array.from(hostCount.entries())
    .filter(([, count]) => count > 1)
    .map(([host]) => host)
    .sort();

  return { routes, duplicateHosts };
}

export function resolveRouteByName(routes: Route[], name: string): Route {
  const target = name.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const matches = routes.filter((route) => {
    if (route.serviceName === target) {
      return true;
    }
    if (route.containerName === target) {
      return true;
    }
    if (route.hosts.includes(target)) {
      return true;
    }
    return route.hosts.some((host) => host.replace(/\.localhost$/, "") === target);
  });

  if (matches.length === 0) {
    throw new Error(`No route found for '${name}'. Run 'dev ls' to view available routes.`);
  }

  if (matches.length > 1) {
    const names = matches.map((route) => `${route.serviceName} (${route.hosts.join(",")})`).join("; ");
    throw new Error(`Route name '${name}' is ambiguous: ${names}`);
  }

  return matches[0];
}
