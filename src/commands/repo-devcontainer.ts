import { printJSON } from "../core/output";
import { writeDevcontainer } from "../core/devcontainer-write";

type RepoDevcontainerWriteOptions = {
  repo?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  installedVersion?: string;
};

export async function runRepoDevcontainerWriteCommand(options: RepoDevcontainerWriteOptions): Promise<void> {
  const report = writeDevcontainer({
    repo: options.repo,
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    installedVersion: options.installedVersion
  });

  if (options.json) {
    printJSON(report);
  } else {
    process.stdout.write(`Devcontainer profile: ${report.profile}\n`);
    for (const file of report.files) {
      process.stdout.write(`- ${file.action}: ${file.path} (${file.reason})\n`);
    }
    if (report.nextSteps.length > 0) {
      process.stdout.write("\nNext steps:\n");
      for (const step of report.nextSteps) {
        process.stdout.write(`- ${step}\n`);
      }
    }
  }

  if (report.issues.some((issue) => issue.level === "error")) {
    process.exitCode = 1;
  }
}
