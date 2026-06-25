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
  error?: string;
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
  apps: DevrouterApp[];
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
