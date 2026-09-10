import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ManagedStopContainerSnapshot } from "./devpod-environment";
import type { ManagedStopBaseline } from "./managed-stop-baseline";
import type { CapacityStartupWitness } from "./reliability-operation-store";

const MAX_POPULATION = 256;

type MountIdentity = {
  Type: string;
  Source: string;
  Destination: string;
};

type ContainerIdentity = {
  id: string;
  service: string;
  configFiles: string[];
  mounts: MountIdentity[];
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function label(container: ManagedStopContainerSnapshot, name: string): string {
  const value = container.labels[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Capacity population contains an incomplete Compose identity.");
  }
  return value;
}

function configFiles(value: string): string[] {
  const files = value.split(",").map((file) => file.trim());
  if (files.length === 0 || files.some((file) => file.length === 0)) {
    throw new Error("Capacity population contains an incomplete Compose file identity.");
  }
  return files;
}

function sortedMounts(mounts: MountIdentity[]): MountIdentity[] {
  return mounts
    .map(({ Type, Source, Destination }) => ({ Type, Source, Destination }))
    .sort((left, right) => {
      const leftKey = JSON.stringify([left.Type, left.Source, left.Destination]);
      const rightKey = JSON.stringify([right.Type, right.Source, right.Destination]);
      return compareText(leftKey, rightKey);
    });
}

function baselineIdentity(container: ManagedStopBaseline["containers"][number]): ContainerIdentity {
  return {
    id: container.id,
    service: container.service,
    configFiles: [...container.configFiles],
    mounts: sortedMounts(container.mounts),
  };
}

function snapshotIdentity(container: ManagedStopContainerSnapshot): ContainerIdentity {
  return {
    id: container.id,
    service: label(container, "com.docker.compose.service"),
    configFiles: configFiles(label(container, "com.docker.compose.project.config_files")),
    mounts: sortedMounts(container.mounts),
  };
}

function assertUniquePopulation(population: ContainerIdentity[]): void {
  const ids = new Set<string>();
  const services = new Set<string>();
  for (const container of population) {
    if (ids.has(container.id) || services.has(container.service)) {
      throw new Error("Capacity population contains duplicate container attribution.");
    }
    ids.add(container.id);
    services.add(container.service);
  }
}

function sortedPopulation(population: ContainerIdentity[]): ContainerIdentity[] {
  return [...population].sort((left, right) => compareText(left.id, right.id));
}

/**
 * Prove a supplied retained managed population without inspecting or mutating a machine.
 * The caller must provide the already validated stop baseline and exact observation identity.
 */
export function proveManagedCapacityPopulation(options: {
  containers: ManagedStopContainerSnapshot[];
  baseline: ManagedStopBaseline;
  repoPath: string;
  composeProject: string;
  daemonId: string;
  endpoint: string;
}): void {
  const { containers, baseline, repoPath, composeProject, daemonId, endpoint } = options;

  if (
    baseline.daemonId !== daemonId ||
    baseline.project !== composeProject ||
    baseline.endpoint !== endpoint ||
    baseline.sourcePath !== repoPath
  ) {
    throw new Error("Capacity population does not match the retained runtime identity.");
  }
  if (
    baseline.containers.length === 0 ||
    containers.length === 0 ||
    baseline.containers.length > MAX_POPULATION ||
    containers.length > MAX_POPULATION
  ) {
    throw new Error("Capacity population must contain a bounded retained population.");
  }

  for (const container of containers) {
    if (
      label(container, "com.docker.compose.project") !== composeProject ||
      label(container, "com.docker.compose.project.working_dir") !== baseline.composeDirectory
    ) {
      throw new Error("Capacity population contains foreign Compose ownership.");
    }
  }

  const expected = baseline.containers.map(baselineIdentity);
  const observed = containers.map(snapshotIdentity);
  assertUniquePopulation(expected);
  assertUniquePopulation(observed);
  if (!isDeepStrictEqual(sortedPopulation(expected), sortedPopulation(observed))) {
    throw new Error("Capacity population does not match the retained container identities.");
  }

  const expectedPrimary = baseline.containers.find(
    (container) => container.service === baseline.primaryService,
  );
  const observedPrimary = containers.find(
    (container) => label(container, "com.docker.compose.service") === baseline.primaryService,
  );
  if (!expectedPrimary || !observedPrimary) {
    throw new Error("Capacity population is missing the retained primary container.");
  }

  const expectedPrimaryMounts = expectedPrimary.mounts.filter(
    (mount) => mount.Type === "bind" && mount.Source === repoPath,
  );
  const observedPrimaryMounts = observedPrimary.mounts.filter(
    (mount) => mount.Type === "bind" && mount.Source === repoPath,
  );
  if (expectedPrimaryMounts.length !== 1 || observedPrimaryMounts.length !== 1) {
    throw new Error("Capacity population does not prove the exact primary workspace mount.");
  }
}

function withinRepo(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Prove a startup generation observed under an intent-bound witness. Every
 * container is either an exact retained member (by ID, already identity-proven
 * at witness publication) or a proven target-generation member: its service is
 * an allowed startup service, its configuration provenance equals the
 * witnessed Compose paths, and only the primary may carry the workspace bind
 * mount. A missing desired service means incomplete startup, never incomplete
 * enumeration, but the primary is required for the bounded initial contract.
 */
export function proveWitnessedCapacityPopulation(options: {
  containers: ManagedStopContainerSnapshot[];
  witness: CapacityStartupWitness;
  repoPath: string;
  composeProject: string;
}): void {
  const { containers, witness, repoPath, composeProject } = options;
  if (containers.length > MAX_POPULATION) {
    throw new Error("Capacity witnessed population exceeds its bounded size.");
  }
  const retained = new Set(witness.retainedContainerIds);
  const services = new Set<string>();
  let primaryObserved = false;
  for (const container of containers) {
    if (
      label(container, "com.docker.compose.project") !== composeProject ||
      !withinRepo(label(container, "com.docker.compose.project.working_dir"), repoPath)
    ) {
      throw new Error("Capacity witnessed population contains foreign Compose ownership.");
    }
    const service = label(container, "com.docker.compose.service");
    if (services.has(service)) {
      throw new Error("Capacity witnessed population contains duplicate container attribution.");
    }
    services.add(service);
    if (retained.has(container.id)) {
      if (service === witness.primaryService) primaryObserved = true;
      continue;
    }
    if (!witness.startupServices.includes(service)) {
      throw new Error("Capacity witnessed population contains an unknown startup service.");
    }
    const configuration = configFiles(label(container, "com.docker.compose.project.config_files"));
    if (!isDeepStrictEqual(configuration, witness.composeFiles)) {
      throw new Error("Capacity witnessed population has foreign configuration provenance.");
    }
    const workspaceMounts = container.mounts.filter(
      (mount) => mount.Type === "bind" && mount.Source === repoPath,
    );
    if (service === witness.primaryService) {
      if (workspaceMounts.length !== 1) {
        throw new Error(
          "Capacity witnessed population does not prove the primary workspace mount.",
        );
      }
      primaryObserved = true;
    } else if (workspaceMounts.length > 0) {
      throw new Error("Capacity witnessed population contains a foreign workspace mount.");
    }
  }
  if (!primaryObserved) {
    throw new Error("Capacity witnessed population is missing the primary container.");
  }
}
