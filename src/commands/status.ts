import { findContainerByName, getCurrentDockerContext, networkExists } from "../core/docker";
import { printJSON, printStatus } from "../core/output";
import {
  DEVNET_NAME,
  ROUTER_CONTAINER_NAME,
  areTLSCertsPresent,
  isTLSConfigured,
  isTLSEnabled
} from "../core/router";
import { RouterStatus } from "../types";

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

export async function runStatusCommand(json: boolean): Promise<void> {
  const container = await findContainerByName(ROUTER_CONTAINER_NAME);
  const status: RouterStatus = {
    dockerContext: getCurrentDockerContext(),
    routerRunning: container?.State === "running",
    routerContainerName: ROUTER_CONTAINER_NAME,
    boundPorts: {
      web80: hasPortBinding(container?.Ports, 80, 80),
      web443: hasPortBinding(container?.Ports, 443, 443),
      dashboard8080: hasPortBinding(container?.Ports, 8080, 8080)
    },
    tlsConfigured: isTLSConfigured(),
    certPresent: areTLSCertsPresent(),
    tlsEnabled: isTLSEnabled(),
    networkExists: await networkExists(DEVNET_NAME)
  };

  if (json) {
    printJSON(status);
    return;
  }

  printStatus(status);
}
