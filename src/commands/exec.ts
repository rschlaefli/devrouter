import { devpodExec } from "../core/devpod-exec";
import { resolveGitCheckoutPath } from "./environment-path";

export type ExecInvocation = { path?: string; command: string[] };

export function parseExecInvocation(args: string[]): ExecInvocation {
  const separator = args.indexOf("--");
  if (separator < 0) {
    throw new Error("Separate the command with `--`: devrouter exec [path] -- <command...>.");
  }
  const pathArgs = args.slice(0, separator);
  const command = args.slice(separator + 1);
  if (pathArgs.length > 1) {
    throw new Error("devrouter exec accepts at most one checkout path before `--`.");
  }
  if (command.length === 0) {
    throw new Error("No command provided after `--`.");
  }
  return { ...(pathArgs[0] ? { path: pathArgs[0] } : {}), command };
}

export async function runExecCommand(options: ExecInvocation): Promise<void> {
  const repoPath = resolveGitCheckoutPath(options.path);
  process.exitCode = await devpodExec(repoPath, options.command);
}
