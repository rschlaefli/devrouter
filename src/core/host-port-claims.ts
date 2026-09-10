import { spawnSync } from "node:child_process";
import path from "node:path";
import { type ManagedDevcontainerPlan, managedComposeEnvironment } from "./devcontainer-profile";
import { networkDockerOptions } from "./network-effect-scope";
import { comparableWorkspacePath, sameWorkspacePath } from "./workspace";
import { listWorkspaceOwnership } from "./workspace-ownership";

// A fixed published binding is machine-global kernel state that devrouter does
// not allocate, so admission resolves the exact model the start would bind and
// refuses on a live collision instead of letting the provider fail late with
// Docker's unattributed "port is already allocated". Detection only: consumer
// configuration is never rewritten to resolve a conflict.

const COMPOSE_RENDER_TIMEOUT_MS = 30_000;
const COMPOSE_RENDER_MAX_BUFFER = 8 * 1024 * 1024;
const DOCKER_TIMEOUT_MS = 10_000;
const DOCKER_MAX_BUFFER = 1024 * 1024;
const MAX_DESIRED_HOST_PORTS = 1024;
const MAX_RUNNING_HOLDERS = 512;

export type DesiredHostPortBinding = {
  service: string;
  /** Exact bound host IP, or null when the binding is a wildcard. */
  hostIp: string | null;
  hostPort: number;
  protocol: string;
};

export type HostPortClaimConflict = {
  service: string;
  hostIp: string | null;
  hostPort: number;
  protocol: string;
  holderContainer: string;
  holderComposeProject?: string;
  holderWorktreePath?: string;
  holderWorkspace?: string;
  holderBranch?: string;
  remediation: string;
};

export type HostPortClaimPlanInput = Pick<
  ManagedDevcontainerPlan,
  "composeFiles" | "composeDirectory"
>;

type HolderSnapshot = {
  id: string;
  name: string;
  composeProject?: string;
  workingDir?: string;
  ports: { hostIp: string | null; hostPort: number; protocol: string }[];
};

type HolderAttribution = Pick<
  HostPortClaimConflict,
  "holderComposeProject" | "holderWorktreePath" | "holderWorkspace" | "holderBranch"
>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalLabel(labels: unknown, key: string): string | undefined {
  const value = isRecord(labels) ? labels[key] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeHostIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // An empty HostIp from Docker and the compose wildcard hosts both mean
  // "all interfaces", which collides with every specific binding.
  if (trimmed.length === 0 || trimmed === "0.0.0.0" || trimmed === "::") return null;
  return trimmed;
}

function parseSinglePortValue(value: unknown, service: string, label: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
      throw new Error(`Service '${service}' has an out-of-range ${label} port.`);
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
      throw new Error(`Service '${service}' has an out-of-range ${label} port '${value}'.`);
    }
    return parsed;
  }
  throw new Error(`Service '${service}' has an unsupported ${label} port value.`);
}

/** Returns the fixed host port, or null when the binding is ephemeral. */
function parseFixedPublishedPort(value: unknown, service: string): number | null {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") {
    return null;
  }
  if (typeof value === "string" && value.includes("-")) {
    return null; // Ranges are expanded by the caller.
  }
  return parseSinglePortValue(value, service, "published host");
}

function parsePublishedRange(value: string, service: string): [number, number] | undefined {
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const lower = Number(match[1]);
  const upper = Number(match[2]);
  if (
    !Number.isInteger(lower) ||
    !Number.isInteger(upper) ||
    lower <= 0 ||
    upper < lower ||
    upper > 65_535
  ) {
    throw new Error(`Service '${service}' publishes an invalid host port range '${value}'.`);
  }
  return [lower, upper];
}

