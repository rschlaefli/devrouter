import { removeHostRouteByName } from "../core/host-routes";
import { removeRepoApp, resolveRepoPath } from "../core/repo-config";

export async function runAppRmCommand(options: { name: string; repo?: string }): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);
  const result = removeRepoApp(repoPath, options.name);
  if (!result.removed) {
    throw new Error(`App '${options.name}' not found in ${result.configPath}.`);
  }

  try {
    removeHostRouteByName(options.name, repoPath);
  } catch {
    // Route might not be active. Ignore.
  }

  process.stdout.write(`Removed '${options.name}' from ${result.configPath}\n`);
}
