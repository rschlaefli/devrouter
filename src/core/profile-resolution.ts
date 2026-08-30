import type { DevrouterConfig, DevrouterProfile } from "../types";
import { applyProfile, loadRepoConfig, resolveProfile, resolveRepoPath } from "./repo-config";

export type ProfileResolutionReport = {
  schemaVersion: 1;
  repoPath: string;
  profile: string;
  apps: string[];
  dependencies: string[];
  readiness: string[];
  managedRuntime: {
    baseServices: string[];
    profileServices: string[];
    services: string[];
    processes: string[];
  };
};

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function expandsAll(values: string[] | undefined): boolean {
  return values?.length === 1 && values[0] === "*";
}

function selectedManagedResources(
  profile: DevrouterProfile | undefined,
  selected: string[] | undefined,
  registry: string[],
): string[] {
  if (!profile || expandsAll(selected)) return sortedUnique(registry);
  return sortedUnique(selected ?? []);
}

function selectedReadiness(
  config: DevrouterConfig,
  profileName: string,
  profile: DevrouterProfile | undefined,
  routedApps: DevrouterConfig["apps"],
): string[] {
  const selectedNames = profileName.split(",");
  if (selectedNames.length === 1) {
    return sortedUnique(
      profile?.readiness ??
        routedApps.filter((app) => app.protocol === "http").map((app) => app.name),
    );
  }

  const readiness = new Set<string>();
  for (const selectedName of selectedNames) {
    const selected = resolveProfile(config, selectedName);
    const selectedApps = applyProfile(config, selected.profile).apps.filter(
      (app) => app.kind !== "dependency",
    );
    const selectedTargets =
      selected.profile?.readiness ??
      selectedApps.filter((app) => app.protocol === "http").map((app) => app.name);
    for (const target of selectedTargets) readiness.add(target);
  }
  return sortedUnique(readiness);
}

export function buildProfileResolutionReport(
  config: DevrouterConfig,
  repoPath: string,
  profileOverride?: string,
): ProfileResolutionReport {
  const resolved = resolveProfile(config, profileOverride);
  const filtered = applyProfile(config, resolved.profile);
  const routedApps = filtered.apps.filter((app) => app.kind !== "dependency");
  const dependencies = filtered.apps.filter((app) => app.kind === "dependency");
  const readiness = selectedReadiness(config, resolved.name, resolved.profile, routedApps);

  const managedRuntime = config.managedRuntime;
  const baseServices = sortedUnique(managedRuntime?.devcontainer.baseServices ?? []);
  const profileServices = managedRuntime
    ? selectedManagedResources(
        resolved.profile,
        resolved.profile?.devcontainerServices,
        managedRuntime.devcontainer.profileServices,
      )
    : [];
  const processes = managedRuntime
    ? selectedManagedResources(
        resolved.profile,
        resolved.profile?.processes,
        managedRuntime.processes,
      )
    : [];

  return {
    schemaVersion: 1,
    repoPath,
    profile: resolved.name,
    apps: sortedUnique(routedApps.map((app) => app.name)),
    dependencies: sortedUnique(dependencies.map((app) => app.name)),
    readiness: sortedUnique(readiness),
    managedRuntime: {
      baseServices,
      profileServices,
      services: sortedUnique([...baseServices, ...profileServices]),
      processes,
    },
  };
}

export function resolveProfileReport(options: {
  repo?: string;
  profile?: string;
}): ProfileResolutionReport {
  const repoPath = resolveRepoPath(options.repo);
  return buildProfileResolutionReport(loadRepoConfig(repoPath), repoPath, options.profile);
}
