import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { HostRouteState, Route } from "../types";
import {
  DEVROUTER_HOME,
  HOST_ROUTES_STATE_FILE,
  TRAEFIK_DYNAMIC_DIR,
  TRAEFIK_HOST_ROUTES_FILE,
  isTLSEnabled
} from "./router";

type UpsertHostRouteInput = {
  name: string;
  host: string;
  protocol?: "http";
  repoPath: string;
  port: number;
  mode: "run" | "attach" | "proxy";
  upstreamHost?: string;
  pid?: number;
  command?: string;
};

// Loopback hostnames a user would write for a port on their own machine. Traefik
// runs inside Docker, so these must be rewritten to host.docker.internal to reach
// the host (e.g. a devcontainer publishing on 127.0.0.1:3000).
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const UPSTREAM_RE = /^([a-zA-Z0-9._-]+):(\d{1,5})$/;

/**
 * Parse a proxy `upstream` (`host:port`) into the port and the backend host
 * Traefik should dial. Loopback hosts are rewritten to host.docker.internal;
 * any other host passes through verbatim (e.g. a devnet container name).
 * Throws on malformed input or out-of-range port.
 */
export function parseUpstream(upstream: string): { host: string; port: number; upstreamHost: string } {
  const match = UPSTREAM_RE.exec(upstream.trim());
  if (!match) {
    throw new Error(`upstream must be in the form host:port (got '${upstream}').`);
  }
  const host = match[1];
  const port = Number(match[2]);
  if (port < 1 || port > 65535) {
    throw new Error(`upstream port must be between 1 and 65535 (got ${port}).`);
  }
  const upstreamHost = LOOPBACK_HOSTS.has(host) ? "host.docker.internal" : host;
  return { host, port, upstreamHost };
}

export function isPidRunning(pid: number | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function buildHostRouteId(repoPath: string, name: string): string {
  return `${repoPath}::${name}`;
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function writeHostRoutesDynamicFile(routes: HostRouteState[], tlsEnabled: boolean): void {
  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};

  for (const route of routes) {
    const key = `host-${sanitizeKey(route.id)}`;
    const router: Record<string, unknown> = {
      rule: `Host(\`${route.host}\`)`,
      entryPoints: tlsEnabled ? ["web", "websecure"] : ["web"],
      service: key
    };
    if (tlsEnabled) {
      router.tls = true;
    }

    routers[key] = router;

    services[key] = {
      loadBalancer: {
        servers: [{ url: `http://${route.upstreamHost ?? "host.docker.internal"}:${route.port}` }]
      }
    };
  }

  const document = {
    http: {
      routers,
      services
    }
  };

  fs.writeFileSync(TRAEFIK_HOST_ROUTES_FILE, YAML.stringify(document, { lineWidth: 0 }), "utf-8");
}

export function ensureHostRouteStorage(): void {
  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  fs.mkdirSync(TRAEFIK_DYNAMIC_DIR, { recursive: true });

  if (!fs.existsSync(TRAEFIK_HOST_ROUTES_FILE)) {
    fs.writeFileSync(
      TRAEFIK_HOST_ROUTES_FILE,
      YAML.stringify({ http: { routers: {}, services: {} } }, { lineWidth: 0 }),
      "utf-8"
    );
  }

  if (!fs.existsSync(HOST_ROUTES_STATE_FILE)) {
    fs.writeFileSync(HOST_ROUTES_STATE_FILE, "[]\n", "utf-8");
  }
}

function writeState(routes: HostRouteState[]): void {
  ensureHostRouteStorage();
  fs.writeFileSync(HOST_ROUTES_STATE_FILE, `${JSON.stringify(routes, null, 2)}\n`, "utf-8");
  writeHostRoutesDynamicFile(routes, isTLSEnabled());
}

export function refreshHostRoutesDynamicFile(): void {
  const routes = listHostRouteState();
  writeHostRoutesDynamicFile(routes, isTLSEnabled());
}

export function listHostRouteState(): HostRouteState[] {
  ensureHostRouteStorage();

  if (!fs.existsSync(HOST_ROUTES_STATE_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(HOST_ROUTES_STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => item as HostRouteState);
  } catch {
    return [];
  }
}

export function upsertHostRoute(input: UpsertHostRouteInput): HostRouteState {
  const routes = listHostRouteState();
  const id = buildHostRouteId(input.repoPath, input.name);
  const existing = routes.find((route) => route.id === id);
  const now = new Date().toISOString();

  const next: HostRouteState = {
    id,
    name: input.name,
    host: input.host,
    protocol: input.protocol ?? "http",
    repoPath: input.repoPath,
    port: input.port,
    mode: input.mode,
    upstreamHost: input.upstreamHost,
    pid: input.pid,
    command: input.command,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  const remaining = routes.filter((route) => route.id !== id);
  remaining.push(next);
  remaining.sort((a, b) => a.name.localeCompare(b.name) || a.repoPath.localeCompare(b.repoPath));
  writeState(remaining);
  return next;
}

export function removeHostRouteById(id: string): boolean {
  const routes = listHostRouteState();
  const next = routes.filter((route) => route.id !== id);
  if (next.length === routes.length) {
    return false;
  }

  writeState(next);
  return true;
}

export function removeHostRouteByName(name: string, repoPath?: string): HostRouteState {
  const routes = listHostRouteState();
  const matches = routes.filter((route) => {
    if (route.name !== name) {
      return false;
    }

    if (repoPath && route.repoPath !== repoPath) {
      return false;
    }

    return true;
  });

  if (matches.length === 0) {
    throw new Error(`No host route named '${name}' found.`);
  }

  if (matches.length > 1 && !repoPath) {
    const refs = matches.map((route) => `${route.name} (${route.repoPath})`).join(", ");
    throw new Error(
      `Multiple host routes named '${name}' exist. Re-run with --repo to disambiguate: ${refs}`
    );
  }

  const match = matches[0];
  const next = routes.filter((route) => route.id !== match.id);
  writeState(next);
  return match;
}

export function listHostRoutes(tlsEnabled: boolean): Route[] {
  const routes = listHostRouteState();
  const scheme = tlsEnabled ? "https" : "http";

  return routes.map((route) => ({
    id: route.id,
    source: "host",
    protocol: "http",
    appName: route.name,
    serviceName: route.name,
    projectName: path.basename(route.repoPath),
    hosts: [route.host],
    urls: [`${scheme}://${route.host}`],
    // Proxy routes front an externally-managed upstream and have no pid; they are
    // live as long as the route exists.
    status: route.mode === "proxy" ? "running" : isPidRunning(route.pid) ? "running" : "stopped",
    health: "unknown",
    createdAt: Math.floor(new Date(route.createdAt).getTime() / 1000)
  }));
}
