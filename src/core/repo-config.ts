import fs from "node:fs";
import path from "node:path";
import YAML, { isMap, isSeq, parseDocument, type Document, type YAMLSeq } from "yaml";
import {
  AppAddOptions,
  DevrouterApp,
  DevrouterConfig,
  DevrouterDockerDependencyApp,
  DevrouterDockerHttpApp,
  DevrouterDockerTcpApp,
  DevrouterHostHttpApp,
  DevrouterProxyHttpApp
} from "../types";
import { parseUpstream } from "./host-routes";
import { TCP_PROTOCOL_REGISTRY } from "./router";
import { resolveWorkspace, wsFromBranch } from "./workspace";

const CONFIG_FILE_NAME = ".devrouter.yml";

const VALID_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.localhost$/;
const DEVROUTER_VERSION_RE = /^\d+\.\d+\.\d+$/;
const VALID_ENV_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/i;
const VALID_ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Workspace templating. `upstream` may embed the literal `${WORKSPACE}` token,
// which is substituted with the resolved workspace at runtime (see applyWorkspace).
// The token is illegal in `host` — the front host is auto-namespaced per workspace.
const WORKSPACE_PLACEHOLDER = "${WORKSPACE}";
const UPSTREAM_TEMPLATE_RE = /^(?:\$\{WORKSPACE\}|[a-zA-Z0-9._-])+:\d{1,5}$/;

// Validate an `upstream` at config-parse time. A concrete `host:port` is checked
// strictly; a `${WORKSPACE}` template is accepted as-is (the substituted value is
// re-validated strictly in applyWorkspace).
function assertUpstreamSpec(upstream: string, label: string): void {
  if (upstream.includes(WORKSPACE_PLACEHOLDER)) {
    if (!UPSTREAM_TEMPLATE_RE.test(upstream.trim())) {
      throw new Error(`${label} is not a valid host:port template (got '${upstream}').`);
    }
    return;
  }
  try {
    parseUpstream(upstream);
  } catch (err) {
    throw new Error(`${label}: ${(err as Error).message}`);
  }
}

function assertHostNotTemplated(host: string, label: string): void {
  if (host.includes("${")) {
    throw new Error(
      `${label} must not contain template placeholders. The front host is namespaced ` +
        "automatically per workspace (web.localhost -> web.<workspace>.localhost); do not " +
        "add ${WORKSPACE} to host."
    );
  }
}

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

function parseEnvMap(
  value: unknown,
  pathLabel: string
): Record<string, string> {
  const obj = ensureObject(value, pathLabel);
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (!VALID_ENV_VAR_RE.test(key)) {
      throw new Error(`${pathLabel}.${key} is not a valid environment variable name.`);
    }
    const source = toStringOrThrow(val, `${pathLabel}.${key}`);
    if (!VALID_ENV_VAR_RE.test(source)) {
      throw new Error(`${pathLabel}.${key} value '${source}' is not a valid environment variable name.`);
    }
    result[key] = source;
  }
  return result;
}

