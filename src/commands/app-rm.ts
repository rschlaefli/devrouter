import { removeRepoApp, resolveRepoPath } from "../core/repo-config";
import { removeRouteForApp } from "../core/route-state";

export async function runAppRmCommand(options: {
  name: string;
  repo?: string;
  keepConfig?: boolean;
}): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);

  // --keep-config: free the live route/hostname only (e.g. to release a hostname
  // claimed by another repo) without editing this repo's committed `.devrouter.yml`.
  if (options.keepConfig) {
    if (removeRouteForApp(repoPath, options.name).length > 0) {
      process.stdout.write(`Freed route for '${options.name}' (config left intact)\n`);
      return;
    }
    process.stdout.write(`No active route for '${options.name}' (config left intact)\n`);
    return;
  }

  const result = removeRepoApp(repoPath, options.name);
  if (!result.removed) {
    throw new Error(`App '${options.name}' not found in ${result.configPath}.`);
  }

  removeRouteForApp(repoPath, options.name);

  process.stdout.write(`Removed '${options.name}' from ${result.configPath}\n`);
}
