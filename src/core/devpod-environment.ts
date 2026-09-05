import { spawnSync } from "node:child_process";
import path from "node:path";
import { sameWorkspacePath } from "./workspace";

export type WorkspaceContainerSnapshot = {
  id: string;
  state: {
    Running: boolean;
    Health?: { Status: string };
  };
  labels: Record<string, string | undefined>;
  mounts: Array<{ Type: string; Source: string; Destination: string }>;
  networks: Record<string, { Aliases?: string[] }>;
  /** Writable-layer bytes. Only present when inspected with `withSize`, and
   *  `null` when the daemon declines to report it. */
  sizeRw?: number | null;
  /** Writable layer plus the shared image layers beneath it. Same presence
   *  rules as `sizeRw`. */
  sizeRootFs?: number | null;
};

type ManagedStopContainerState = "running" | "exited" | "created";

export type ManagedStopContainerSnapshot = Omit<WorkspaceContainerSnapshot, "state"> & {
  state: Omit<WorkspaceContainerSnapshot["state"], "Running"> & {
    Status: ManagedStopContainerState;
    Running: boolean;
    Paused: false;
    Restarting: false;
    Dead: false;
  };
};

const SAFE_INSPECT_TEMPLATE =
  '{"id":{{json .Id}},"state":{"Running":{{json .State.Running}},"Health":{{with (index .State "Health")}}{"Status":{{json .Status}}}{{else}}null{{end}}},"labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}},"com.docker.compose.project.working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"com.docker.compose.project.config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"com.docker.compose.config-hash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}';

// Size reporting costs the daemon a filesystem walk per container, so it is
// requested only on demand. The keys are read through `index` rather than as
// `.SizeRw`, because direct field access on a container the daemon inspected
// without `--size` is a hard template error that fails the whole batch, while
// `index` yields null for that one container. Unlike a `{{with}}` guard it
// also preserves a genuine zero, which a container with an untouched writable
// layer legitimately reports.
const SIZE_INSPECT_TEMPLATE = SAFE_INSPECT_TEMPLATE.replace(
  /}$/,
  ',"sizeRw":{{json (index . "SizeRw")}},"sizeRootFs":{{json (index . "SizeRootFs")}}}',
);

const MANAGED_STOP_INSPECT_TEMPLATE =
  '{"id":{{json .Id}},"state":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"Paused":{{json .State.Paused}},"Restarting":{{json .State.Restarting}},"Dead":{{json .State.Dead}},"Health":{{with (index .State "Health")}}{"Status":{{json .Status}}}{{else}}null{{end}}},"labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}},"com.docker.compose.project.working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"com.docker.compose.project.config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"com.docker.compose.config-hash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}},"mounts":[{{range $index, $mount := .Mounts}}{{if $index}},{{end}}{"Type":{{json $mount.Type}},"Source":{{json $mount.Source}},"Destination":{{json $mount.Destination}}}{{end}}],"networks":{}}';

const MANAGED_STOP_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const FULL_CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const MANAGED_STOP_DOCKER_TIMEOUT_MS = 5_000;
const MANAGED_STOP_DOCKER_MAX_BUFFER = 1024 * 1024;
const MANAGED_STOP_COMPOSE_LABEL = "com.docker.compose.project";
const MANAGED_STOP_IDENTITY_LABELS = [
  "com.docker.compose.project",
  "com.docker.compose.service",
  "com.docker.compose.project.working_dir",
  "com.docker.compose.project.config_files",
  "com.docker.compose.config-hash",
] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFullContainerId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !FULL_CONTAINER_ID_PATTERN.test(value)) {
    throw new Error("Managed stop Docker inspection returned an invalid container id.");
  }
}

function assertUniqueContainerIds(ids: string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error("Managed stop Docker inspection returned duplicate container ids.");
  }
}

function parseDockerLines(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line === "")) {
    throw new Error("Managed stop Docker inspection returned an empty record.");
  }
  return lines;
}

function runManagedStopDocker(args: string[]): string {
  const result = spawnSync("docker", args, {
    encoding: "utf-8",
    timeout: MANAGED_STOP_DOCKER_TIMEOUT_MS,
    maxBuffer: MANAGED_STOP_DOCKER_MAX_BUFFER,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Managed stop Docker inspection failed.");
  }
  if (typeof result.stdout !== "string") {
    throw new Error("Managed stop Docker inspection returned invalid output.");
  }
  return result.stdout;
}

function listManagedStopContainerIds(composeProject: string): string[] {
  const stdout = runManagedStopDocker([
    "ps",
    "-a",
    "--no-trunc",
    "--filter",
    `label=${MANAGED_STOP_COMPOSE_LABEL}=${composeProject}`,
    "--format",
    "{{.ID}}",
  ]);
  const ids = parseDockerLines(stdout);
  ids.forEach(assertFullContainerId);
  assertUniqueContainerIds(ids);
  return ids;
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error("Managed stop Docker inspection returned an invalid field.");
  }
}

