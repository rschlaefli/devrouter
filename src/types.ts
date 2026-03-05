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
  protocol?: "http";
  repoPath: string;
  port: number;
  mode: "run" | "attach";
  pid?: number;
  command?: string;
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
  };
  apps: DevrouterApp[];
};

export type DevrouterAppDependency = {
  app: string;
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

export type DevrouterDockerDependencyApp = {
  kind: "dependency";
  name: string;
  runtime: "docker";
  dependencies: DevrouterAppDependency[];
  docker: DevrouterDockerDependencyConfig;
};

export type DevrouterRoutedApp = DevrouterHostHttpApp | DevrouterDockerHttpApp | DevrouterDockerTcpApp;
export type DevrouterDockerRoutedApp = DevrouterDockerHttpApp | DevrouterDockerTcpApp;
export type DevrouterApp = DevrouterRoutedApp | DevrouterDockerDependencyApp;

export type AppAddOptions = {
  name: string;
  kind?: "app" | "dependency";
  host?: string;
  protocol?: "http" | "tcp";
  runtime?: "host" | "docker";
  service?: string;
  port?: number;
  composeFiles: string[];
  router?: string;
  tcpProtocol?: string;
  command?: string;
  cwd?: string;
  dependsOn: string[];
};
