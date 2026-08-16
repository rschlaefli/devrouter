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

const SAFE_INSPECT_TEMPLATE =
  '{"id":{{json .Id}},"state":{"Running":{{json .State.Running}},"Health":{{with (index .State "Health")}}{"Status":{{json .Status}}}{{else}}null{{end}}},"labels":{"com.docker.compose.project.working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"com.docker.compose.project.config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}';

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

export function inspectWorkspaceContainers(options?: {
  withSize?: boolean;
  ids?: string[];
}): WorkspaceContainerSnapshot[] {
  let ids = options?.ids;
  if (!ids) {
    const listed = spawnSync("docker", ["ps", "-a", "--format", "{{.ID}}"], {
      encoding: "utf-8",
    });
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
