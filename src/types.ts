export type Route = {
  id: string;
  source: "docker" | "host";
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
  };
  tlsEnabled: boolean;
  certPresent: boolean;
  tlsConfigured: boolean;
  networkExists: boolean;
};

export type AddOptions = {
  service: string;
  port: number;
  host?: string;
  router?: string;
  file?: string;
  force?: boolean;
};

export type AddResult = {
  filePath: string;
  host: string;
  router: string;
};

export type PortListener = {
  port: number;
  command: string;
  pid: string;
  user: string;
  address: string;
};

export type HostRouteStrategy = {
  type: "auto";
  denyPorts: number[];
  allowPortRange: string;
};

export type HostRouteDefinition = {
  name: string;
  host: string;
  mode: "host";
  command: string;
  cwd: string;
  strategy: HostRouteStrategy;
};

export type HostConfig = {
  version: 1;
  routes: HostRouteDefinition[];
};

export type HostRouteState = {
  id: string;
  name: string;
  host: string;
  repoPath: string;
  port: number;
  mode: "run" | "attach";
  pid?: number;
  command?: string;
  createdAt: string;
  updatedAt: string;
};
