import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import type { HostRouteState, Route } from "../types";
import { withFileLockSync } from "./file-lock";
import {
  DEVROUTER_HOME,
  HOST_ROUTES_STATE_FILE,
  isTLSEnabled,
  TCP_PROTOCOL_REGISTRY,
  TRAEFIK_DYNAMIC_DIR,
  TRAEFIK_HOST_ROUTES_FILE,
} from "./router";
import { sameWorkspacePath } from "./workspace";

export type HostRouteInput = {
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
export function parseUpstream(upstream: string): {
  host: string;
  port: number;
  upstreamHost: string;
} {
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

function hostRouteFromInput(
  input: HostRouteInput,
  existing: HostRouteState | undefined,
  now: string,
): HostRouteState {
  return {
    id: buildHostRouteId(input.repoPath, input.name),
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
    updatedAt: now,
  };
}

function sanitizeKey(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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
  postgres: ["postgresql"],
};

function tcpTlsOptionName(tcpProtocol: string): string {
  return `devrouter-tcp-${tcpProtocol}`;
}

export function buildHostRoutesDocument(
  routes: HostRouteState[],
  tlsEnabled: boolean,
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
        entryPoints: [
          route.tcpProtocol && TCP_PROTOCOL_REGISTRY[route.tcpProtocol]?.entrypoint,
        ].filter(Boolean),
        service: key,
        tls,
      };
      tcpServices[key] = {
        loadBalancer: {
          servers: [{ address: `${route.upstreamHost ?? "host.docker.internal"}:${route.port}` }],
        },
      };
      continue;
    }

    const router: Record<string, unknown> = {
      rule: `Host(\`${route.host}\`)`,
      entryPoints: tlsEnabled ? ["web", "websecure"] : ["web"],
      service: key,
    };
    if (tlsEnabled) {
      router.tls = true;
    }

    routers[key] = router;

    services[key] = {
      loadBalancer: {
        servers: [{ url: `http://${route.upstreamHost ?? "host.docker.internal"}:${route.port}` }],
      },
    };
  }

  const document: Record<string, unknown> = {
    http: {
      routers,
      services,
    },
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

const ROUTE_METADATA_PREFIX = "# devrouter-routes-v1: ";
const ROUTE_METADATA_FAMILY_PREFIX = "# devrouter-routes-";

type RouteMetadata = {
  version: 1;
  tlsEnabled: boolean;
  routes: HostRouteState[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRouteState(value: unknown, source: string): HostRouteState[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} must contain a route array.`);
  }

  const routes = value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${source} route ${index} must be an object.`);
    }
    for (const key of ["id", "name", "host", "repoPath", "createdAt", "updatedAt"] as const) {
      if (typeof item[key] !== "string" || item[key].length === 0) {
        throw new Error(`${source} route ${index} has an invalid '${key}'.`);
      }
    }
    if (!Number.isInteger(item.port) || Number(item.port) < 1 || Number(item.port) > 65535) {
      throw new Error(`${source} route ${index} has an invalid 'port'.`);
    }
    if (item.mode !== "run" && item.mode !== "attach" && item.mode !== "proxy") {
      throw new Error(`${source} route ${index} has an invalid 'mode'.`);
    }
    if (item.protocol !== undefined && item.protocol !== "http" && item.protocol !== "tcp") {
      throw new Error(`${source} route ${index} has an invalid 'protocol'.`);
    }
    for (const key of ["tcpProtocol", "upstreamHost", "command", "workspace"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "string") {
        throw new Error(`${source} route ${index} has an invalid '${key}'.`);
      }
    }
    if (item.pid !== undefined && (!Number.isInteger(item.pid) || Number(item.pid) <= 0)) {
      throw new Error(`${source} route ${index} has an invalid 'pid'.`);
    }

    const route = item as HostRouteState;
    if (route.id !== buildHostRouteId(route.repoPath, route.name)) {
      throw new Error(`${source} route ${index} has an inconsistent 'id'.`);
    }
    return route;
  });

  const ids = new Set<string>();
  const hosts = new Set<string>();
  for (const route of routes) {
    if (ids.has(route.id)) {
      throw new Error(`${source} contains duplicate route id '${route.id}'.`);
    }
    if (hosts.has(route.host)) {
      throw new Error(`${source} contains duplicate route host '${route.host}'.`);
    }
    ids.add(route.id);
    hosts.add(route.host);
  }
  return routes;
}

function fsyncDirectory(directory: string): void {
  const directoryHandle = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(directoryHandle);
  } finally {
    fs.closeSync(directoryHandle);
  }
}

function atomicDurableWrite(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryHandle: number | undefined;
  try {
    temporaryHandle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(temporaryHandle, contents, "utf-8");
    fs.fsyncSync(temporaryHandle);
    fs.closeSync(temporaryHandle);
    temporaryHandle = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (temporaryHandle !== undefined) {
      fs.closeSync(temporaryHandle);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw cleanupError;
      }
    }
    throw error;
  }
}

