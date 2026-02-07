import { spawnSync } from "node:child_process";
import { listContainers } from "../core/docker";
import { listHostRoutes } from "../core/host-routes";
import { discoverRoutes, resolveRouteByName } from "../core/routes";
import { DEVNET_NAME, isTLSEnabled } from "../core/router";

export async function runOpenCommand(name: string): Promise<void> {
  const containers = await listContainers(true);
  const tlsEnabled = isTLSEnabled();
  const { routes: dockerRoutes } = discoverRoutes(containers, tlsEnabled, DEVNET_NAME);
  const hostRoutes = listHostRoutes(tlsEnabled);
  const route = resolveRouteByName([...dockerRoutes, ...hostRoutes], name);

  const url = route.urls[0];
  if (!url) {
    throw new Error(`Route '${name}' has no URL.`);
  }

  const result = spawnSync("open", [url], { encoding: "utf-8" });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Unable to open '${url}': ${details || "unknown error"}`);
  }

  process.stdout.write(`Opened ${url}\n`);
}
