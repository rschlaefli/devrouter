import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML, { type Document, isMap, isSeq, parseDocument, type YAMLSeq } from "yaml";
import type {
  AppAddOptions,
  CapacityEstimates,
  DevrouterApp,
  DevrouterConfig,
  DevrouterDockerDependencyApp,
  DevrouterDockerHttpApp,
  DevrouterHostHttpApp,
  DevrouterHttpReadiness,
  DevrouterManagedRuntime,
  DevrouterProfile,
} from "../types";
import {
  DEPENDENCY_ONLY_RUNTIME,
  formatSupportedTcpProtocols,
  RUNTIME_PROTOCOL_COMPATIBILITY,
  SECRET_MANAGER_ENV_PLACEHOLDER,
  SUPPORTED_PROTOCOLS,
  SUPPORTED_RUNTIMES,
  SUPPORTED_TCP_PROTOCOLS,
  WORKSPACE_PLACEHOLDER,
} from "./capabilities";
import { parseUpstream } from "./host-routes";
import { resolveWorkspace, wsFromBranch } from "./workspace";

declare const __VERSION__: string;

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const match = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return match
      ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
      : { major: 0, minor: 0, patch: 0 };
  };
  const left = parse(a);
  const right = parse(b);
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

let hasWarnedVersionMismatch = false;

const CONFIG_FILE_NAME = ".devrouter.yml";
const DEFAULT_TCP_PROTOCOL = "postgres";

const VALID_HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.localhost$/;
const DEVROUTER_VERSION_RE = /^\d+\.\d+\.\d+$/;
const VALID_ENV_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/i;
const VALID_ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CAPACITY_PROFILES = 256;
const MAX_CAPACITY_OPERATIONS = 64;
const MAX_CAPACITY_TRANSITIONS = 1024;
const MAX_CAPACITY_NAME_LENGTH = 64;

// Workspace templating. `upstream` may embed the literal `${WORKSPACE}` token,
// which is substituted with the resolved workspace at runtime (see applyWorkspace).
// The token is illegal in `host` — the front host is auto-namespaced per workspace.
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
        "add ${WORKSPACE} to host.",
    );
  }
}

const MAX_COMMAND_LENGTH = 4096;
const MAX_PREPARE_ARGS = 64;
const MAX_PREPARE_ARG_BYTES = 4096;

const DEFAULT_HOST_STRATEGY = {
  type: "auto" as const,
  denyPorts: [80, 443, 5432],
  allowPortRange: "1024-65535",
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
  pathLabel: string,
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

function parseEnvMap(value: unknown, pathLabel: string): Record<string, string> {
  const obj = ensureObject(value, pathLabel);
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (!VALID_ENV_VAR_RE.test(key)) {
      throw new Error(`${pathLabel}.${key} is not a valid environment variable name.`);
    }
    const source = toStringOrThrow(val, `${pathLabel}.${key}`);
    if (!VALID_ENV_VAR_RE.test(source)) {
      throw new Error(
        `${pathLabel}.${key} value '${source}' is not a valid environment variable name.`,
      );
    }
    result[key] = source;
  }
  return result;
}

function isSupportedProtocol(value: string): value is (typeof SUPPORTED_PROTOCOLS)[number] {
  return SUPPORTED_PROTOCOLS.includes(value as (typeof SUPPORTED_PROTOCOLS)[number]);
}

function isSupportedRuntime(value: string): value is (typeof SUPPORTED_RUNTIMES)[number] {
  return SUPPORTED_RUNTIMES.includes(value as (typeof SUPPORTED_RUNTIMES)[number]);
}

function isSupportedTcpProtocol(value: string): boolean {
  return SUPPORTED_TCP_PROTOCOLS.includes(value);
}

function runtimeSupportsProtocol(
  runtime: (typeof SUPPORTED_RUNTIMES)[number],
  protocol: (typeof SUPPORTED_PROTOCOLS)[number],
): boolean {
  const supportedProtocols: readonly (typeof SUPPORTED_PROTOCOLS)[number][] =
    RUNTIME_PROTOCOL_COMPATIBILITY[runtime];
  return supportedProtocols.includes(protocol);
}

function parseDependencies(
  value: unknown,
  pathLabel: string,
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
      app: toStringOrThrow(objectValue.app, `${pathLabel}[${index}].app`),
    };
    if (objectValue.envMap !== undefined) {
      result.envMap = parseEnvMap(objectValue.envMap, `${pathLabel}[${index}].envMap`);
    }
    return result;
  });
}

function parseHostStrategy(
  value: unknown,
  pathLabel: string,
): DevrouterHostHttpApp["hostRun"]["strategy"] {
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
      toIntegerOrThrow(entry, `${pathLabel}.denyPorts[${index}]`),
    );
  }

  const allowPortRange =
    objectValue.allowPortRange === undefined
      ? DEFAULT_HOST_STRATEGY.allowPortRange
      : toStringOrThrow(objectValue.allowPortRange, `${pathLabel}.allowPortRange`);

  return {
    type: "auto",
    denyPorts,
    allowPortRange,
  };
}

function parseDockerConfig(value: unknown, pathLabel: string): DevrouterDockerHttpApp["docker"] {
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
        : toStringOrThrow(objectValue.router, `${pathLabel}.router`),
  };
}

function parseDependencyDockerConfig(
  value: unknown,
  pathLabel: string,
): DevrouterDockerDependencyApp["docker"] {
  const objectValue = ensureObject(value, pathLabel);
  ensureAllowedKeys(objectValue, ["service", "composeFiles"], pathLabel);

  const composeFiles = toStringArray(objectValue.composeFiles, `${pathLabel}.composeFiles`);
  return {
    service: toStringOrThrow(objectValue.service, `${pathLabel}.service`),
    composeFiles: composeFiles.length > 0 ? composeFiles : ["docker-compose.yml"],
  };
}

const MAX_READINESS_PATH_LENGTH = 512;
const MIME_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function parseHttpReadinessPath(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${pathLabel} must be a non-empty string.`);
  }
  if (value.length > MAX_READINESS_PATH_LENGTH) {
    throw new Error(
      `${pathLabel} exceeds maximum length of ${MAX_READINESS_PATH_LENGTH} characters.`,
    );
  }
  if (!/^[\x20-\x7E]+$/.test(value)) {
    throw new Error(`${pathLabel} must contain only printable ASCII characters.`);
  }
  if (!value.startsWith("/") || value.includes("//")) {
    throw new Error(`${pathLabel} must be an absolute path with a single leading slash.`);
  }
  if (/[?#\\%]/.test(value)) {
    throw new Error(
      `${pathLabel} must not contain query, fragment, backslash, or percent characters.`,
    );
  }
  if (value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${pathLabel} must not contain dot segments.`);
  }
  return value;
}

