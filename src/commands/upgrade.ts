import {
  compareVersions,
  listAvailableUpgradeTargets,
  loadUpgradeCatalog,
  normalizeVersion,
  type UpgradeRelease
} from "../core/upgrade";

type UpgradeCommandOptions = {
  targetVersion?: string;
  repo?: string;
};

type UpgradeCommandDeps = {
  metadataFile?: string;
  changelogPath?: string;
};

function printUpgradeTargets(currentVersion: string, availableTargets: UpgradeRelease[]): void {
  if (availableTargets.length === 0) {
    process.stdout.write(`Current version: ${currentVersion}\n`);
    process.stdout.write("No newer upgrade targets are available.\n");
    return;
  }

  const nextTarget = availableTargets[0];
  process.stdout.write(`Current version: ${currentVersion}\n`);
  process.stdout.write("Available upgrade targets:\n");
  for (const release of availableTargets) {
    const suffix = release.version === nextTarget.version ? "  <- next" : "";
    process.stdout.write(`- ${release.version}${suffix}\n`);
  }
  process.stdout.write("\nRun `dev upgrade <version>` to print the Agent Adaptation Prompt for a target version.\n");
}

export async function runUpgradeCommand(
  options: UpgradeCommandOptions,
  deps: UpgradeCommandDeps = {}
): Promise<void> {
  const catalog = loadUpgradeCatalog({
    repo: options.repo,
    metadataFile: deps.metadataFile,
    changelogPath: deps.changelogPath
  });

  const availableTargets = listAvailableUpgradeTargets(catalog.currentVersion, catalog.releases);
  if (!options.targetVersion) {
    process.stdout.write(`Local version file: ${catalog.metadataPath}\n`);
    process.stdout.write(`Release source: ${catalog.changelogPath}\n`);
    printUpgradeTargets(catalog.currentVersion, availableTargets);
    return;
  }

  const selectedTarget = normalizeVersion(options.targetVersion);
  if (compareVersions(selectedTarget, catalog.currentVersion) <= 0) {
    throw new Error(
      `Target ${selectedTarget} is not newer than current version ${catalog.currentVersion}.`
    );
  }

  const release = catalog.releases.find((entry) => entry.version === selectedTarget);
  if (!release) {
    throw new Error(
      `Version ${selectedTarget} was not found in ${catalog.changelogPath}.`
    );
  }

  process.stdout.write(`Current version: ${catalog.currentVersion}\n`);
  process.stdout.write(`Target version: ${selectedTarget}\n`);
  process.stdout.write("\nAgent adaptation prompt:\n");
  process.stdout.write("```text\n");
  process.stdout.write(`${release.prompt}\n`);
  process.stdout.write("```\n");

  const furtherTargets = availableTargets.filter(
    (entry) => compareVersions(entry.version, selectedTarget) > 0
  );
  if (furtherTargets.length === 0) {
    process.stdout.write("\nNo further upgrade targets are available after this version.\n");
    return;
  }

  process.stdout.write(`\nFurther version available: ${furtherTargets[0].version}\n`);
  if (furtherTargets.length > 1) {
    process.stdout.write(
      `More versions after that: ${furtherTargets.slice(1).map((entry) => entry.version).join(", ")}\n`
    );
  }
}
