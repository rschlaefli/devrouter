import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";
import { withMutationLock as withDevpodMutationLock } from "./devpod-mutation";
import { listMergedRuntimeWorkspaces } from "./devpod-workspaces";
import { withMutationLock as withDevsyMutationLock } from "./devsy-mutation";
import { listGitWorktrees, listWorkspaceOwnership } from "./workspace-ownership";
import { getWorkspaceRegistrySnapshots, resetWorkspaceRuntimeCaches } from "./workspace-runtime";
import { byteOrder, canonicalJson, requireManifestHash, sha256Hex } from "./worktree-reclaim";

/**
 * Docker leftovers are the Compose containers, volumes and networks a
 * devcontainer stack keeps after its checkout folder was deleted. Provider
 * deletion removes only the registration, so nothing else ever removes them.
 * A stack counts as a leftover only when a provider-created container proves
 * the vanished checkout lay inside this repository's `trees/` folder.
 */

export const LEFTOVER_MANIFEST_KIND = "docker-leftover-manifest";
const LEFTOVER_RECEIPT_KIND = "docker-leftover-receipt";
const SCHEMA_VERSION = 1;
const MAX_DOCKER_OBJECTS = 5000;
const FUTURE_TOLERANCE_SECONDS = 300;
const PROJECT_LABEL = "com.docker.compose.project";
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const PROVIDER_LABEL = "dev.containers.id";
const STOPPED_STATES = new Set(["exited", "dead", "created"]);
const HEX_ID = /^[0-9a-f]{64}$/;

