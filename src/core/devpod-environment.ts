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
};

const SAFE_INSPECT_TEMPLATE =
  '{"id":{{json .Id}},"state":{"Running":{{json .State.Running}},"Health":{{with (index .State "Health")}}{"Status":{{json .Status}}}{{else}}null{{end}}},"labels":{"com.docker.compose.project.working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"com.docker.compose.project.config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}';

export function inspectWorkspaceContainers(): WorkspaceContainerSnapshot[] {
  const listed = spawnSync("docker", ["ps", "-a", "--format", "{{.ID}}"], {
    encoding: "utf-8",
  });
  if (listed.status !== 0) {
    throw new Error(
      `docker ps failed: ${(listed.stderr || listed.stdout || "unknown error").trim()}`,
    );
  }
  const ids = listed.stdout
    .split(/\r?\n/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return [];

  const inspected = spawnSync("docker", ["inspect", "--format", SAFE_INSPECT_TEMPLATE, ...ids], {
    encoding: "utf-8",
  });
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
