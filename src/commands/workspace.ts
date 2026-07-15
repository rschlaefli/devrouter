import { workspaceEnsure } from "../core/workspace-ensure";
import { workspaceDown, workspaceLs, workspaceUp } from "../core/workspace-lifecycle";

export async function runWorkspaceUpCommand(
  branch: string,
  options: { path?: string; noDevpod?: boolean; open?: boolean; repo?: string },
): Promise<void> {
  await workspaceUp(branch, {
    path: options.path,
    noDevpod: options.noDevpod,
    open: options.open,
    repoPath: options.repo,
  });
}

export async function runWorkspaceEnsureCommand(options: {
  path?: string;
  open?: boolean;
}): Promise<void> {
  const result = await workspaceEnsure(options.path, { open: options.open });
  process.stdout.write(
    `Workspace '${result.workspace}' is ready (${result.devpodId}).\n` +
      `${result.urls.map((url) => `  ${url}`).join("\n")}\n`,
  );
}

export function runWorkspaceLsCommand(options: { repo?: string; json?: boolean }): void {
  const rows = workspaceLs(options.repo);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("No git worktrees found.\n");
    return;
  }
  for (const row of rows) {
    const label = row.workspace ?? "(primary)";
    const ownership = row.ownerStatus ?? (row.legacy ? "legacy" : "unmanaged");
    process.stdout.write(
      `${label}\t${row.branch ?? "-"}\t${ownership}\tdevpod:${row.devpodStatus}\t${row.routeCount} route(s)\t${row.worktreePath}\n`,
    );
  }
}

export async function runWorkspaceDownCommand(
  target: string,
  options: { keepWorktree?: boolean; keepDevpod?: boolean; repo?: string },
): Promise<void> {
  await workspaceDown(target, {
    keepWorktree: options.keepWorktree,
    keepDevpod: options.keepDevpod,
    repoPath: options.repo,
  });
}
