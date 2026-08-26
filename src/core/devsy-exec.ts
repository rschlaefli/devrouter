import { spawn } from "node:child_process";
import { listDevsyWorkspaces, selectDevsyWorkspace } from "./devsy-workspaces";
import { withWorkspaceLifecycleLock } from "./workspace";

function ensureGuidance(repoPath: string): string {
  return `Run 'devrouter ensure ${repoPath}' first.`;
}

export async function devsyExec(repoPath: string, command: string[]): Promise<number> {
  if (command.length === 0) {
    throw new Error("No command provided. Use `devrouter exec [path] -- <command...>`.");
  }
  return withWorkspaceLifecycleLock(repoPath, async () => {
    const workspace = selectDevsyWorkspace(listDevsyWorkspaces(), repoPath);
    if (!workspace) {
      throw new Error(
        `No exact Devsy workspace exists for '${repoPath}'. ${ensureGuidance(repoPath)}`,
      );
    }

    // Devsy resolves the workspace folder and remote user itself and forwards
    // the remote exit code as its own, so no status-marker wrapping is needed.
    const args = ["workspace", "exec", "--result-format", "plain", workspace.id, "--", ...command];

    return new Promise<number>((resolve, reject) => {
      const child = spawn("devsy", args, { stdio: "inherit" });
      child.once("error", (error) => reject(new Error(`devsy exec failed: ${error.message}`)));
      child.once("close", (code) => resolve(code ?? 1));
    });
  });
}
