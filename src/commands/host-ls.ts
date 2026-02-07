import { listHostRouteState } from "../core/host-routes";
import { printHostRouteState, printJSON } from "../core/output";

export async function runHostLsCommand(json: boolean): Promise<void> {
  const routes = listHostRouteState();

  if (json) {
    printJSON(routes);
    return;
  }

  printHostRouteState(routes);
}
