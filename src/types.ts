export type Route = {
  id: string;
  source: "docker" | "host";
  protocol: "http" | `tcp/${string}`;
  appName: string;
  containerId?: string;
  containerName?: string;
  serviceName: string;
  projectName: string;
  hosts: string[];
  urls: string[];
  status: string;
  health: string;
  createdAt: number;
};

export type RouterStatus = {
  dockerContext: string;
  routerRunning: boolean;
  routerContainerName: string;
  boundPorts: {
    web80: boolean;
    web443: boolean;
    dashboard8080: boolean;
    tcp: Record<string, boolean>;
  };
  tlsEnabled: boolean;
  certPresent: boolean;
  tlsConfigured: boolean;
  networkExists: boolean;
  repo?: RepoStatus;
  insights: RouterInsights;
};

export type RepoStatus = {
  path: string;
  configPath: string;
  exists: boolean;
  valid: boolean;
  appCount: number;
  tcpAppCount: number;
  managedRuntime?: ManagedRuntimeStatus;
  error?: string;
};

export type ManagedRuntimeResourceStatus =
  | "running"
  | "healthy"
  | "stopped"
  | "starting"
  | "unhealthy"
  | "missing"
  | "foreign"
  | "drifted";

export type ManagedRuntimeStatus = {
  mode: "legacy" | "managed";
  status: "legacy" | "ready" | "starting" | "stopped" | "drifted" | "failed-transition";
  profile: string;
  activeProfile?: string;
  workspace?: string;
  devpodId?: string;
  composeProject?: string;
  desired: {
    apps: string[];
    services: string[];
    processes: string[];
  };
  active: {
    apps: string[];
    services: string[];
    processes: string[];
  };
  serviceStatuses: Record<string, ManagedRuntimeResourceStatus>;
  processStatuses: Record<string, ManagedRuntimeResourceStatus>;
  drift: string[];
  sourceConfigSha256?: string;
  effectiveConfigSha256?: string;
  transitionPhase?: string;
};

export type RouterInsights = {
  httpRoutingReady: boolean;
  tcpRoutingReady: boolean;
  nextSteps: string[];
};

export type DiagnosticLevel = "ok" | "warn" | "error";

export type DiagnosticCheck = {
  id: string;
  level: DiagnosticLevel;
  summary: string;
  details?: string;
  suggestion?: string;
};

export type DoctorReport = {
  generatedAt: string;
  repoPath?: string;
  summary: {
    ok: number;
    warn: number;
    error: number;
  };
  checks: DiagnosticCheck[];
  nextSteps: string[];
};

export type SetupActionStatus = "performed" | "skipped" | "failed";

export type SetupAction = {
  id: string;
  status: SetupActionStatus;
  summary: string;
  details?: string;
  suggestion?: string;
};

export type SetupReport = {
  generatedAt: string;
  repoPath?: string;
  actions: SetupAction[];
  checks: DiagnosticCheck[];
  summary: {
    actions: Record<SetupActionStatus, number>;
    checks: DoctorReport["summary"];
  };
  nextSteps: string[];
};

export type PortListener = {
  port: number;
  command: string;
  pid: string;
  user: string;
  address: string;
};

export type HostRouteState = {
  id: string;
  name: string;
  host: string;
  protocol?: "http" | "tcp";
  // For protocol=tcp proxy routes: the TCP protocol key (postgres/redis/...) that
  // selects the shared Traefik entrypoint. Undefined for http routes.
  tcpProtocol?: string;
  repoPath: string;
  port: number;
  mode: "run" | "attach" | "proxy";
  // Backend host Traefik dials for this route. Defaults to host.docker.internal
  // (host-run apps). Proxy routes set it to the (loopback-rewritten) upstream host.
  upstreamHost?: string;
  pid?: number;
  command?: string;
  // Workspace token this route belongs to (undefined for the primary checkout).
  // Lets `dev workspace ls`/`down` and GC filter routes by workspace without
  // loading the (possibly-deleted) worktree's .devrouter.yml.
  workspace?: string;
  createdAt: string;
  updatedAt: string;
};

export type DevrouterConfig = {
  version: 1;
  devrouter?: {
    version?: string;
  };
  project?: {
    name?: string;
  };
  secretManager?: {
    command: string;
    defaultEnv?: string;
  };
  managedRuntime?: DevrouterManagedRuntime;
  profiles?: Record<string, DevrouterProfile>;
  apps: DevrouterApp[];
};

