import { runHostRoute } from "../core/host-process";

export async function runHostRunCommand(options: { name: string; repo?: string }): Promise<void> {
  await runHostRoute(options.name, options.repo);
}