export function resolveFixedPublishedHostPorts(renderedConfig: unknown): DesiredHostPortBinding[] {
  const services = isRecord(renderedConfig) ? renderedConfig.services : undefined;
  const bindings: DesiredHostPortBinding[] = [];
  const pushBinding = (binding: DesiredHostPortBinding) => {
    bindings.push(binding);
    if (bindings.length > MAX_DESIRED_HOST_PORTS) {
      throw new Error(
        `The managed Compose model declares more than ${MAX_DESIRED_HOST_PORTS} fixed host ports.`,
      );
    }
  };
  for (const [service, serviceValue] of Object.entries(isRecord(services) ? services : {})) {
    const serviceRecord = isRecord(serviceValue) ? serviceValue : {};
    if (!Array.isArray(serviceRecord.ports)) continue;
    for (const port of serviceRecord.ports) {
      if (!isRecord(port)) {
        throw new Error(`Service '${service}' declares an unsupported port entry.`);
      }
      // Target validation stays even though only the published side is
      // matched: an out-of-range target cannot bind, so refusing stays loud.
      parseSinglePortValue(port.target, service, "container target");
      const hostIp = normalizeHostIp(port.host_ip);
      const protocol = typeof port.protocol === "string" && port.protocol ? port.protocol : "tcp";
      if (typeof port.published !== "string" || !port.published.includes("-")) {
        const hostPort = parseFixedPublishedPort(port.published, service);
        if (hostPort === null) continue;
        pushBinding({ service, hostIp, hostPort, protocol });
        continue;
      }
      const range = parsePublishedRange(port.published, service);
      if (!range) {
        throw new Error(
          `Service '${service}' publishes an unsupported host port value '${String(port.published)}'.`,
        );
      }
      for (let hostPort = range[0]; hostPort <= range[1]; hostPort += 1) {
        pushBinding({ service, hostIp, hostPort, protocol });
      }
    }
  }
  return bindings;
}

export function hostPortBindingsConflict(
  desired: { hostIp: string | null; hostPort: number; protocol: string },
  holder: { hostIp: string | null; hostPort: number; protocol: string },
): boolean {
  return (
    desired.hostPort === holder.hostPort &&
    desired.protocol === holder.protocol &&
    // Wildcards collide with everything in their protocol family; specific
    // addresses only collide with themselves. IPv6 nuance intentionally
    // over-approximates: a loud refusal beats a missed kernel collision.
    (desired.hostIp === null || holder.hostIp === null || desired.hostIp === holder.hostIp)
  );
}

const HOST_PORT_INSPECT_TEMPLATE =
  '{"id":{{json .Id}},"name":{{json .Name}},"labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.project.working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}},"ports":{{json .NetworkSettings.Ports}}}';

function runDocker(args: string[]): string {
  const result = spawnSync("docker", args, {
    ...networkDockerOptions(),
    encoding: "utf-8",
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: DOCKER_MAX_BUFFER,
  });
  if (result.error || result.status !== 0) {
    const reason = (result.stderr || result.stdout || result.error?.message || "unknown error")
      .toString()
      .trim();
    throw new Error(`docker ${String(args[0])} failed: ${reason}`);
  }
  if (typeof result.stdout !== "string") {
    throw new Error(`docker ${String(args[0])} returned invalid output.`);
  }
  return result.stdout;
}

function parseHolderPortMap(value: unknown): HolderSnapshot["ports"] {
  const ports: HolderSnapshot["ports"] = [];
  for (const [key, entries] of Object.entries(isRecord(value) ? value : {})) {
    const separator = key.lastIndexOf("/");
    // Only the bound host side feeds matching; the key's container port is
    // irrelevant and is not validated beyond the key shape.
    if (separator <= 0) continue;
    const protocol = key.slice(separator + 1);
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry) || entry.HostPort === undefined || entry.HostPort === null) continue;
      const bound = Number(entry.HostPort);
      if (!Number.isInteger(bound) || bound <= 0) continue;
      ports.push({ hostIp: normalizeHostIp(entry.HostIp), hostPort: bound, protocol });
    }
  }
  return ports;
}

function parseHolderSnapshots(stdout: string): HolderSnapshot[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new Error("Host-port holder inspection returned malformed JSON.");
      }
      if (!isRecord(parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) {
        throw new Error("Host-port holder inspection returned an invalid container record.");
      }
      const name = typeof parsed.name === "string" ? parsed.name.replace(/^\//, "") : parsed.id;
      return {
        id: parsed.id,
        name,
        composeProject: optionalLabel(parsed.labels, "com.docker.compose.project"),
        workingDir: optionalLabel(parsed.labels, "com.docker.compose.project.working_dir"),
        ports: parseHolderPortMap(parsed.ports),
      };
    });
}

