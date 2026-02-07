import { getRepoConfigPath, hasLegacyConfigFiles, initRepoConfig, resolveRepoPath } from "../core/repo-config";

export async function runRepoInitCommand(options: { repo?: string }): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);
  const legacy = hasLegacyConfigFiles(repoPath);
  if (legacy.length > 0) {
    process.stdout.write(
      `Detected legacy files in ${repoPath}: ${legacy.join(", ")}\n`
    );
  }

  const result = initRepoConfig(repoPath);
  if (!result.created) {
    process.stdout.write(`Already exists: ${getRepoConfigPath(repoPath)}\n`);
    return;
  }

  process.stdout.write(`Created ${result.configPath}\n`);
  process.stdout.write("Next: dev app add --name <name> --host <host.localhost> --protocol <http|tcp> --runtime <host|docker>\n");
}
