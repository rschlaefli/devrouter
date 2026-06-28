import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { withDockerFailureGuidance } from "./docker-error-guidance";

export const DEVNET_NAME = "devnet";
export const ROUTER_CONTAINER_NAME = "devrouter-traefik";

export type TcpProtocolEntry = {
  port: number;
  entrypoint: string;
};

export const TCP_PROTOCOL_REGISTRY: Record<string, TcpProtocolEntry> = {
  postgres: { port: 5432, entrypoint: "postgres" },
  redis: { port: 6379, entrypoint: "redis" },
  mariadb: { port: 3306, entrypoint: "mariadb" },
  mysql: { port: 3306, entrypoint: "mysql" },
};

export const DEVROUTER_HOME = path.join(os.homedir(), ".config", "devrouter");
export const TRAEFIK_DIR = path.join(DEVROUTER_HOME, "traefik");
export const TRAEFIK_DYNAMIC_DIR = path.join(TRAEFIK_DIR, "dynamic");
export const CERTS_DIR = path.join(DEVROUTER_HOME, "certs");
export const BIN_DIR = path.join(DEVROUTER_HOME, "bin");
export const CACHE_DIR = path.join(DEVROUTER_HOME, "cache");

export const COMPOSE_FILE = path.join(DEVROUTER_HOME, "compose.yml");
export const TRAEFIK_STATIC_FILE = path.join(TRAEFIK_DIR, "traefik.yml");
export const TRAEFIK_DYNAMIC_BASE_FILE = path.join(TRAEFIK_DYNAMIC_DIR, "base.yml");
export const TRAEFIK_HOST_ROUTES_FILE = path.join(TRAEFIK_DYNAMIC_DIR, "host-routes.yml");
export const HOST_ROUTES_STATE_FILE = path.join(DEVROUTER_HOME, "host-routes-state.json");
export const ACTIVE_TCP_PROTOCOLS_FILE = path.join(DEVROUTER_HOME, "active-tcp-protocols.json");
export const ROUTER_README_FILE = path.join(DEVROUTER_HOME, "README.md");
const LEGACY_TRAEFIK_DYNAMIC_FILE = path.join(TRAEFIK_DIR, "dynamic.yml");

export const CERT_FILE = path.join(CERTS_DIR, "localhost.pem");
export const CERT_KEY_FILE = path.join(CERTS_DIR, "localhost-key.pem");

const ROUTER_REQUIRED_FILES = [
  COMPOSE_FILE,
  TRAEFIK_STATIC_FILE,
  TRAEFIK_DYNAMIC_BASE_FILE,
  TRAEFIK_HOST_ROUTES_FILE,
  HOST_ROUTES_STATE_FILE
] as const;

function renderComposeYml(activeTcpPorts: TcpProtocolEntry[]): string {
  const tcpPortLines = activeTcpPorts.map((entry) => `      - "${entry.port}:${entry.port}"`).join("\n");
  const tcpSection = tcpPortLines.length > 0 ? `\n${tcpPortLines}` : "";
  return `services:
  traefik:
    image: traefik:v2.11
    container_name: ${ROUTER_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"${tcpSection}
      - "127.0.0.1:8080:8080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
      - "${TRAEFIK_STATIC_FILE}:/etc/traefik/traefik.yml:ro"
      - "${TRAEFIK_DYNAMIC_DIR}:/etc/traefik/dynamic:ro"
      - "${CERTS_DIR}:/certs:ro"
    networks:
      - ${DEVNET_NAME}

networks:
  ${DEVNET_NAME}:
    external: true
`;
}

function renderTraefikStaticYml(activeTcpEntrypoints: TcpProtocolEntry[]): string {
  const tcpEntrypointLines = activeTcpEntrypoints
    .map((entry) => `  ${entry.entrypoint}:\n    address: ":${entry.port}"`)
    .join("\n");
  const tcpSection = tcpEntrypointLines.length > 0 ? `\n${tcpEntrypointLines}` : "";
  return `api:
  dashboard: true
  insecure: true

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"${tcpSection}
  traefik:
    address: ":8080"

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: ${DEVNET_NAME}
  file:
    directory: /etc/traefik/dynamic
    watch: true

accessLog: {}
`;
}

