import { runConfiguredApp } from "../core/app-run";

export async function runAppRunCommand(options: {
  name: string;
  repo?: string;
  yes?: boolean;
}): Promise<void> {
  const result = await runConfiguredApp({
    name: options.name,
    repoPath: options.repo,
    yes: options.yes
  });
  if (result.startedServices.length > 0) {
    process.stdout.write(
      `Started docker services: ${result.startedServices.join(", ")}\n`
    );
  }

  if (result.dependencyApps.length > 0) {
    process.stdout.write(`Configured dependencies: ${result.dependencyApps.join(", ")}\n`);
  }

  process.stdout.write(`App '${result.appName}' is running in ${result.mode} mode.\n`);
}
