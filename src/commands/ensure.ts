import { workspaceEnsure } from "../core/workspace-ensure";
import { resolveGitCheckoutPath } from "./environment-path";

export async function runEnsureCommand(options: {
  path?: string;
  open?: boolean;
  json?: boolean;
}): Promise<void> {
  const repoPath = resolveGitCheckoutPath(options.path);
  const result = await workspaceEnsure(repoPath, {
    open: options.open,
    quiet: Boolean(options.json),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const label = result.kind === "primary" ? "Primary checkout" : `Workspace '${result.workspace}'`;
  const routes = result.urls.map((url) => `  ${url}`).join("\n");
  process.stdout.write(`${label} is ready (${result.devpodId}).\n${routes}${routes ? "\n" : ""}`);
}
