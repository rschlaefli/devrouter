import type {
  DevrouterConfig,
  DevrouterProfile,
  ManagedRuntimeResourceStatus,
  ManagedRuntimeStatus,
} from "../types";
import {
  inspectManagedDevcontainerConfig,
  inspectManagedDevcontainerGeneratedConfig,
  type ManagedDevcontainerPlan,
} from "./devcontainer-profile";
import {
  hasExactComposeIdentity,
  inspectWorkspaceContainers,
  type WorkspaceContainerSnapshot,
  workspaceAppContainers,
} from "./devpod-environment";
import { listHostRouteState } from "./host-routes";
import { runManagedProcessAction } from "./managed-post-start";
import { type ManagedRuntimeState, readManagedRuntimeState } from "./managed-runtime-state";
import { sameWorkspacePath } from "./workspace";

type RuntimeInspection = {
  plan?: ManagedDevcontainerPlan;
  generatedConfigSha256?: string;
  composeProject?: string;
  primaryReady: boolean;
  primaryActive: boolean;
  baseStatuses: Record<string, ManagedRuntimeResourceStatus>;
  serviceStatuses: Record<string, ManagedRuntimeResourceStatus>;
  processStatuses: Record<string, ManagedRuntimeResourceStatus>;
  activeServices: string[];
  activeProcesses: string[];
  drift: string[];
};

const EMPTY_RESOURCES = {
  apps: [] as string[],
  services: [] as string[],
  processes: [] as string[],
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function selectedResources(
  values: string[] | undefined,
  allValues: string[],
  hasResolvedProfile: boolean,
): string[] {
  if (values === undefined) return hasResolvedProfile ? [] : sortedUnique(allValues);
  return values.length === 1 && values[0] === "*" ? sortedUnique(allValues) : sortedUnique(values);
}

function containerResourceStatus(
  container: WorkspaceContainerSnapshot | undefined,
): ManagedRuntimeResourceStatus {
  if (!container) return "missing";
  if (!container.state.Running) return "stopped";
  const health = container.state.Health?.Status;
  if (health === "starting") return "starting";
  if (health === "unhealthy") return "unhealthy";
  return "healthy";
}

function isActiveResourceStatus(status: ManagedRuntimeResourceStatus): boolean {
  return (
    status === "running" || status === "healthy" || status === "starting" || status === "unhealthy"
  );
}

function isReadyResourceStatus(status: ManagedRuntimeResourceStatus): boolean {
  return status === "running" || status === "healthy";
}

function exactRoutes(
  repoPath: string,
  workspace?: string,
): {
  apps: string[];
  drift: string[];
} {
  try {
    const routes = listHostRouteState().filter(
      (route) => sameWorkspacePath(route.repoPath, repoPath) && route.workspace === workspace,
    );
    return { apps: sortedUnique(routes.map((route) => route.name)), drift: [] };
  } catch {
    return { apps: [], drift: ["managed route state could not be inspected"] };
  }
}

function compareResourceSet(
  label: string,
  expected: string[],
  actual: string[],
): string | undefined {
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    return `active ${label} differ from the selected profile`;
  }
  return undefined;
}

function resourceStatusesForMissing(
  names: string[],
  status: ManagedRuntimeResourceStatus,
): Record<string, ManagedRuntimeResourceStatus> {
  return Object.fromEntries(names.map((name) => [name, status]));
}

