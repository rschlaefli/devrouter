import type { DevcontainerVerifyReport } from "../core/devcontainer-verify";
import { verifyDevcontainer } from "../core/devcontainer-verify";
import { writeDevcontainer } from "../core/devcontainer-write";
import { printJSON } from "../core/output";

type RepoDevcontainerWriteOptions = {
  repo?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  installedVersion?: string;
};

export async function runRepoDevcontainerWriteCommand(
  options: RepoDevcontainerWriteOptions,
): Promise<void> {
  const report = writeDevcontainer({
    repo: options.repo,
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    installedVersion: options.installedVersion,
  });

  if (options.json) {
    printJSON(report);
  } else {
    process.stdout.write(`Devcontainer profile: ${report.profile}\n`);
    for (const file of report.files) {
      process.stdout.write(`- ${file.action}: ${file.path} (${file.reason})\n`);
    }
    if (report.issues.length > 0) {
      process.stdout.write("\nFindings:\n");
      for (const issue of report.issues) {
        process.stdout.write(`- ${issue.id} [${issue.level}]: ${issue.summary}\n`);
        if (issue.details) {
          process.stdout.write(`  Details: ${issue.details}\n`);
        }
        if (issue.suggestion) {
          process.stdout.write(`  Suggestion: ${issue.suggestion}\n`);
        }
      }
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

type RepoDevcontainerVerifyOptions = {
  repo?: string;
  live?: boolean;
  yes?: boolean;
  json?: boolean;
};

export async function runRepoDevcontainerVerifyCommand(
  options: RepoDevcontainerVerifyOptions,
): Promise<void> {
  const report = await verifyDevcontainer({
    repo: options.repo,
    live: Boolean(options.live),
    yes: Boolean(options.yes),
  });

  if (options.json) {
    printJSON(report);
  } else {
    printVerifySummary(report);
  }

  if (report.summary.error > 0) {
    process.exitCode = 1;
  }
}

function printVerifySummary(report: DevcontainerVerifyReport): void {
  process.stdout.write(`Repo: ${report.repoPath}\n`);
  process.stdout.write(`Mode: ${report.live ? "live" : "static"}\n`);
  process.stdout.write(
    `Checks: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.error} error\n`,
  );
  process.stdout.write(`Proxy apps: ${report.evidence.proxyApps.length}\n`);

  if (report.checks.some((check) => check.level !== "ok")) {
    process.stdout.write("\nFindings:\n");
    for (const check of report.checks.filter((entry) => entry.level !== "ok")) {
      process.stdout.write(`- ${check.id} [${check.level}]: ${check.summary}\n`);
    }
  }

  if (report.nextSteps.length > 0) {
    process.stdout.write("\nNext steps:\n");
    for (const step of report.nextSteps) {
      process.stdout.write(`- ${step}\n`);
    }
  }
}