export function renderTraefikBaseDynamicYml(tlsEnabled: boolean): string {
  if (!tlsEnabled) {
    // Traefik v2.11 rejects empty standalone dynamic maps with "X cannot be a
    // standalone element", which fails the whole file provider and makes every
    // host/proxy route 404. With TLS off there is nothing to declare here, so
    // emit a comment-only file (Traefik ignores empty dynamic files).
    return `# devrouter: TLS disabled, no base dynamic config required.
# Intentionally left empty (empty Traefik dynamic maps break the file provider).
`;
  }

  return `http:
  middlewares:
    redirect-to-https:
      redirectScheme:
        scheme: https
        permanent: false
  routers:
    redirect-http-to-https:
      entryPoints:
        - web
      rule: "HostRegexp(\`{host:.+\\\\.localhost}\`)"
      middlewares:
        - redirect-to-https
      service: noop@internal

tls:
  certificates:
    - certFile: /certs/localhost.pem
      keyFile: /certs/localhost-key.pem
`;
}

function renderHostRoutesDynamicYml(): string {
  return `http:
  routers: {}
  services: {}
`;
}

function renderHostRouteState(): string {
  return "[]\n";
}

function renderRouterReadme(): string {
  return `# devrouter state

This folder is managed by the devrouter CLI.

## Files

- compose.yml: shared Traefik stack
- traefik/traefik.yml: Traefik static config
- traefik/dynamic/base.yml: TLS + redirect config
- traefik/dynamic/host-routes.yml: generated host-run routes
- host-routes-state.json: host-run route metadata
- certs/: mkcert output files

## Commands

- dev init [--write-agents] [--write-skill] [--with-linear]
- dev -V [--repo <path>] (installed/local version + next upgrade)
- dev upgrade [version] [--repo <path>]
- dev setup --yes [--repo <path>] [--json]
- dev up
- dev down
- dev status
- dev doctor
- dev ls
- dev open <name>
- dev logs [-f] [--tail N]
- dev repo init
- dev repo inspect [--repo <path>] [--json]
- dev repo agents [--with-linear]
- dev app add --name <name> --host <host.localhost> --protocol <http|tcp> --runtime <host|docker>
- dev app run <name>
- dev app exec <name> [--shell] [--env-map TARGET=SOURCE] -- <command>
- dev app ls
- dev app rm <name>
- dev tls install

## Troubleshooting

If dev up fails with port conflicts on 80/443 (or TCP protocol ports), run:

- lsof -nP -iTCP:80 -sTCP:LISTEN
- lsof -nP -iTCP:443 -sTCP:LISTEN
`;
}

function resolveActiveTcpEntries(protocols: string[]): TcpProtocolEntry[] {
  const seen = new Set<number>();
  const entries: TcpProtocolEntry[] = [];
  for (const protocol of protocols) {
    const entry = TCP_PROTOCOL_REGISTRY[protocol];
    if (entry && !seen.has(entry.port)) {
      seen.add(entry.port);
      entries.push(entry);
    }
  }
  return entries;
}