export type DevrouterManagedRuntime = {
  devcontainer: {
    // Services that remain active for every managed profile.
    baseServices: string[];
    // Complete registry of optional services that profile declarations may select.
    profileServices: string[];
  };
  // Complete registry of repository-managed process markers.
  processes: string[];
};

// Named subset of routed apps (+ optional dependency services), Dev Container
// services, and repository-managed process markers that `ensure --profile
// <name>` selects. A config without `profiles` behaves exactly as before
// (implicit full profile). The parser normalizes an omitted `apps` dimension to
// an empty array for route-free capability profiles.
export type DevrouterProfile = {
  // Routed app names, or ["*"] for every routed app.
  apps: string[];
  // kind=dependency services this profile needs. Omitted = all dependencies.
  dependencies?: string[];
  // Routed apps `ensure` HTTP-probes before declaring readiness. Omitted = all
  // profile apps with an http route.
  readiness?: string[];
  // Dev Container services from managedRuntime.devcontainer.profileServices,
  // or ["*"] for every registered profile service.
  devcontainerServices?: string[];
  // Process markers from managedRuntime.processes, or ["*"] for every marker.
  processes?: string[];
  default?: boolean;
};

export type DevrouterAppDependency = {
  app: string;
  envMap?: Record<string, string>;
};

export type DevrouterHostStrategy = {
  type: "auto";
  denyPorts: number[];
  allowPortRange: string;
};

export type DevrouterHostRunConfig = {
  command: string;
  cwd: string;
  strategy: DevrouterHostStrategy;
  portTimeout?: number;
};

export type DevrouterDockerConfig = {
  service: string;
  internalPort: number;
  composeFiles: string[];
  router?: string;
};

export type DevrouterDockerDependencyConfig = {
  service: string;
  composeFiles: string[];
};

type DevrouterAppBase = {
  name: string;
  dependencies: DevrouterAppDependency[];
  kind?: "app";
};

type DevrouterRoutedAppBase = DevrouterAppBase & {
  host: string;
};

export type DevrouterHostHttpApp = DevrouterRoutedAppBase & {
  protocol: "http";
  runtime: "host";
  hostRun: DevrouterHostRunConfig;
};

export type DevrouterDockerHttpApp = DevrouterRoutedAppBase & {
  protocol: "http";
  runtime: "docker";
  docker: DevrouterDockerConfig;
};

export type DevrouterDockerTcpApp = DevrouterRoutedAppBase & {
  protocol: "tcp";
  tcpProtocol: string;
  runtime: "docker";
  docker: DevrouterDockerConfig;
};

// Upstream-only HTTP route to an externally-managed port (e.g. a devcontainer's
// published app, or a container reachable on devnet by name). No lifecycle, env
// injection, hostRun, compose ownership, or dependencies — devrouter only
// registers the Traefik route.
export type DevrouterProxyHttpApp = DevrouterRoutedAppBase & {
  protocol: "http";
  runtime: "proxy";
  upstream: string;
};

// Upstream-only TCP route (e.g. a devcontainer's Postgres/Redis reachable on
// devnet by name). Traefik SNI-routes `HostSNI(host)` on the shared protocol
// entrypoint to the upstream. Requires TLS (SNI is read from the TLS
// ClientHello) — clients connect with TLS (e.g. Postgres sslmode=require).
export type DevrouterProxyTcpApp = DevrouterRoutedAppBase & {
  protocol: "tcp";
  tcpProtocol: string;
  runtime: "proxy";
  upstream: string;
};

export type DevrouterDockerDependencyApp = {
  kind: "dependency";
  name: string;
  runtime: "docker";
  dependencies: DevrouterAppDependency[];
  docker: DevrouterDockerDependencyConfig;
};

export type DevrouterProxyApp = DevrouterProxyHttpApp | DevrouterProxyTcpApp;
export type DevrouterRoutedApp =
  | DevrouterHostHttpApp
  | DevrouterDockerHttpApp
  | DevrouterDockerTcpApp
  | DevrouterProxyHttpApp
  | DevrouterProxyTcpApp;
export type DevrouterDockerRoutedApp = DevrouterDockerHttpApp | DevrouterDockerTcpApp;
export type DevrouterApp = DevrouterRoutedApp | DevrouterDockerDependencyApp;

export type AppAddOptions = {
  name: string;
  kind?: "app" | "dependency";
  host?: string;
  protocol?: "http" | "tcp";
  runtime?: "host" | "docker" | "proxy";
  service?: string;
  port?: number;
  upstream?: string;
  composeFiles: string[];
  router?: string;
  tcpProtocol?: string;
  command?: string;
  cwd?: string;
  dependsOn: string[];
};
