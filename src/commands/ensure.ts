import { superviseLifecycle } from "../core/reliability-lifecycle";
import type { WorkspaceEnsureResult } from "../core/workspace-ensure";
import { resolveGitCheckoutPath } from "./environment-path";

export async function runEnsureCommand(options: {
  path?: string;
  profile?: string;
  repair?: boolean;
  open?: boolean;
  json?: boolean;
}): Promise<void> {
  const repoPath = resolveGitCheckoutPath(options.path);
  const result = (await superviseLifecycle("ensure", repoPath, {
    open: options.open,
    quiet: Boolean(options.json),
    profile: options.profile,
    ...(options.repair ? { repair: true } : {}),
  })) as WorkspaceEnsureResult;
  const conflicts = result.hostPortConflicts ?? [];
  const applicationFailed = result.applicationReadiness?.status === "application-error";
  if (applicationFailed || conflicts.length > 0) process.exitCode = 1;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const label =
    result.kind === "primary"
      ? `Primary checkout [profile: ${result.profile}]`
      : `Workspace '${result.workspace}' [profile: ${result.profile}]`;

  if (conflicts.length > 0) {
    const lines = conflicts.map((conflict) => {
      const desired = `${conflict.hostIp ?? "*"}:${conflict.hostPort}/${conflict.protocol}`;
      const holder = [
        `'${conflict.holderContainer}'`,
        conflict.holderComposeProject
          ? `compose project '${conflict.holderComposeProject}'`
          : undefined,
        conflict.holderWorkspace ? `workspace '${conflict.holderWorkspace}'` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      return `  - service '${conflict.service}' needs ${desired}, held by ${holder}\n    ${conflict.remediation}`;
    });
    process.stdout.write(
      `${label} was not started: ${conflicts.length} fixed host-port claim${conflicts.length === 1 ? "" : "s"} conflict${conflicts.length === 1 ? "s" : ""} with running containers.\n${lines.join("\n")}\n`,
    );
    return;
  }

  const routes = result.urls.map((url) => `  ${url}`).join("\n");
  process.stdout.write(
    `${label} ${applicationFailed ? "has available infrastructure but failed its application readiness contract" : "is ready"} (${result.devpodId}).\n${routes}${routes ? "\n" : ""}`,
  );
}