function parseHttpReadinessStatuses(value: unknown, pathLabel: string): number[] {
  if (value === undefined) {
    return [200];
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error(`${pathLabel} must contain between 1 and 32 status codes.`);
  }

  const seen = new Set<number>();
  return value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isInteger(entry)) {
      throw new Error(`${pathLabel}[${index}] must be an integer HTTP status code.`);
    }
    if (!((entry >= 200 && entry <= 299) || (entry >= 400 && entry <= 499))) {
      throw new Error(`${pathLabel}[${index}] must be a 2xx or 4xx status code.`);
    }
    if (seen.has(entry)) {
      throw new Error(`${pathLabel} contains duplicate status code '${entry}'.`);
    }
    seen.add(entry);
    return entry;
  });
}

function parseHttpReadinessContentType(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${pathLabel} must be a non-empty MIME type.`);
  }
  const contentType = value.trim().toLowerCase();
  const separator = contentType.indexOf("/");
  if (
    separator <= 0 ||
    separator === contentType.length - 1 ||
    contentType.indexOf("/", separator + 1) !== -1 ||
    !MIME_TOKEN_RE.test(contentType.slice(0, separator)) ||
    !MIME_TOKEN_RE.test(contentType.slice(separator + 1))
  ) {
    throw new Error(`${pathLabel} must be a MIME type in token/token form without parameters.`);
  }
  return contentType;
}

function parseHttpReadiness(value: unknown, pathLabel: string): DevrouterHttpReadiness {
  const readiness = ensureObject(value, pathLabel);
  ensureAllowedKeys(readiness, ["path", "statuses", "contentType"], pathLabel);

  const result: DevrouterHttpReadiness = {
    path: parseHttpReadinessPath(readiness.path, `${pathLabel}.path`),
    statuses: parseHttpReadinessStatuses(readiness.statuses, `${pathLabel}.statuses`),
  };
  if (readiness.contentType !== undefined) {
    result.contentType = parseHttpReadinessContentType(
      readiness.contentType,
      `${pathLabel}.contentType`,
    );
  }
  return result;
}

function parseHostOrThrow(value: unknown, pathLabel: string): string {
  const host = toStringOrThrow(value, pathLabel).toLowerCase();
  assertHostNotTemplated(host, pathLabel);
  if (!host.endsWith(".localhost")) {
    throw new Error(`${pathLabel} must end with .localhost.`);
  }
  if (!VALID_HOSTNAME_RE.test(host)) {
    throw new Error(
      `${pathLabel} contains invalid characters. Only lowercase alphanumerics and hyphens are allowed.`,
    );
  }
  return host;
}

function parseApp(value: unknown, index: number): DevrouterApp {
  const pathLabel = `apps[${index}]`;
  const objectValue = ensureObject(value, pathLabel);
  ensureAllowedKeys(
    objectValue,
    [
      "name",
      "kind",
      "host",
      "protocol",
      "runtime",
      "hostRun",
      "docker",
      "tcpProtocol",
      "upstream",
      "dependencies",
      "readiness",
    ],
    pathLabel,
  );

  const name = toStringOrThrow(objectValue.name, `${pathLabel}.name`);
  const kind =
    objectValue.kind === undefined ? "app" : toStringOrThrow(objectValue.kind, `${pathLabel}.kind`);
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
    if (objectValue.readiness !== undefined) {
      throw new Error(`${pathLabel}.readiness is only supported for HTTP proxy apps.`);
    }

    const runtime = toStringOrThrow(objectValue.runtime, `${pathLabel}.runtime`);
    if (runtime !== DEPENDENCY_ONLY_RUNTIME) {
      throw new Error(
        `${pathLabel}.runtime must be '${DEPENDENCY_ONLY_RUNTIME}' when kind=dependency.`,
      );
    }

    return {
      kind: "dependency",
      name,
      runtime: DEPENDENCY_ONLY_RUNTIME,
      dependencies,
      docker: parseDependencyDockerConfig(objectValue.docker, `${pathLabel}.docker`),
    };
  }

  const host = parseHostOrThrow(objectValue.host, `${pathLabel}.host`);
  const protocol = toStringOrThrow(objectValue.protocol, `${pathLabel}.protocol`);
  const runtime = toStringOrThrow(objectValue.runtime, `${pathLabel}.runtime`);
  if (!isSupportedProtocol(protocol)) {
    throw new Error(`${pathLabel}.protocol must be one of: ${SUPPORTED_PROTOCOLS.join(", ")}.`);
  }
  if (!isSupportedRuntime(runtime)) {
    throw new Error(`${pathLabel}.runtime must be one of: ${SUPPORTED_RUNTIMES.join(", ")}.`);
  }
  if (runtime === "host") {
    if (objectValue.readiness !== undefined) {
      throw new Error(`${pathLabel}.readiness is only supported for HTTP proxy apps.`);
    }
    if (!runtimeSupportsProtocol("host", protocol)) {
      throw new Error(`${pathLabel}: host runtime currently supports only protocol=http.`);
    }

    const hostRun = ensureObject(objectValue.hostRun, `${pathLabel}.hostRun`);
    ensureAllowedKeys(
      hostRun,
      ["command", "cwd", "strategy", "portTimeout"],
      `${pathLabel}.hostRun`,
    );

    const command = toStringOrThrow(hostRun.command, `${pathLabel}.hostRun.command`);
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new Error(
        `${pathLabel}.hostRun.command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters.`,
      );
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
        ...(portTimeout !== undefined ? { portTimeout } : {}),
      },
    };
  }

  if (runtime === "docker") {
    if (objectValue.readiness !== undefined) {
      throw new Error(`${pathLabel}.readiness is only supported for HTTP proxy apps.`);
    }
    const docker = parseDockerConfig(objectValue.docker, `${pathLabel}.docker`);

    if (protocol === "http") {
      return {
        name,
        host,
        protocol: "http",
        runtime: "docker",
        dependencies,
        docker,
      };
    }

    if (protocol === "tcp") {
      const tcpProtocol = toStringOrThrow(objectValue.tcpProtocol, `${pathLabel}.tcpProtocol`);
      if (!isSupportedTcpProtocol(tcpProtocol)) {
        throw new Error(
          `${pathLabel}.tcpProtocol must be one of: ${formatSupportedTcpProtocols()}.`,
        );
      }

      return {
        name,
        host,
        protocol: "tcp",
        tcpProtocol,
        runtime: "docker",
        dependencies,
        docker,
      };
    }
  }

  if (runtime === "proxy") {
    if (!runtimeSupportsProtocol("proxy", protocol)) {
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
      if (objectValue.readiness !== undefined) {
        throw new Error(`${pathLabel}.readiness is only supported for HTTP proxy apps.`);
      }
      const tcpProtocol = toStringOrThrow(objectValue.tcpProtocol, `${pathLabel}.tcpProtocol`);
      if (!isSupportedTcpProtocol(tcpProtocol)) {
        throw new Error(
          `${pathLabel}.tcpProtocol must be one of: ${formatSupportedTcpProtocols()}.`,
        );
      }

      return {
        name,
        host,
        protocol: "tcp",
        tcpProtocol,
        runtime: "proxy",
        dependencies,
        upstream,
      };
    }

    return {
      name,
      host,
      protocol: "http",
      runtime: "proxy",
      dependencies,
      upstream,
      ...(objectValue.readiness !== undefined
        ? { readiness: parseHttpReadiness(objectValue.readiness, `${pathLabel}.readiness`) }
        : {}),
    };
  }

  throw new Error(`${pathLabel} has unsupported protocol/runtime combination.`);
}

function parseUniqueStringArray(value: unknown, pathLabel: string): string[] {
  const values = toStringArray(value, pathLabel);
  const seen = new Set<string>();
  for (const item of values) {
    if (seen.has(item)) {
      throw new Error(`${pathLabel} contains duplicate '${item}'.`);
    }
    seen.add(item);
  }
  return values;
}

function parseRequiredUniqueStringArray(value: unknown, pathLabel: string): string[] {
  if (value === undefined) {
    throw new Error(`${pathLabel} must be an array of strings.`);
  }
  return parseUniqueStringArray(value, pathLabel);
}

function parsePrepareCommand(value: unknown, pathLabel: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${pathLabel} must be a non-empty array of strings.`);
  }
  if (value.length === 0) {
    throw new Error(`${pathLabel} must be a non-empty array of strings.`);
  }
  if (value.length > MAX_PREPARE_ARGS) {
    throw new Error(`${pathLabel} exceeds the maximum of ${MAX_PREPARE_ARGS} arguments.`);
  }

  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${pathLabel}[${index}] must be a string.`);
    }
    if (index === 0 && item.length === 0) {
      throw new Error(`${pathLabel}[0] must be a non-empty executable.`);
    }
    if (item.includes("\0")) {
      throw new Error(`${pathLabel}[${index}] must not contain null bytes.`);
    }
    const byteLength = Buffer.byteLength(item, "utf8");
    if (byteLength > MAX_PREPARE_ARG_BYTES) {
      throw new Error(
        `${pathLabel}[${index}] exceeds the maximum of ${MAX_PREPARE_ARG_BYTES} UTF-8 bytes.`,
      );
    }
    return item;
  });
}

function parseManagedRuntime(
  value: unknown,
  configPath: string,
): DevrouterManagedRuntime | undefined {
  if (value === undefined) {
    return undefined;
  }

  const managedRuntime = ensureObject(value, `${configPath}.managedRuntime`);
  ensureAllowedKeys(
    managedRuntime,
    ["devcontainer", "processes", "network"],
    `${configPath}.managedRuntime`,
  );
  let network: DevrouterManagedRuntime["network"];
  if (managedRuntime.network !== undefined) {
    const value = ensureObject(managedRuntime.network, `${configPath}.managedRuntime.network`);
    ensureAllowedKeys(
      value,
      ["prefixLength", "endpointUpperBound"],
      `${configPath}.managedRuntime.network`,
    );
    if (value.prefixLength !== undefined && ![24, 25, 26].includes(value.prefixLength as number))
      throw new Error("managedRuntime.network.prefixLength must be 24, 25 or 26.");
    if (
      value.endpointUpperBound !== undefined &&
      (!Number.isSafeInteger(value.endpointUpperBound) ||
        (value.endpointUpperBound as number) < 1 ||
        (value.endpointUpperBound as number) > 253)
    )
      throw new Error(
        "managedRuntime.network.endpointUpperBound must be an integer from 1 to 253.",
      );
    network = {
      ...(value.prefixLength !== undefined
        ? { prefixLength: value.prefixLength as 24 | 25 | 26 }
        : {}),
      ...(value.endpointUpperBound !== undefined
        ? { endpointUpperBound: value.endpointUpperBound as number }
        : {}),
    };
  }

  const devcontainer = ensureObject(
    managedRuntime.devcontainer,
    `${configPath}.managedRuntime.devcontainer`,
  );
  ensureAllowedKeys(
    devcontainer,
    ["baseServices", "profileServices", "prepareCommand"],
    `${configPath}.managedRuntime.devcontainer`,
  );
  const baseServices = parseRequiredUniqueStringArray(
    devcontainer.baseServices,
    `${configPath}.managedRuntime.devcontainer.baseServices`,
  );
  const profileServices = parseRequiredUniqueStringArray(
    devcontainer.profileServices,
    `${configPath}.managedRuntime.devcontainer.profileServices`,
  );
  const prepareCommand = parsePrepareCommand(
    devcontainer.prepareCommand,
    `${configPath}.managedRuntime.devcontainer.prepareCommand`,
  );
  const baseSet = new Set(baseServices);
  const overlappingServices = profileServices.filter((service) => baseSet.has(service));
  if (overlappingServices.length > 0) {
    throw new Error(
      `${configPath}.managedRuntime.devcontainer.baseServices and profileServices overlap: ${overlappingServices.join(", ")}.`,
    );
  }

  const processes = parseRequiredUniqueStringArray(
    managedRuntime.processes,
    `${configPath}.managedRuntime.processes`,
  );
  const unsafeProcesses = processes.filter(
    (process) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(process),
  );
  if (unsafeProcesses.length > 0) {
    throw new Error(
      `${configPath}.managedRuntime.processes entries must be safe exact identifiers: ${unsafeProcesses.join(", ")}.`,
    );
  }

  return {
    ...(network ? { network } : {}),
    devcontainer: {
      baseServices,
      profileServices,
      ...(prepareCommand ? { prepareCommand } : {}),
    },
    processes,
  };
}

function parseCapacitySafeInteger(value: unknown, pathLabel: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new Error(`${pathLabel} must be a safe integer.`);
  }
  if (value < minimum) {
    throw new Error(`${pathLabel} must be at least ${minimum}.`);
  }
  return value;
}

function parseCapacityName(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${pathLabel} must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${pathLabel} must not have leading or trailing whitespace.`);
  }
  if (value.length > MAX_CAPACITY_NAME_LENGTH) {
    throw new Error(
      `${pathLabel} exceeds the maximum length of ${MAX_CAPACITY_NAME_LENGTH} characters.`,
    );
  }
  if (
    [...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  ) {
    throw new Error(`${pathLabel} must not contain control characters.`);
  }
  return value;
}

