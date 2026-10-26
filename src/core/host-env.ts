import { spawnSync } from "node:child_process";
import path from "node:path";
import type { DevrouterConfig, DevrouterRoutedApp } from "../types";
import { inspectManagedDevcontainerConfig } from "./devcontainer-profile";
import { inspectWorkspaceContainers, type WorkspaceContainerSnapshot } from "./devpod-environment";
import { listContainers } from "./docker";
import { listHostRoutes, parseUpstream } from "./host-routes";
import {
  type ManagedHostPortDeclaration,
  type ManagedHostPorts,
  managedHostPortDeclarationsIdentity,
  resolveManagedHostPorts,
} from "./managed-host-ports";
import { readManagedRuntimeState } from "./managed-runtime-state";
import { findOwnedNetworkClaim } from "./network-claim-lookup";
import { prepareNetworkComposeFiles } from "./network-compose-files";
import { networkDockerOptions } from "./network-effect-scope";
import { applyWorkspace, loadRepoConfig } from "./repo-config";
import { DEVNET_NAME, isTLSEnabled, TCP_PROTOCOL_REGISTRY } from "./router";
import { discoverRoutes } from "./routes";
import { getMkcertRootCAPath } from "./tls";
import { resolveWorkspace, sameWorkspacePath } from "./workspace";

export type HostEnvEndpoint = { host: string; port: number };

export type LoopbackUnavailableReason =
  | "not-published"
  | "ambiguous"
  | "not-running"
  | "not-found"
  | "unsupported-runtime"
  | "unavailable";

export type HostEnvApp =
  | { name: string; protocol: "http"; host: string; active: boolean; url: string }
  | {
      name: string;
      protocol: "tcp";
      tcpProtocol: string;
      host: string;
      active: boolean;
      routed: HostEnvEndpoint & { params: Record<string, string> };
      loopback: HostEnvEndpoint | null;
      loopbackReason?: LoopbackUnavailableReason;
    };

export type HostEnvReport = {
  version: 1;
  repoPath: string;
  workspace: string | null;
  tls: boolean;
  caPath: string | null;
  caReason?: string;
  apps: HostEnvApp[];
  hostPorts?: ManagedHostPorts;
};

/** Live evidence the report is assembled from; `undefined` means unavailable. */
export type HostEnvEvidence = {
  tlsEnabled: boolean;
  activeHosts: Set<string>;
  caPath: string | { error: string };
  containers: WorkspaceContainerSnapshot[] | undefined;
  publishedBindings: (containerId: string, port: number) => string | undefined;
  hostPorts?: ManagedHostPorts;
};

const LOOPBACK_UPSTREAM_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

// Postgres multiplexing on the shared port requires TLS from the first byte,
// which libpq 17+ calls direct SSL negotiation.
const ROUTED_TCP_PARAMS: Record<string, Record<string, string>> = {
  postgres: { sslmode: "require", sslnegotiation: "direct" },
};

function declarationsFor(
  config: DevrouterConfig,
): Record<string, ManagedHostPortDeclaration> | undefined {
  const declarations = config.managedRuntime?.devcontainer.hostPorts;
  return declarations && Object.keys(declarations).length > 0 ? declarations : undefined;
}

function unavailableHostPorts(
  declarations: Record<string, ManagedHostPortDeclaration>,
): ManagedHostPorts {
  return Object.fromEntries(
    Object.entries(declarations).map(([name, declaration]) => [
      name,
      { ...declaration, status: "unavailable" as const, reason: "unavailable" as const },
    ]),
  );
}

/**
 * Pick the loopback endpoint from `docker port` output. Only loopback bindings
 * count, so a host tool never reaches a port the checkout did not publish to
 * this machine alone.
 */
export function parseLoopbackBinding(output: string): HostEnvEndpoint | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(127\.0\.0\.1|\[::1\]):(\d+)$/);
    if (match) {
      return { host: match[1] === "[::1]" ? "::1" : "127.0.0.1", port: Number(match[2]) };
    }
  }
  return undefined;
}

