import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  hasExactComposeIdentity,
  inspectWorkspaceContainers,
  type WorkspaceContainerSnapshot,
} from "./devpod-environment";
import { networkDockerOptions } from "./network-effect-scope";

export type ManagedHostPortDeclaration = {
  service: string;
  target: number;
};

export type HostPortReportEntry = {
  service: string;
  target: number;
  status: "available" | "inactive" | "unavailable";
  endpoint?: { host: "127.0.0.1"; port: number };
  reason?: "not-found" | "not-running" | "ambiguous" | "not-published" | "unavailable";
};

export type ManagedHostPorts = Record<string, HostPortReportEntry>;

type ResolveManagedHostPortsInput = {
  repoPath: string;
  declarations: Record<string, ManagedHostPortDeclaration>;
  selectedServices: string[];
  composeProject?: string;
  composeFiles?: string[];
  containers?: WorkspaceContainerSnapshot[];
  publishedBindings?: (containerId: string, target: number) => string | undefined;
};

const PORT_LOOKUP_TIMEOUT_MS = 10_000;
const PORT_LOOKUP_MAX_BUFFER = 64 * 1024;
const LOOPBACK_BINDING = /^127\.0\.0\.1:(\d+)$/;

function unavailableEntry(
  declaration: ManagedHostPortDeclaration,
  reason: NonNullable<HostPortReportEntry["reason"]>,
): HostPortReportEntry {
  return { ...declaration, status: "unavailable", reason };
}

function livePublishedBindings(containerId: string, target: number): string | undefined {
  const result = spawnSync("docker", ["port", containerId, `${target}/tcp`], {
    encoding: "utf-8",
    timeout: PORT_LOOKUP_TIMEOUT_MS,
    maxBuffer: PORT_LOOKUP_MAX_BUFFER,
    ...networkDockerOptions(),
  });
  if (result.error || result.status === null) return undefined;
  if (result.status !== 0) return "";
  return typeof result.stdout === "string" ? result.stdout : undefined;
}

function parseLoopbackBinding(output: string): {
  endpoint?: { host: "127.0.0.1"; port: number };
  reason?: "ambiguous" | "not-published";
} {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { reason: "not-published" };
  if (lines.length > 1) return { reason: "ambiguous" };

  const match = LOOPBACK_BINDING.exec(lines[0]);
  if (!match) return { reason: "not-published" };
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { reason: "not-published" };
  return { endpoint: { host: "127.0.0.1", port } };
}

function revalidateLiveOwner(
  containerId: string,
  input: ResolveManagedHostPortsInput,
  composeProject: string,
  composeFiles: string[],
  service: string,
): "available" | "not-running" | "unavailable" {
  try {
    const current = inspectWorkspaceContainers({ ids: [containerId] });
    if (current.length !== 1 || current[0].id !== containerId) return "unavailable";
    if (
      !hasExactComposeIdentity(current[0], {
        repoPath: input.repoPath,
        service,
        composeProject,
        composeFiles,
      })
    ) {
      return "unavailable";
    }
    return current[0].state.Running ? "available" : "not-running";
  } catch {
    return "unavailable";
  }
}

/**
 * Resolve explicitly declared TCP ports from one exact, running Compose owner.
 * Callers can inject snapshots and binding output for deterministic evidence.
 */