function renderCompatibilityState(routes: HostRouteState[]): string {
  return `${JSON.stringify(routes, null, 2)}\n`;
}

function renderCanonicalState(routes: HostRouteState[], tlsEnabled: boolean): string {
  const metadata: RouteMetadata = { version: 1, tlsEnabled, routes };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url");
  const document = buildHostRoutesDocument(routes, tlsEnabled);
  return `${ROUTE_METADATA_PREFIX}${encoded}\n${YAML.stringify(document, { lineWidth: 0 })}`;
}

function writeRouteGeneration(routes: HostRouteState[], tlsEnabled: boolean): void {
  atomicDurableWrite(HOST_ROUTES_STATE_FILE, renderCompatibilityState(routes));
  atomicDurableWrite(TRAEFIK_HOST_ROUTES_FILE, renderCanonicalState(routes, tlsEnabled));
}

function readCompatibilityState(): HostRouteState[] {
  let raw: string;
  try {
    raw = fs.readFileSync(HOST_ROUTES_STATE_FILE, "utf-8");
  } catch (error) {
    throw new Error(
      `Could not read the compatibility host-route state: ${(error as Error).message}`,
    );
  }
  try {
    return validateRouteState(JSON.parse(raw), "Compatibility host-route state");
  } catch (error) {
    throw new Error(`Invalid compatibility host-route state: ${(error as Error).message}`);
  }
}

function parseCanonicalState(
  raw: string,
): { kind: "legacy" } | { kind: "canonical"; metadata: RouteMetadata } {
  const firstNewline = raw.indexOf("\n");
  const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
  if (!firstLine.startsWith(ROUTE_METADATA_PREFIX)) {
    if (firstLine.startsWith(ROUTE_METADATA_FAMILY_PREFIX)) {
      throw new Error(`Unsupported or malformed host-route metadata header '${firstLine}'.`);
    }
    return { kind: "legacy" };
  }

  const encoded = firstLine.slice(ROUTE_METADATA_PREFIX.length);
  if (!/^[a-zA-Z0-9_-]+$/.test(encoded)) {
    throw new Error("Host-route metadata header is not valid base64url.");
  }

  let metadataValue: unknown;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) {
      throw new Error("non-canonical base64url encoding");
    }
    metadataValue = JSON.parse(decoded.toString("utf-8"));
  } catch (error) {
    throw new Error(`Host-route metadata header is invalid: ${(error as Error).message}`);
  }
  if (!isRecord(metadataValue) || metadataValue.version !== 1) {
    throw new Error("Host-route metadata header has an unsupported version.");
  }
  if (typeof metadataValue.tlsEnabled !== "boolean") {
    throw new Error("Host-route metadata header has an invalid TLS state.");
  }
  const routes = validateRouteState(metadataValue.routes, "Canonical host-route metadata");
  const metadata: RouteMetadata = {
    version: 1,
    tlsEnabled: metadataValue.tlsEnabled,
    routes,
  };

  let document: unknown;
  try {
    document = YAML.parse(firstNewline === -1 ? "" : raw.slice(firstNewline + 1));
  } catch (error) {
    throw new Error(`Canonical host-route document is invalid: ${(error as Error).message}`);
  }
  const expectedDocument = buildHostRoutesDocument(routes, metadata.tlsEnabled);
  if (!isDeepStrictEqual(document, expectedDocument)) {
    throw new Error("Canonical host-route document does not match its metadata.");
  }
  return { kind: "canonical", metadata };
}

export function ensureHostRouteStorage(): void {
  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  fs.mkdirSync(TRAEFIK_DYNAMIC_DIR, { recursive: true });
}

function writeState(routes: HostRouteState[]): void {
  ensureHostRouteStorage();
  writeRouteGeneration(routes, isTLSEnabled());
}

const STATE_LOCK_FILE = `${HOST_ROUTES_STATE_FILE}.lock`;

/**
 * Serialize read-modify-write of the shared host-route state file across
 * processes. Parallel workspace runs (`dev app run` from several worktrees of the
 * same repo) otherwise race the read-modify-write and clobber each other's routes.
 * Uses an inode-verified dot lock with a bounded wait. Dead owners are reclaimed;
 * a live owner is never forcibly displaced.
 */
function withStateLock<T>(fn: () => T): T {
  ensureHostRouteStorage();
  return withFileLockSync(STATE_LOCK_FILE, { activity: "host route update", waitMs: 5000 }, fn);
}

export function refreshHostRoutesDynamicFile(): void {
  withStateLock(() => {
    const routes = readHostRouteStateLocked();
    writeState(routes);
  });
}

