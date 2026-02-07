import { spawnSync } from "node:child_process";
import Dockerode, { ContainerInfo } from "dockerode";

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

function createDockerClient(): Dockerode {
  const context = getCurrentDockerContext();
  const host = getDockerHostFromContext(context);

  if (host.startsWith("unix://")) {
    return new Dockerode({ socketPath: host.replace("unix://", "") });
  }

  if (host.startsWith("tcp://") || host.startsWith("http://") || host.startsWith("https://")) {
    const normalized = host.startsWith("tcp://") ? host.replace("tcp://", "http://") : host;
    const url = new URL(normalized);
    return new Dockerode({
      host: url.hostname,
      port: Number(url.port || 2375),
      protocol: url.protocol.replace(":", "") as "http" | "https"
    });
  }

  throw new Error(`Unsupported docker host from context: ${host}`);
}

export async function listContainers(all = true): Promise<ContainerInfo[]> {
  const docker = createDockerClient();
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
  const docker = createDockerClient();

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
  const docker = createDockerClient();
  try {
    await docker.getNetwork(name).inspect();
    return true;
  } catch {
    return false;
  }
}
