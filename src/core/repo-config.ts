import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  AppAddOptions,
  DevrouterApp,
  DevrouterConfig,
  DevrouterDockerDependencyApp,
  DevrouterDockerHttpApp,
  DevrouterDockerPostgresApp,
  DevrouterHostHttpApp
} from "../types";

const CONFIG_FILE_NAME = ".devrouter.yml";

const VALID_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.localhost$/;
const DEVROUTER_VERSION_RE = /^\d+\.\d+\.\d+$/;

const MAX_COMMAND_LENGTH = 4096;

const DEFAULT_HOST_STRATEGY = {
  type: "auto" as const,
  denyPorts: [80, 443, 5432],
  allowPortRange: "1024-65535"
};

type DevrouterConfigWithUnknown = Record<string, unknown>;

function ensureObject(value: unknown, pathLabel: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function ensureAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  pathLabel: string
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${pathLabel}.${key} is not supported.`);
    }
  }
}

function toStringOrThrow(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${pathLabel} must be a non-empty string.`);
  }

  return value.trim();
}

function toStringArray(value: unknown, pathLabel: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an array of strings.`);
  }

  return value.map((item, index) => toStringOrThrow(item, `${pathLabel}[${index}]`));
}

function toIntegerOrThrow(value: unknown, pathLabel: string): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${pathLabel} must be a positive integer.`);
  }

  return numberValue;
}

