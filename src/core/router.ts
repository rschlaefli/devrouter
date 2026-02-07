import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEVNET_NAME = "devnet";
export const ROUTER_CONTAINER_NAME = "devrouter-traefik";

export const DEVROUTER_HOME = path.join(os.homedir(), ".config", "devrouter");
export const TRAEFIK_DIR = path.join(DEVROUTER_HOME, "traefik");
export const TRAEFIK_DYNAMIC_DIR = path.join(TRAEFIK_DIR, "dynamic");
export const CERTS_DIR = path.join(DEVROUTER_HOME, "certs");
export const BIN_DIR = path.join(DEVROUTER_HOME, "bin");

export const COMPOSE_FILE = path.join(DEVROUTER_HOME, "compose.yml");
export const TRAEFIK_STATIC_FILE = path.join(TRAEFIK_DIR, "traefik.yml");
export const TRAEFIK_DYNAMIC_BASE_FILE = path.join(TRAEFIK_DYNAMIC_DIR, "base.yml");
export const TRAEFIK_HOST_ROUTES_FILE = path.join(TRAEFIK_DYNAMIC_DIR, "host-routes.yml");
export const HOST_ROUTES_STATE_FILE = path.join(DEVROUTER_HOME, "host-routes-state.json");
export const ROUTER_README_FILE = path.join(DEVROUTER_HOME, "README.md");
const LEGACY_TRAEFIK_DYNAMIC_FILE = path.join(TRAEFIK_DIR, "dynamic.yml");

export const CERT_FILE = path.join(CERTS_DIR, "localhost.pem");
export const CERT_KEY_FILE = path.join(CERTS_DIR, "localhost-key.pem");

function renderComposeYml(): string {
  return `services:
  traefik:
    image: traefik:v2.11
    container_name: ${ROUTER_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "127.0.0.1:8080:8080"
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

function renderTraefikStaticYml(): string {
  return `api:
  dashboard: true
  insecure: true

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
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

function renderTraefikBaseDynamicYml(tlsEnabled: boolean): string {
  if (!tlsEnabled) {
    return `http: {}

tls: {}
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

- dev up
- dev down
- dev status
- dev ls
- dev add --service <svc> --port <internal-port>
- dev tls install
- dev host run --name <route>
- dev host attach --name <route>
- dev host ls
- dev host rm --name <route>

## Troubleshooting

If dev up fails with port conflicts on 80/443, run:

- lsof -nP -iTCP:80 -sTCP:LISTEN
- lsof -nP -iTCP:443 -sTCP:LISTEN
`;
}

export function ensureRouterFiles(): void {
  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  fs.mkdirSync(TRAEFIK_DIR, { recursive: true });
  fs.mkdirSync(TRAEFIK_DYNAMIC_DIR, { recursive: true });
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });

  fs.writeFileSync(COMPOSE_FILE, renderComposeYml(), "utf-8");
  fs.writeFileSync(TRAEFIK_STATIC_FILE, renderTraefikStaticYml(), "utf-8");

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

export function runDockerCompose(args: string[]): void {
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    encoding: "utf-8"
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`docker compose failed: ${details || "unknown error"}`);
  }
}

export function startRouterStack(): void {
  runDockerCompose(["up", "-d"]);
}

export function stopRouterStack(): void {
  runDockerCompose(["down"]);
}