function inspectManagedRuntime(options: {
  repoPath: string;
  config: DevrouterConfig;
  registeredServices: string[];
  registeredProcesses: string[];
  desiredServices: string[];
  desiredProcesses: string[];
  workspace?: string;
  state?: ManagedRuntimeState;
}): RuntimeInspection {
  const {
    repoPath,
    config,
    registeredServices,
    registeredProcesses,
    desiredServices,
    desiredProcesses,
    workspace,
    state,
  } = options;
  const drift: string[] = [];
  const baseServices = sortedUnique(config.managedRuntime?.devcontainer.baseServices ?? []);
  const serviceStatuses = resourceStatusesForMissing(registeredServices, "missing");
  const baseStatuses = resourceStatusesForMissing(baseServices, "missing");
  const processStatuses = resourceStatusesForMissing(registeredProcesses, "missing");
  const activeServices: string[] = [];
  const activeProcesses: string[] = [];

  let plan: ManagedDevcontainerPlan | undefined;
  try {
    plan = inspectManagedDevcontainerConfig({
      repoPath,
      config,
      profile: {
        apps: ["*"],
        devcontainerServices: desiredServices,
        processes: ["*"],
      },
      linked: workspace !== undefined,
    });
  } catch {
    drift.push("managed Dev Container configuration could not be inspected");
    return {
      plan,
      primaryReady: false,
      primaryActive: false,
      baseStatuses,
      serviceStatuses,
      processStatuses,
      activeServices,
      activeProcesses,
      drift,
    };
  }

  let containers: WorkspaceContainerSnapshot[];
  try {
    containers = inspectWorkspaceContainers();
  } catch {
    drift.push("managed workspace containers could not be inspected");
    return {
      plan,
      primaryReady: false,
      primaryActive: false,
      baseStatuses,
      serviceStatuses,
      processStatuses,
      activeServices,
      activeProcesses,
      drift,
    };
  }

  if (!plan) {
    drift.push("managed Dev Container configuration could not be inspected");
    return {
      plan,
      primaryReady: false,
      primaryActive: false,
      baseStatuses,
      serviceStatuses,
      processStatuses,
      activeServices,
      activeProcesses,
      drift,
    };
  }
  const resolvedPlan = plan;
  let generatedConfigSha256: string | undefined;
  let generatedConfigMissing = false;
  try {
    const generated = inspectManagedDevcontainerGeneratedConfig(resolvedPlan);
    generatedConfigSha256 = generated.sha256;
    if (generated.status === "missing") {
      generatedConfigMissing = true;
    } else if (generated.status === "foreign") {
      drift.push("managed generated Dev Container configuration is not devrouter-owned");
    } else if (generated.status === "drifted") {
      drift.push("managed generated Dev Container configuration changed");
    }
  } catch {
    drift.push("managed generated Dev Container configuration could not be inspected");
  }

  const appContainers = workspaceAppContainers(containers, repoPath).filter((container) =>
    hasExactComposeIdentity(container, {
      repoPath,
      service: resolvedPlan.primaryService,
      composeFiles: resolvedPlan.composeFiles,
    }),
  );
  const projectScopedPrimary = state?.composeProject
    ? appContainers.filter(
        (container) => container.labels["com.docker.compose.project"] === state.composeProject,
      )
    : appContainers;

  let primary: WorkspaceContainerSnapshot | undefined;
  let composeProject = state?.composeProject;
  if (projectScopedPrimary.length === 1) {
    primary = projectScopedPrimary[0];
    composeProject = primary.labels["com.docker.compose.project"] ?? composeProject;
  } else if (projectScopedPrimary.length > 1) {
    drift.push("managed primary container identity is ambiguous");
  } else if (appContainers.length > 0) {
    drift.push(
      state?.composeProject
        ? "managed primary container is foreign"
        : "managed primary container identity is ambiguous",
    );
  }

  if (!composeProject && appContainers.length === 1) {
    composeProject = appContainers[0].labels["com.docker.compose.project"];
  }
  if (primary && !composeProject) {
    drift.push("managed primary container has no Compose project identity");
  }

  const exactService = (service: string): WorkspaceContainerSnapshot[] =>
    containers.filter((container) =>
      hasExactComposeIdentity(container, {
        repoPath,
        service,
        composeProject,
        composeFiles: resolvedPlan.composeFiles,
      }),
    );
  const unscopedService = (service: string): WorkspaceContainerSnapshot[] =>
    containers.filter((container) =>
      hasExactComposeIdentity(container, {
        repoPath,
        service,
        composeFiles: resolvedPlan.composeFiles,
      }),
    );

  const inspectService = (
    service: string,
    statuses: Record<string, ManagedRuntimeResourceStatus>,
  ): void => {
    const exact = exactService(service);
    if (exact.length > 1) {
      statuses[service] = "drifted";
      drift.push(`managed service '${service}' identity is ambiguous`);
      return;
    }
    if (exact.length === 0) {
      const foreign = unscopedService(service);
      statuses[service] = foreign.length > 0 ? "foreign" : "missing";
      if (foreign.length > 0) drift.push(`managed service '${service}' is foreign`);
      return;
    }
    const status = containerResourceStatus(exact[0]);
    statuses[service] = status;
    if (isActiveResourceStatus(status)) {
      if (statuses === serviceStatuses) activeServices.push(service);
    }
  };

  for (const service of registeredServices) inspectService(service, serviceStatuses);
  for (const service of baseServices) inspectService(service, baseStatuses);

  const managedServicesActive =
    activeServices.length > 0 || Object.values(baseStatuses).some(isActiveResourceStatus);

  const primaryWorkspacePath = primary?.mounts.find(
    (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, repoPath),
  )?.Destination;
  const primaryActive = Boolean(primary?.state.Running);
  if (generatedConfigMissing && (state || primaryActive || managedServicesActive)) {
    drift.push("managed generated Dev Container configuration is missing");
  }
  const primaryHealth = primary?.state.Health?.Status;
  const primaryReady =
    primaryActive && primaryHealth !== "starting" && primaryHealth !== "unhealthy";
  if (!primary) {
    if (managedServicesActive) {
      drift.push("managed primary container is missing");
    }
  } else if (!primaryActive) {
    if (managedServicesActive) {
      drift.push("managed primary container is stopped");
    }
  } else if (primaryHealth === "unhealthy") {
    drift.push("managed primary container is unhealthy");
  }

  if (primary && primaryActive && primaryWorkspacePath) {
    for (const process of registeredProcesses) {
      let status: ManagedRuntimeResourceStatus;
      try {
        status = runManagedProcessAction({
          container: { id: primary.id, workspacePath: primaryWorkspacePath },
          name: process,
          action: "status",
          quiet: true,
        });
      } catch {
        status = "drifted";
      }
      processStatuses[process] = status;
      if (status === "running") activeProcesses.push(process);
      if (desiredProcesses.includes(process) && status !== "running") {
        drift.push(`managed process '${process}' is not running`);
      }
    }
  } else {
    if (primary && !primaryActive) {
      for (const process of registeredProcesses) processStatuses[process] = "stopped";
    }
    if (desiredProcesses.length > 0 && (primaryActive || managedServicesActive)) {
      drift.push("managed processes cannot be proven without the primary container");
    }
  }

  for (const service of desiredServices) {
    const status = serviceStatuses[service] ?? "missing";
    if (
      !isReadyResourceStatus(status) &&
      status !== "starting" &&
      (primaryActive || managedServicesActive)
    ) {
      drift.push(`managed service '${service}' is not ready`);
    }
  }
  for (const service of baseServices) {
    const status = baseStatuses[service] ?? "missing";
    if (
      !isReadyResourceStatus(status) &&
      status !== "starting" &&
      (primaryActive || managedServicesActive)
    ) {
      drift.push(`managed base service '${service}' is not ready`);
    }
  }

  return {
    plan,
    generatedConfigSha256,
    composeProject,
    primaryReady,
    primaryActive,
    baseStatuses,
    serviceStatuses,
    processStatuses,
    activeServices: sortedUnique(activeServices),
    activeProcesses: sortedUnique(activeProcesses),
    drift,
  };
}

