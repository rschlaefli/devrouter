import type { DevrouterConfig, DevrouterProfile, DevrouterRoutedApp } from "../types";
import { applyProfile, loadRepoConfig, resolveProfile, resolveRepoPath } from "./repo-config";

export type ManagedProfileExpansionDimension = "apps" | "devcontainerServices" | "processes";

// Reserved managed `full` profile normalization replaces declared dimensions with
// wildcards. The notice records only the dimensions that actually changed, so a
// profile that already selects every resource stays quiet.
export type ManagedProfileExpansionNotice = {
  code: "MANAGED_FULL_PROFILE_EXPANSION";
  profile: string;
  dimensions: ManagedProfileExpansionDimension[];
  remedy: {
    code: "SET_NAMED_DEFAULT_PROFILE";
    profiles: string[];
  };
};

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
  notices?: ManagedProfileExpansionNotice[];
};

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function expandsAll(values: string[] | undefined): boolean {
  return values?.length === 1 && values[0] === "*";
}

function selectionMatchesAll(values: string[] | undefined, all: string[]): boolean {
  if (values === undefined) return all.length === 0;
  const selected = sortedUnique(values);
  return selected.length === all.length && selected.every((value, index) => value === all[index]);
}

// Dimensions that the reserved managed `full` profile silently replaced with a
// wildcard: declared finite values that differ from the registry, and omitted
// dimensions whose registry is non-empty. Declared wildcards and declarations
// that already equal every registered resource are not expansions.
function managedFullExpansionDimensions(
  declared: DevrouterProfile,
  config: DevrouterConfig,
): ManagedProfileExpansionDimension[] {
  const managedRuntime = config.managedRuntime;
  if (!managedRuntime) return [];

  const allApps = sortedUnique(
    config.apps.filter((app) => app.kind !== "dependency").map((app) => app.name),
  );
  const allServices = sortedUnique(managedRuntime.devcontainer.profileServices);
  const allProcesses = sortedUnique(managedRuntime.processes);

  const dimensions: ManagedProfileExpansionDimension[] = [];
  const consider = (
    dimension: ManagedProfileExpansionDimension,
    declaredValues: string[] | undefined,
    all: string[],
  ): void => {
    if (expandsAll(declaredValues) || selectionMatchesAll(declaredValues, all)) return;
    dimensions.push(dimension);
  };

  consider("apps", declared.apps, allApps);
  consider("devcontainerServices", declared.devcontainerServices, allServices);
  consider("processes", declared.processes, allProcesses);
  return dimensions;
}

// The reserved `full` profile is fixed to every registered resource in managed
// runtimes, so a declared `full` profile selected alone or used as the default
// can silently widen a finite or omitted declaration. Combined selections read
// the literal declared arrays and are intentionally not reported.
function managedFullExpansionNotices(
  config: DevrouterConfig,
  resolvedName: string,
): ManagedProfileExpansionNotice[] {
  if (!config.managedRuntime || resolvedName !== "full") return [];
  const declared = config.profiles?.full;
  if (!declared) return [];

  const dimensions = managedFullExpansionDimensions(declared, config);
  if (dimensions.length === 0) return [];

  return [
    {
      code: "MANAGED_FULL_PROFILE_EXPANSION",
      profile: "full",
      dimensions,
      remedy: {
        code: "SET_NAMED_DEFAULT_PROFILE",
        profiles: Object.keys(config.profiles ?? {})
          .filter((name) => name !== "full")
          .sort(),
      },
    },
  ];
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
  routedApps: DevrouterRoutedApp[],
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

  const notices = managedFullExpansionNotices(config, resolved.name);

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
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export function resolveProfileReport(options: {
  repo?: string;
  profile?: string;
}): ProfileResolutionReport {
  const repoPath = resolveRepoPath(options.repo);
  return buildProfileResolutionReport(loadRepoConfig(repoPath), repoPath, options.profile);
}
