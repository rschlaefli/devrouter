import { printJSON } from "../core/output";
import { type ProfileResolutionReport, resolveProfileReport } from "../core/profile-resolution";

export type ProfileResolveCommandOptions = {
  repo?: string;
  profile?: string;
  json?: boolean;
};

export async function runProfileResolveCommand(
  options: ProfileResolveCommandOptions,
): Promise<void> {
  const report = resolveProfileReport(options);
  if (options.json) {
    printJSON(report);
    return;
  }
  printProfileResolutionSummary(report);
}

function renderValues(values: string[]): string {
  return values.join(", ") || "-";
}

function printProfileResolutionSummary(report: ProfileResolutionReport): void {
  process.stdout.write(`Repo: ${report.repoPath}\n`);
  process.stdout.write(`Profile: ${report.profile}\n`);
  process.stdout.write(`Apps: ${renderValues(report.apps)}\n`);
  process.stdout.write(`Dependencies: ${renderValues(report.dependencies)}\n`);
  process.stdout.write(`Readiness: ${renderValues(report.readiness)}\n`);
  process.stdout.write(`Managed services: ${renderValues(report.managedRuntime.services)}\n`);
  process.stdout.write(`Managed processes: ${renderValues(report.managedRuntime.processes)}\n`);
}
