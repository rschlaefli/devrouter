import type { ContainerInfo } from "dockerode";
import type { Route } from "../types";
import { TCP_PROTOCOL_REGISTRY } from "./router";

const HTTP_ROUTER_RULE_KEY = /^traefik\.http\.routers\.([^.]+)\.rule$/;
const TCP_ROUTER_RULE_KEY = /^traefik\.tcp\.routers\.([^.]+)\.rule$/;
const TCP_ROUTER_ENTRYPOINTS_KEY = /^traefik\.tcp\.routers\.([^.]+)\.entrypoints$/;

function resolveEntrypointToProtocol(entrypoint: string): string {
  for (const [protocol, entry] of Object.entries(TCP_PROTOCOL_REGISTRY)) {
    if (entry.entrypoint === entrypoint) {
      return protocol;
    }
  }
  return entrypoint;
}

function normalizeContainerName(name: string | undefined): string {
  if (!name) {
    return "unknown";
  }
  return name.startsWith("/") ? name.slice(1) : name;
}

export function parseHostsFromRule(rule: string): string[] {
  return parseHostsFromMatcher(rule, "Host");
}

function parseHostsFromMatcher(rule: string, matcherName: "Host" | "HostSNI"): string[] {
  const hosts: string[] = [];
  const matcherRegex = new RegExp(`${matcherName}\\(([^)]+)\\)`, "g");
  const hostBlocks = rule.matchAll(matcherRegex);

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
  protocol: Route["protocol"],
  tlsEnabled: boolean
): Route {
  const labels = container.Labels ?? {};
  const containerName = normalizeContainerName(container.Names?.[0]);
  const serviceName = labels["com.docker.compose.service"] ?? containerName;
  const appName = labels["devrouter.app.name"] ?? routerId;
  const projectName = labels["com.docker.compose.project"] ?? "-";

  const status = container.State ?? "unknown";
  const statusText = container.Status ?? "";
  let health = "unknown";
  if (statusText.includes("unhealthy")) {
    health = "unhealthy";
  } else if (statusText.includes("healthy")) {
    health = "healthy";
  }

  let urls: string[];
  if (protocol === "http") {
    urls = hosts.map((host) => `${tlsEnabled ? "https" : "http"}://${host}`);
  } else {
    const tcpProtocol = protocol.startsWith("tcp/") ? protocol.slice(4) : "tcp";
    const registryEntry = TCP_PROTOCOL_REGISTRY[tcpProtocol];
    const port = registryEntry?.port ?? "?";
    urls = hosts.map((host) => `${tcpProtocol}://${host}:${port} (tls required)`);
  }

  return {
    id: routerId,
    source: "docker",
    protocol,
    appName,
    containerId: container.Id,
    containerName,
    serviceName,
    projectName,
    hosts,
    urls,
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
      if (!value) {
        continue;
      }

      const httpMatch = key.match(HTTP_ROUTER_RULE_KEY);
      if (httpMatch) {
        const routerId = httpMatch[1];
        const hosts = parseHostsFromMatcher(value, "Host");
        if (hosts.length > 0) {
          routes.push(buildRoute(container, routerId, hosts, "http", tlsEnabled));
        }
        continue;
      }

      const tcpMatch = key.match(TCP_ROUTER_RULE_KEY);
      if (!tcpMatch) {
        continue;
      }

      const routerId = tcpMatch[1];
      const hosts = parseHostsFromMatcher(value, "HostSNI").filter((host) => host !== "*");
      if (hosts.length === 0) {
        continue;
      }

      const entrypointsLabel = labels[`traefik.tcp.routers.${routerId}.entrypoints`];
      const tcpProtocol = entrypointsLabel ? resolveEntrypointToProtocol(entrypointsLabel) : "tcp";
      routes.push(buildRoute(container, routerId, hosts, `tcp/${tcpProtocol}`, tlsEnabled));
    }
  }

  return { routes, duplicateHosts: findDuplicateHosts(routes) };
}

export function findDuplicateHosts(routes: Route[]): string[] {
  const hostCount = new Map<string, number>();
  for (const route of routes) {
    for (const host of route.hosts) {
      hostCount.set(host, (hostCount.get(host) ?? 0) + 1);
    }
  }

  return Array.from(hostCount.entries())
    .filter(([, count]) => count > 1)
    .map(([host]) => host)
    .sort();
}

export function resolveRouteByName(routes: Route[], name: string): Route {
  const target = name.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const matches = routes.filter((route) => {
    if (route.appName === target) {
      return true;
    }
    if (route.serviceName === target) {
      return true;
    }
    if (route.containerName && route.containerName === target) {
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
    const names = matches
      .map((route) => `${route.appName}/${route.serviceName} (${route.hosts.join(",")})`)
      .join("; ");
    throw new Error(`Route name '${name}' is ambiguous: ${names}`);
  }

  return matches[0];
}