export function collectManagedRuntimeStatus(options: {
  repoPath: string;
  workspace?: string;
  config: DevrouterConfig;
  profile: string;
  resolvedProfile?: DevrouterProfile;
  /** Inspect a candidate before publishing it to persistent runtime state. */
  candidateState?: ManagedRuntimeState;
}): ManagedRuntimeStatus {
  if (!options.config.managedRuntime) {
    return {
      mode: "legacy",
      status: "legacy",
      profile: options.profile,
      desired: { ...EMPTY_RESOURCES },
      active: { ...EMPTY_RESOURCES },
      serviceStatuses: {},
      baseServiceStatuses: {},
      processStatuses: {},
      drift: [],
    };
  }

  const managedRuntime = options.config.managedRuntime;
  const hasResolvedProfile = options.resolvedProfile !== undefined;
  const routedApps = options.config.apps
    .filter((app) => app.kind !== "dependency")
    .map((app) => app.name);
  const registeredServices = sortedUnique(managedRuntime.devcontainer.profileServices);
  const registeredProcesses = sortedUnique(managedRuntime.processes);
  const desiredApps = selectedResources(
    options.resolvedProfile?.apps,
    routedApps,
    hasResolvedProfile,
  );
  const desiredServices = selectedResources(
    options.resolvedProfile?.devcontainerServices,
    registeredServices,
    hasResolvedProfile,
  );
  const desiredProcesses = selectedResources(
    options.resolvedProfile?.processes,
    registeredProcesses,
    hasResolvedProfile,
  );

  let state: ManagedRuntimeState | undefined;
  let stateReadFailed = false;
  try {
    state = options.candidateState ?? readManagedRuntimeState(options.repoPath, options.workspace);
  } catch {
    stateReadFailed = true;
  }

  const drift: string[] = [];
  if (stateReadFailed) drift.push("managed runtime state could not be read");
  if (state?.status === "degraded") drift.push("the last managed transition is degraded");
  if (state) {
    const desiredState = {
      apps: sortedUnique(state.desired.apps),
      services: sortedUnique(state.desired.services),
      processes: sortedUnique(state.desired.processes),
    };
    const desired = {
      apps: desiredApps,
      services: desiredServices,
      processes: desiredProcesses,
    };
    for (const [label, expected, actual] of [
      ["apps", desired.apps, desiredState.apps],
      ["services", desired.services, desiredState.services],
      ["processes", desired.processes, desiredState.processes],
    ] as const) {
      const mismatch = compareResourceSet(label, expected, actual);
      if (mismatch) drift.push(mismatch);
    }
    if (state.profile !== options.profile)
      drift.push("active profile differs from the selected profile");
  }

  const inspection = inspectManagedRuntime({
    repoPath: options.repoPath,
    config: options.config,
    registeredServices,
    registeredProcesses,
    desiredServices,
    desiredProcesses,
    workspace: options.workspace,
    state,
  });
  drift.push(...inspection.drift);

  if (state && inspection.plan && state.sourceConfigSha256 !== inspection.plan.sourceConfigSha256) {
    drift.push("managed Dev Container source configuration changed");
  }
  if (
    state &&
    inspection.plan &&
    state.effectiveConfigSha256 !== inspection.plan.effectiveConfigSha256
  ) {
    drift.push("managed Dev Container effective configuration changed");
  }
  if (
    state &&
    inspection.generatedConfigSha256 &&
    state.effectiveConfigSha256 !== inspection.generatedConfigSha256
  ) {
    drift.push("managed generated Dev Container configuration differs from last successful state");
  }

  const routes = exactRoutes(options.repoPath, options.workspace);
  drift.push(...routes.drift);
  const activeApps = routes.apps;
  const anyActive =
    inspection.primaryActive ||
    inspection.activeServices.length > 0 ||
    Object.values(inspection.baseStatuses).some(isActiveResourceStatus) ||
    inspection.activeProcesses.length > 0 ||
    activeApps.length > 0;
  if (activeApps.length > 0 && !inspection.primaryActive) {
    drift.push("active app routes exist without a running primary container");
  }
  if (desiredApps.some((app) => !activeApps.includes(app)) && anyActive) {
    drift.push("one or more selected app routes are missing");
  }
  if (activeApps.some((app) => !desiredApps.includes(app))) {
    drift.push("one or more active app routes are outside the selected profile");
  }
  if (inspection.activeServices.some((service) => !desiredServices.includes(service))) {
    drift.push("one or more active services are outside the selected profile");
  }
  if (inspection.activeProcesses.some((process) => !desiredProcesses.includes(process))) {
    drift.push("one or more active processes are outside the selected profile");
  }

  const requiredServicesReady = desiredServices.every((service) =>
    isReadyResourceStatus(inspection.serviceStatuses[service] ?? "missing"),
  );
  const baseServicesReady = Object.values(inspection.baseStatuses).every(isReadyResourceStatus);
  const processesReady = desiredProcesses.every((process) =>
    isReadyResourceStatus(inspection.processStatuses[process] ?? "missing"),
  );
  const routesReady = desiredApps.every((app) => activeApps.includes(app));
  const ready =
    inspection.primaryReady &&
    requiredServicesReady &&
    baseServicesReady &&
    processesReady &&
    routesReady &&
    !stateReadFailed &&
    !drift.length;

  const status =
    state?.status === "degraded"
      ? "failed-transition"
      : drift.length > 0
        ? "drifted"
        : ready
          ? "ready"
          : anyActive
            ? "starting"
            : "stopped";

  const active = {
    apps: activeApps,
    services: inspection.activeServices,
    processes: inspection.activeProcesses,
  };

  return {
    mode: "managed",
    status,
    profile: options.profile,
    ...(state?.profile ? { activeProfile: state.profile } : {}),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    ...(state?.devpodId ? { devpodId: state.devpodId } : {}),
    ...(inspection.composeProject ? { composeProject: inspection.composeProject } : {}),
    desired: {
      apps: desiredApps,
      services: desiredServices,
      processes: desiredProcesses,
    },
    active,
    serviceStatuses: inspection.serviceStatuses,
    baseServiceStatuses: inspection.baseStatuses,
    processStatuses: inspection.processStatuses,
    drift: sortedUnique(drift),
    ...(inspection.plan?.sourceConfigSha256 || state?.sourceConfigSha256
      ? { sourceConfigSha256: inspection.plan?.sourceConfigSha256 ?? state?.sourceConfigSha256 }
      : {}),
    ...(inspection.plan?.effectiveConfigSha256 || state?.effectiveConfigSha256
      ? {
          effectiveConfigSha256:
            inspection.plan?.effectiveConfigSha256 ?? state?.effectiveConfigSha256,
        }
      : {}),
    ...(state?.transitionPhase ? { transitionPhase: state.transitionPhase } : {}),
  };
}
