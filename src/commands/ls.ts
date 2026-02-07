import { listContainers } from "../core/docker";
import { printJSON, printRoutes } from "../core/output";
import { discoverRoutes } from "../core/routes";
import { DEVNET_NAME, isTLSEnabled } from "../core/router";

export async function runLsCommand(json: boolean): Promise<void> {
  const containers = await listContainers(true);
  const tlsEnabled = isTLSEnabled();
  const result = discoverRoutes(containers, tlsEnabled, DEVNET_NAME);

  if (json) {
    printJSON(result);
    return;
  }

  printRoutes(result.routes, result.duplicateHosts);
}
