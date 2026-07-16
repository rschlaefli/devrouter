import type { DevrouterConfig, DevrouterProxyApp, DevrouterRoutedApp } from "../types";
import { ensureNetwork } from "./docker";
import { type HostRouteInput, parseUpstream, replaceHostRoutesForRepo } from "./host-routes";
import {
  activateTcpProtocol,
  DEVNET_NAME,
  ensureRouterFiles,
  isTLSEnabled,
  startRouterStack,
} from "./router";
import { ensureTLSHostsCovered, tlsSetupCommand } from "./tls";

export function routedAppsFromConfig(config: DevrouterConfig): DevrouterRoutedApp[] {
  return config.apps.filter((app): app is DevrouterRoutedApp => app.kind !== "dependency");
}

export function configuredProxyAppsFromConfig(config: DevrouterConfig): DevrouterProxyApp[] {
  return routedAppsFromConfig(config).filter(
    (app): app is DevrouterProxyApp => app.runtime === "proxy",
  );
}

export function proxyAppsFromConfig(config: DevrouterConfig): DevrouterProxyApp[] {
  const routedApps = routedAppsFromConfig(config);
  const proxyApps = configuredProxyAppsFromConfig(config);
  const unsupported = routedApps.filter((app) => app.runtime !== "proxy");
  if (unsupported.length > 0) {
    throw new Error(
      `Environment reconciliation supports proxy runtime apps only; unsupported: ${unsupported
        .map((app) => `${app.name} (${app.runtime})`)
        .join(", ")}`,
    );
  }
  return proxyApps;
}

export async function ensureRouteInfrastructure(
  apps: DevrouterRoutedApp[],
  options: { repoPath?: string } = {},
): Promise<Awaited<ReturnType<typeof ensureTLSHostsCovered>>> {
  ensureRouterFiles();
  await ensureNetwork(DEVNET_NAME);
  const tlsCoverage = await ensureTLSHostsCovered(
    apps.map((app) => app.host),
    options,
  );

  for (const app of apps) {
    if (app.protocol === "tcp") {
      if (!isTLSEnabled()) {
        throw new Error(
          `TCP route '${app.name}' requires TLS. Run: ${tlsSetupCommand(options.repoPath)}`,
        );
      }
      activateTcpProtocol(app.tcpProtocol);
    }
  }

  startRouterStack();
  return tlsCoverage;
}

export async function replacePublishedProxyRoutes(
  repoPath: string,
  config: DevrouterConfig,
  workspace?: string,
): Promise<{ routes: HostRouteInput[]; tlsRefreshed: boolean }> {
  const apps = proxyAppsFromConfig(config);
  const tlsCoverage = await ensureRouteInfrastructure(apps, { repoPath });

  const routes = apps.map<HostRouteInput>((app) => {
    const upstream = parseUpstream(app.upstream);
    return {
      name: app.name,
      host: app.host,
      protocol: app.protocol,
      tcpProtocol: app.protocol === "tcp" ? app.tcpProtocol : undefined,
      repoPath,
      port: upstream.port,
      mode: "proxy",
      upstreamHost: upstream.upstreamHost,
      workspace,
    };
  });

  replaceHostRoutesForRepo(repoPath, routes);
  return { routes, tlsRefreshed: tlsCoverage.refreshed };
}