function parseCapacityProfileKey(
  value: unknown,
  pathLabel: string,
  declaredProfiles: DevrouterConfig["profiles"],
): string {
  const key = parseCapacityName(value, pathLabel);
  if (key === "full") return key;

  const names = key.split(",");
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error(`${pathLabel}[${index}] is not a valid profile name.`);
    }
    if (seen.has(name)) {
      throw new Error(`${pathLabel} contains duplicate profile '${name}'.`);
    }
    if (!declaredProfiles || !Object.hasOwn(declaredProfiles, name)) {
      throw new Error(`${pathLabel} references undefined profile '${name}'.`);
    }
    seen.add(name);
  }

  return [...names].sort().join(",");
}

function parseCapacityDimension(
  value: unknown,
  pathLabel: string,
  runtime: boolean,
): { steadyBytes: number; startupTotalBytes: number } {
  const dimension = ensureObject(value, pathLabel);
  ensureAllowedKeys(dimension, ["steadyBytes", "startupTotalBytes"], pathLabel);
  const minimum = runtime ? 1 : 0;
  const steadyBytes = parseCapacitySafeInteger(
    dimension.steadyBytes,
    `${pathLabel}.steadyBytes`,
    minimum,
  );
  const startupTotalBytes = parseCapacitySafeInteger(
    dimension.startupTotalBytes,
    `${pathLabel}.startupTotalBytes`,
    minimum,
  );
  if (startupTotalBytes < steadyBytes) {
    throw new Error(`${pathLabel}.startupTotalBytes must be at least steadyBytes.`);
  }
  return { steadyBytes, startupTotalBytes };
}

