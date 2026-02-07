import { resolveRepoPath } from "../core/host-config";
import { removeHostRouteByName } from "../core/host-routes";

export async function runHostRmCommand(options: { name: string; repo?: string }): Promise<void> {
  const repoPath = options.repo ? resolveRepoPath(options.repo) : undefined;
  const removed = removeHostRouteByName(options.name, repoPath);
  process.stdout.write(`Removed host route '${removed.name}' (${removed.host}).\n`);
}