function resolveLoopback(
  app: DevrouterRoutedApp,
  repoPath: string,
  evidence: HostEnvEvidence,
): { loopback: HostEnvEndpoint | null; loopbackReason?: LoopbackUnavailableReason } {
  if (app.runtime !== "proxy") {
    return { loopback: null, loopbackReason: "unsupported-runtime" };
  }
  const upstream = parseUpstream(app.upstream);
  if (LOOPBACK_UPSTREAM_HOSTS.has(upstream.host)) {
    return { loopback: { host: "127.0.0.1", port: upstream.port } };
  }
  if (!evidence.containers) {
    return { loopback: null, loopbackReason: "unavailable" };
  }

  const devcontainerDir = path.join(repoPath, ".devcontainer");
  const owners = evidence.containers.filter(
    (container) =>
      sameWorkspacePath(
        container.labels["com.docker.compose.project.working_dir"] ?? "",
        devcontainerDir,
      ) && (container.networks[DEVNET_NAME]?.Aliases ?? []).includes(upstream.host),
  );
  if (owners.length === 0) return { loopback: null, loopbackReason: "not-found" };
  if (owners.length > 1) return { loopback: null, loopbackReason: "ambiguous" };
  const [owner] = owners;
  if (!owner.state.Running) return { loopback: null, loopbackReason: "not-running" };

  const bindings = evidence.publishedBindings(owner.id, upstream.port);
  if (bindings === undefined) return { loopback: null, loopbackReason: "unavailable" };
  const endpoint = parseLoopbackBinding(bindings);
  return endpoint ? { loopback: endpoint } : { loopback: null, loopbackReason: "not-published" };
}

export function buildHostEnvReport(input: {
  repoPath: string;
  config: DevrouterConfig;
  workspace: string | undefined;
  evidence: HostEnvEvidence;
}): HostEnvReport {
  const { repoPath, config, workspace, evidence } = input;
  const apps: HostEnvApp[] = [];

  for (const app of config.apps) {
    if (!("host" in app)) continue;
    const active = evidence.activeHosts.has(app.host);
    if (app.protocol === "http") {
      const scheme = evidence.tlsEnabled ? "https" : "http";
      apps.push({
        name: app.name,
        protocol: "http",
        host: app.host,
        active,
        url: `${scheme}://${app.host}`,
      });
      continue;
    }
    apps.push({
      name: app.name,
      protocol: "tcp",
      tcpProtocol: app.tcpProtocol,
      host: app.host,
      active,
      routed: {
        host: app.host,
        port: TCP_PROTOCOL_REGISTRY[app.tcpProtocol]?.port ?? 0,
        params: { ...(ROUTED_TCP_PARAMS[app.tcpProtocol] ?? {}) },
      },
      ...resolveLoopback(app, repoPath, evidence),
    });
  }

  const ca = evidence.caPath;
  const declarations = declarationsFor(config);
  return {
    version: 1,
    repoPath,
    workspace: workspace ?? null,
    tls: evidence.tlsEnabled,
    ...(typeof ca === "string" ? { caPath: ca } : { caPath: null, caReason: ca.error }),
    apps,
    ...(declarations
      ? { hostPorts: evidence.hostPorts ?? unavailableHostPorts(declarations) }
      : {}),
  };
}