function parseCapacityOperation(
  value: unknown,
  pathLabel: string,
): { hostIncrementBytes: number; runtimeIncrementBytes: number } {
  const operation = ensureObject(value, pathLabel);
  ensureAllowedKeys(operation, ["hostIncrementBytes", "runtimeIncrementBytes"], pathLabel);
  return {
    hostIncrementBytes: parseCapacitySafeInteger(
      operation.hostIncrementBytes,
      `${pathLabel}.hostIncrementBytes`,
      0,
    ),
    runtimeIncrementBytes: parseCapacitySafeInteger(
      operation.runtimeIncrementBytes,
      `${pathLabel}.runtimeIncrementBytes`,
      0,
    ),
  };
}

function parseCapacityOperations(
  value: unknown,
  pathLabel: string,
): Record<string, { hostIncrementBytes: number; runtimeIncrementBytes: number }> {
  const rawOperations = ensureObject(value, pathLabel);
  const operationEntries = Object.entries(rawOperations);
  if (operationEntries.length === 0) {
    throw new Error(`${pathLabel} must define at least one named operation.`);
  }
  if (operationEntries.length > MAX_CAPACITY_OPERATIONS) {
    throw new Error(`${pathLabel} exceeds the maximum of ${MAX_CAPACITY_OPERATIONS} operations.`);
  }

  const operations: Record<string, { hostIncrementBytes: number; runtimeIncrementBytes: number }> =
    {};
  for (const [operationName, operationValue] of operationEntries) {
    const name = parseCapacityName(operationName, `${pathLabel} key`);
    if (!/^[a-z][a-z0-9._-]*$/.test(name)) {
      throw new Error(`${pathLabel}.${operationName} is not a valid operation name.`);
    }
    operations[name] = parseCapacityOperation(operationValue, `${pathLabel}.${operationName}`);
  }
  return operations;
}

function parseCapacityTransition(
  value: unknown,
  pathLabel: string,
): { hostTotalBytes: number; runtimeTotalBytes: number } {
  const transition = ensureObject(value, pathLabel);
  ensureAllowedKeys(transition, ["hostTotalBytes", "runtimeTotalBytes"], pathLabel);
  return {
    hostTotalBytes: parseCapacitySafeInteger(
      transition.hostTotalBytes,
      `${pathLabel}.hostTotalBytes`,
      0,
    ),
    runtimeTotalBytes: parseCapacitySafeInteger(
      transition.runtimeTotalBytes,
      `${pathLabel}.runtimeTotalBytes`,
      1,
    ),
  };
}

