import {
  listDevpodWorkspaces,
  mutateOwnedDevpodWorkspace,
  selectDevpodWorkspace,
} from "./devpod-workspaces";
import { removeHostRoutesWhere } from "./host-routes";
import {
  isLinkedWorktree,
  resolveWorktreeWorkspace,
  sameWorkspacePath,
  withWorkspaceLifecycleLock,
} from "./workspace";
import { workspaceDeleteOwnedPath, workspaceStopOwnedPath } from "./workspace-lifecycle";
import { listGitWorktrees, listWorkspaceOwnership } from "./workspace-ownership";

export type EnvironmentStopResult = {
  kind: "primary" | "linked";
  repoPath: string;
  workspace?: string;
  devpodId?: string;
  stopped: boolean;
  deleted?: boolean;
  freedRoutes: number;
};

export async function environmentStop(
  repoPath: string,
  options: { delete?: boolean } = {},
): Promise<EnvironmentStopResult> {
  const linked = isLinkedWorktree(repoPath);
  const workspace = linked ? resolveWorktreeWorkspace(repoPath) : undefined;
  if (linked && !workspace) {
    throw new Error(`Linked checkout '${repoPath}' does not yield a valid workspace token.`);
  }

  if (linked && workspace) {
    const matchingRecords = listWorkspaceOwnership(repoPath).filter((record) =>
      sameWorkspacePath(record.worktreePath, repoPath),
    );
    if (matchingRecords.length > 1) {
      throw new Error(`Linked checkout '${repoPath}' has multiple ownership records.`);
    }
    const record = matchingRecords[0];
    if (record) {
      const mainRepo = listGitWorktrees(repoPath)[0]?.path;
      if (!mainRepo) {
        throw new Error(`Could not resolve the primary checkout for '${repoPath}'.`);
      }
      const result = await (options.delete ? workspaceDeleteOwnedPath : workspaceStopOwnedPath)(
        record.worktreePath,
        {
          quiet: true,
          repoPath: mainRepo,
        },
      );
      return {
        kind: "linked",
        repoPath,
        workspace: result.workspace,
        ...(result.devpodId ? { devpodId: result.devpodId } : {}),
        stopped: !options.delete && result.providerChanged,
        ...(options.delete ? { deleted: result.providerChanged } : {}),
        freedRoutes: result.freedRoutes,
      };
    }
  }

  return withWorkspaceLifecycleLock(repoPath, async () => {
    const devpod = selectDevpodWorkspace(listDevpodWorkspaces(), repoPath);
    const action = options.delete ? "delete" : "stop";
    const mutation = devpod
      ? mutateOwnedDevpodWorkspace(action, devpod.id, repoPath)
      : { status: "absent" as const };
    const removedRoutes = removeHostRoutesWhere((route) =>
      sameWorkspacePath(route.repoPath, repoPath),
    );

    return {
      kind: linked ? "linked" : "primary",
      repoPath,
      ...(workspace ? { workspace } : {}),
      ...(mutation.status === "changed" && devpod ? { devpodId: devpod.id } : {}),
      stopped: !options.delete && mutation.status === "changed",
      ...(options.delete ? { deleted: mutation.status === "changed" } : {}),
      freedRoutes: removedRoutes.length,
    };
  });
}