function parseDependencies(
  value: unknown,
  pathLabel: string
): Array<{ app: string }> {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an array.`);
  }

  return value.map((entry, index) => {
    const objectValue = ensureObject(entry, `${pathLabel}[${index}]`);
    ensureAllowedKeys(objectValue, ["app"], `${pathLabel}[${index}]`);
    return { app: toStringOrThrow(objectValue.app, `${pathLabel}[${index}].app`) };
  });
}

function parseHostStrategy(value: unknown, pathLabel: string): DevrouterHostHttpApp["hostRun"]["strategy"] {
  if (value === undefined) {
    return { ...DEFAULT_HOST_STRATEGY };
  }

  const objectValue = ensureObject(value, pathLabel);
  ensureAllowedKeys(objectValue, ["type", "denyPorts", "allowPortRange"], pathLabel);

  const type = toStringOrThrow(objectValue.type ?? "auto", `${pathLabel}.type`);
  if (type !== "auto") {
    throw new Error(`${pathLabel}.type must be 'auto'.`);
  }

  let denyPorts = [...DEFAULT_HOST_STRATEGY.denyPorts];
  if (objectValue.denyPorts !== undefined) {
    if (!Array.isArray(objectValue.denyPorts)) {
      throw new Error(`${pathLabel}.denyPorts must be an array.`);
    }
    denyPorts = objectValue.denyPorts.map((entry, index) =>
      toIntegerOrThrow(entry, `${pathLabel}.denyPorts[${index}]`)
    );
  }

  const allowPortRange =
    objectValue.allowPortRange === undefined
      ? DEFAULT_HOST_STRATEGY.allowPortRange
      : toStringOrThrow(objectValue.allowPortRange, `${pathLabel}.allowPortRange`);

  return {
    type: "auto",
    denyPorts,
    allowPortRange
  };
}

function parseDockerConfig(
  value: unknown,
  pathLabel: string
): DevrouterDockerHttpApp["docker"] {
  const objectValue = ensureObject(value, pathLabel);
  ensureAllowedKeys(objectValue, ["service", "internalPort", "composeFiles", "router"], pathLabel);

  const composeFiles = toStringArray(objectValue.composeFiles, `${pathLabel}.composeFiles`);
  return {
    service: toStringOrThrow(objectValue.service, `${pathLabel}.service`),
    internalPort: toIntegerOrThrow(objectValue.internalPort, `${pathLabel}.internalPort`),
    composeFiles: composeFiles.length > 0 ? composeFiles : ["docker-compose.yml"],
    router:
      objectValue.router === undefined
        ? undefined
        : toStringOrThrow(objectValue.router, `${pathLabel}.router`)
  };
}

function parseDependencyDockerConfig(
  value: unknown,
  pathLabel: string
): DevrouterDockerDependencyApp["docker"] {
  const objectValue = ensureObject(value, pathLabel);
  ensureAllowedKeys(objectValue, ["service", "composeFiles"], pathLabel);

  const composeFiles = toStringArray(objectValue.composeFiles, `${pathLabel}.composeFiles`);
  return {
    service: toStringOrThrow(objectValue.service, `${pathLabel}.service`),
    composeFiles: composeFiles.length > 0 ? composeFiles : ["docker-compose.yml"]
  };
}

function parseHostOrThrow(value: unknown, pathLabel: string): string {
  const host = toStringOrThrow(value, pathLabel).toLowerCase();
  if (!host.endsWith(".localhost")) {
    throw new Error(`${pathLabel} must end with .localhost.`);
  }
  if (!VALID_HOSTNAME_RE.test(host)) {
    throw new Error(`${pathLabel} contains invalid characters. Only lowercase alphanumerics and hyphens are allowed.`);
  }
  return host;
}

function parseApp(value: unknown, index: number): DevrouterApp {
  const pathLabel = `apps[${index}]`;
  const objectValue = ensureObject(value, pathLabel);
  ensureAllowedKeys(
    objectValue,
    ["name", "kind", "host", "protocol", "runtime", "hostRun", "docker", "tcpProtocol", "dependencies"],
    pathLabel
  );

  const name = toStringOrThrow(objectValue.name, `${pathLabel}.name`);
  const kind = objectValue.kind === undefined
    ? "app"
    : toStringOrThrow(objectValue.kind, `${pathLabel}.kind`);
  if (kind !== "app" && kind !== "dependency") {
    throw new Error(`${pathLabel}.kind must be 'app' or 'dependency'.`);
  }

  const dependencies = parseDependencies(objectValue.dependencies, `${pathLabel}.dependencies`);
  if (kind === "dependency") {
    if (objectValue.host !== undefined) {
      throw new Error(`${pathLabel}.host is not supported when kind=dependency.`);
    }
    if (objectValue.protocol !== undefined) {
      throw new Error(`${pathLabel}.protocol is not supported when kind=dependency.`);
    }
    if (objectValue.tcpProtocol !== undefined) {
      throw new Error(`${pathLabel}.tcpProtocol is not supported when kind=dependency.`);
    }
    if (objectValue.hostRun !== undefined) {
      throw new Error(`${pathLabel}.hostRun is not supported when kind=dependency.`);
    }

    const runtime = toStringOrThrow(objectValue.runtime, `${pathLabel}.runtime`);
    if (runtime !== "docker") {
      throw new Error(`${pathLabel}.runtime must be 'docker' when kind=dependency.`);
    }

    return {
      kind: "dependency",
      name,
      runtime: "docker",
      dependencies,
      docker: parseDependencyDockerConfig(objectValue.docker, `${pathLabel}.docker`)
    };
  }

  const host = parseHostOrThrow(objectValue.host, `${pathLabel}.host`);
  const protocol = toStringOrThrow(objectValue.protocol, `${pathLabel}.protocol`);
  const runtime = toStringOrThrow(objectValue.runtime, `${pathLabel}.runtime`);

  if (runtime === "host") {
    if (protocol !== "http") {
      throw new Error(`${pathLabel}: host runtime currently supports only protocol=http.`);
    }

    const hostRun = ensureObject(objectValue.hostRun, `${pathLabel}.hostRun`);
    ensureAllowedKeys(hostRun, ["command", "cwd", "strategy", "portTimeout"], `${pathLabel}.hostRun`);

    const command = toStringOrThrow(hostRun.command, `${pathLabel}.hostRun.command`);
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new Error(`${pathLabel}.hostRun.command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters.`);
    }

    const portTimeout =
      hostRun.portTimeout === undefined
        ? undefined
        : toIntegerOrThrow(hostRun.portTimeout, `${pathLabel}.hostRun.portTimeout`);

    return {
      name,
      host,
      protocol: "http",
      runtime: "host",
      dependencies,
      hostRun: {
        command,
        cwd:
          hostRun.cwd === undefined
            ? "."
            : toStringOrThrow(hostRun.cwd, `${pathLabel}.hostRun.cwd`),
        strategy: parseHostStrategy(hostRun.strategy, `${pathLabel}.hostRun.strategy`),
        ...(portTimeout !== undefined ? { portTimeout } : {})
      }
    };
  }

  if (runtime === "docker") {
    const docker = parseDockerConfig(objectValue.docker, `${pathLabel}.docker`);

    if (protocol === "http") {
      return {
        name,
        host,
        protocol: "http",
        runtime: "docker",
        dependencies,
        docker
      };
    }

    if (protocol === "tcp") {
      const tcpProtocol = toStringOrThrow(objectValue.tcpProtocol, `${pathLabel}.tcpProtocol`);
      if (tcpProtocol !== "postgres") {
        throw new Error(`${pathLabel}.tcpProtocol must be 'postgres' for protocol=tcp.`);
      }

      return {
        name,
        host,
        protocol: "tcp",
        tcpProtocol: "postgres",
        runtime: "docker",
        dependencies,
        docker
      };
    }
  }

  throw new Error(`${pathLabel} has unsupported protocol/runtime combination.`);
}

function parseConfig(raw: unknown, configPath: string): DevrouterConfig {
  const root = ensureObject(raw, configPath);
  ensureAllowedKeys(root, ["version", "devrouter", "project", "secretManager", "apps"], configPath);

  const version = toIntegerOrThrow(root.version, `${configPath}.version`);
  if (version !== 1) {
    throw new Error(`${configPath}.version must be 1.`);
  }

  let devrouter: DevrouterConfig["devrouter"] | undefined;
  if (root.devrouter !== undefined) {
    const metadata = ensureObject(root.devrouter, `${configPath}.devrouter`);
    ensureAllowedKeys(metadata, ["version"], `${configPath}.devrouter`);
    if (metadata.version !== undefined) {
      const devrouterVersion = toStringOrThrow(metadata.version, `${configPath}.devrouter.version`);
      if (!DEVROUTER_VERSION_RE.test(devrouterVersion)) {
        throw new Error(`${configPath}.devrouter.version must be a semantic version like 0.0.14.`);
      }
      devrouter = { version: devrouterVersion };
    } else {
      devrouter = {};
    }
  }

  if (root.project !== undefined) {
    const project = ensureObject(root.project, `${configPath}.project`);
    ensureAllowedKeys(project, ["name"], `${configPath}.project`);
    if (project.name !== undefined && typeof project.name !== "string") {
      throw new Error(`${configPath}.project.name must be a string.`);
    }
  }

  let secretManager: DevrouterConfig["secretManager"] | undefined;
  if (root.secretManager !== undefined) {
    const sm = ensureObject(root.secretManager, `${configPath}.secretManager`);
    ensureAllowedKeys(sm, ["command"], `${configPath}.secretManager`);
    const command = toStringOrThrow(sm.command, `${configPath}.secretManager.command`);
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new Error(`${configPath}.secretManager.command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters.`);
    }
    secretManager = { command };
  }

  if (!Array.isArray(root.apps)) {
    throw new Error(`${configPath}.apps must be an array.`);
  }

  const apps = root.apps.map((app, index) => parseApp(app, index));
  const seenNames = new Set<string>();
  for (const app of apps) {
    if (seenNames.has(app.name)) {
      throw new Error(`${configPath}.apps has duplicate name '${app.name}'.`);
    }
    seenNames.add(app.name);
  }

  return {
    version: 1,
    ...(devrouter ? { devrouter } : {}),
    project:
      root.project && typeof root.project === "object"
        ? { name: (root.project as { name?: string }).name }
        : undefined,
    ...(secretManager ? { secretManager } : {}),
    apps
  };
}

function renderConfig(config: DevrouterConfig): string {
  return YAML.stringify(config, { lineWidth: 0 });
}

export function resolveRepoPath(repoPath?: string): string {
  return path.resolve(repoPath ?? process.cwd());
}

export function getRepoConfigPath(repoPath?: string): string {
  return path.join(resolveRepoPath(repoPath), CONFIG_FILE_NAME);
}

export function loadRepoConfig(repoPath?: string): DevrouterConfig {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing ${CONFIG_FILE_NAME} in ${resolvedRepoPath}. Run 'dev repo init --repo ${resolvedRepoPath}' first.`
    );
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(raw) as DevrouterConfigWithUnknown | null;
  return parseConfig(parsed ?? {}, configPath);
}

