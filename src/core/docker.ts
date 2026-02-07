import { spawnSync } from "node:child_process";
import type { ContainerInfo } from "dockerode";

type DockerClient = {
  listContainers(options: { all: boolean }): Promise<ContainerInfo[]>;
  getNetwork(name: string): { inspect(): Promise<unknown> };
  createNetwork(options: { Name: string; Driver: string; Attachable: boolean }): Promise<unknown>;
};

type DockerodeConstructor = new (options: {
  socketPath?: string;
  host?: string;
  port?: number;
  protocol?: "http" | "https";
}) => DockerClient;

let dockerodeConstructorPromise: Promise<DockerodeConstructor> | null = null;

async function getDockerodeConstructor(): Promise<DockerodeConstructor> {
  if (!dockerodeConstructorPromise) {
    dockerodeConstructorPromise = import("dockerode").then((module) => {
      const maybeDefault = module as unknown as { default?: DockerodeConstructor };
      return maybeDefault.default ?? (module as unknown as DockerodeConstructor);
    });
  }

  return dockerodeConstructorPromise;
}

function runDockerContextCommand(args: string[]): string {
  const result = spawnSync("docker", ["context", ...args], {
    encoding: "utf-8"
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`docker context command failed: ${details || "unknown error"}`);
  }

  return result.stdout.trim();
}

export function getCurrentDockerContext(): string {
  return runDockerContextCommand(["show"]);
}

function getDockerHostFromContext(context: string): string {
  const result = spawnSync(
    "docker",
    ["context", "inspect", context, "--format", "{{ .Endpoints.docker.Host }}"],
    { encoding: "utf-8" }
  );

  if (result.status === 0) {
    const value = result.stdout.trim();
    if (value && value !== "<no value>") {
      return value;
    }
  }

  if (process.env.DOCKER_HOST) {
    return process.env.DOCKER_HOST;
  }

  return "unix:///var/run/docker.sock";
}

async function createDockerClient(): Promise<DockerClient> {
  const DockerodeClass = await getDockerodeConstructor();
  const context = getCurrentDockerContext();
  const host = getDockerHostFromContext(context);

  if (host.startsWith("unix://")) {
    return new DockerodeClass({ socketPath: host.replace("unix://", "") });
  }

  if (host.startsWith("tcp://") || host.startsWith("http://") || host.startsWith("https://")) {
    const normalized = host.startsWith("tcp://") ? host.replace("tcp://", "http://") : host;
    const url = new URL(normalized);
    return new DockerodeClass({
      host: url.hostname,
      port: Number(url.port || 2375),
      protocol: url.protocol.replace(":", "") as "http" | "https"
    });
  }

  throw new Error(`Unsupported docker host from context: ${host}`);
}

export async function listContainers(all = true): Promise<ContainerInfo[]> {
  const docker = await createDockerClient();
  return docker.listContainers({ all });
}

export async function findContainerByName(name: string): Promise<ContainerInfo | undefined> {
  const containers = await listContainers(true);
  return containers.find((container) => container.Names?.some((n) => n === `/${name}`));
}

export async function isContainerRunning(name: string): Promise<boolean> {
  const container = await findContainerByName(name);
  return container?.State === "running";
}

export async function ensureNetwork(name: string): Promise<void> {
  const docker = await createDockerClient();

  try {
    await docker.getNetwork(name).inspect();
    return;
  } catch {
    // Network not found, create below.
  }

  await docker.createNetwork({
    Name: name,
    Driver: "bridge",
    Attachable: true
  });
}

export async function networkExists(name: string): Promise<boolean> {
  const docker = await createDockerClient();
  try {
    await docker.getNetwork(name).inspect();
    return true;
  } catch {
    return false;
  }
}
