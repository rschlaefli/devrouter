import path from "node:path";
import type { ManagedRuntimeState } from "./managed-runtime-state";

export type ManagedStopBaseline = {
  version: 1;
  provider: "devsy";
  context: string;
  providerId: string;
  uid: string;
  sourcePath: string;
  sourceContainer: string;
  endpoint: string;
  daemonId: string;
  sourceConfigSha256: string;
  effectiveConfigSha256: string;
  project: string;
  primaryService: string;
  requiredServices: string[];
  allowedServices: string[];
  composeDirectory: string;
  composeFiles: string[];
  featureDirectory: string;
  containers: Array<{
    id: string;
    service: string;
    configFiles: string[];
    mounts: Array<{ Type: string; Source: string; Destination: string }>;
  }>;
};

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error("Invalid managed stop baseline fields.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    (!empty && !value.length) ||
    value.trim() !== value ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error("Invalid managed stop baseline identity.");
  }
  return value;
}

function absolute(value: unknown): string {
  const result = text(value);
  if (!path.isAbsolute(result) || path.normalize(result) !== result) {
    throw new Error("Invalid managed stop baseline path.");
  }
  return result;
}

function list(value: unknown, parse = text): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 256) {
    throw new Error("Invalid managed stop baseline population.");
  }
  const result = value.map((item) => parse(item));
  if (new Set(result).size !== result.length) throw new Error("Duplicate stop baseline identity.");
  return result;
}

function id(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("Invalid stop baseline container ID.");
  return result;
}

/** Validate without resolving files: a retained stop must survive source-file deletion. */
export function validateManagedStopBaseline(
  value: unknown,
  state: ManagedRuntimeState,
): ManagedStopBaseline {
  const v = record(value, [
    "version",
    "provider",
    "context",
    "providerId",
    "uid",
    "sourcePath",
    "sourceContainer",
    "endpoint",
    "daemonId",
    "sourceConfigSha256",
    "effectiveConfigSha256",
    "project",
    "primaryService",
    "requiredServices",
    "allowedServices",
    "composeDirectory",
    "composeFiles",
    "featureDirectory",
    "containers",
  ]);
  if (
    v.version !== 1 ||
    v.provider !== "devsy" ||
    Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024
  ) {
    throw new Error("Unsupported or oversized managed stop baseline.");
  }
  const endpoint = text(v.endpoint);
  if (!endpoint.startsWith("unix://"))
    throw new Error("Stop baseline requires a pinned local Docker endpoint.");
  absolute(endpoint.slice(7));
  const result: ManagedStopBaseline = {
    version: 1,
    provider: "devsy",
    context: text(v.context),
    providerId: text(v.providerId),
    uid: text(v.uid, true),
    sourcePath: absolute(v.sourcePath),
    sourceContainer: text(v.sourceContainer, true),
    endpoint,
    daemonId: text(v.daemonId),
    sourceConfigSha256: id(v.sourceConfigSha256),
    effectiveConfigSha256: id(v.effectiveConfigSha256),
    project: text(v.project),
    primaryService: text(v.primaryService),
    requiredServices: list(v.requiredServices),
    allowedServices: list(v.allowedServices),
    composeDirectory: absolute(v.composeDirectory),
    composeFiles: list(v.composeFiles, absolute),
    featureDirectory: absolute(v.featureDirectory),
    containers: [],
  };
  if (
    result.providerId !== state.devpodId ||
    result.sourcePath !== state.repoPath ||
    result.project !== state.composeProject ||
    result.sourceConfigSha256 !== state.sourceConfigSha256 ||
    result.effectiveConfigSha256 !== state.effectiveConfigSha256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result.context) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(result.providerId) ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(result.project) ||
    !result.requiredServices.includes(result.primaryService) ||
    result.requiredServices.some((service) => !result.allowedServices.includes(service))
  ) {
    throw new Error("Managed stop baseline does not bind the retained generation.");
  }
  if (!Array.isArray(v.containers) || !v.containers.length || v.containers.length > 256) {
    throw new Error("Invalid managed stop baseline population.");
  }
  result.containers = v.containers.map((entry) => {
    const c = record(entry, ["id", "service", "configFiles", "mounts"]);
    const configFiles = list(c.configFiles, absolute);
    if (
      configFiles.length < result.composeFiles.length ||
      result.composeFiles.some((file, index) => configFiles[index] !== file) ||
      configFiles
        .slice(result.composeFiles.length)
        .some(
          (file) =>
            path.dirname(file) !== result.featureDirectory ||
            !/^docker-compose\.devcontainer\.containerFeatures-[a-zA-Z0-9_-]+\.yml$/.test(
              path.basename(file),
            ),
        )
    ) {
      throw new Error("Invalid stop baseline Compose provenance.");
    }
    if (!Array.isArray(c.mounts) || c.mounts.length > 256)
      throw new Error("Invalid baseline mounts.");
    return {
      id: id(c.id),
      service: text(c.service),
      configFiles,
      mounts: c.mounts.map((item) => {
        const mount = record(item, ["Type", "Source", "Destination"]);
        return {
          Type: text(mount.Type),
          Source: mount.Type === "tmpfs" && mount.Source === "" ? "" : absolute(mount.Source),
          Destination: absolute(mount.Destination),
        };
      }),
    };
  });
  const services = result.containers.map((container) => container.service);
  if (
    new Set(services).size !== services.length ||
    new Set(result.containers.map((container) => container.id)).size !== result.containers.length ||
    services.some((service) => !result.allowedServices.includes(service)) ||
    result.requiredServices.some((service) => !services.includes(service))
  ) {
    throw new Error("Incomplete or duplicate stop baseline population.");
  }
  const primary = result.containers.find(
    (container) => container.service === result.primaryService,
  );
  if (
    primary?.mounts.filter((mount) => mount.Type === "bind" && mount.Source === state.repoPath)
      .length !== 1 ||
    (result.sourceContainer && result.sourceContainer !== primary.id)
  ) {
    throw new Error("Stop baseline has no exact primary source binding.");
  }
  return result;
}