export function saveRepoConfig(repoPath: string, config: DevrouterConfig): void {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  const validated = parseConfig(config as unknown as Record<string, unknown>, configPath);
  fs.writeFileSync(configPath, renderConfig(validated), "utf-8");
}

export function initRepoConfig(
  repoPath?: string,
  options: { devrouterVersion?: string } = {}
): { repoPath: string; configPath: string; created: boolean } {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  if (fs.existsSync(configPath)) {
    return { repoPath: resolvedRepoPath, configPath, created: false };
  }

  if (options.devrouterVersion !== undefined && !DEVROUTER_VERSION_RE.test(options.devrouterVersion)) {
    throw new Error(`Invalid devrouter version '${options.devrouterVersion}'. Expected semantic version like 0.0.14.`);
  }

  const initialConfig: DevrouterConfig = {
    version: 1,
    ...(options.devrouterVersion
      ? {
          devrouter: {
            version: options.devrouterVersion
          }
        }
      : {}),
    project: {
      name: path.basename(resolvedRepoPath)
    },
    apps: []
  };

  fs.writeFileSync(configPath, renderConfig(initialConfig), "utf-8");
  return { repoPath: resolvedRepoPath, configPath, created: true };
}

function buildAppFromOptions(options: AppAddOptions): DevrouterApp {
  const kind = options.kind ?? "app";
  if (kind !== "app" && kind !== "dependency") {
    throw new Error("--kind must be app or dependency");
  }
  const dependencies = options.dependsOn.map((app) => ({ app }));

  if (kind === "dependency") {
    if (options.runtime !== undefined && options.runtime !== "docker") {
      throw new Error("--runtime must be docker when --kind dependency");
    }
    if (options.host !== undefined) {
      throw new Error("--host is not supported when --kind dependency");
    }
    if (options.protocol !== undefined) {
      throw new Error("--protocol is not supported when --kind dependency");
    }
    if (options.tcpProtocol !== undefined) {
      throw new Error("--tcp-protocol is not supported when --kind dependency");
    }
    if (options.command !== undefined) {
      throw new Error("--command is not supported when --kind dependency");
    }
    if (options.cwd !== undefined) {
      throw new Error("--cwd is not supported when --kind dependency");
    }
    if (options.port !== undefined) {
      throw new Error("--port is not supported when --kind dependency");
    }
    if (options.router !== undefined) {
      throw new Error("--router is not supported when --kind dependency");
    }
    if (!options.service) {
      throw new Error("--service is required when --kind dependency");
    }

    return {
      kind: "dependency",
      name: options.name,
      runtime: "docker",
      dependencies,
      docker: {
        service: options.service,
        composeFiles: options.composeFiles.length > 0 ? options.composeFiles : ["docker-compose.yml"]
      }
    };
  }

  if (!options.host) {
    throw new Error("--host is required when --kind app");
  }
  const host = options.host.toLowerCase();
  if (!host.endsWith(".localhost")) {
    throw new Error("--host must end with .localhost");
  }
  if (!VALID_HOSTNAME_RE.test(host)) {
    throw new Error("--host contains invalid characters. Only lowercase alphanumerics and hyphens are allowed.");
  }

  if (!options.runtime) {
    throw new Error("--runtime is required when --kind app");
  }
  if (!options.protocol) {
    throw new Error("--protocol is required when --kind app");
  }

  if (options.runtime === "host") {
    if (options.protocol !== "http") {
      throw new Error("--runtime host currently supports only --protocol http");
    }

    if (!options.command) {
      throw new Error("--command is required when --runtime host");
    }

    return {
      name: options.name,
      host,
      protocol: "http",
      runtime: "host",
      dependencies,
      hostRun: {
        command: options.command,
        cwd: options.cwd ?? ".",
        strategy: { ...DEFAULT_HOST_STRATEGY }
      }
    };
  }

  if (!options.service) {
    throw new Error("--service is required when --runtime docker");
  }

  if (!options.port || !Number.isInteger(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive integer when --runtime docker");
  }

  const docker = {
    service: options.service,
    internalPort: options.port,
    composeFiles: options.composeFiles.length > 0 ? options.composeFiles : ["docker-compose.yml"],
    router: options.router
  };

  if (options.protocol === "http") {
    return {
      name: options.name,
      host,
      protocol: "http",
      runtime: "docker",
      dependencies,
      docker
    };
  }

  const tcpProtocol = options.tcpProtocol ?? "postgres";
  if (tcpProtocol !== "postgres") {
    throw new Error("--tcp-protocol must be postgres for --protocol tcp");
  }

  return {
    name: options.name,
    host,
    protocol: "tcp",
    tcpProtocol: "postgres",
    runtime: "docker",
    dependencies,
    docker
  };
}

export function upsertRepoApp(repoPath: string, options: AppAddOptions): { configPath: string; app: DevrouterApp } {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const config = loadRepoConfig(resolvedRepoPath);
  const app = buildAppFromOptions(options);
  const apps = config.apps.filter((existing) => existing.name !== app.name);
  apps.push(app);
  apps.sort((a, b) => a.name.localeCompare(b.name));

  const next: DevrouterConfig = {
    ...config,
    apps
  };
  saveRepoConfig(resolvedRepoPath, next);

  return {
    configPath: getRepoConfigPath(resolvedRepoPath),
    app
  };
}

export function removeRepoApp(repoPath: string, name: string): { configPath: string; removed: boolean } {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const config = loadRepoConfig(resolvedRepoPath);
  const apps = config.apps.filter((app) => app.name !== name);
  const removed = apps.length !== config.apps.length;
  if (!removed) {
    return {
      configPath: getRepoConfigPath(resolvedRepoPath),
      removed: false
    };
  }

  saveRepoConfig(resolvedRepoPath, {
    ...config,
    apps
  });

  return {
    configPath: getRepoConfigPath(resolvedRepoPath),
    removed: true
  };
}

export function resolveAppByName(repoPath: string, name: string): { config: DevrouterConfig; app: DevrouterApp } {
  const config = loadRepoConfig(repoPath);
  const app = config.apps.find((entry) => entry.name === name);
  if (!app) {
    const available = config.apps.map((entry) => entry.name).join(", ");
    throw new Error(`App '${name}' not found in ${getRepoConfigPath(repoPath)}. Available: ${available || "(none)"}`);
  }

  return { config, app };
}

export function resolveAppDependencies(config: DevrouterConfig, app: DevrouterApp): DevrouterApp[] {
  const results: DevrouterApp[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>([app.name]);
  const byName = new Map(config.apps.map((entry) => [entry.name, entry]));

  const visit = (name: string, chain: string[]): void => {
    if (visiting.has(name)) {
      throw new Error(`Dependency cycle detected: ${[...chain, name].join(" -> ")}`);
    }
    if (seen.has(name)) {
      return;
    }
    visiting.add(name);
    const dependency = byName.get(name);
    if (!dependency) {
      throw new Error(`Dependency '${name}' referenced by '${app.name}' does not exist in config.`);
    }
    results.push(dependency);
    for (const nested of dependency.dependencies) {
      visit(nested.app, [...chain, name]);
    }
    visiting.delete(name);
    seen.add(name);
  };

  for (const dependency of app.dependencies) {
    visit(dependency.app, [app.name]);
  }

  return results;
}
