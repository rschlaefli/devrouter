import {
  listDevpodWorkspaces,
  runDevpodWorkspaceAction,
  selectDevpodWorkspace,
} from "./devpod-workspaces";
import { removeHostRoutesWhere } from "./host-routes";
import {
  isLinkedWorktree,
  resolveWorktreeWorkspace,
  sameWorkspacePath,
  withWorkspaceLifecycleLock,
} from "./workspace";
import { workspaceStopOwnedPath } from "./workspace-lifecycle";
import { listGitWorktrees, listWorkspaceOwnership } from "./workspace-ownership";

export type EnvironmentStopResult = {
  kind: "primary" | "linked";
  repoPath: string;
  workspace?: string;
  devpodId?: string;
  stopped: boolean;
  freedRoutes: number;
};

export async function environmentStop(repoPath: string): Promise<EnvironmentStopResult> {
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
      const result = await workspaceStopOwnedPath(record.worktreePath, {
        quiet: true,
        repoPath: mainRepo,
      });
      return {
        kind: "linked",
        repoPath,
        workspace: result.workspace,
        ...(result.devpodId ? { devpodId: result.devpodId } : {}),
        stopped: result.providerChanged,
        freedRoutes: result.freedRoutes,
      };
    }
  }

  return withWorkspaceLifecycleLock(repoPath, async () => {
    const devpod = selectDevpodWorkspace(listDevpodWorkspaces(), repoPath);

    if (devpod) {
      runDevpodWorkspaceAction("stop", devpod.id);
    }
    const removedRoutes = removeHostRoutesWhere((route) =>
      sameWorkspacePath(route.repoPath, repoPath),
    );

    return {
      kind: linked ? "linked" : "primary",
      repoPath,
      ...(workspace ? { workspace } : {}),
      ...(devpod ? { devpodId: devpod.id } : {}),
      stopped: Boolean(devpod),
      freedRoutes: removedRoutes.length,
    };
  });
}