function validateManagedStopSnapshot(
  value: unknown,
  composeProject: string,
): ManagedStopContainerSnapshot {
  if (!isRecord(value)) {
    throw new Error("Managed stop Docker inspection returned an invalid record.");
  }

  assertFullContainerId(value.id);
  if (!isRecord(value.state)) {
    throw new Error("Managed stop Docker inspection returned an invalid state.");
  }
  const status = value.state.Status;
  if (status !== "running" && status !== "exited" && status !== "created") {
    throw new Error("Managed stop Docker inspection returned an invalid state status.");
  }
  if (typeof value.state.Running !== "boolean") {
    throw new Error("Managed stop Docker inspection returned an invalid running flag.");
  }
  if (typeof value.state.Paused !== "boolean" || value.state.Paused) {
    throw new Error("Managed stop Docker inspection returned an invalid paused flag.");
  }
  if (typeof value.state.Restarting !== "boolean" || value.state.Restarting) {
    throw new Error("Managed stop Docker inspection returned an invalid restarting flag.");
  }
  if (typeof value.state.Dead !== "boolean" || value.state.Dead) {
    throw new Error("Managed stop Docker inspection returned an invalid dead flag.");
  }
  if ((status === "running") !== value.state.Running) {
    throw new Error("Managed stop Docker inspection returned contradictory state.");
  }

  let health: { Status: string } | undefined;
  if (value.state.Health !== undefined && value.state.Health !== null) {
    if (!isRecord(value.state.Health)) {
      throw new Error("Managed stop Docker inspection returned an invalid health field.");
    }
    assertString(value.state.Health.Status);
    health = { Status: value.state.Health.Status };
  }

  if (!isRecord(value.labels)) {
    throw new Error("Managed stop Docker inspection returned invalid labels.");
  }
  for (const label of MANAGED_STOP_IDENTITY_LABELS) {
    assertString(value.labels[label]);
  }
  if (value.labels[MANAGED_STOP_COMPOSE_LABEL] !== composeProject) {
    throw new Error("Managed stop Docker inspection returned a foreign Compose project.");
  }

  if (!Array.isArray(value.mounts)) {
    throw new Error("Managed stop Docker inspection returned invalid mounts.");
  }
  const mounts = value.mounts.map((mount) => {
    if (!isRecord(mount)) {
      throw new Error("Managed stop Docker inspection returned an invalid mount.");
    }
    assertString(mount.Type);
    assertString(mount.Source);
    assertString(mount.Destination);
    return {
      Type: mount.Type,
      Source: mount.Source,
      Destination: mount.Destination,
    };
  });

  if (!isRecord(value.networks)) {
    throw new Error("Managed stop Docker inspection returned invalid networks.");
  }

  return {
    id: value.id,
    state: {
      ...(health ? { Health: health } : {}),
      Status: status,
      Running: value.state.Running,
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    labels: {
      "com.docker.compose.project": value.labels["com.docker.compose.project"] as string,
      "com.docker.compose.service": value.labels["com.docker.compose.service"] as string,
      "com.docker.compose.project.working_dir": value.labels[
        "com.docker.compose.project.working_dir"
      ] as string,
      "com.docker.compose.project.config_files": value.labels[
        "com.docker.compose.project.config_files"
      ] as string,
      "com.docker.compose.config-hash": value.labels["com.docker.compose.config-hash"] as string,
    },
    mounts,
    networks: {},
  };
}

function inspectManagedStopPopulation(
  ids: string[],
  composeProject: string,
): ManagedStopContainerSnapshot[] {
  const stdout = runManagedStopDocker([
    "inspect",
    "--format",
    MANAGED_STOP_INSPECT_TEMPLATE,
    ...ids,
  ]);
  const lines = parseDockerLines(stdout);
  if (lines.length !== ids.length) {
    throw new Error("Managed stop Docker inspection returned an incomplete population.");
  }

  const expected = new Set(ids);
  const seen = new Set<string>();
  const snapshots = lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error("Managed stop Docker inspection returned malformed JSON.");
    }
    const snapshot = validateManagedStopSnapshot(parsed, composeProject);
    if (!expected.has(snapshot.id) || seen.has(snapshot.id)) {
      throw new Error("Managed stop Docker inspection returned an unexpected population.");
    }
    seen.add(snapshot.id);
    return snapshot;
  });

  if (seen.size !== expected.size) {
    throw new Error("Managed stop Docker inspection returned an incomplete population.");
  }
  return snapshots;
}

function requireSameContainerPopulation(expected: string[], actual: string[]): void {
  if (expected.length !== actual.length) {
    throw new Error("Managed stop Docker inspection observed a changed population.");
  }
  const expectedSet = new Set(expected);
  if (actual.some((id) => !expectedSet.has(id))) {
    throw new Error("Managed stop Docker inspection observed a changed population.");
  }
}

