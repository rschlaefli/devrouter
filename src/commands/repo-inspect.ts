import { inspectRepo } from "../core/repo-inspect";
import { printJSON } from "../core/output";
import type { RepoInspection } from "../core/repo-inspect";

type RepoInspectCommandOptions = {
  repo?: string;
  json?: boolean;
};

export async function runRepoInspectCommand(options: RepoInspectCommandOptions): Promise<void> {
  const report = inspectRepo({ repo: options.repo });
  if (options.json) {
    printJSON(report);
    return;
  }

  printRepoInspectionSummary(report);
}

function printRepoInspectionSummary(report: RepoInspection): void {
  const packageManager = report.packageManager
    ? `${report.packageManager.name}${report.packageManager.version ? `@${report.packageManager.version}` : ""}`
    : "not detected";
  const devrouter = report.devrouter.exists
    ? report.devrouter.valid
      ? `valid (${report.devrouter.appCount} app(s))`
      : "invalid"
    : "missing";

  process.stdout.write(`Repo: ${report.repoPath}\n`);
  process.stdout.write(`Package manager: ${packageManager}\n`);
  process.stdout.write(`Scripts: ${report.scripts.length}\n`);
  process.stdout.write(`App candidates: ${report.apps.length}\n`);
  process.stdout.write(`Compose services: ${report.services.length}\n`);
  process.stdout.write(`Devcontainer: ${report.devcontainer.exists ? "yes" : "no"}\n`);
  process.stdout.write(`Devrouter config: ${devrouter}\n`);

  if (report.issues.length > 0) {
    process.stdout.write("\nIssues:\n");
    for (const issue of report.issues) {
      process.stdout.write(`- ${issue.id} [${issue.level}]: ${issue.summary}\n`);
    }
  }

  process.stdout.write("\nFor full agent-readable output, run: dev repo inspect --json\n");
}
