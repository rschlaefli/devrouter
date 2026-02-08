export type Route = {
  id: string;
  source: "docker" | "host";
  protocol: "http" | "tcp/postgres";
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
    postgres5432: boolean;
    dashboard8080: boolean;
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
  project?: {
    name?: string;
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

type DevrouterAppBase = {
  name: string;
  host: string;
  dependencies: DevrouterAppDependency[];
};

export type DevrouterHostHttpApp = DevrouterAppBase & {
  protocol: "http";
  runtime: "host";
  hostRun: DevrouterHostRunConfig;
};

export type DevrouterDockerHttpApp = DevrouterAppBase & {
  protocol: "http";
  runtime: "docker";
  docker: DevrouterDockerConfig;
};

export type DevrouterDockerPostgresApp = DevrouterAppBase & {
  protocol: "tcp";
  tcpProtocol: "postgres";
  runtime: "docker";
  docker: DevrouterDockerConfig;
};

export type DevrouterApp = DevrouterHostHttpApp | DevrouterDockerHttpApp | DevrouterDockerPostgresApp;

export type AppAddOptions = {
  name: string;
  host: string;
  protocol: "http" | "tcp";
  runtime: "host" | "docker";
  service?: string;
  port?: number;
  composeFiles: string[];
  router?: string;
  tcpProtocol?: "postgres";
  command?: string;
  cwd?: string;
  dependsOn: string[];
};
