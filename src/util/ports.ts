import { spawnSync } from "node:child_process";
import { PortListener } from "../types";

export function findPortListeners(port: number): PortListener[] {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf-8"
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }

  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.length <= 1) {
    return [];
  }

  return lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    const command = parts[0] ?? "?";
    const pid = parts[1] ?? "?";
    const user = parts[2] ?? "?";
    const address = parts.slice(-2).join(" ") || "?";

    return {
      port,
      command,
      pid,
      user,
      address
    };
  });
}
