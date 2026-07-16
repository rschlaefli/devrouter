import { environmentStop } from "../core/environment-stop";
import { resolveGitCheckoutPath } from "./environment-path";

export async function runStopCommand(options: { path?: string; json?: boolean }): Promise<void> {
  const repoPath = resolveGitCheckoutPath(options.path);
  const result = await environmentStop(repoPath);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const label = result.kind === "primary" ? "Primary checkout" : `Workspace '${result.workspace}'`;
  if (!result.stopped && result.freedRoutes === 0) {
    process.stdout.write(`${label} is already stopped; no routes needed removal.\n`);
    return;
  }
  const provider = result.stopped ? `Stopped DevPod '${result.devpodId}'. ` : "";
  process.stdout.write(
    `${provider}Freed ${result.freedRoutes} route(s) for ${label.toLowerCase()}.\n`,
  );
}
