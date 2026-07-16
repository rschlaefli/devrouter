import { resolveRepoPath } from "../core/repo-config";
import { resolveGitTopLevel } from "../core/workspace-ownership";

export function resolveGitCheckoutPath(repoPath?: string): string {
  const resolved = resolveRepoPath(repoPath);
  try {
    return resolveGitTopLevel(resolved);
  } catch (error) {
    throw new Error(`Environment commands require a Git repository: '${resolved}'.`, {
      cause: error,
    });
  }
}
