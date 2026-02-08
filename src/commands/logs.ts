import { spawn, spawnSync } from "node:child_process";
import { ROUTER_CONTAINER_NAME } from "../core/router";
import { isContainerRunning } from "../core/docker";

type LogsOptions = {
  follow?: boolean;
  tail?: string;
};

export async function runLogsCommand(options: LogsOptions): Promise<void> {
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