export function inspectManagedStopContainers(
  composeProject: string,
): ManagedStopContainerSnapshot[] {
  if (
    typeof composeProject !== "string" ||
    composeProject.length === 0 ||
    composeProject !== composeProject.trim() ||
    !MANAGED_STOP_PROJECT_PATTERN.test(composeProject)
  ) {
    throw new Error("Managed stop Docker inspection requires a safe Compose project.");
  }

  const listedIds = listManagedStopContainerIds(composeProject);
  if (listedIds.length === 0) {
    const confirmedIds = listManagedStopContainerIds(composeProject);
    requireSameContainerPopulation(listedIds, confirmedIds);
    return [];
  }

  const snapshots = inspectManagedStopPopulation(listedIds, composeProject);
  const confirmedIds = listManagedStopContainerIds(composeProject);
  requireSameContainerPopulation(listedIds, confirmedIds);
  return snapshots;
}

export function inspectWorkspaceContainers(options?: {
  withSize?: boolean;
  ids?: string[];
  composeProject?: string;
}): WorkspaceContainerSnapshot[] {
  let ids = options?.ids;
  if (!ids) {
    const listed = spawnSync(
      "docker",
      [
        "ps",
        "-a",
        ...(options?.composeProject
          ? ["--filter", `label=com.docker.compose.project=${options.composeProject}`]
          : []),
        "--format",
        "{{.ID}}",
      ],
      { encoding: "utf-8" },
    );
    if (listed.status !== 0) {
      // `listed.error` carries the spawn failure itself (ENOENT when the docker
      // binary is absent), where stdout and stderr are both null; without it a
      // missing daemon reports only "unknown error".
      throw new Error(
        `docker ps failed: ${(listed.stderr || listed.stdout || listed.error?.message || "unknown error").trim()}`,
      );
    }
    ids = listed.stdout
      .split(/\r?\n/)
      .map((id) => id.trim())
      .filter(Boolean);
  }
  if (ids.length === 0) return [];

  const template = options?.withSize ? SIZE_INSPECT_TEMPLATE : SAFE_INSPECT_TEMPLATE;
  const inspected = spawnSync(
    "docker",
    ["inspect", ...(options?.withSize ? ["--size"] : []), "--format", template, ...ids],
    { encoding: "utf-8" },
  );
  if (inspected.status !== 0) {
    throw new Error(
      `docker inspect failed: ${(inspected.stderr || inspected.stdout || "unknown error").trim()}`,
    );
  }
  return inspected.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkspaceContainerSnapshot);
}

export function workspaceAppContainers(
  containers: WorkspaceContainerSnapshot[],
  repoPath: string,
): WorkspaceContainerSnapshot[] {
  return containers.filter((container) => {
    const workingDir = container.labels["com.docker.compose.project.working_dir"];
    return (
      Boolean(workingDir && sameWorkspacePath(workingDir, path.join(repoPath, ".devcontainer"))) &&
      container.mounts.some(
        (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, repoPath),
      )
    );
  });
}

export function hasExactComposeIdentity(
  container: WorkspaceContainerSnapshot,
  options: {
    repoPath: string;
    service: string;
    composeProject?: string;
    composeFiles?: string[];
  },
): boolean {
  if (
    (options.composeProject !== undefined &&
      container.labels["com.docker.compose.project"] !== options.composeProject) ||
    container.labels["com.docker.compose.service"] !== options.service ||
    !sameWorkspacePath(
      container.labels["com.docker.compose.project.working_dir"] ?? "",
      path.join(options.repoPath, ".devcontainer"),
    )
  ) {
    return false;
  }
  const expectedFiles = options.composeFiles;
  if (!expectedFiles) return true;

  const actualFiles = (container.labels["com.docker.compose.project.config_files"] ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  const providerGeneratedFiles = actualFiles.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    return /\/(?:\.devpod\/agent\/contexts\/[^/]+\/workspaces\/[^/]+|\.devsy\/contexts\/[^/]+\/workspaces\/[^/]+\/agent)\/\.docker-compose\/docker-compose\.devcontainer\.containerFeatures-[^/]+\.yml$/.test(
      normalized,
    );
  });
  return (
    actualFiles.length === expectedFiles.length + providerGeneratedFiles.length &&
    expectedFiles.every((expected) =>
      actualFiles.some((actual) => sameWorkspacePath(actual, expected)),
    ) &&
    actualFiles.every(
      (actual) =>
        providerGeneratedFiles.includes(actual) ||
        expectedFiles.some((expected) => sameWorkspacePath(actual, expected)),
    )
  );
}

export function resolveRunningWorkspaceContainer(repoPath: string): {
  id: string;
  workspacePath: string;
} {
  const matches = workspaceAppContainers(inspectWorkspaceContainers(), repoPath).filter(
    (container) => container.state.Running,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one running workspace app container for '${repoPath}', found ${matches.length}.`,
    );
  }
  const container = matches[0];
  const repoMount = container.mounts.find(
    (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, repoPath),
  );
  if (!repoMount) {
    throw new Error(`Workspace app container no longer mounts '${repoPath}'.`);
  }
  return { id: container.id, workspacePath: repoMount.Destination };
}
