import { execWithAppEnv } from "../core/app-run";

export async function runAppExecCommand(options: {
  name: string;
  repo?: string;
  yes?: boolean;
  command: string;
}): Promise<void> {
  const result = await execWithAppEnv({
    name: options.name,
    repoPath: options.repo,
    yes: options.yes,
    command: options.command
  });

  process.exitCode = result.exitCode;
}
