import { runSetup } from "../core/setup";
import { printJSON, printSetupReport } from "../core/output";

type SetupCommandOptions = {
  repo?: string;
  json?: boolean;
  yes?: boolean;
};

export async function runSetupCommand(options: SetupCommandOptions): Promise<void> {
  const report = await runSetup({ repo: options.repo, yes: Boolean(options.yes) });

  if (options.json) {
    printJSON(report);
  } else {
    printSetupReport(report);
  }

  if (report.summary.actions.failed > 0 || report.summary.checks.error > 0) {
    process.exitCode = 1;
  }
}
