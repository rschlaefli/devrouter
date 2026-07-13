import { getRepoConfigPath, initRepoConfig, resolveRepoPath } from "../core/repo-config";

export async function runRepoInitCommand(options: {
  repo?: string;
  installedVersion?: string;
}): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);
  const result = initRepoConfig(repoPath, { devrouterVersion: options.installedVersion });
  if (!result.created) {
    process.stdout.write(`Already exists: ${getRepoConfigPath(repoPath)}\n`);
    return;
  }

  process.stdout.write(`Created ${result.configPath}\n`);
  process.stdout.write(
    "Next: dev app add --name <name> --host <host.localhost> --protocol <http|tcp> --runtime <host|docker>\n",
  );
}