export type DockerContainer = {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  /** Names of the volumes this container mounts. */
  volumes: string[];
};
export type DockerVolume = { name: string; labels: Record<string, string>; createdAt: string };
export type DockerNetwork = {
  id: string;
  name: string;
  labels: Record<string, string>;
  attached: number;
};
export type DockerInventory = {
  daemonId: string;
  containers: DockerContainer[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
};

export class DockerListingBoundError extends Error {}

export type DockerRunner = (args: string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

const defaultDockerRunner: DockerRunner = (args) => {
  const result = spawnSync("docker", args, {
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
};

function dockerOutput(run: DockerRunner, args: string[]): string {
  const result = run(args);
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim() || "unknown error"}`);
  }
  return result.stdout;
}

function listIds(run: DockerRunner, args: string[], kind: string): string[] {
  const ids = dockerOutput(run, args)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length > MAX_DOCKER_OBJECTS) {
    throw new DockerListingBoundError(
      `docker lists ${ids.length} ${kind}; the leftover report reads at most ${MAX_DOCKER_OBJECTS}`,
    );
  }
  return ids;
}

function inspectAll(run: DockerRunner, command: string[], ids: string[]): unknown[] {
  const objects: unknown[] = [];
  for (let start = 0; start < ids.length; start += 200) {
    const parsed = JSON.parse(dockerOutput(run, [...command, ...ids.slice(start, start + 200)]));
    if (!Array.isArray(parsed)) throw new Error(`docker ${command.join(" ")} returned no array`);
    objects.push(...parsed);
  }
  return objects;
}

function labelsOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * Every container and volume (any container may mount a Compose volume), plus
 * the Compose-labelled networks, with the daemon identity that binds
 * an approved manifest to this Docker engine.
 */
export function readDockerInventory(run: DockerRunner = defaultDockerRunner): DockerInventory {
  const daemonId = dockerOutput(run, ["info", "--format", "{{.ID}}"]).trim();
  if (!daemonId) throw new Error("docker info returned no daemon ID");
  const containerIds = listIds(run, ["ps", "-a", "-q", "--no-trunc"], "containers");
  const containers = inspectAll(run, ["container", "inspect"], containerIds).map((raw) => {
    const entry = raw as {
      Id: string;
      Name?: string;
      State?: { Status?: string };
      Config?: { Labels?: unknown };
      Mounts?: { Type?: string; Name?: string }[];
    };
    return {
      id: entry.Id,
      name: (entry.Name ?? "").replace(/^\//, ""),
      state: entry.State?.Status ?? "unknown",
      labels: labelsOf(entry.Config?.Labels),
      volumes: (entry.Mounts ?? [])
        .filter((mount) => mount.Type === "volume" && mount.Name)
        .map((mount) => mount.Name as string),
    };
  });
  // Every volume, so anonymous volumes (which carry no Compose label) can be
  // listed in a manifest and found again after their container is gone.
  const volumeNames = listIds(run, ["volume", "ls", "-q"], "volumes");
  const volumes = inspectAll(run, ["volume", "inspect"], volumeNames).map((raw) => {
    const entry = raw as { Name: string; Labels?: unknown; CreatedAt?: string };
    return { name: entry.Name, labels: labelsOf(entry.Labels), createdAt: entry.CreatedAt ?? "" };
  });
  const networkIds = listIds(
    run,
    ["network", "ls", "-q", "--no-trunc", "--filter", `label=${PROJECT_LABEL}`],
    "networks",
  );
  const networks = inspectAll(run, ["network", "inspect"], networkIds).map((raw) => {
    const entry = raw as { Id: string; Name: string; Labels?: unknown; Containers?: object };
    return {
      id: entry.Id,
      name: entry.Name,
      labels: labelsOf(entry.Labels),
      attached: Object.keys(entry.Containers ?? {}).length,
    };
  });
  return { daemonId, containers, volumes, networks };
}

export type LeftoverContext = {
  /** `<repo>/trees` as the repository spells it. */
  treesPath: string;
  /** Live Git registrations, ownership records and provider registrations. */
  worktreePaths: string[];
  ownershipPaths: string[];
  providerPaths: string[];
  /** False when a provider registry could not be read; nothing is then removable. */
  registriesReadable: boolean;
  /** `undefined` for a missing path; any other error counts as present. */
  realpath: (file: string) => string | undefined;
  exists: (file: string) => boolean;
};

export type DockerLeftover = {
  project: string;
  checkout: string;
  containers: { id: string; name: string; state: string }[];
  volumes: { name: string; createdAt: string }[];
  networks: { id: string; name: string }[];
};

export type DockerLeftoverBlocked = {
  project: string;
  checkout: string;
  reason: string;
  next: "workspace gc" | "git worktree prune" | "stop the stack" | "investigate";
};

export type UnattributedVolume = { name: string; project: string; reason: string };

export type DockerLeftoverReport = {
  daemonId: string;
  leftovers: DockerLeftover[];
  blocked: DockerLeftoverBlocked[];
  unattributedVolumes: UnattributedVolume[];
};

function checkoutOf(workingDir: string): string {
  return workingDir.replace(/\/+$/, "").replace(/\/\.devcontainer$/, "");
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Anonymous volumes have a 64-hex name and no Compose project label. */
function isAnonymousVolume(volume: DockerVolume): boolean {
  return /^[0-9a-f]{64}$/.test(volume.name) && !volume.labels[PROJECT_LABEL];
}

/**
 * Where a vanished checkout sits relative to this repository's `trees/`
 * folder. The label path must name a folder below `trees/` (as spelled or
 * resolved) and be absent, and its nearest existing ancestor must still
 * resolve inside the real `trees/` folder, which rules out an unmounted volume
 * or a re-pointed symlink. `inside-worktree` means an existing ancestor below
 * `trees/` is itself a checkout, so only a subfolder of live work is missing.
 */
function vanishedInsideTrees(
  checkout: string,
  context: LeftoverContext,
): "vanished" | "inside-worktree" | "out-of-scope" {
  const treesReal = context.realpath(context.treesPath);
  if (!treesReal) return "out-of-scope";
  const lexical = [context.treesPath, treesReal].some(
    (prefix) => checkout !== prefix && isInsideOrEqual(prefix, checkout),
  );
  if (!lexical || context.exists(checkout)) return "out-of-scope";
  let ancestor = path.dirname(checkout);
  while (!context.exists(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return "out-of-scope";
    ancestor = parent;
  }
  const ancestorReal = context.realpath(ancestor);
  if (ancestorReal === undefined || !isInsideOrEqual(treesReal, ancestorReal)) {
    return "out-of-scope";
  }
  for (let current = ancestor; ; current = path.dirname(current)) {
    const real = context.realpath(current);
    if (real === undefined || real === treesReal || !isInsideOrEqual(treesReal, real)) break;
    if (context.exists(path.join(current, ".git"))) return "inside-worktree";
  }
  return "vanished";
}

function resolved(file: string, context: LeftoverContext): string[] {
  const real = context.realpath(file);
  return real && real !== path.resolve(file) ? [path.resolve(file), real] : [path.resolve(file)];
}

/**
 * How a registered path relates to the checkout: the same folder, or a
 * checkout below `trees/` that contains it. The primary checkout contains
 * `trees/` itself and so never counts as containing.
 */
function relation(
  entry: string,
  checkout: string,
  context: LeftoverContext,
): "same" | "contains" | undefined {
  const entries = resolved(entry, context);
  const checkouts = resolved(checkout, context);
  if (entries.some((left) => checkouts.includes(left))) return "same";
  const trees = resolved(context.treesPath, context);
  const belowTrees = (left: string) =>
    trees.some((root) => left !== root && isInsideOrEqual(root, left));
  if (
    entries.some(
      (left) => belowTrees(left) && checkouts.some((right) => isInsideOrEqual(left, right)),
    )
  ) {
    return "contains";
  }
  return undefined;
}

/** Classifies every Compose project on the engine against this repository. */
export function findDockerLeftovers(
  inventory: DockerInventory,
  context: LeftoverContext,
): DockerLeftoverReport {
  const byProject = new Map<string, DockerContainer[]>();
  for (const container of inventory.containers) {
    const project = container.labels[PROJECT_LABEL];
    if (!project) continue;
    byProject.set(project, [...(byProject.get(project) ?? []), container]);
  }
  const leftovers: DockerLeftover[] = [];
  const blocked: DockerLeftoverBlocked[] = [];
  for (const [project, containers] of [...byProject].sort(([a], [b]) => byteOrder(a, b))) {
    // Every container's working directory counts, so a project name shared
    // with another checkout's containers never qualifies.
    const checkouts = new Set(
      containers
        .filter((container) => container.labels[WORKING_DIR_LABEL])
        .map((container) => checkoutOf(container.labels[WORKING_DIR_LABEL])),
    );
    if (checkouts.size !== 1) continue;
    if (!containers.some((container) => container.labels[PROVIDER_LABEL])) continue;
    const [checkout] = checkouts;
    const scope = vanishedInsideTrees(checkout, context);
    if (scope === "out-of-scope") continue;
    const block = (reason: string, next: DockerLeftoverBlocked["next"]) =>
      blocked.push({ project, checkout, reason, next });
    if (scope === "inside-worktree") {
      block("the missing folder lies inside an existing checkout", "investigate");
      continue;
    }
    if (!context.registriesReadable) {
      block("a provider registry could not be read", "investigate");
      continue;
    }
    const registered = (paths: string[]) =>
      paths.map((entry) => relation(entry, checkout, context));
    const all = [
      ...registered(context.worktreePaths),
      ...registered([...context.ownershipPaths, ...context.providerPaths]),
    ];
    if (all.includes("contains")) {
      block("a registered checkout contains the missing folder", "investigate");
      continue;
    }
    if (registered(context.worktreePaths).includes("same")) {
      block("Git still registers the vanished worktree", "git worktree prune");
      continue;
    }
    if (all.includes("same")) {
      block("a devrouter record or provider registration still names the checkout", "workspace gc");
      continue;
    }
    const running = containers.filter((container) => !STOPPED_STATES.has(container.state));
    if (running.length) {
      block(`${running.length} container(s) are not stopped`, "stop the stack");
      continue;
    }
    leftovers.push(removableSet(project, checkout, containers, inventory));
  }
  return {
    daemonId: inventory.daemonId,
    leftovers,
    blocked,
    unattributedVolumes: unattributedVolumes(inventory, byProject),
  };
}

function removableSet(
  project: string,
  checkout: string,
  containers: DockerContainer[],
  inventory: DockerInventory,
): DockerLeftover {
  const own = new Set(containers.map((container) => container.id));
  const mountedHere = new Set(containers.flatMap((container) => container.volumes));
  const mountedElsewhere = new Set(
    inventory.containers
      .filter((container) => !own.has(container.id))
      .flatMap((container) => container.volumes),
  );
  return {
    project,
    checkout,
    containers: containers
      .map(({ id, name, state }) => ({ id, name, state }))
      .sort((a, b) => byteOrder(a.id, b.id)),
    volumes: inventory.volumes
      .filter(
        (volume) =>
          !mountedElsewhere.has(volume.name) &&
          ((volume.labels[PROJECT_LABEL] === project && volume.name.startsWith(`${project}_`)) ||
            (isAnonymousVolume(volume) && mountedHere.has(volume.name))),
      )
      .map(({ name, createdAt }) => ({ name, createdAt }))
      .sort((a, b) => byteOrder(a.name, b.name)),
    networks: inventory.networks
      .filter(
        (network) =>
          network.labels[PROJECT_LABEL] === project &&
          network.name.startsWith(`${project}_`) &&
          network.attached === 0,
      )
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => byteOrder(a.id, b.id)),
  };
}

function unattributedVolumes(
  inventory: DockerInventory,
  byProject: Map<string, DockerContainer[]>,
): UnattributedVolume[] {
  const mounted = new Set(inventory.containers.flatMap((container) => container.volumes));
  return inventory.volumes
    .filter(
      (volume) =>
        volume.labels[PROJECT_LABEL] !== undefined &&
        !byProject.has(volume.labels[PROJECT_LABEL]) &&
        !mounted.has(volume.name),
    )
    .map((volume) => ({
      name: volume.name,
      project: volume.labels[PROJECT_LABEL],
      reason: "no container of its Compose project remains, so no checkout can be proven",
    }))
    .sort((a, b) => byteOrder(a.name, b.name));
}

/** The live context for one repository; registries are re-read, never cached. */
export function readLeftoverContext(repoPath: string): LeftoverContext {
  resetWorkspaceRuntimeCaches();
  const snapshots = getWorkspaceRegistrySnapshots();
  return {
    treesPath: path.join(repoPath, "trees"),
    worktreePaths: listGitWorktrees(repoPath).map((worktree) => worktree.path),
    ownershipPaths: listWorkspaceOwnership(repoPath).map((record) => record.worktreePath),
    providerPaths: listMergedRuntimeWorkspaces().map((workspace) => workspace.source.localFolder),
    registriesReadable: snapshots.unavailable.length === 0,
    realpath: (file) => {
      try {
        return fs.realpathSync.native(file);
      } catch {
        return undefined;
      }
    },
    exists: (file) => {
      try {
        fs.lstatSync(file);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ENOENT";
      }
    },
  };
}

export type LeftoverCandidate = DockerLeftover & { id: string };

export type LeftoverManifest = {
  kind: typeof LEFTOVER_MANIFEST_KIND;
  schemaVersion: 1;
  repo: string;
  daemonId: string;
  createdAtEpoch: number;
  candidateCount: number;
  candidates: LeftoverCandidate[];
};

export function leftoverCandidateId(daemonId: string, leftover: DockerLeftover): string {
  return sha256Hex(canonicalJson({ daemonId, ...leftover }));
}

export function buildLeftoverManifest(
  repo: string,
  report: DockerLeftoverReport,
  createdAtEpoch: number,
): string {
  const manifest: LeftoverManifest = {
    kind: LEFTOVER_MANIFEST_KIND,
    schemaVersion: SCHEMA_VERSION,
    repo,
    daemonId: report.daemonId,
    createdAtEpoch,
    candidateCount: report.leftovers.length,
    candidates: report.leftovers.map((leftover) => ({
      ...leftover,
      id: leftoverCandidateId(report.daemonId, leftover),
    })),
  };
  validateLeftoverManifest(manifest);
  return canonicalJson(manifest);
}

function requireExactKeys(value: object, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} fields must be exactly: ${[...keys].sort().join(", ")}`);
  }
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function requireSortedUnique(values: string[], label: string): void {
  const sorted = [...new Set(values)].sort(byteOrder);
  if (sorted.length !== values.length || sorted.some((entry, index) => entry !== values[index])) {
    throw new Error(`${label} must be sorted and unique`);
  }
}

export function isLeftoverManifest(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === LEFTOVER_MANIFEST_KIND
  );
}

export function validateLeftoverManifest(value: unknown): LeftoverManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest root must be an object");
  }
  const root = value as Record<string, unknown>;
  if (root.kind !== LEFTOVER_MANIFEST_KIND) {
    throw new Error(`manifest kind must be ${LEFTOVER_MANIFEST_KIND}`);
  }
  requireExactKeys(
    root,
    ["candidateCount", "candidates", "createdAtEpoch", "daemonId", "kind", "repo", "schemaVersion"],
    "manifest",
  );
  if (root.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`manifest schemaVersion must be ${SCHEMA_VERSION}`);
  }
  requireString(root.repo, "manifest repo");
  if (!path.isAbsolute(root.repo)) throw new Error("manifest repo must be an absolute path");
  requireString(root.daemonId, "manifest daemonId");
  if (!Number.isInteger(root.createdAtEpoch) || (root.createdAtEpoch as number) < 0) {
    throw new Error("manifest createdAtEpoch must be a non-negative integer");
  }
  if (!Array.isArray(root.candidates) || root.candidateCount !== root.candidates.length) {
    throw new Error("manifest candidateCount does not match candidates");
  }
  const daemonId = root.daemonId;
  root.candidates.forEach((raw, index) => {
    const label = `candidate[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${label} must be an object`);
    }
    const candidate = raw as Record<string, unknown>;
    requireExactKeys(
      candidate,
      ["checkout", "containers", "id", "networks", "project", "volumes"],
      label,
    );
    requireString(candidate.project, `${label}.project`);
    requireString(candidate.checkout, `${label}.checkout`);
    if (!path.isAbsolute(candidate.checkout)) {
      throw new Error(`${label}.checkout must be an absolute path`);
    }
    const members = [
      ["containers", ["id", "name", "state"], "id"],
      ["volumes", ["createdAt", "name"], "name"],
      ["networks", ["id", "name"], "id"],
    ] as const;
    for (const [key, fields, sortKey] of members) {
      const list = candidate[key];
      if (!Array.isArray(list)) throw new Error(`${label}.${key} must be an array`);
      for (const member of list as Record<string, unknown>[]) {
        requireExactKeys(member, [...fields], `${label}.${key}[]`);
        for (const field of fields) {
          if (field !== "createdAt") requireString(member[field], `${label}.${key}[].${field}`);
        }
      }
      requireSortedUnique(
        (list as Record<string, string>[]).map((member) => member[sortKey]),
        `${label}.${key}`,
      );
    }
    if (!(candidate.containers as unknown[]).length) {
      throw new Error(`${label}.containers must prove the checkout with at least one container`);
    }
    if (!HEX_ID.test(String(candidate.id))) throw new Error(`${label}.id is not a SHA-256`);
    const { id, ...leftover } = candidate as LeftoverCandidate;
    if (id !== leftoverCandidateId(daemonId, leftover)) {
      throw new Error(`${label}.id does not match its contents`);
    }
  });
  requireSortedUnique(
    (root.candidates as LeftoverCandidate[]).map((candidate) => candidate.project),
    "manifest candidate projects",
  );
  return root as unknown as LeftoverManifest;
}

