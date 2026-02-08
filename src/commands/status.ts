import { printJSON, printStatus } from "../core/output";
import { collectRouterStatus } from "../core/status";

export async function runStatusCommand(options: { json?: boolean; repo?: string }): Promise<void> {
  const status = await collectRouterStatus(options.repo);

  if (options.json) {
    printJSON(status);
    return;
  }

  printStatus(status);
}
