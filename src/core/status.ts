import fs from "node:fs";
import {
  findContainerByName,
  getCurrentDockerContext,
  networkExists
} from "./docker";
import {
  DEVNET_NAME,
  ROUTER_CONTAINER_NAME,
  areTLSCertsPresent,
  getRouterFileLayout,
  isTLSConfigured,
  isTLSEnabled
} from "./router";
import { getRepoConfigPath, loadRepoConfig, resolveRepoPath } from "./repo-config";
import { RepoStatus, RouterStatus } from "../types";

function hasPortBinding(
  ports: Array<{ PrivatePort?: number; PublicPort?: number }> | undefined,
  privatePort: number,
  publicPort: number
): boolean {
  if (!ports) {
    return false;
  }

  return ports.some((port) => port.PrivatePort === privatePort && port.PublicPort === publicPort);
}

function toRepoStatus(repoPath?: string): RepoStatus | undefined {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  const explicitRepo = typeof repoPath === "string" && repoPath.trim().length > 0;
  const configExists = fs.existsSync(configPath);

  if (!explicitRepo && !configExists) {
    return undefined;
  }

  if (!configExists) {
    return {
      path: resolvedRepoPath,
      configPath,
      exists: false,
      valid: false,
      appCount: 0,
      tcpAppCount: 0,
      error: `Missing .devrouter.yml in ${resolvedRepoPath}`
    };
  }

  try {
    const config = loadRepoConfig(resolvedRepoPath);
    const tcpAppCount = config.apps.filter((app) => app.protocol === "tcp").length;
    return {
      path: resolvedRepoPath,
      configPath,
      exists: true,
      valid: true,
      appCount: config.apps.length,
      tcpAppCount
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: resolvedRepoPath,
      configPath,
      exists: true,
      valid: false,
      appCount: 0,
      tcpAppCount: 0,
      error: message
    };
  }
}

export async function collectRouterStatus(repoPath?: string): Promise<RouterStatus> {
  const repo = toRepoStatus(repoPath);
  const tlsEnabled = isTLSEnabled();
  let container: Awaited<ReturnType<typeof findContainerByName>> | undefined;
  let networkIsPresent = false;
  let dockerContext = "unknown";
  let dockerUnavailableMessage: string | undefined;

  try {
    dockerContext = getCurrentDockerContext();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dockerContext = `unavailable (${message})`;
    dockerUnavailableMessage = message;
  }

  try {
    container = await findContainerByName(ROUTER_CONTAINER_NAME);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dockerUnavailableMessage = dockerUnavailableMessage ?? message;
  }

  try {
    networkIsPresent = await networkExists(DEVNET_NAME);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dockerUnavailableMessage = dockerUnavailableMessage ?? message;
  }

  const boundPorts = {
    web80: hasPortBinding(container?.Ports, 80, 80),
    web443: hasPortBinding(container?.Ports, 443, 443),
    postgres5432: hasPortBinding(container?.Ports, 5432, 5432),
    dashboard8080: hasPortBinding(container?.Ports, 8080, 8080)
  };

  const nextSteps: string[] = [];
  const httpRoutingReady = container?.State === "running" && boundPorts.web80;
  const tcpRoutingReady = container?.State === "running" && boundPorts.postgres5432 && tlsEnabled;

  if (!container || container.State !== "running") {
    nextSteps.push("Run: dev up");
  }

  if (dockerUnavailableMessage) {
    nextSteps.push("Ensure Docker is running and reachable from the active Docker context");
  }

  if (!tlsEnabled) {
    nextSteps.push("Run: dev tls install (required for tcp/postgres, recommended for http)");
  }

  if (repo && !repo.exists) {
    nextSteps.push(`Run: dev repo init --repo ${repo.path}`);
  } else if (repo && !repo.valid) {
    nextSteps.push("Fix .devrouter.yml validation errors and re-run `dev doctor --repo <path>`");
  } else if (repo && repo.valid && repo.appCount === 0) {
    nextSteps.push(`Run: dev app add --name <name> --host <name>.localhost --protocol http --runtime host --repo ${repo.path}`);
  } else if (repo && repo.valid) {
    nextSteps.push(`Run: dev app ls --repo ${repo.path}`);
    nextSteps.push("Run: dev app run <name> --repo <path> --yes");
    nextSteps.push("Run: dev ls");
  }

  const files = getRouterFileLayout();
  if (files.missing.length > 0) {
    nextSteps.push("Run: dev up to re-create missing global router files");
  }

  return {
    dockerContext,
    routerRunning: container?.State === "running",
    routerContainerName: ROUTER_CONTAINER_NAME,
    boundPorts,
    tlsConfigured: isTLSConfigured(),
    certPresent: areTLSCertsPresent(),
    tlsEnabled,
    networkExists: networkIsPresent,
    repo,
    insights: {
      httpRoutingReady,
      tcpRoutingReady,
      nextSteps: Array.from(new Set(nextSteps))
    }
  };
}
