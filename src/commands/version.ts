import {
  listAvailableUpgradeTargets,
  loadUpgradeCatalog
} from "../core/upgrade";

type VersionCommandOptions = {
  repo?: string;
  installedVersion: string;
};

type VersionCommandDeps = {
  metadataFile?: string;
  changelogPath?: string;
};

export async function runVersionCommand(
  options: VersionCommandOptions,
  deps: VersionCommandDeps = {}
): Promise<void> {
  process.stdout.write(`Installed CLI version: ${options.installedVersion}\n`);

  try {
    const catalog = loadUpgradeCatalog({
      repo: options.repo,
      metadataFile: deps.metadataFile,
      changelogPath: deps.changelogPath
    });
    process.stdout.write(`Local repo version (${catalog.metadataPath}): ${catalog.currentVersion}\n`);

    const availableTargets = listAvailableUpgradeTargets(catalog.currentVersion, catalog.releases);
    if (availableTargets.length === 0) {
      process.stdout.write("Next upgrade target: none\n");
      return;
    }

    const next = availableTargets[0];
    process.stdout.write(`Next upgrade target: ${next.version}\n`);
    process.stdout.write(`All upgrade targets: ${availableTargets.map((entry) => entry.version).join(", ")}\n`);
    process.stdout.write(`Run: dev upgrade ${next.version}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`Local repo version: unavailable (${message})\n`);
    process.stdout.write("Next upgrade target: unavailable\n");
  }
}
