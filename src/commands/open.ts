import { spawnSync } from "node:child_process";
import { listContainers } from "../core/docker";
import { listHostRoutes } from "../core/host-routes";
import { getRepoConfigPath, loadRuntimeConfig, resolveRepoPath } from "../core/repo-config";
import { DEVNET_NAME, isTLSEnabled } from "../core/router";
import { discoverRoutes, resolveRouteByName } from "../core/routes";
import type { DevrouterConfig, Route } from "../types";

function resolveByConfiguredAppName(routes: Route[], name: string): Route | undefined {
  const repoPath = resolveRepoPath();

  let config: DevrouterConfig;
  try {
    config = loadRuntimeConfig(repoPath).config;
  } catch {
    return undefined;
  }

  const app = config.apps.find((entry) => entry.name === name);
  if (!app) {
    return undefined;
  }

  if (app.kind === "dependency") {
    throw new Error(
      `App '${name}' in ${getRepoConfigPath(repoPath)} is kind=dependency and does not create a route. ` +
        "Start a routed app that depends on it, then open that routed app name.",
    );
  }

  try {
    return resolveRouteByName(routes, app.host);
  } catch {
    throw new Error(
      `App '${name}' is configured in ${getRepoConfigPath(repoPath)} but no active route was found. ` +
        `Start it with 'dev app run ${name} --repo ${repoPath} --yes' and re-run 'dev ls'.`,
    );
  }
}

export async function runOpenCommand(name: string): Promise<void> {
  const containers = await listContainers(true);
  const tlsEnabled = isTLSEnabled();
  const { routes: dockerRoutes } = discoverRoutes(containers, tlsEnabled, DEVNET_NAME);
  const hostRoutes = listHostRoutes(tlsEnabled);
  const routes = [...dockerRoutes, ...hostRoutes];
  const route = resolveByConfiguredAppName(routes, name) ?? resolveRouteByName(routes, name);

  const url = route.urls[0];
  if (!url) {
    throw new Error(`Route '${name}' has no URL.`);
  }

  if (route.protocol !== "http") {
    process.stdout.write(`Route '${route.serviceName}' is ${route.protocol}: ${url}\n`);
    process.stdout.write(
      'Use a TLS-enabled Postgres client (for example: psql "host=<host> port=5432 sslmode=require ...").\n',
    );
    return;
  }

  const result = spawnSync("open", [url], { encoding: "utf-8" });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Unable to open '${url}': ${details || "unknown error"}`);
  }

  process.stdout.write(`Opened ${url}\n`);
}
