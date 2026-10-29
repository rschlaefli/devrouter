import { spawn, spawnSync } from "node:child_process";
import { isContainerRunning } from "../core/docker";
import { readLifecycleDiagnostics } from "../core/lifecycle-diagnostics";
import { ROUTER_CONTAINER_NAME } from "../core/router";
import { resolveWorktreeWorkspace } from "../core/workspace";
import { resolveWorkspaceRuntimeForReport } from "../core/workspace-runtime";
import { resolveGitCheckoutPath } from "./environment-path";

type LogsOptions = {
  follow?: boolean;
  tail?: string;
  repo?: string;
};

export async function runLogsCommand(options: LogsOptions): Promise<void> {
  if (options.repo) {
    if (options.follow)
      throw new Error("Lifecycle logs are bounded snapshots; follow is unavailable.");
    const repoPath = resolveGitCheckoutPath(options.repo);
    const provider = resolveWorkspaceRuntimeForReport(repoPath);
    const lines = Number(options.tail ?? "100");
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10_000)
      throw new Error("Lifecycle log tail must be between 1 and 10000 lines.");
    const receipt = provider
      ? readLifecycleDiagnostics({
          repoPath,
          workspace: resolveWorktreeWorkspace(repoPath) ?? null,
          provider,
        })
      : undefined;
    if (!receipt) throw new Error("Matching lifecycle diagnostic output is unavailable.");
    const output = Buffer.concat(receipt.output.map((chunk) => Buffer.from(chunk.data, "base64")));
    const text = output.toString("utf8");
    const terminated = text.endsWith("\n");
    const entries = (terminated ? text.slice(0, -1) : text).split("\n");
    process.stdout.write(entries.slice(-lines).join("\n") + (terminated ? "\n" : ""));
    return;
  }
  const running = await isContainerRunning(ROUTER_CONTAINER_NAME);
  if (!running) {
    throw new Error("Router is not running. Start it with: dev up");
  }

  const tail = options.tail ?? "100";
  const args = ["logs", "--tail", tail, ROUTER_CONTAINER_NAME];

  if (options.follow) {
    args.splice(1, 0, "-f");
    const child = spawn("docker", args, { stdio: "inherit" });

    const onSignal = () => {
      child.kill("SIGTERM");
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        resolve();
      });
    });
  } else {
    const result = spawnSync("docker", args, { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error("Failed to retrieve router logs.");
    }
  }
}
