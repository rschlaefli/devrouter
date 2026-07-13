import { listContainers } from "../core/docker";
import { listHostRoutes } from "../core/host-routes";
import { printJSON, printRoutes } from "../core/output";
import { DEVNET_NAME, isTLSEnabled } from "../core/router";
import { discoverRoutes, findDuplicateHosts } from "../core/routes";

export async function runLsCommand(json: boolean): Promise<void> {
  const containers = await listContainers(true);
  const tlsEnabled = isTLSEnabled();
  const docker = discoverRoutes(containers, tlsEnabled, DEVNET_NAME);
  const host = listHostRoutes(tlsEnabled);
  const routes = [...docker.routes, ...host];
  const duplicateHosts = findDuplicateHosts(routes);
  const result = { routes, duplicateHosts };

  if (json) {
    printJSON(result);
    return;
  }

  printRoutes(result.routes, result.duplicateHosts);
}
