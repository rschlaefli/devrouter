import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { HostRouteState, Route } from "../types";
import {
  DEVROUTER_HOME,
  HOST_ROUTES_STATE_FILE,
  TCP_PROTOCOL_REGISTRY,
  TRAEFIK_DYNAMIC_DIR,
  TRAEFIK_HOST_ROUTES_FILE,
  isTLSEnabled
} from "./router";

type UpsertHostRouteInput = {
  name: string;
  host: string;
  protocol?: "http" | "tcp";
  tcpProtocol?: string;
  repoPath: string;
  port: number;
  mode: "run" | "attach" | "proxy";
  upstreamHost?: string;
  pid?: number;
  command?: string;
  workspace?: string;
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

/**
 * Build the Traefik file-provider dynamic document for the given routes. HTTP
 * routes become `http` Host() routers; TCP proxy routes become `tcp` HostSNI()
 * routers on their shared protocol entrypoint (TLS mandatory — SNI is read from
 * the TLS ClientHello — and Traefik terminates TLS, forwarding plaintext to the
 * upstream address). The `tcp` section is omitted entirely when there are no TCP
 * routes (an empty `tcp` map is a standalone element that breaks the provider).
 */
// Some TCP protocols require the TLS terminator to negotiate a specific ALPN
// protocol. libpq 17+ direct-SSL (sslnegotiation=direct, the only Postgres mode
// that sends an immediate TLS ClientHello with SNI) MANDATES that the server
// select ALPN `postgresql`; without it Traefik replies "no application
// protocol". Declared as a per-protocol TLSOption and referenced by the router.
const TCP_TLS_ALPN_PROTOCOLS: Record<string, string[]> = {
  postgres: ["postgresql"]
};

function tcpTlsOptionName(tcpProtocol: string): string {
  return `devrouter-tcp-${tcpProtocol}`;
}

export function buildHostRoutesDocument(
  routes: HostRouteState[],
  tlsEnabled: boolean
): Record<string, unknown> {
  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  const tcpRouters: Record<string, unknown> = {};
  const tcpServices: Record<string, unknown> = {};
  const tlsOptions: Record<string, unknown> = {};

  for (const route of routes) {
    const key = `host-${sanitizeKey(route.id)}`;

    if (route.protocol === "tcp") {
      const alpn = route.tcpProtocol ? TCP_TLS_ALPN_PROTOCOLS[route.tcpProtocol] : undefined;
      let tls: Record<string, unknown> = {};
      if (alpn && route.tcpProtocol) {
        const optionName = tcpTlsOptionName(route.tcpProtocol);
        tlsOptions[optionName] = { alpnProtocols: alpn };
        // `@file` qualifies the provider so Traefik resolves the option declared
        // in this same dynamic file.
        tls = { options: `${optionName}@file` };
      }
      tcpRouters[key] = {
        rule: `HostSNI(\`${route.host}\`)`,
        entryPoints: [route.tcpProtocol && TCP_PROTOCOL_REGISTRY[route.tcpProtocol]?.entrypoint].filter(
          Boolean
        ),
        service: key,
        tls
      };
      tcpServices[key] = {
        loadBalancer: {
          servers: [{ address: `${route.upstreamHost ?? "host.docker.internal"}:${route.port}` }]
        }
      };
      continue;
    }

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

  const document: Record<string, unknown> = {
    http: {
      routers,
      services
    }
  };
  if (Object.keys(tcpRouters).length > 0) {
    document.tcp = { routers: tcpRouters, services: tcpServices };
  }
  // TLS options live under the top-level `tls` key (Traefik merges this with the
  // certificates declared in base.yml across file-provider files).
  if (Object.keys(tlsOptions).length > 0) {
    document.tls = { options: tlsOptions };
  }

  return document;
}

function writeHostRoutesDynamicFile(routes: HostRouteState[], tlsEnabled: boolean): void {
  const document = buildHostRoutesDocument(routes, tlsEnabled);
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

const STATE_LOCK_FILE = `${HOST_ROUTES_STATE_FILE}.lock`;

function sleepSync(ms: number): void {
  // Synchronous, busy-wait-free sleep (no async refactor of the spawn-heavy run path).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize read-modify-write of the shared host-route state file across
 * processes. Parallel workspace runs (`dev app run` from several worktrees of the
 * same repo) otherwise race the read-modify-write and clobber each other's routes.
 * Uses an `O_EXCL` lockfile with a bounded wait; a lock older than the deadline is
 * assumed stale (crashed process) and reclaimed.
 */
function withStateLock<T>(fn: () => T): T {
  ensureHostRouteStorage();
  const deadline = Date.now() + 5000;
  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(STATE_LOCK_FILE, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      if (Date.now() >= deadline) {
        try {
          fs.rmSync(STATE_LOCK_FILE, { force: true });
        } catch {
          // Another waiter reclaimed it first; loop and retry.
        }
        continue;
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.rmSync(STATE_LOCK_FILE, { force: true });
    } catch {
      // Best effort: a stale-lock reclaim may have already removed it.
    }
  }
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
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {
      process.stderr.write(
        `Warning: devrouter host routes state file is corrupted or unreadable (${error.message}). Recreating route state.\n`
      );
    }
    return [];
  }
}

export function upsertHostRoute(input: UpsertHostRouteInput): HostRouteState {
  return withStateLock(() => {
    const routes = listHostRouteState();
    const id = buildHostRouteId(input.repoPath, input.name);
    const existing = routes.find((route) => route.id === id);
    const now = new Date().toISOString();

    const next: HostRouteState = {
      id,
      name: input.name,
      host: input.host,
      protocol: input.protocol ?? "http",
      tcpProtocol: input.tcpProtocol,
      repoPath: input.repoPath,
      port: input.port,
      mode: input.mode,
      upstreamHost: input.upstreamHost,
      pid: input.pid,
      command: input.command,
      workspace: input.workspace,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    const remaining = routes.filter((route) => route.id !== id);
    remaining.push(next);
    remaining.sort((a, b) => a.name.localeCompare(b.name) || a.repoPath.localeCompare(b.repoPath));
    writeState(remaining);
    return next;
  });
}

export function removeHostRouteById(id: string): boolean {
  return withStateLock(() => {
    const routes = listHostRouteState();
    const next = routes.filter((route) => route.id !== id);
    if (next.length === routes.length) {
      return false;
    }

    writeState(next);
    return true;
  });
}

export function removeHostRoutesWhere(
  predicate: (route: HostRouteState) => boolean
): HostRouteState[] {
  return withStateLock(() => {
    const routes = listHostRouteState();
    const removed = routes.filter(predicate);
    if (removed.length === 0) {
      return [];
    }

    const removedIds = new Set(removed.map((route) => route.id));
    writeState(routes.filter((route) => !removedIds.has(route.id)));
    return removed;
  });
}

export function removeHostRouteByName(name: string, repoPath?: string): HostRouteState {
  return withStateLock(() => {
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
  });
}

export function listHostRoutes(tlsEnabled: boolean): Route[] {
  const routes = listHostRouteState();
  const scheme = tlsEnabled ? "https" : "http";

  return routes.map((route) => {
    const isTcp = route.protocol === "tcp";
    const tcpProtocol = route.tcpProtocol ?? "tcp";
    return {
      id: route.id,
      source: "host",
      protocol: isTcp ? (`tcp/${tcpProtocol}` as const) : "http",
      appName: route.name,
      serviceName: route.name,
      projectName: path.basename(route.repoPath),
      hosts: [route.host],
      // TCP routes are reached via an SNI-aware client on the shared protocol
      // port; surface a protocol-scheme URL rather than http(s)://.
      urls: isTcp
        ? [`${tcpProtocol}://${route.host}:${TCP_PROTOCOL_REGISTRY[tcpProtocol]?.port ?? route.port}`]
        : [`${scheme}://${route.host}`],
      // Proxy routes front an externally-managed upstream and have no pid; they are
      // live as long as the route exists.
      status: route.mode === "proxy" ? "running" : isPidRunning(route.pid) ? "running" : "stopped",
      health: "unknown",
      createdAt: Math.floor(new Date(route.createdAt).getTime() / 1000)
    };
  });
}
