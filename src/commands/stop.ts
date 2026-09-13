import type { EnvironmentStopResult } from "../core/environment-stop";
import { superviseLifecycle } from "../core/reliability-lifecycle";
import { resolveGitCheckoutPath } from "./environment-path";

export async function runStopCommand(options: {
  path?: string;
  json?: boolean;
  delete?: boolean;
}): Promise<void> {
  const repoPath = resolveGitCheckoutPath(options.path);
  const result = (await superviseLifecycle("stop", repoPath, {
    delete: options.delete,
  })) as EnvironmentStopResult;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const label = result.kind === "primary" ? "Primary checkout" : `Workspace '${result.workspace}'`;
  if (result.runtimeAbsent) {
    process.stdout.write(`${label} has no runtime or routes; stop is complete.\n`);
    return;
  }
  if (!result.stopped && !result.deleted && result.freedRoutes === 0) {
    process.stdout.write(`${label} is already stopped; no routes needed removal.\n`);
    return;
  }
  const provider = result.deleted
    ? `Deleted DevPod '${result.devpodId}'. `
    : result.stopped
      ? `Stopped DevPod '${result.devpodId}'. `
      : "";
  process.stdout.write(
    `${provider}Freed ${result.freedRoutes} route(s) for ${label.toLowerCase()}.\n`,
  );
}
