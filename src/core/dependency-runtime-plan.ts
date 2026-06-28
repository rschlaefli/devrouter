import type {
  DevrouterApp,
  DevrouterDockerDependencyApp,
  DevrouterDockerTcpApp,
  DevrouterHostHttpApp,
  DevrouterProxyApp
} from "../types";
import type { RunningComposeServicesResult } from "./docker-run";
import {
  DEP_ENV_SUFFIXES,
  buildPostgresDependencyShadowUrl,
  buildPostgresDependencyUrl
} from "./capabilities";

export type DependencyStopPolicy = "always-stop-selected" | "stop-only-newly-started";

type DockerRuntimeApp = Exclude<DevrouterApp, DevrouterHostHttpApp | DevrouterProxyApp>;

type DependencyRuntimePlan = {
  app: Exclude<DevrouterApp, DevrouterDockerDependencyApp>;
  dependencies: DevrouterApp[];
  selectedApps: DevrouterApp[];
  selectedDockerApps: DockerRuntimeApp[];
  services: string[];
  dependencyServices: string[];
  stopPolicy: DependencyStopPolicy;
  runningServicesBefore?: RunningComposeServicesResult;
  allDependencyServicesRunning: boolean;
  shouldPromptForDependencies: boolean;
  hasTcpDeps: boolean;
};

type DependencyStartPlan = {
  shouldRunComposeUp: boolean;
  startedServices: string[];
  dependencyApps: string[];
  ownershipWarning?: string;
};

export type MappedTcpDependency = {
  app: DevrouterDockerTcpApp;
  mappedPort: number | undefined;
};

function uniqueApps(apps: DevrouterApp[]): DevrouterApp[] {
  const byName = new Map<string, DevrouterApp>();
  for (const app of apps) {
    byName.set(app.name, app);
  }
  return Array.from(byName.values());
}

function dependencyNames(apps: DevrouterApp[]): string[] {
  return apps.map((entry) => entry.name).sort();
}

export function planDependencyRuntime(options: {
  app: Exclude<DevrouterApp, DevrouterDockerDependencyApp>;
  dependencies: DevrouterApp[];
  stopPolicy?: DependencyStopPolicy;
  runningServicesBefore?: RunningComposeServicesResult;
}): DependencyRuntimePlan {
  const selectedApps = uniqueApps([options.app, ...options.dependencies]);
  const selectedDockerApps = selectedApps.filter(
    (entry): entry is DockerRuntimeApp => entry.runtime === "docker"
  );
  const services = selectedDockerApps.map((entry) => entry.docker.service);
  const dependencyServices = options.dependencies
    .filter((entry): entry is DockerRuntimeApp => entry.runtime === "docker")
    .map((entry) => entry.docker.service);
  const runningServices = options.runningServicesBefore?.status === "known"
    ? options.runningServicesBefore.runningServices
    : undefined;
  const allDependencyServicesRunning = runningServices !== undefined
    && dependencyServices.every((service) => runningServices.has(service));
  const hasTcpDeps = options.app.runtime === "host" && selectedDockerApps.some(
    (entry) => entry.kind !== "dependency" && entry.protocol === "tcp"
  );

  return {
    app: options.app,
    dependencies: options.dependencies,
    selectedApps,
    selectedDockerApps,
    services,
    dependencyServices,
    stopPolicy: options.stopPolicy ?? "always-stop-selected",
    runningServicesBefore: options.runningServicesBefore,
    allDependencyServicesRunning,
    shouldPromptForDependencies: options.dependencies.length > 0 && !allDependencyServicesRunning,
    hasTcpDeps
  };
}