export function readLeftoverManifest(file: string): { raw: Buffer; manifest: LeftoverManifest } {
  const raw = fs.readFileSync(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch (error) {
    throw new Error(`manifest is not valid UTF-8 JSON: ${(error as Error).message}`);
  }
  const manifest = validateLeftoverManifest(parsed);
  if (canonicalJson(parsed) !== raw.toString("utf-8")) {
    throw new Error("manifest is not in canonical JSON form");
  }
  return { raw, manifest };
}

export type LeftoverSkipCode = "changed" | "blocked" | "daemon-mismatch";
export type LeftoverTargetOutcome = {
  id: string;
  project: string;
  status: "removed" | "already-done" | "would-remove" | "skipped" | "failed";
  code?: LeftoverSkipCode | "teardown-failed" | "environment";
  reason?: string;
  /** `removed-container:<id>`, `gone-volume:<name>` and so on, in order. */
  steps: string[];
};
export type LeftoverApplyReport = {
  manifestSha256: string;
  dryRun: boolean;
  targets: LeftoverTargetOutcome[];
};

export type LeftoverApplyDependencies = {
  readInventory?: () => DockerInventory;
  readContext?: (repo: string) => LeftoverContext;
  run?: DockerRunner;
  commonDir?: (repo: string) => string;
  /** Holds both provider mutation locks (Devsy, then DevPod) around one project. */
  withLocks?: <T>(target: string, operation: () => T) => T;
  nowEpoch?: () => number;
};

class LeftoverSkip extends Error {
  constructor(
    readonly code: LeftoverSkipCode,
    message: string,
  ) {
    super(message);
  }
}

const defaultWithLocks = <T>(target: string, operation: () => T): T =>
  withDevsyMutationLock("Docker leftover removal", target, () =>
    withDevpodMutationLock("Docker leftover removal", target, operation),
  );

function gitCommonDir(repo: string): string {
  const result = spawnSync(
    "git",
    ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf-8" },
  );
  const commonDir = result.stdout?.trim();
  if (result.status !== 0 || !commonDir)
    throw new Error(`cannot read the Git directory of ${repo}`);
  return commonDir;
}

/**
 * What of an approved candidate may be removed now. While a container of the
 * project remains, the current attribution must still classify it as the same
 * leftover; once all containers are gone (a rerun after a partial apply) the
 * remaining approved volumes and networks must still be unused and unchanged.
 */
function currentRemovals(
  candidate: LeftoverCandidate,
  inventory: DockerInventory,
  context: LeftoverContext,
): DockerLeftover {
  const report = findDockerLeftovers(inventory, context);
  const projectContainers = inventory.containers.filter(
    (container) => container.labels[PROJECT_LABEL] === candidate.project,
  );
  let current: DockerLeftover;
  if (projectContainers.length) {
    const blocked = report.blocked.find((entry) => entry.project === candidate.project);
    if (blocked) throw new LeftoverSkip("blocked", `${blocked.reason}; next: ${blocked.next}`);
    const leftover = report.leftovers.find((entry) => entry.project === candidate.project);
    if (!leftover || leftover.checkout !== candidate.checkout) {
      throw new LeftoverSkip("changed", "the project is no longer a leftover of this checkout");
    }
    current = leftover;
  } else {
    if (context.exists(candidate.checkout)) {
      throw new LeftoverSkip("changed", "the checkout folder exists again");
    }
    const mounted = new Set(inventory.containers.flatMap((container) => container.volumes));
    const ours = (object: { name: string; labels: Record<string, string> }) =>
      object.labels[PROJECT_LABEL] === candidate.project &&
      object.name.startsWith(`${candidate.project}_`);
    current = {
      project: candidate.project,
      checkout: candidate.checkout,
      containers: [],
      volumes: inventory.volumes
        .filter(
          (volume) =>
            !mounted.has(volume.name) &&
            (ours(volume) ||
              (isAnonymousVolume(volume) &&
                candidate.volumes.some((approved) => approved.name === volume.name))),
        )
        .map(({ name, createdAt }) => ({ name, createdAt })),
      networks: inventory.networks
        .filter((network) => ours(network) && network.attached === 0)
        .map(({ id, name }) => ({ id, name })),
    };
  }
  const approve = <T>(present: T[], approved: T[], key: (entry: T) => string, kind: string) => {
    const allowed = new Set(approved.map(key));
    const extra = present.filter((entry) => !allowed.has(key(entry)));
    if (extra.length) {
      throw new LeftoverSkip("changed", `${extra.length} unapproved ${kind} now belong to it`);
    }
  };
  approve(current.containers, candidate.containers, (entry) => entry.id, "container(s)");
  approve(
    current.volumes,
    candidate.volumes,
    (entry) => `${entry.name}\0${entry.createdAt}`,
    "volume(s)",
  );
  approve(current.networks, candidate.networks, (entry) => entry.id, "network(s)");
  // Approved members that are no longer removable (now mounted elsewhere, or
  // re-created) must not be touched; members that are simply gone are done.
  const stillPresent = (name: string) => inventory.volumes.some((volume) => volume.name === name);
  const notRemovable = candidate.volumes.filter(
    (volume) =>
      stillPresent(volume.name) && !current.volumes.some((entry) => entry.name === volume.name),
  );
  if (notRemovable.length) {
    throw new LeftoverSkip(
      "changed",
      `${notRemovable.length} approved volume(s) are now in use or re-created`,
    );
  }
  return current;
}

function removeMember(run: DockerRunner, args: string[], step: string, steps: string[]): void {
  const result = run(args);
  if (result.status === 0) {
    steps.push(`removed-${step}`);
    return;
  }
  if (/no such (container|volume|network)/i.test(result.stderr)) {
    steps.push(`gone-${step}`);
    return;
  }
  throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
}

/**
 * Applies an approved leftover manifest. Without `yes` it is a dry run. Each
 * project is re-derived inside both provider mutation locks immediately before
 * removal; a changed project is skipped and the others continue. Containers go
 * first, then the approved named and anonymous volumes, then networks.
 */
export function applyLeftoverManifest(
  options: { manifestFile: string; sha256: string; maxAgeSeconds: number; yes: boolean },
  dependencies: LeftoverApplyDependencies = {},
): LeftoverApplyReport {
  const { raw, manifest } = readLeftoverManifest(options.manifestFile);
  const manifestSha256 = requireManifestHash(raw, options.sha256);
  const now = dependencies.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
  if (manifest.createdAtEpoch > now + FUTURE_TOLERANCE_SECONDS) {
    throw new Error("manifest creation time is in the future");
  }
  const age = Math.max(0, now - manifest.createdAtEpoch);
  if (age > options.maxAgeSeconds) {
    throw new Error(`manifest is ${age}s old; maximum allowed age is ${options.maxAgeSeconds}s`);
  }
  if (!manifest.candidates.length) throw new Error("approved manifest is empty");
  const run = dependencies.run ?? defaultDockerRunner;
  const readInventory = dependencies.readInventory ?? (() => readDockerInventory(run));
  const readContext = dependencies.readContext ?? readLeftoverContext;
  const withLocks = dependencies.withLocks ?? defaultWithLocks;

  const targets: LeftoverTargetOutcome[] = [];
  for (const candidate of manifest.candidates) {
    const outcome: LeftoverTargetOutcome = {
      id: candidate.id,
      project: candidate.project,
      status: "skipped",
      steps: [],
    };
    targets.push(outcome);
    try {
      withLocks(candidate.project, () => {
        const inventory = readInventory();
        if (inventory.daemonId !== manifest.daemonId) {
          throw new LeftoverSkip(
            "daemon-mismatch",
            "the manifest was made for another Docker engine",
          );
        }
        const current = currentRemovals(candidate, inventory, readContext(manifest.repo));
        const count = current.containers.length + current.volumes.length + current.networks.length;
        if (count === 0) {
          outcome.status = "already-done";
          return;
        }
        if (!options.yes) {
          outcome.status = "would-remove";
          outcome.reason = `${current.containers.length} container(s), ${current.volumes.length} volume(s), ${current.networks.length} network(s)`;
          return;
        }
        // The provider-created container proves which checkout the stack
        // belongs to, so it goes last: a rerun after a partial removal can
        // then still attribute the remaining containers.
        const proves = (id: string) =>
          Boolean(
            inventory.containers.find((container) => container.id === id)?.labels[PROVIDER_LABEL],
          );
        const ordered = [
          ...current.containers.filter((container) => !proves(container.id)),
          ...current.containers.filter((container) => proves(container.id)),
        ];
        for (const container of ordered) {
          removeMember(run, ["rm", container.id], `container:${container.id}`, outcome.steps);
        }
        for (const volume of current.volumes) {
          removeMember(run, ["volume", "rm", volume.name], `volume:${volume.name}`, outcome.steps);
        }
        for (const network of current.networks) {
          removeMember(
            run,
            ["network", "rm", network.id],
            `network:${network.name}`,
            outcome.steps,
          );
        }
        writeLeftoverReceipt(
          (dependencies.commonDir ?? gitCommonDir)(manifest.repo),
          manifestSha256,
          candidate,
          outcome.steps,
          now,
        );
        outcome.status = "removed";
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.reason = message;
      if (error instanceof LeftoverSkip) {
        outcome.code = error.code;
        continue;
      }
      outcome.status = "failed";
      outcome.code = outcome.steps.length ? "teardown-failed" : "environment";
    }
  }
  return { manifestSha256, dryRun: !options.yes, targets };
}

export function leftoverReceiptPath(commonDir: string, manifestSha256: string, id: string): string {
  return path.join(commonDir, "devrouter-leftovers", "receipts", manifestSha256, `${id}.json`);
}

function writeLeftoverReceipt(
  commonDir: string,
  manifestSha256: string,
  candidate: LeftoverCandidate,
  steps: string[],
  nowEpoch: number,
): void {
  const file = leftoverReceiptPath(commonDir, manifestSha256, candidate.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomically(
    file,
    canonicalJson({
      candidateId: candidate.id,
      checkout: candidate.checkout,
      completedAtEpoch: nowEpoch,
      kind: LEFTOVER_RECEIPT_KIND,
      manifestSha256,
      project: candidate.project,
      schemaVersion: SCHEMA_VERSION,
      steps,
      tool: "devrouter",
    }),
  );
}
