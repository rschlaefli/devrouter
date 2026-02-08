import { printConfigApps, printJSON } from "../core/output";
import { loadRepoConfig, resolveRepoPath } from "../core/repo-config";

export async function runAppLsCommand(options: { repo?: string; json?: boolean }): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);
  const config = loadRepoConfig(repoPath);
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