export function planDependencyStart(
  runtimePlan: DependencyRuntimePlan,
  startDependencies: boolean
): DependencyStartPlan {
  const shouldRunComposeUp = runtimePlan.app.runtime === "docker" || startDependencies;
  if (!shouldRunComposeUp) {
    return {
      shouldRunComposeUp,
      startedServices: [],
      dependencyApps: []
    };
  }

  if (runtimePlan.stopPolicy === "stop-only-newly-started") {
    if (runtimePlan.runningServicesBefore?.status === "unknown") {
      return {
        shouldRunComposeUp,
        startedServices: [],
        dependencyApps: startDependencies ? dependencyNames(runtimePlan.dependencies) : [],
        ownershipWarning:
          "unable to determine which dependencies were already running before 'dev app exec'; " +
          "leaving dependencies running after command exit to avoid stopping non-owned services. " +
          `Details: ${runtimePlan.runningServicesBefore.reason}`
      };
    }

    const beforeSet = runtimePlan.runningServicesBefore?.status === "known"
      ? runtimePlan.runningServicesBefore.runningServices
      : undefined;
    return {
      shouldRunComposeUp,
      startedServices: beforeSet
        ? runtimePlan.services.filter((service) => !beforeSet.has(service))
        : [],
      dependencyApps: startDependencies ? dependencyNames(runtimePlan.dependencies) : []
    };
  }

  const beforeSet = runtimePlan.app.runtime === "docker" && runtimePlan.runningServicesBefore?.status === "known"
    ? runtimePlan.runningServicesBefore.runningServices
    : undefined;

  return {
    shouldRunComposeUp,
    startedServices: runtimePlan.app.runtime === "docker"
      ? runtimePlan.services.filter((service) => !beforeSet?.has(service))
      : [...runtimePlan.services],
    dependencyApps: startDependencies ? dependencyNames(runtimePlan.dependencies) : []
  };
}

export function buildTcpDepUrl(tcpProtocol: string, port: number): string | undefined {
  switch (tcpProtocol) {
    case "postgres":
      return buildPostgresDependencyUrl(port);
    case "redis":
      return `redis://localhost:${port}`;
    case "mysql":
    case "mariadb":
      return `mysql://root@localhost:${port}`;
    default:
      return undefined;
  }
}

export function buildTcpDepShadowUrl(tcpProtocol: string, port: number): string | undefined {
  if (tcpProtocol === "postgres") {
    return buildPostgresDependencyShadowUrl(port);
  }
  return undefined;
}

export function buildDependencyEnv(mappedDeps: MappedTcpDependency[]): Record<string, string> {
  const depEnv: Record<string, string> = {};
  const [hostSuffix, portSuffix, urlSuffix, shadowUrlSuffix] = DEP_ENV_SUFFIXES;

  for (const { app, mappedPort } of mappedDeps) {
    if (mappedPort === undefined) {
      continue;
    }

    const envPrefix = app.name.toUpperCase().replace(/-/g, "_");
    depEnv[`${envPrefix}_${hostSuffix}`] = "localhost";
    depEnv[`${envPrefix}_${portSuffix}`] = String(mappedPort);
    const url = buildTcpDepUrl(app.tcpProtocol, mappedPort);
    if (url) {
      depEnv[`${envPrefix}_${urlSuffix}`] = url;
    }
    const shadowUrl = buildTcpDepShadowUrl(app.tcpProtocol, mappedPort);
    if (shadowUrl) {
      depEnv[`${envPrefix}_${shadowUrlSuffix}`] = shadowUrl;
    }
  }

  return depEnv;
}

export function applyDependencyEnvMap(
  app: Exclude<DevrouterApp, DevrouterDockerDependencyApp>,
  depEnv: Record<string, string>
): Record<string, string> {
  const mappedEnv = { ...depEnv };

  for (const depRef of app.dependencies) {
    if (!depRef.envMap) {
      continue;
    }

    for (const [target, source] of Object.entries(depRef.envMap)) {
      if (!(source in mappedEnv)) {
        throw new Error(
          `envMap on dependency '${depRef.app}': source variable '${source}' not found in dependency env. ` +
          `Available: ${Object.keys(mappedEnv).join(", ") || "(none)"}`
        );
      }
      mappedEnv[target] = mappedEnv[source];
    }
  }

  return mappedEnv;
}