function listDevcontainerContainers(repoPath: string): WorkspaceContainerSnapshot[] | undefined {
  const listed = spawnSync(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project.working_dir=${path.join(repoPath, ".devcontainer")}`,
      "--format",
      "{{.ID}}",
    ],
    { encoding: "utf-8", ...networkDockerOptions() },
  );
  if (listed.status !== 0) return undefined;
  const ids = listed.stdout
    .split(/\r?\n/)
    .map((id) => id.trim())
    .filter(Boolean);
  try {
    return inspectWorkspaceContainers({ ids });
  } catch {
    return undefined;
  }
}

function dockerPortBindings(containerId: string, port: number): string | undefined {
  const result = spawnSync("docker", ["port", containerId, `${port}/tcp`], {
    encoding: "utf-8",
    ...networkDockerOptions(),
  });
  // `docker port` exits non-zero when the port has no published binding.
  if (result.status !== 0) return result.error ? undefined : "";
  return result.stdout;
}

async function collectActiveHosts(tlsEnabled: boolean): Promise<Set<string>> {
  const hosts = new Set<string>();
  for (const route of listHostRoutes(tlsEnabled)) {
    for (const host of route.hosts) hosts.add(host);
  }
  try {
    const { routes } = discoverRoutes(await listContainers(true), tlsEnabled, DEVNET_NAME);
    for (const route of routes) {
      for (const host of route.hosts) hosts.add(host);
    }
  } catch {
    // Docker-labelled routes are unavailable without a daemon; host routes still count.
  }
  return hosts;
}

function collectManagedHostPorts(
  repoPath: string,
  config: DevrouterConfig,
  workspace: string | undefined,
): ManagedHostPorts | undefined {
  const declarations = declarationsFor(config);
  if (!declarations) return undefined;
  const unavailable = () => unavailableHostPorts(declarations);

  try {
    const state = readManagedRuntimeState(repoPath, workspace);
    if (
      !state ||
      state.hostPortDeclarationsSha256 !== managedHostPortDeclarationsIdentity(declarations)
    )
      return unavailable();
    let plan = inspectManagedDevcontainerConfig({
      repoPath,
      config,
      profile: {
        apps: [...state.desired.apps],
        devcontainerServices: [...state.desired.services],
        processes: [...state.desired.processes],
      },
      linked: workspace !== undefined,
    });
    const network = findOwnedNetworkClaim(repoPath);
    if (network) {
      if (network.state !== "attached") return unavailable();
      plan = prepareNetworkComposeFiles(plan, network.subnet).plan;
    }
    if (
      plan.sourceConfigSha256 !== state.sourceConfigSha256 ||
      plan.effectiveConfigSha256 !== state.effectiveConfigSha256
    ) {
      return unavailable();
    }
    return resolveManagedHostPorts({
      repoPath,
      declarations,
      selectedServices: [...new Set([...plan.baseServices, ...state.desired.services])],
      composeProject: state.composeProject,
      composeFiles: plan.composeFiles,
    });
  } catch {
    return unavailable();
  }
}

/** Read-only: never starts, stops, or reconciles a runtime. */
export async function collectHostEnvReport(repoPath: string): Promise<HostEnvReport> {
  const workspace = resolveWorkspace(repoPath);
  const config = applyWorkspace(loadRepoConfig(repoPath), workspace, repoPath);
  const tlsEnabled = isTLSEnabled();
  let caPath: HostEnvEvidence["caPath"];
  try {
    caPath = getMkcertRootCAPath({ repoPath });
  } catch (error) {
    caPath = { error: error instanceof Error ? error.message : String(error) };
  }
  const needsContainers = config.apps.some(
    (app) => "host" in app && app.protocol === "tcp" && app.runtime === "proxy",
  );

  return buildHostEnvReport({
    repoPath,
    config,
    workspace,
    evidence: {
      tlsEnabled,
      activeHosts: await collectActiveHosts(tlsEnabled),
      caPath,
      containers: needsContainers ? listDevcontainerContainers(repoPath) : [],
      publishedBindings: dockerPortBindings,
      hostPorts: collectManagedHostPorts(repoPath, config, workspace),
    },
  });
}

function variablePrefix(appName: string): string {
  return `DEVROUTER_${appName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Variables `devrouter env -- <command>` adds to the child environment. The
 * `DEVROUTER_` namespace never shadows a consumer variable, and the CA path is
 * only offered when the caller has not chosen one.
 */
export function hostEnvVariables(
  report: HostEnvReport,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const variables: Record<string, string> = {};
  if (report.workspace) variables.DEVROUTER_WORKSPACE = report.workspace;
  if (report.caPath && processEnv.NODE_EXTRA_CA_CERTS === undefined) {
    variables.NODE_EXTRA_CA_CERTS = report.caPath;
  }
  for (const app of report.apps) {
    const prefix = variablePrefix(app.name);
    if (app.protocol === "http") {
      variables[`${prefix}_URL`] = app.url;
      continue;
    }
    variables[`${prefix}_ROUTED_HOST`] = app.routed.host;
    variables[`${prefix}_ROUTED_PORT`] = String(app.routed.port);
    if (app.loopback) {
      variables[`${prefix}_HOST`] = app.loopback.host;
      variables[`${prefix}_PORT`] = String(app.loopback.port);
    }
  }
  for (const [name, port] of Object.entries(report.hostPorts ?? {})) {
    if (port.status !== "available" || !port.endpoint) continue;
    variables[`DEVROUTER_HOST_PORT_${name.toUpperCase().replaceAll("-", "_")}`] = String(
      port.endpoint.port,
    );
  }
  return variables;
}
