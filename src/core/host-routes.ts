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
  mode: "run" | "attach";
  pid?: number;
  command?: string;
};

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
        servers: [{ url: `http://host.docker.internal:${route.port}` }]
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
    status: isPidRunning(route.pid) ? "running" : "stopped",
    health: "unknown",
    createdAt: Math.floor(new Date(route.createdAt).getTime() / 1000)
  }));
}
