import { execWithAppEnv } from "../core/app-run";

export async function runAppExecCommand(options: {
  name: string;
  repo?: string;
  yes?: boolean;
  shell?: boolean;
  env?: string;
  workspace?: string;
  command: string[];
}): Promise<void> {
  const result = await execWithAppEnv({
    name: options.name,
    repoPath: options.repo,
    yes: options.yes,
    shell: options.shell,
    env: options.env,
    workspace: options.workspace,
    command: options.command,
  });

  process.exitCode = result.exitCode;
}
