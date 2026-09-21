import { spawnSync } from "node:child_process";
import type { ManagedMountNesting, ManagedMountNestingUnwound } from "../types";
import type { WorkspaceContainerSnapshot } from "./devpod-environment";
import { networkDockerOptions } from "./network-effect-scope";

type ConfiguredMount = WorkspaceContainerSnapshot["mounts"][number];

const NESTED_MOUNT_REASON = "no configured mount is nested inside another configured mount";
const UNREADABLE_MOUNT_REASON = "the container's own mount table could not be read";

/**
 * Mount points are compared as paths, so a trailing slash never decides
 * whether one mount sits inside another.
 */
function normalizeDestination(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function isNestedWithin(destination: string, candidate: string): boolean {
  return candidate === "/" ? destination !== "/" : destination.startsWith(`${candidate}/`);
}

function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/**
 * The mount table of the container's own namespace: the fifth field of each
 * `/proc/self/mountinfo` line. Spaces and other separators arrive as octal
 * escapes, so the comparison works on the decoded path.
 */
export function parseMountinfoDestinations(text: string): string[] {
  const destinations = new Set<string>();
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 5 || !/^\d+$/.test(fields[0] ?? "")) continue;
    destinations.add(normalizeDestination(unescapeMountField(fields[4] ?? "")));
  }
  return [...destinations];
}

/**
 * Whether the configured mount at this index sits inside another configured
 * mount, and can therefore be unwound while `docker inspect` keeps reporting it.
 */
function isNestedIndex(destinations: string[], index: number): boolean {
  return destinations.some(
    (candidate, other) => other !== index && isNestedWithin(destinations[index] ?? "", candidate),
  );
}

function configuredDestinations(configured: ConfiguredMount[]): string[] {
  return configured.map((mount) => normalizeDestination(mount.Destination));
}

/**
 * Compare each nested configured mount with the mount table the container's
 * own namespace reports. Only nested mounts are compared, because that is the
 * shape the host file-sharing layer can unwind while `docker inspect` keeps
 * reporting it: the outer mount underneath the nested one becomes visible, and
 * container-side writes land in the host checkout.
 */
export function classifyManagedMountNesting(
  configured: ConfiguredMount[],
  effectiveDestinations: string[] | null,
  containerId?: string,
): ManagedMountNesting {
  const destinations = configuredDestinations(configured);
  const nested = configured.filter((_mount, index) => isNestedIndex(destinations, index));
  const identity = containerId ? { container: containerId } : {};
  if (nested.length === 0) {
    return { status: "not-applicable", checked: [], unwound: [], reason: NESTED_MOUNT_REASON };
  }
  if (effectiveDestinations === null) {
    return {
      status: "unverified",
      checked: [],
      unwound: [],
      ...identity,
      reason: UNREADABLE_MOUNT_REASON,
    };
  }

  const effective = new Set(effectiveDestinations.map(normalizeDestination));
  const checked: string[] = [];
  const unwound: ManagedMountNestingUnwound[] = [];
  for (const mount of nested) {
    const destination = normalizeDestination(mount.Destination);
    if (effective.has(destination)) {
      checked.push(mount.Destination);
      continue;
    }
    const nestedWithin = destinations
      .filter((candidate) => isNestedWithin(destination, candidate))
      .sort((a, b) => a.length - b.length)[0];
    unwound.push({
      destination: mount.Destination,
      source: mount.Source,
      nestedWithin: nestedWithin ?? "/",
    });
  }

  return {
    status: unwound.length > 0 ? "unwound" : "effective",
    checked,
    unwound,
    ...identity,
  };
}

function readContainerMountinfo(
  containerId: string,
  options: { timeoutMs?: number },
): string[] | null {
  const result = spawnSync("docker", ["exec", containerId, "cat", "/proc/self/mountinfo"], {
    encoding: "utf-8",
    timeout: options.timeoutMs ?? 5000,
    stdio: ["ignore", "pipe", "pipe"],
    ...networkDockerOptions(),
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const destinations = parseMountinfoDestinations(result.stdout);
  return destinations.length > 0 ? destinations : null;
}

/**
 * Read-only observation of one running container. Every failure to read the
 * container's own namespace is reported as `unverified` with a values-free
 * reason instead of a passing or failing nesting claim.
 */
export function observeManagedMountNesting(
  container: Pick<WorkspaceContainerSnapshot, "id" | "mounts">,
  options: { timeoutMs?: number } = {},
): ManagedMountNesting {
  const destinations = configuredDestinations(container.mounts);
  // Only a nested mount can be unwound, so a container that configures none
  // reports not-applicable without a read it could not use.
  const effective = destinations.some((_destination, index) => isNestedIndex(destinations, index))
    ? readContainerMountinfo(container.id, options)
    : null;
  return classifyManagedMountNesting(container.mounts, effective, container.id);
}
