import { buildDoctorReport } from "../core/doctor";
import { printDoctorReport, printJSON } from "../core/output";

type DoctorCommandOptions = {
  repo?: string;
  json?: boolean;
};

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<void> {
  const report = await buildDoctorReport({ repo: options.repo });

  if (options.json) {
    printJSON(report);
  } else {
    printDoctorReport(report);
  }

  if (report.summary.error > 0) {
    process.exitCode = 1;
  }
}