function parseCapacityEstimates(
  value: unknown,
  configPath: string,
  declaredProfiles: DevrouterConfig["profiles"],
): CapacityEstimates | undefined {
  if (value === undefined) return undefined;

  const pathLabel = `${configPath}.capacity`;
  const capacity = ensureObject(value, pathLabel);
  ensureAllowedKeys(capacity, ["version", "profiles", "transitions"], pathLabel);

  const version = parseCapacitySafeInteger(capacity.version, `${pathLabel}.version`, 1);
  if (version !== 1) {
    throw new Error(`${pathLabel}.version must be 1.`);
  }

  const rawProfiles = ensureObject(capacity.profiles, `${pathLabel}.profiles`);
  const profileEntries = Object.entries(rawProfiles);
  if (profileEntries.length === 0) {
    throw new Error(`${pathLabel}.profiles must define at least one exact profile combination.`);
  }
  if (profileEntries.length > MAX_CAPACITY_PROFILES) {
    throw new Error(
      `${pathLabel}.profiles exceeds the maximum of ${MAX_CAPACITY_PROFILES} combinations.`,
    );
  }

  const profiles: CapacityEstimates["profiles"] = {};
  for (const [rawKey, profileValue] of profileEntries) {
    const profileKey = parseCapacityProfileKey(
      rawKey,
      `${pathLabel}.profiles key`,
      declaredProfiles,
    );
    if (Object.hasOwn(profiles, profileKey)) {
      throw new Error(
        `${pathLabel}.profiles contains aliases for the same exact combination '${profileKey}'.`,
      );
    }
    const profile = ensureObject(profileValue, `${pathLabel}.profiles.${rawKey}`);
    ensureAllowedKeys(
      profile,
      ["host", "runtime", "operations"],
      `${pathLabel}.profiles.${rawKey}`,
    );
    profiles[profileKey] = {
      host: parseCapacityDimension(profile.host, `${pathLabel}.profiles.${rawKey}.host`, false),
      runtime: parseCapacityDimension(
        profile.runtime,
        `${pathLabel}.profiles.${rawKey}.runtime`,
        true,
      ),
      operations: parseCapacityOperations(
        profile.operations,
        `${pathLabel}.profiles.${rawKey}.operations`,
      ),
    };
  }

  let transitions: CapacityEstimates["transitions"];
  if (capacity.transitions !== undefined) {
    const rawTransitions = ensureObject(capacity.transitions, `${pathLabel}.transitions`);
    const transitionEntries = Object.entries(rawTransitions);
    if (transitionEntries.length === 0) {
      throw new Error(`${pathLabel}.transitions must define at least one transition.`);
    }
    transitions = {};
    let transitionCount = 0;
    for (const [rawSource, targetValue] of transitionEntries) {
      const source = parseCapacityProfileKey(
        rawSource,
        `${pathLabel}.transitions source key`,
        declaredProfiles,
      );
      if (!Object.hasOwn(profiles, source)) {
        throw new Error(
          `${pathLabel}.transitions source '${source}' must have a profile estimate.`,
        );
      }
      if (Object.hasOwn(transitions, source)) {
        throw new Error(`${pathLabel}.transitions contains aliases for source '${source}'.`);
      }
      const rawTargets = ensureObject(targetValue, `${pathLabel}.transitions.${rawSource}`);
      const targetEntries = Object.entries(rawTargets);
      if (targetEntries.length === 0) {
        throw new Error(`${pathLabel}.transitions.${rawSource} must define a target.`);
      }
      const targets: Record<string, { hostTotalBytes: number; runtimeTotalBytes: number }> = {};
      for (const [rawTarget, transitionValue] of targetEntries) {
        transitionCount += 1;
        if (transitionCount > MAX_CAPACITY_TRANSITIONS) {
          throw new Error(
            `${pathLabel}.transitions exceeds the maximum of ${MAX_CAPACITY_TRANSITIONS} entries.`,
          );
        }
        const target = parseCapacityProfileKey(
          rawTarget,
          `${pathLabel}.transitions.${rawSource} target key`,
          declaredProfiles,
        );
        if (!Object.hasOwn(profiles, target)) {
          throw new Error(
            `${pathLabel}.transitions target '${target}' must have a profile estimate.`,
          );
        }
        if (Object.hasOwn(targets, target)) {
          throw new Error(
            `${pathLabel}.transitions.${rawSource} contains aliases for '${target}'.`,
          );
        }
        const transition = parseCapacityTransition(
          transitionValue,
          `${pathLabel}.transitions.${rawSource}.${rawTarget}`,
        );
        const sourceProfile = profiles[source];
        const targetProfile = profiles[target];
        if (
          transition.hostTotalBytes <
          Math.max(sourceProfile.host.steadyBytes, targetProfile.host.steadyBytes)
        ) {
          throw new Error(
            `${pathLabel}.transitions.${rawSource}.${rawTarget}.hostTotalBytes must cover both steady host estimates.`,
          );
        }
        if (
          transition.runtimeTotalBytes <
          Math.max(sourceProfile.runtime.steadyBytes, targetProfile.runtime.steadyBytes)
        ) {
          throw new Error(
            `${pathLabel}.transitions.${rawSource}.${rawTarget}.runtimeTotalBytes must cover both steady runtime estimates.`,
          );
        }
        targets[target] = transition;
      }
      transitions[source] = targets;
    }
  }

  return {
    version: 1,
    profiles,
    ...(transitions ? { transitions } : {}),
  };
}

export function normalizeCapacityEstimates(estimates: CapacityEstimates): CapacityEstimates {
  const profiles: CapacityEstimates["profiles"] = {};
  for (const key of Object.keys(estimates.profiles).sort()) {
    const estimate = estimates.profiles[key];
    profiles[key] = {
      host: {
        steadyBytes: estimate.host.steadyBytes,
        startupTotalBytes: estimate.host.startupTotalBytes,
      },
      runtime: {
        steadyBytes: estimate.runtime.steadyBytes,
        startupTotalBytes: estimate.runtime.startupTotalBytes,
      },
      operations: Object.fromEntries(
        Object.keys(estimate.operations)
          .sort()
          .map((name) => [name, { ...estimate.operations[name] }]),
      ),
    };
  }

  let transitions: CapacityEstimates["transitions"];
  if (estimates.transitions !== undefined) {
    transitions = {};
    for (const source of Object.keys(estimates.transitions).sort()) {
      const targets: Record<string, { hostTotalBytes: number; runtimeTotalBytes: number }> = {};
      for (const target of Object.keys(estimates.transitions[source]).sort()) {
        const transition = estimates.transitions[source][target];
        targets[target] = {
          hostTotalBytes: transition.hostTotalBytes,
          runtimeTotalBytes: transition.runtimeTotalBytes,
        };
      }
      transitions[source] = targets;
    }
  }

  return {
    version: 1,
    profiles,
    ...(transitions ? { transitions } : {}),
  };
}

export function capacityEstimatesDigest(estimates: CapacityEstimates): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeCapacityEstimates(estimates)), "utf8")
    .digest("hex");
}

function parseConfig(raw: unknown, configPath: string): DevrouterConfig {
  const root = ensureObject(raw, configPath);
  ensureAllowedKeys(
    root,
    [
      "version",
      "devrouter",
      "project",
      "secretManager",
      "managedRuntime",
      "profiles",
      "capacity",
      "apps",
    ],
    configPath,
  );

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
      throw new Error(
        `${configPath}.secretManager.command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters.`,
      );
    }

    let defaultEnv: string | undefined;
    if (sm.defaultEnv !== undefined) {
      defaultEnv = toStringOrThrow(sm.defaultEnv, `${configPath}.secretManager.defaultEnv`);
      if (defaultEnv.length > 64) {
        throw new Error(
          `${configPath}.secretManager.defaultEnv exceeds maximum length of 64 characters.`,
        );
      }
      if (!VALID_ENV_NAME_RE.test(defaultEnv)) {
        throw new Error(
          `${configPath}.secretManager.defaultEnv must be alphanumeric with hyphens.`,
        );
      }
    }

    if (command.includes(SECRET_MANAGER_ENV_PLACEHOLDER) && !defaultEnv) {
      throw new Error(
        `${configPath}.secretManager.defaultEnv is required when command contains ${SECRET_MANAGER_ENV_PLACEHOLDER}.`,
      );
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

  const managedRuntime = parseManagedRuntime(root.managedRuntime, configPath);
  const profiles = parseProfiles(root.profiles, configPath, apps, managedRuntime);
  const capacity = parseCapacityEstimates(root.capacity, configPath, profiles);

  return {
    version: 1,
    ...(devrouter ? { devrouter } : {}),
    project:
      root.project && typeof root.project === "object"
        ? { name: (root.project as { name?: string }).name }
        : undefined,
    ...(secretManager ? { secretManager } : {}),
    ...(managedRuntime ? { managedRuntime } : {}),
    ...(profiles ? { profiles } : {}),
    ...(capacity ? { capacity } : {}),
    apps,
  };
}

