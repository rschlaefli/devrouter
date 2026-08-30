import path from "node:path";
import { writeFileAtomically } from "../core/atomic-file";
import { printJSON } from "../core/output";
import { type ProfilePlanReport, resolveProfilePlan } from "../core/profile-plan";
import { type ProfileResolutionReport, resolveProfileReport } from "../core/profile-resolution";

export type ProfileResolveCommandOptions = {
  repo?: string;
  profile?: string;
  json?: boolean;
};

export type ProfilePlanCommandOptions = {
  repo?: string;
  profile?: string;
  contract: string;
  output?: string;
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

export async function runProfilePlanCommand(options: ProfilePlanCommandOptions): Promise<void> {
  const report = resolveProfilePlan(options);
  if (options.output) {
    writeFileAtomically(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.json) {
    printJSON(report);
    return;
  }
  printProfilePlanSummary(report, options.output);
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

function printProfilePlanSummary(report: ProfilePlanReport, output?: string): void {
  printProfileResolutionSummary(report);
  process.stdout.write(`Contract: ${report.contractPath}\n`);
  for (const key of Object.keys(report.bindings).sort()) {
    process.stdout.write(`Binding ${key}: ${renderValues(report.bindings[key] ?? [])}\n`);
  }
  if (output) process.stdout.write(`Output: ${path.resolve(output)}\n`);
}