function listHolderSnapshots(): HolderSnapshot[] {
  const listed = runDocker(["ps", "--filter", "status=running", "--format", "{{.ID}}"]);
  const ids = listed
    .split(/\r?\n/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return [];
  if (ids.length > MAX_RUNNING_HOLDERS) {
    throw new Error(
      `Host-port holder inspection found ${ids.length} running containers, above its bound.`,
    );
  }
  const inspected = runDocker(["inspect", "--format", HOST_PORT_INSPECT_TEMPLATE, ...ids]);
  return parseHolderSnapshots(inspected);
}

// The rendered model resolves env-file values, so it is parsed for port
// bindings and never persisted, logged, or embedded in errors.
function renderManagedComposeModel(
  plan: HostPortClaimPlanInput,
  workspace?: {
    token: string;
    gitCommonDir: string;
  },
): unknown {
  const fileArgs = plan.composeFiles.flatMap((file) => ["-f", file]);
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--profile",
      "*",
      "--project-directory",
      plan.composeDirectory,
      ...fileArgs,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: plan.composeDirectory,
      encoding: "utf-8",
      env: managedComposeEnvironment(workspace),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COMPOSE_RENDER_TIMEOUT_MS,
      maxBuffer: COMPOSE_RENDER_MAX_BUFFER,
    },
  );
  if (result.status !== 0 || result.error || !result.stdout?.trim()) {
    const reason = (result.stderr || result.error?.message || "unknown error")
      .toString()
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join("; ");
    throw new Error(
      `Host-port claims could not render the managed Compose model that the start would bind: ${reason}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Host-port claims received a malformed rendered Compose model.");
  }
}

function attributeHolderWorktree(workingDir: string): string | undefined {
  if (path.basename(workingDir) !== ".devcontainer") return undefined;
  return comparableWorkspacePath(path.dirname(workingDir));
}

function holderAttribution(holder: HolderSnapshot, repoPath: string): HolderAttribution {
  const attribution: HolderAttribution = {};
  if (holder.composeProject) attribution.holderComposeProject = holder.composeProject;
  const worktree = holder.workingDir ? attributeHolderWorktree(holder.workingDir) : undefined;
  if (!worktree) return attribution;
  attribution.holderWorktreePath = worktree;
  try {
    const owner = listWorkspaceOwnership(repoPath).find(
      (record) => comparableWorkspacePath(record.worktreePath) === worktree,
    );
    if (owner) {
      attribution.holderWorkspace = owner.workspace;
      if (owner.branch) attribution.holderBranch = owner.branch;
    }
  } catch {
    // Attribution is advisory; the conflict and its container stand regardless.
  }
  return attribution;
}

function remediationFor(holder: HolderSnapshot, attribution: HolderAttribution): string {
  if (attribution.holderWorktreePath) {
    return `Stop the holding workspace with 'devrouter stop ${attribution.holderWorktreePath}', or override the consumer's published host binding through its own configuration, then run ensure again.`;
  }
  return `Stop or reconfigure the holding container '${holder.name}' and run ensure again; devrouter never rewrites consumer-declared host bindings.`;
}

export function detectHostPortClaimConflicts(options: {
  repoPath: string;
  plan: HostPortClaimPlanInput;
  workspace?: { token: string; gitCommonDir: string };
}): HostPortClaimConflict[] {
  const desired = resolveFixedPublishedHostPorts(
    renderManagedComposeModel(options.plan, options.workspace),
  );
  if (desired.length === 0) return [];

  const holders = listHolderSnapshots();
  const devcontainerDir = path.join(options.repoPath, ".devcontainer");
  const conflicts: HostPortClaimConflict[] = [];
  for (const binding of desired) {
    for (const holder of holders) {
      for (const holderPort of holder.ports) {
        if (!hostPortBindingsConflict(binding, holderPort)) continue;
        // A holder without a working_dir label cannot be proven to be this
        // target's own container, so the conflict stands (fail-closed).
        if (holder.workingDir && sameWorkspacePath(holder.workingDir, devcontainerDir)) continue;
        const attribution = holderAttribution(holder, options.repoPath);
        conflicts.push({
          service: binding.service,
          hostIp: binding.hostIp,
          hostPort: binding.hostPort,
          protocol: binding.protocol,
          holderContainer: holder.name,
          ...attribution,
          remediation: remediationFor(holder, attribution),
        });
      }
    }
  }
  return conflicts;
}