export function getActiveTcpProtocols(): string[] {
  if (!fs.existsSync(ACTIVE_TCP_PROTOCOLS_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(ACTIVE_TCP_PROTOCOLS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item in TCP_PROTOCOL_REGISTRY);
  } catch {
    return [];
  }
}

function saveActiveTcpProtocols(protocols: string[]): void {
  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  fs.writeFileSync(ACTIVE_TCP_PROTOCOLS_FILE, JSON.stringify(protocols, null, 2) + "\n", "utf-8");
}

export function activateTcpProtocol(protocol: string): boolean {
  if (!(protocol in TCP_PROTOCOL_REGISTRY)) {
    throw new Error(`Unknown TCP protocol '${protocol}'. Supported: ${Object.keys(TCP_PROTOCOL_REGISTRY).join(", ")}`);
  }
  const current = getActiveTcpProtocols();
  if (current.includes(protocol)) {
    return false;
  }
  const next = [...current, protocol];
  saveActiveTcpProtocols(next);
  ensureRouterFiles(next);
  return true;
}

export function clearActiveTcpProtocols(): void {
  if (fs.existsSync(ACTIVE_TCP_PROTOCOLS_FILE)) {
    fs.unlinkSync(ACTIVE_TCP_PROTOCOLS_FILE);
  }
}

export function ensureRouterFiles(activeTcpProtocols?: string[]): void {
  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  fs.mkdirSync(TRAEFIK_DIR, { recursive: true });
  fs.mkdirSync(TRAEFIK_DYNAMIC_DIR, { recursive: true });
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const protocols = activeTcpProtocols ?? getActiveTcpProtocols();
  const tcpEntries = resolveActiveTcpEntries(protocols);

  fs.writeFileSync(COMPOSE_FILE, renderComposeYml(tcpEntries), "utf-8");
  fs.writeFileSync(TRAEFIK_STATIC_FILE, renderTraefikStaticYml(tcpEntries), "utf-8");

  if (!fs.existsSync(TRAEFIK_DYNAMIC_BASE_FILE)) {
    if (fs.existsSync(LEGACY_TRAEFIK_DYNAMIC_FILE)) {
      fs.copyFileSync(LEGACY_TRAEFIK_DYNAMIC_FILE, TRAEFIK_DYNAMIC_BASE_FILE);
    } else {
      fs.writeFileSync(TRAEFIK_DYNAMIC_BASE_FILE, renderTraefikBaseDynamicYml(false), "utf-8");
    }
  }

  if (!fs.existsSync(TRAEFIK_HOST_ROUTES_FILE)) {
    fs.writeFileSync(TRAEFIK_HOST_ROUTES_FILE, renderHostRoutesDynamicYml(), "utf-8");
  }

  if (!fs.existsSync(HOST_ROUTES_STATE_FILE)) {
    fs.writeFileSync(HOST_ROUTES_STATE_FILE, renderHostRouteState(), "utf-8");
  }

  fs.writeFileSync(ROUTER_README_FILE, renderRouterReadme(), "utf-8");
}

export function setTLSEnabled(enabled: boolean): void {
  ensureRouterFiles();
  fs.writeFileSync(TRAEFIK_DYNAMIC_BASE_FILE, renderTraefikBaseDynamicYml(enabled), "utf-8");
}

export function isTLSConfigured(): boolean {
  if (!fs.existsSync(TRAEFIK_DYNAMIC_BASE_FILE)) {
    return false;
  }

  const content = fs.readFileSync(TRAEFIK_DYNAMIC_BASE_FILE, "utf-8");
  return content.includes("certificates:") && content.includes("/certs/localhost.pem");
}

export function areTLSCertsPresent(): boolean {
  return fs.existsSync(CERT_FILE) && fs.existsSync(CERT_KEY_FILE);
}

export function isTLSEnabled(): boolean {
  return areTLSCertsPresent() && isTLSConfigured();
}

export function getRouterFileLayout(): { required: string[]; missing: string[] } {
  const required = [...ROUTER_REQUIRED_FILES];
  const missing = required.filter((filePath) => !fs.existsSync(filePath));
  return { required, missing };
}

export function runDockerCompose(args: string[]): void {
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    encoding: "utf-8"
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`docker compose failed: ${withDockerFailureGuidance(details || "unknown error")}`);
  }
}

export function startRouterStack(): void {
  runDockerCompose(["up", "-d"]);
}

export function stopRouterStack(): void {
  runDockerCompose(["down"]);
}
