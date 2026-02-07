import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { HostConfig, HostRouteDefinition, HostRouteStrategy } from "../types";

const DEFAULT_CONFIG_FILE = "devrouter.host.yml";
const DEFAULT_STRATEGY: HostRouteStrategy = {
  type: "auto",
  denyPorts: [80, 443],
  allowPortRange: "1024-65535"
};

type LoadedHostRoute = {
  repoPath: string;
  configPath: string;
  route: HostRouteDefinition;
  routeCwd: string;
};

function toStringOrEmpty(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  return "";
}

function parseStrategy(raw: unknown): HostRouteStrategy {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_STRATEGY };
  }

  const data = raw as Record<string, unknown>;
  const type = toStringOrEmpty(data.type) || "auto";
  if (type !== "auto") {
    throw new Error(`Unsupported strategy.type '${type}'. Only 'auto' is supported in v1.`);
  }

  let denyPorts = DEFAULT_STRATEGY.denyPorts;
  if (Array.isArray(data.denyPorts)) {
    denyPorts = data.denyPorts
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  const allowPortRange =
    toStringOrEmpty(data.allowPortRange) || DEFAULT_STRATEGY.allowPortRange;

  return {
    type: "auto",
    denyPorts,
    allowPortRange
  };
}

function parseRoute(raw: unknown, index: number): HostRouteDefinition {
  if (!raw || typeof raw !== "object") {
    throw new Error(`routes[${index}] must be an object`);
  }

  const data = raw as Record<string, unknown>;
  const name = toStringOrEmpty(data.name);
  const host = toStringOrEmpty(data.host).toLowerCase();
  const mode = toStringOrEmpty(data.mode) || "host";
  const command = toStringOrEmpty(data.command);
  const cwd = toStringOrEmpty(data.cwd) || ".";

  if (!name) {
    throw new Error(`routes[${index}].name is required`);
  }

  if (!host) {
    throw new Error(`routes[${index}].host is required`);
  }

  if (!host.endsWith(".localhost")) {
    throw new Error(`routes[${index}].host must end with .localhost`);
  }

  if (mode !== "host") {
    throw new Error(`routes[${index}].mode must be 'host'`);
  }

  if (!command) {
    throw new Error(`routes[${index}].command is required`);
  }

  return {
    name,
    host,
    mode: "host",
    command,
    cwd,
    strategy: parseStrategy(data.strategy)
  };
}

export function resolveRepoPath(repoPath?: string): string {
  return path.resolve(repoPath ?? process.cwd());
}

export function getHostConfigPath(repoPath?: string): string {
  return path.join(resolveRepoPath(repoPath), DEFAULT_CONFIG_FILE);
}

export function loadHostConfig(repoPath?: string): HostConfig {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getHostConfigPath(resolvedRepoPath);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing ${DEFAULT_CONFIG_FILE} in ${resolvedRepoPath}. Create it before using 'dev host' commands.`
    );
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const data = (YAML.parse(raw) as Record<string, unknown> | null) ?? {};
  const version = Number(data.version ?? 1);
  if (version !== 1) {
    throw new Error(`Unsupported ${DEFAULT_CONFIG_FILE} version '${String(data.version)}'.`);
  }

  if (!Array.isArray(data.routes)) {
    throw new Error(`${DEFAULT_CONFIG_FILE} must define a routes array.`);
  }

  const routes = data.routes.map((route, index) => parseRoute(route, index));
  if (routes.length === 0) {
    throw new Error(`${DEFAULT_CONFIG_FILE} has no routes.`);
  }

  return { version: 1, routes };
}

export function resolveHostRoute(name: string, repoPath?: string): LoadedHostRoute {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getHostConfigPath(resolvedRepoPath);
  const config = loadHostConfig(resolvedRepoPath);
  const route = config.routes.find((entry) => entry.name === name);

  if (!route) {
    const available = config.routes.map((entry) => entry.name).join(", ");
    throw new Error(
      `Route '${name}' not found in ${configPath}. Available routes: ${available || "(none)"}`
    );
  }

  const routeCwd = path.resolve(resolvedRepoPath, route.cwd);
  return {
    repoPath: resolvedRepoPath,
    configPath,
    route,
    routeCwd
  };
}