function parseDependencies(
  value: unknown,
  pathLabel: string
): Array<{ app: string; envMap?: Record<string, string> }> {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an array.`);
  }

  return value.map((entry, index) => {
    const objectValue = ensureObject(entry, `${pathLabel}[${index}]`);
    ensureAllowedKeys(objectValue, ["app", "envMap"], `${pathLabel}[${index}]`);
    const result: { app: string; envMap?: Record<string, string> } = {
      app: toStringOrThrow(objectValue.app, `${pathLabel}[${index}].app`)
    };
    if (objectValue.envMap !== undefined) {
      result.envMap = parseEnvMap(objectValue.envMap, `${pathLabel}[${index}].envMap`);
    }
    return result;
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
  assertHostNotTemplated(host, pathLabel);
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
    ["name", "kind", "host", "protocol", "runtime", "hostRun", "docker", "tcpProtocol", "upstream", "dependencies"],
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
      const supportedProtocols = Object.keys(TCP_PROTOCOL_REGISTRY);
      if (!supportedProtocols.includes(tcpProtocol)) {
        throw new Error(
          `${pathLabel}.tcpProtocol must be one of: ${supportedProtocols.join(", ")}.`
        );
      }

      return {
        name,
        host,
        protocol: "tcp",
        tcpProtocol,
        runtime: "docker",
        dependencies,
        docker
      };
    }
  }

  if (runtime === "proxy") {
    if (protocol !== "http" && protocol !== "tcp") {
      throw new Error(`${pathLabel}: proxy runtime supports protocol=http or protocol=tcp.`);
    }
    if (objectValue.hostRun !== undefined) {
      throw new Error(`${pathLabel}.hostRun is not supported when runtime=proxy.`);
    }
    if (objectValue.docker !== undefined) {
      throw new Error(`${pathLabel}.docker is not supported when runtime=proxy.`);
    }
    if (dependencies.length > 0) {
      throw new Error(`${pathLabel}.dependencies is not supported when runtime=proxy.`);
    }

    const upstream = toStringOrThrow(objectValue.upstream, `${pathLabel}.upstream`);
    assertUpstreamSpec(upstream, `${pathLabel}.upstream`);

    if (protocol === "tcp") {
      const tcpProtocol = toStringOrThrow(objectValue.tcpProtocol, `${pathLabel}.tcpProtocol`);
      const supportedProtocols = Object.keys(TCP_PROTOCOL_REGISTRY);
      if (!supportedProtocols.includes(tcpProtocol)) {
        throw new Error(`${pathLabel}.tcpProtocol must be one of: ${supportedProtocols.join(", ")}.`);
      }

      return {
        name,
        host,
        protocol: "tcp",
        tcpProtocol,
        runtime: "proxy",
        dependencies,
        upstream
      };
    }

    return {
      name,
      host,
      protocol: "http",
      runtime: "proxy",
      dependencies,
      upstream
    };
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
    ensureAllowedKeys(sm, ["command", "defaultEnv"], `${configPath}.secretManager`);
    const command = toStringOrThrow(sm.command, `${configPath}.secretManager.command`);
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new Error(`${configPath}.secretManager.command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters.`);
    }

    let defaultEnv: string | undefined;
    if (sm.defaultEnv !== undefined) {
      defaultEnv = toStringOrThrow(sm.defaultEnv, `${configPath}.secretManager.defaultEnv`);
      if (defaultEnv.length > 64) {
        throw new Error(`${configPath}.secretManager.defaultEnv exceeds maximum length of 64 characters.`);
      }
      if (!VALID_ENV_NAME_RE.test(defaultEnv)) {
        throw new Error(`${configPath}.secretManager.defaultEnv must be alphanumeric with hyphens.`);
      }
    }

    if (command.includes("{env}") && !defaultEnv) {
      throw new Error(`${configPath}.secretManager.defaultEnv is required when command contains {env}.`);
    }

    secretManager = { command, ...(defaultEnv ? { defaultEnv } : {}) };
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

// Surgical, comment-preserving edits to .devrouter.yml. `dev app add` / `dev app rm`
// must not round-trip the whole file through the serializer (that strips committed
// comments, reorders apps, and injects empty `dependencies: []`). Instead we mutate
// the parsed YAML document in place and re-emit only the touched node.

function readConfigDocument(configPath: string): Document {
  return parseDocument(fs.readFileSync(configPath, "utf-8"));
}

function writeConfigDocument(configPath: string, doc: Document): void {
  fs.writeFileSync(configPath, doc.toString({ lineWidth: 0 }), "utf-8");
}

function getOrCreateAppsSeq(doc: Document): YAMLSeq {
  const apps = doc.get("apps", true);
  if (isSeq(apps)) {
    return apps;
  }
  const seq = doc.createNode([]) as YAMLSeq;
  doc.set("apps", seq);
  return seq;
}

function findAppIndex(apps: YAMLSeq, name: string): number {
  return apps.items.findIndex((item) => isMap(item) && item.get("name") === name);
}

// Plain-object form of an app for re-emission, dropping the empty `dependencies: []`
// that would otherwise be injected into a hand-written config. `createNode` already
// omits `undefined` values (e.g. an absent `docker.router`).
function appToNodeValue(app: DevrouterApp): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(app)) as Record<string, unknown>;
  if (Array.isArray(value.dependencies) && value.dependencies.length === 0) {
    delete value.dependencies;
  }
  return value;
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
  assertHostNotTemplated(host, "--host");
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

  if (options.runtime === "proxy") {
    if (options.protocol !== "http" && options.protocol !== "tcp") {
      throw new Error("--runtime proxy supports --protocol http or --protocol tcp");
    }
    if (!options.upstream) {
      throw new Error("--upstream is required when --runtime proxy");
    }
    if (options.service !== undefined) {
      throw new Error("--service is not supported when --runtime proxy");
    }
    if (options.port !== undefined) {
      throw new Error("--port is not supported when --runtime proxy");
    }
    if (options.command !== undefined) {
      throw new Error("--command is not supported when --runtime proxy");
    }
    if (dependencies.length > 0) {
      throw new Error("--depends-on is not supported when --runtime proxy");
    }
    assertUpstreamSpec(options.upstream, "--upstream");

    if (options.protocol === "tcp") {
      const tcpProtocol = options.tcpProtocol;
      const supportedProtocols = Object.keys(TCP_PROTOCOL_REGISTRY);
      if (!tcpProtocol || !supportedProtocols.includes(tcpProtocol)) {
        throw new Error(
          `--tcp-protocol must be one of: ${supportedProtocols.join(", ")} when --runtime proxy --protocol tcp`
        );
      }

      return {
        name: options.name,
        host,
        protocol: "tcp",
        tcpProtocol,
        runtime: "proxy",
        dependencies,
        upstream: options.upstream
      };
    }

    return {
      name: options.name,
      host,
      protocol: "http",
      runtime: "proxy",
      dependencies,
      upstream: options.upstream
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
  const supportedProtocols = Object.keys(TCP_PROTOCOL_REGISTRY);
  if (!supportedProtocols.includes(tcpProtocol)) {
    throw new Error(`--tcp-protocol must be one of: ${supportedProtocols.join(", ")}`);
  }

  return {
    name: options.name,
    host,
    protocol: "tcp",
    tcpProtocol,
    runtime: "docker",
    dependencies,
    docker
  };
}

export function upsertRepoApp(repoPath: string, options: AppAddOptions): { configPath: string; app: DevrouterApp } {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  // Load (validating the existing file) and build the app before touching the file.
  const config = loadRepoConfig(resolvedRepoPath);
  const app = buildAppFromOptions(options);
  // Validate the resulting config as a whole, mirroring the previous save path.
  const nextApps = config.apps.filter((existing) => existing.name !== app.name);
  nextApps.push(app);
  parseConfig({ ...config, apps: nextApps } as unknown as Record<string, unknown>, configPath);

  // Apply the change as an in-place document edit so comments/formatting survive.
  const doc = readConfigDocument(configPath);
  const apps = getOrCreateAppsSeq(doc);
  const node = doc.createNode(appToNodeValue(app));
  const index = findAppIndex(apps, app.name);
  if (index >= 0) {
    // Replace in place, carrying over the leading blank line and any comment block
    // attached to the existing entry.
    const existing = apps.items[index];
    if (isMap(existing)) {
      if (existing.spaceBefore) {
        node.spaceBefore = true;
      }
      if (existing.commentBefore != null) {
        node.commentBefore = existing.commentBefore;
      }
    }
    apps.set(index, node);
  } else {
    // Append at the end (no reordering); separate from prior entries with a blank line.
    if (apps.items.length > 0) {
      node.spaceBefore = true;
    }
    apps.add(node);
  }
  writeConfigDocument(configPath, doc);

  return { configPath, app };
}

export function removeRepoApp(repoPath: string, name: string): { configPath: string; removed: boolean } {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  const config = loadRepoConfig(resolvedRepoPath);
  if (!config.apps.some((app) => app.name === name)) {
    return { configPath, removed: false };
  }

  const doc = readConfigDocument(configPath);
  const apps = doc.get("apps", true);
  if (isSeq(apps)) {
    const index = findAppIndex(apps, name);
    if (index >= 0) {
      apps.delete(index);
    }
  }
  writeConfigDocument(configPath, doc);

  return { configPath, removed: true };
}

// Insert the workspace token as the label immediately before `.localhost`:
// web.localhost -> web.<ws>.localhost; db.app.localhost -> db.app.<ws>.localhost.
function namespaceHost(host: string, workspace: string): string {
  const suffix = ".localhost";
  const base = host.slice(0, host.length - suffix.length);
  return `${base}.${workspace}${suffix}`;
}

/**
 * Derive the runtime (per-workspace) view of a config without mutating the loaded
 * object or the committed file. When a workspace is active the front host of each
 * routed app is namespaced and each docker app gets a workspace-unique Traefik
 * router key. `${WORKSPACE}` in `upstream` is always substituted (with the active
 * workspace, or the project-name default), then re-validated strictly.
 *
 * With no workspace and no `${WORKSPACE}` templates, the config is returned
 * unchanged — existing single-checkout behavior is byte-identical.
 */
export function applyWorkspace(
  config: DevrouterConfig,
  workspace: string | undefined,
  repoPath: string
): DevrouterConfig {
  const defaultToken =
    wsFromBranch(config.project?.name ?? path.basename(path.resolve(repoPath))) ?? "app";
  const substitutionToken = workspace ?? defaultToken;

  const next = structuredClone(config);
  for (const app of next.apps) {
    if (!("host" in app)) {
      continue; // dependency-only app: no route to namespace
    }

    if (workspace) {
      const namespaced = namespaceHost(app.host, workspace);
      if (!VALID_HOSTNAME_RE.test(namespaced)) {
        throw new Error(`Namespaced host '${namespaced}' for workspace '${workspace}' is invalid.`);
      }
      app.host = namespaced;
    }

    if ("upstream" in app && app.upstream.includes(WORKSPACE_PLACEHOLDER)) {
      const resolved = app.upstream.split(WORKSPACE_PLACEHOLDER).join(substitutionToken);
      try {
        parseUpstream(resolved);
      } catch (err) {
        throw new Error(`Resolved upstream '${resolved}' is invalid: ${(err as Error).message}`);
      }
      app.upstream = resolved;
    }

    if (workspace && app.runtime === "docker") {
      app.docker.router = `${app.docker.router ?? app.name}-${workspace}`;
    }
  }

  return next;
}

/**
 * Load a repo config and apply the active workspace transform. This is the single
 * entry point for runtime commands (run/exec/status/doctor/open) so the whole
 * surface sees consistent namespaced hosts/upstreams. Config-authoring/read
 * commands that show the committed template (`app ls`, `upgrade`, `app add/rm`)
 * keep using raw `loadRepoConfig`.
 */
export function loadRuntimeConfig(
  repoPath?: string,
  workspaceOverride?: string
): { config: DevrouterConfig; workspace: string | undefined } {
  const resolved = resolveRepoPath(repoPath);
  const raw = loadRepoConfig(resolved);
  const workspace = resolveWorkspace(resolved, workspaceOverride);
  return { config: applyWorkspace(raw, workspace, resolved), workspace };
}

export function resolveAppByName(
  repoPath: string,
  name: string,
  workspaceOverride?: string
): { config: DevrouterConfig; app: DevrouterApp; workspace: string | undefined } {
  const { config, workspace } = loadRuntimeConfig(repoPath, workspaceOverride);
  const app = config.apps.find((entry) => entry.name === name);
  if (!app) {
    const available = config.apps.map((entry) => entry.name).join(", ");
    throw new Error(`App '${name}' not found in ${getRepoConfigPath(repoPath)}. Available: ${available || "(none)"}`);
  }

  return { config, app, workspace };
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