function readHostRouteStateLocked(): HostRouteState[] {
  ensureHostRouteStorage();
  if (!fs.existsSync(TRAEFIK_HOST_ROUTES_FILE)) {
    if (fs.existsSync(HOST_ROUTES_STATE_FILE)) {
      const routes = readCompatibilityState();
      writeRouteGeneration(routes, isTLSEnabled());
      return routes;
    }
    writeRouteGeneration([], isTLSEnabled());
    return [];
  }

  const raw = fs.readFileSync(TRAEFIK_HOST_ROUTES_FILE, "utf-8");
  const canonical = parseCanonicalState(raw);
  if (canonical.kind === "legacy") {
    if (!fs.existsSync(HOST_ROUTES_STATE_FILE)) {
      throw new Error(
        "Headerless host-route document requires a valid compatibility state file for migration.",
      );
    }
    const routes = readCompatibilityState();
    writeRouteGeneration(routes, isTLSEnabled());
    return routes;
  }

  let mirrorMatches = false;
  if (fs.existsSync(HOST_ROUTES_STATE_FILE)) {
    try {
      mirrorMatches = isDeepStrictEqual(readCompatibilityState(), canonical.metadata.routes);
    } catch {
      mirrorMatches = false;
    }
  }
  if (!mirrorMatches) {
    atomicDurableWrite(HOST_ROUTES_STATE_FILE, renderCompatibilityState(canonical.metadata.routes));
  }
  return canonical.metadata.routes;
}

export function listHostRouteState(): HostRouteState[] {
  return withStateLock(readHostRouteStateLocked);
}

export function upsertHostRoute(input: HostRouteInput): HostRouteState {
  return withStateLock(() => {
    const routes = readHostRouteStateLocked();
    const id = buildHostRouteId(input.repoPath, input.name);
    const existing = routes.find((route) => route.id === id);
    const now = new Date().toISOString();
    const next = hostRouteFromInput(input, existing, now);

    const remaining = routes.filter((route) => route.id !== id);
    remaining.push(next);
    remaining.sort((a, b) => a.name.localeCompare(b.name) || a.repoPath.localeCompare(b.repoPath));
    writeState(remaining);
    return next;
  });
}

/** Replace every route owned by one exact repo/worktree as one locked write. */
export function replaceHostRoutesForRepo(
  repoPath: string,
  inputs: HostRouteInput[],
): HostRouteState[] {
  return withStateLock(() => {
    if (inputs.some((input) => !sameWorkspacePath(input.repoPath, repoPath))) {
      throw new Error(`Route replacement contains an entry outside '${repoPath}'.`);
    }

    const routes = readHostRouteStateLocked();
    const remaining = routes.filter((route) => !sameWorkspacePath(route.repoPath, repoPath));
    const names = new Set<string>();
    const hosts = new Set<string>();
    for (const input of inputs) {
      if (names.has(input.name)) {
        throw new Error(`Route replacement contains duplicate app '${input.name}'.`);
      }
      if (hosts.has(input.host)) {
        throw new Error(`Route replacement contains duplicate host '${input.host}'.`);
      }
      const conflict = remaining.find((route) => route.host === input.host);
      if (conflict) {
        throw new Error(
          `Hostname '${input.host}' is already claimed by '${conflict.name}' (${conflict.repoPath}).`,
        );
      }
      names.add(input.name);
      hosts.add(input.host);
    }

    const now = new Date().toISOString();
    const replacements = inputs.map((input) => {
      const id = buildHostRouteId(input.repoPath, input.name);
      return hostRouteFromInput(
        input,
        routes.find((route) => route.id === id),
        now,
      );
    });
    const next = [...remaining, ...replacements].sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.repoPath.localeCompare(right.repoPath),
    );
    writeState(next);
    return replacements;
  });
}

export function removeHostRouteById(id: string): boolean {
  return withStateLock(() => {
    const routes = readHostRouteStateLocked();
    const next = routes.filter((route) => route.id !== id);
    if (next.length === routes.length) {
      return false;
    }

    writeState(next);
    return true;
  });
}

export function removeHostRoutesWhere(
  predicate: (route: HostRouteState) => boolean,
): HostRouteState[] {
  return withStateLock(() => {
    const routes = readHostRouteStateLocked();
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
    const routes = readHostRouteStateLocked();
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
        `Multiple host routes named '${name}' exist. Re-run with --repo to disambiguate: ${refs}`,
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
        ? [
            `${tcpProtocol}://${route.host}:${TCP_PROTOCOL_REGISTRY[tcpProtocol]?.port ?? route.port}`,
          ]
        : [`${scheme}://${route.host}`],
      // Proxy routes front an externally-managed upstream and have no pid; they are
      // live as long as the route exists.
      status: route.mode === "proxy" ? "running" : isPidRunning(route.pid) ? "running" : "stopped",
      health: "unknown",
      createdAt: Math.floor(new Date(route.createdAt).getTime() / 1000),
    };
  });
}