export function resolveManagedHostPorts(input: ResolveManagedHostPortsInput): ManagedHostPorts {
  const report: ManagedHostPorts = {};
  const selectedServices = new Set(input.selectedServices);
  const selectedKeys: string[] = [];

  for (const [key, declaration] of Object.entries(input.declarations)) {
    if (!selectedServices.has(declaration.service)) {
      report[key] = { ...declaration, status: "inactive" };
      continue;
    }
    selectedKeys.push(key);
    report[key] = { ...declaration, status: "unavailable", reason: "unavailable" };
  }

  if (selectedKeys.length === 0) return report;

  const composeProject = input.composeProject;
  const composeFiles = input.composeFiles;
  if (
    typeof composeProject !== "string" ||
    composeProject.length === 0 ||
    composeFiles === undefined ||
    composeFiles.length === 0 ||
    composeFiles.some((file) => file.length === 0)
  ) {
    return report;
  }

  if (
    selectedKeys.some((key) => {
      const target = input.declarations[key].target;
      return !Number.isInteger(target) || target < 1 || target > 65_535;
    })
  ) {
    return report;
  }

  const liveContainers = input.containers === undefined;
  let containers = input.containers;
  if (containers === undefined) {
    try {
      containers = inspectWorkspaceContainers({ composeProject });
    } catch {
      return report;
    }
  }

  const publishedBindings = input.publishedBindings ?? livePublishedBindings;
  for (const key of selectedKeys) {
    const declaration = input.declarations[key];
    let owners: WorkspaceContainerSnapshot[];
    try {
      owners = containers.filter((container) =>
        hasExactComposeIdentity(container, {
          repoPath: input.repoPath,
          service: declaration.service,
          composeProject,
          composeFiles,
        }),
      );
    } catch {
      report[key] = unavailableEntry(declaration, "unavailable");
      continue;
    }
    if (owners.length === 0) {
      report[key] = unavailableEntry(declaration, "not-found");
      continue;
    }
    if (owners.length > 1) {
      report[key] = unavailableEntry(declaration, "ambiguous");
      continue;
    }

    const owner = owners[0];
    if (!owner.state.Running) {
      report[key] = unavailableEntry(declaration, "not-running");
      continue;
    }

    let output: string | undefined;
    try {
      output = publishedBindings(owner.id, declaration.target);
    } catch {
      output = undefined;
    }
    if (typeof output !== "string") {
      report[key] = unavailableEntry(declaration, "unavailable");
      continue;
    }

    const binding = parseLoopbackBinding(output);
    if (!binding.endpoint) {
      report[key] = unavailableEntry(declaration, binding.reason ?? "unavailable");
      continue;
    }

    if (liveContainers) {
      const proof = revalidateLiveOwner(
        owner.id,
        input,
        composeProject,
        composeFiles,
        declaration.service,
      );
      if (proof !== "available") {
        report[key] = unavailableEntry(declaration, proof);
        continue;
      }
    }

    report[key] = {
      ...declaration,
      status: "available",
      endpoint: binding.endpoint,
    };
  }

  return report;
}

/** Retained declaration identity excludes transient Docker-allocated port numbers. */
export function managedHostPortDeclarationsIdentity(
  declarations: Record<string, ManagedHostPortDeclaration>,
): string | undefined {
  const keys = Object.keys(declarations).sort();
  if (keys.length === 0) return undefined;
  const canonical = keys.map((key) => [key, declarations[key].service, declarations[key].target]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Values that prevent stale selected-port environment from surviving a transition. */
export function managedHostPortVariables(report: ManagedHostPorts): Record<string, string> {
  return Object.fromEntries(
    Object.entries(report).map(([key, entry]) => [
      `DEVROUTER_HOST_PORT_${key.toUpperCase().replaceAll("-", "_")}`,
      entry.status === "available" && entry.endpoint ? String(entry.endpoint.port) : "",
    ]),
  );
}

/** Stable process identity for the currently available host-port mapping. */
export function managedHostPortIdentity(report: ManagedHostPorts): string | undefined {
  const keys = Object.keys(report).sort();
  if (keys.length === 0) return undefined;
  const canonical = keys.map((key) => {
    const entry = report[key];
    return [key, entry.status === "available" ? (entry.endpoint?.port ?? null) : entry.status];
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function assertManagedHostPortsAvailable(report: ManagedHostPorts): void {
  const unavailable = Object.entries(report)
    .filter(([, entry]) => entry.status === "unavailable")
    .map(([key]) => key)
    .sort();
  if (unavailable.length > 0) {
    throw new Error(`Selected managed host ports are unavailable: ${unavailable.join(", ")}.`);
  }
}
