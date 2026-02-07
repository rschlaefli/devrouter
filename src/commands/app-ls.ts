import { printConfigApps, printJSON } from "../core/output";
import { loadRepoConfigWithCutover, resolveRepoPath } from "../core/repo-config";

export async function runAppLsCommand(options: { repo?: string; json?: boolean }): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);
  const config = loadRepoConfigWithCutover(repoPath);
  if (options.json) {
    printJSON({
      repoPath,
      configPath: `${repoPath}/.devrouter.yml`,
      apps: config.apps
    });
    return;
  }

  printConfigApps(repoPath, config.apps);
}