const PROFILE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PROFILES = 32;

// Parse and validate the optional `profiles` map. Cross-references against
// `apps` (existence, readiness subset) are checked here so a broken profile
// graph fails at config-load time, not mid-ensure.
function parseProfiles(
  value: unknown,
  configPath: string,
  apps: DevrouterApp[],
  managedRuntime: DevrouterManagedRuntime | undefined,
): DevrouterConfig["profiles"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = ensureObject(value, `${configPath}.profiles`);
  if (Object.keys(raw).length === 0) {
    throw new Error(`${configPath}.profiles must define at least one profile.`);
  }
  if (Object.keys(raw).length > MAX_PROFILES) {
    throw new Error(`${configPath}.profiles exceeds the maximum of ${MAX_PROFILES} profiles.`);
  }

  const routedNames = new Set(
    apps.filter((app) => app.kind !== "dependency").map((app) => app.name),
  );

  const result: Record<string, DevrouterProfile> = {};
  let defaultCount = 0;
  const profileServices = new Set(managedRuntime?.devcontainer.profileServices ?? []);
  const processMarkers = new Set(managedRuntime?.processes ?? []);
  for (const [name, profileValue] of Object.entries(raw)) {
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error(
        `${configPath}.profiles.${name} is not a valid profile name (lowercase alphanumerics and hyphens).`,
      );
    }
    const profile = ensureObject(profileValue, `${configPath}.profiles.${name}`);
    ensureAllowedKeys(
      profile,
      ["apps", "dependencies", "readiness", "devcontainerServices", "processes", "default"],
      `${configPath}.profiles.${name}`,
    );

    const profileApps = toStringArray(profile.apps, `${configPath}.profiles.${name}.apps`);
    if (!managedRuntime && profileApps.length === 0) {
      throw new Error(`${configPath}.profiles.${name}.apps must not be empty.`);
    }
    const isWildcard = profileApps.length === 1 && profileApps[0] === "*";
    if (profileApps.includes("*") && !isWildcard) {
      throw new Error(
        `${configPath}.profiles.${name}.apps must use '*' as its only entry when selecting all apps.`,
      );
    }
    if (!isWildcard) {
      for (const appName of profileApps) {
        if (!routedNames.has(appName)) {
          throw new Error(
            `${configPath}.profiles.${name}.apps references '${appName}', which is not a routed app (kind=app).`,
          );
        }
      }
    }

    let dependencies: string[] | undefined;
    if (profile.dependencies !== undefined) {
      dependencies = toStringArray(
        profile.dependencies,
        `${configPath}.profiles.${name}.dependencies`,
      );
      for (const depName of dependencies) {
        const dependency = apps.find((candidate) => candidate.name === depName);
        if (!dependency) {
          throw new Error(
            `${configPath}.profiles.${name}.dependencies references '${depName}', which does not exist in apps.`,
          );
        }
        if (dependency.kind !== "dependency") {
          throw new Error(
            `${configPath}.profiles.${name}.dependencies references '${depName}', which is not kind=dependency.`,
          );
        }
      }
    }

    let readiness: string[] | undefined;
    if (profile.readiness !== undefined) {
      readiness = toStringArray(profile.readiness, `${configPath}.profiles.${name}.readiness`);
      const appSet = new Set(isWildcard ? Array.from(routedNames) : profileApps);
      for (const readyName of readiness) {
        if (!appSet.has(readyName)) {
          throw new Error(
            `${configPath}.profiles.${name}.readiness references '${readyName}', which is not in the profile's apps.`,
          );
        }
      }
    }

    let devcontainerServices: string[] | undefined;
    if (profile.devcontainerServices !== undefined) {
      if (!managedRuntime) {
        throw new Error(
          `${configPath}.profiles.${name}.devcontainerServices requires managedRuntime.`,
        );
      }
      devcontainerServices = toStringArray(
        profile.devcontainerServices,
        `${configPath}.profiles.${name}.devcontainerServices`,
      );
      const isServiceWildcard =
        devcontainerServices.length === 1 && devcontainerServices[0] === "*";
      if (devcontainerServices.includes("*") && !isServiceWildcard) {
        throw new Error(
          `${configPath}.profiles.${name}.devcontainerServices must use '*' as its only entry when selecting all services.`,
        );
      }
      if (!isServiceWildcard) {
        for (const service of devcontainerServices) {
          if (!profileServices.has(service)) {
            throw new Error(
              `${configPath}.profiles.${name}.devcontainerServices references '${service}', which is not a registered profile service.`,
            );
          }
        }
      }
    }

    let processes: string[] | undefined;
    if (profile.processes !== undefined) {
      if (!managedRuntime) {
        throw new Error(`${configPath}.profiles.${name}.processes requires managedRuntime.`);
      }
      processes = toStringArray(profile.processes, `${configPath}.profiles.${name}.processes`);
      const isProcessWildcard = processes.length === 1 && processes[0] === "*";
      if (processes.includes("*") && !isProcessWildcard) {
        throw new Error(
          `${configPath}.profiles.${name}.processes must use '*' as its only entry when selecting all processes.`,
        );
      }
      if (!isProcessWildcard) {
        for (const process of processes) {
          if (!processMarkers.has(process)) {
            throw new Error(
              `${configPath}.profiles.${name}.processes references '${process}', which is not a registered process marker.`,
            );
          }
        }
      }
    }

    const selectsDimension =
      profileApps.length > 0 ||
      (dependencies?.length ?? 0) > 0 ||
      (devcontainerServices?.length ?? 0) > 0 ||
      (processes?.length ?? 0) > 0;
    if (!selectsDimension) {
      throw new Error(
        `${configPath}.profiles.${name}.apps must not be empty; select at least one profile dimension.`,
      );
    }

    let isDefault = false;
    if (profile.default !== undefined) {
      if (typeof profile.default !== "boolean") {
        throw new Error(`${configPath}.profiles.${name}.default must be a boolean.`);
      }
      isDefault = profile.default;
    }

    if (isDefault) {
      defaultCount += 1;
    }

    result[name] = {
      apps: profileApps,
      ...(dependencies ? { dependencies } : {}),
      ...(readiness ? { readiness } : {}),
      ...(devcontainerServices ? { devcontainerServices } : {}),
      ...(processes ? { processes } : {}),
      ...(isDefault ? { default: true } : {}),
    };
  }

  if (defaultCount > 1) {
    throw new Error(`${configPath}.profiles must have at most one default profile.`);
  }

  return result;
}

