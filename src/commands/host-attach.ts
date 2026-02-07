import { attachHostRoute } from "../core/host-process";

export async function runHostAttachCommand(options: {
  name: string;
  repo?: string;
}): Promise<void> {
  await attachHostRoute(options.name, options.repo);
}