// Resolve the effective profile for a config. Explicit selection wins; without
// one, the config's default profile applies, and a config without `profiles`
// keeps the implicit full profile (undefined = everything).
//
function canonicalProfileValues(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function isProfileWildcard(values: string[] | undefined): boolean {
  return values?.length === 1 && values[0] === "*";
}

function normalizeProfile(profile: DevrouterProfile): DevrouterProfile {
  return {
    apps: canonicalProfileValues(profile.apps),
    ...(profile.dependencies ? { dependencies: canonicalProfileValues(profile.dependencies) } : {}),
    ...(profile.readiness ? { readiness: canonicalProfileValues(profile.readiness) } : {}),
    ...(profile.devcontainerServices
      ? { devcontainerServices: canonicalProfileValues(profile.devcontainerServices) }
      : {}),
    ...(profile.processes ? { processes: canonicalProfileValues(profile.processes) } : {}),
    ...(profile.default ? { default: true } : {}),
  };
}

function normalizeSelectedProfile(
  name: string,
  profile: DevrouterProfile,
  managedRuntime: DevrouterConfig["managedRuntime"],
): DevrouterProfile {
  const normalized = normalizeProfile(profile);
  if (name !== "full" || !managedRuntime) return normalized;
  return {
    ...normalized,
    apps: ["*"],
    devcontainerServices: ["*"],
    processes: ["*"],
  };
}

// A selection may name several profiles separated by commas (e.g. `manage,pwa`).
// The union is deduplicated and sorted independently across every profile
// dimension. `default` flags are ignored when combining — a merged selection is
// never treated as a default.
export function resolveProfile(
  config: DevrouterConfig,
  profileOverride?: string,
): { name: string; profile?: DevrouterProfile } {
  const profiles = config.profiles;

  const mergeSelection = (selection: string): { name: string; profile?: DevrouterProfile } => {
    const rawNames = selection.split(",");
    if (rawNames.some((name) => name.trim().length === 0)) {
      throw new Error("Profile selection contains an empty token.");
    }
    const names = Array.from(new Set(rawNames.map((name) => name.trim())));
    if (names.length === 0) {
      throw new Error("Profile selection is empty.");
    }
    const missing = names.filter((name) => !profiles?.[name]);
    if (missing.length > 0) {
      const available = profiles ? Object.keys(profiles).join(", ") : "(none defined)";
      throw new Error(
        `Profile '${missing[0]}' is not defined in .devrouter.yml. Available: ${available}`,
      );
    }
    if (names.length === 1) {
      const profile = profiles?.[names[0]];
      if (!profile) return { name: names[0] };
      return {
        name: names[0],
        profile: normalizeSelectedProfile(names[0], profile, config.managedRuntime),
      };
    }

    // Canonical merged name: sorted unique selection, so `pwa,manage` and
    // `manage,pwa` share one fingerprint and one route-generation tag.
    const canonicalName = [...names].sort().join(",");

    const apps = new Set<string>();
    const dependencies = new Set<string>();
    const readiness = new Set<string>();
    const devcontainerServices = new Set<string>();
    const processes = new Set<string>();
    let hasAppWildcard = false;
    let hasServiceWildcard = false;
    let hasProcessWildcard = false;
    for (const name of names) {
      const profile = profiles?.[name];
      if (!profile) continue;
      if (isProfileWildcard(profile.apps)) {
        hasAppWildcard = true;
      } else {
        for (const appName of profile.apps) apps.add(appName);
      }
      for (const depName of profile.dependencies ?? []) dependencies.add(depName);
      for (const readyName of profile.readiness ?? []) readiness.add(readyName);
      if (isProfileWildcard(profile.devcontainerServices)) {
        hasServiceWildcard = true;
      } else {
        for (const service of profile.devcontainerServices ?? []) {
          devcontainerServices.add(service);
        }
      }
      if (isProfileWildcard(profile.processes)) {
        hasProcessWildcard = true;
      } else {
        for (const process of profile.processes ?? []) processes.add(process);
      }
    }

    const merged: DevrouterProfile = {
      apps: hasAppWildcard ? ["*"] : canonicalProfileValues(Array.from(apps)),
      ...(dependencies.size > 0
        ? { dependencies: canonicalProfileValues(Array.from(dependencies)) }
        : {}),
      ...(readiness.size > 0 ? { readiness: canonicalProfileValues(Array.from(readiness)) } : {}),
      ...(hasServiceWildcard
        ? { devcontainerServices: ["*"] }
        : devcontainerServices.size > 0
          ? { devcontainerServices: canonicalProfileValues(Array.from(devcontainerServices)) }
          : {}),
      ...(hasProcessWildcard
        ? { processes: ["*"] }
        : processes.size > 0
          ? { processes: canonicalProfileValues(Array.from(processes)) }
          : {}),
    };
    return { name: canonicalName, profile: merged };
  };

  if (profileOverride !== undefined && (profileOverride !== "full" || profiles?.full)) {
    return mergeSelection(profileOverride);
  }
  if (profiles && profileOverride === undefined) {
    const defaultName = Object.keys(profiles).find((name) => profiles[name].default);
    if (defaultName) {
      return {
        name: defaultName,
        profile: normalizeSelectedProfile(
          defaultName,
          profiles[defaultName],
          config.managedRuntime,
        ),
      };
    }
    // Profiles exist but none is default: full behavior (all apps).
    return {
      name: "full",
      profile: config.managedRuntime
        ? { apps: ["*"], devcontainerServices: ["*"], processes: ["*"] }
        : undefined,
    };
  }
  return {
    name: "full",
    profile: config.managedRuntime
      ? { apps: ["*"], devcontainerServices: ["*"], processes: ["*"] }
      : undefined,
  };
}

// Filter a runtime config down to a profile's apps. Dependencies: a profile with
// explicit `dependencies` keeps exactly those; otherwise every dependency that a
// kept app (transitively) requires is preserved.
export function applyProfile(
  config: DevrouterConfig,
  profile: DevrouterProfile | undefined,
): DevrouterConfig {
  const wildcardApps = profile?.apps.length === 1 && profile.apps[0] === "*";
  if (!profile || (wildcardApps && profile.dependencies === undefined)) {
    return config;
  }

  const appSet = new Set(profile.apps);
  const next = structuredClone(config);
  const kept: DevrouterApp[] = [];
  const keptDependencies = new Set<string>();
  for (const app of next.apps) {
    if (app.kind === "dependency") {
      continue; // decided after dependency closure below
    }
    if (!wildcardApps && !appSet.has(app.name)) {
      continue;
    }
    // Transitively collect every dependency this app requires.
    for (const dependency of resolveAppDependencies(config, app)) {
      keptDependencies.add(dependency.name);
    }
    kept.push(app);
  }

  // Explicit profile dependencies are additive (a profile may need a service no
  // routed app in the profile references).
  for (const dependencyName of profile.dependencies ?? []) {
    keptDependencies.add(dependencyName);
  }

  for (const app of next.apps) {
    if (app.kind === "dependency" && keptDependencies.has(app.name)) {
      kept.push(app);
    }
  }

  next.apps = kept;
  return next;
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

export function loadRepoConfig(
  repoPath?: string,
  read = (file: string) => fs.readFileSync(file, "utf-8"),
): DevrouterConfig {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing ${CONFIG_FILE_NAME} in ${resolvedRepoPath}. Run 'dev repo init --repo ${resolvedRepoPath}' first.`,
    );
  }

  const raw = read(configPath);
  const parsed = YAML.parse(raw) as DevrouterConfigWithUnknown | null;
  const config = parseConfig(parsed ?? {}, configPath);

  const requiredVersion = config.devrouter?.version;
  if (requiredVersion && !hasWarnedVersionMismatch) {
    const cliVersion = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";
    if (cliVersion !== "0.0.0-dev" && compareSemver(requiredVersion, cliVersion) > 0) {
      hasWarnedVersionMismatch = true;
      process.stderr.write(
        `\n⚠️  Warning: The repository configuration requires devrouter version ${requiredVersion}, ` +
          `but you are running version ${cliVersion}.\n` +
          `   Please upgrade your CLI to avoid unexpected behavior: npm install -g @devrouter/cli\n\n`,
      );
    }
  }

  return config;
}

export function initRepoConfig(
  repoPath?: string,
  options: { devrouterVersion?: string } = {},
): { repoPath: string; configPath: string; created: boolean } {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  if (fs.existsSync(configPath)) {
    return { repoPath: resolvedRepoPath, configPath, created: false };
  }

  if (
    options.devrouterVersion !== undefined &&
    !DEVROUTER_VERSION_RE.test(options.devrouterVersion)
  ) {
    throw new Error(
      `Invalid devrouter version '${options.devrouterVersion}'. Expected semantic version like 0.0.14.`,
    );
  }

  const initialConfig: DevrouterConfig = {
    version: 1,
    ...(options.devrouterVersion
      ? {
          devrouter: {
            version: options.devrouterVersion,
          },
        }
      : {}),
    project: {
      name: path.basename(resolvedRepoPath),
    },
    apps: [],
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
    if (options.runtime !== undefined && options.runtime !== DEPENDENCY_ONLY_RUNTIME) {
      throw new Error(`--runtime must be ${DEPENDENCY_ONLY_RUNTIME} when --kind dependency`);
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
      runtime: DEPENDENCY_ONLY_RUNTIME,
      dependencies,
      docker: {
        service: options.service,
        composeFiles:
          options.composeFiles.length > 0 ? options.composeFiles : ["docker-compose.yml"],
      },
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
    throw new Error(
      "--host contains invalid characters. Only lowercase alphanumerics and hyphens are allowed.",
    );
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
        strategy: { ...DEFAULT_HOST_STRATEGY },
      },
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
      if (!tcpProtocol || !isSupportedTcpProtocol(tcpProtocol)) {
        throw new Error(
          `--tcp-protocol must be one of: ${formatSupportedTcpProtocols()} when --runtime proxy --protocol tcp`,
        );
      }

      return {
        name: options.name,
        host,
        protocol: "tcp",
        tcpProtocol,
        runtime: "proxy",
        dependencies,
        upstream: options.upstream,
      };
    }

    return {
      name: options.name,
      host,
      protocol: "http",
      runtime: "proxy",
      dependencies,
      upstream: options.upstream,
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
    router: options.router,
  };

  if (options.protocol === "http") {
    return {
      name: options.name,
      host,
      protocol: "http",
      runtime: "docker",
      dependencies,
      docker,
    };
  }

  const tcpProtocol = options.tcpProtocol ?? DEFAULT_TCP_PROTOCOL;
  if (!isSupportedTcpProtocol(tcpProtocol)) {
    throw new Error(`--tcp-protocol must be one of: ${formatSupportedTcpProtocols()}`);
  }

  return {
    name: options.name,
    host,
    protocol: "tcp",
    tcpProtocol,
    runtime: "docker",
    dependencies,
    docker,
  };
}

export function upsertRepoApp(
  repoPath: string,
  options: AppAddOptions,
): { configPath: string; app: DevrouterApp } {
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

export function removeRepoApp(
  repoPath: string,
  name: string,
): { configPath: string; removed: boolean } {
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
  repoPath: string,
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
      const resolved = app.upstream.replaceAll(WORKSPACE_PLACEHOLDER, substitutionToken);
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
 *
 * When `profileOverride` is set, the config is additionally filtered to that
 * profile's apps/dependencies (`applyProfile`); without an override, the config's
 * default profile applies when one is declared, else everything stays.
 */
export function loadRuntimeConfig(
  repoPath?: string,
  workspaceOverride?: string,
  profileOverride?: string,
): {
  config: DevrouterConfig;
  workspace: string | undefined;
  profile: string;
  resolvedProfile?: DevrouterProfile;
} {
  const resolved = resolveRepoPath(repoPath);
  const raw = loadRepoConfig(resolved);
  const resolvedProfile = resolveProfile(raw, profileOverride);
  const workspace = resolveWorkspace(resolved, workspaceOverride);
  const config = applyProfile(applyWorkspace(raw, workspace, resolved), resolvedProfile.profile);
  return {
    config,
    workspace,
    profile: resolvedProfile.name,
    resolvedProfile: resolvedProfile.profile,
  };
}

export function resolveAppByName(
  repoPath: string,
  name: string,
  workspaceOverride?: string,
): { config: DevrouterConfig; app: DevrouterApp; workspace: string | undefined } {
  const { config, workspace } = loadRuntimeConfig(repoPath, workspaceOverride);
  const app = config.apps.find((entry) => entry.name === name);
  if (!app) {
    const available = config.apps.map((entry) => entry.name).join(", ");
    throw new Error(
      `App '${name}' not found in ${getRepoConfigPath(repoPath)}. Available: ${available || "(none)"}`,
    );
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
