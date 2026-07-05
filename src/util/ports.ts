import { spawnSync } from "node:child_process";
import { PortListener } from "../types";

function parseSsPortListeners(stdout: string, port: number): PortListener[] {
  const listeners: PortListener[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const localAddr = parts[3];
    const colonIdx = localAddr.lastIndexOf(":");
    if (colonIdx === -1) continue;
    const linePort = Number(localAddr.slice(colonIdx + 1));
    if (linePort !== port) continue;

    const usersCol = parts.slice(5).join(" ");
    const pidMatch = /pid=(\d+)/.exec(usersCol);
    const cmdMatch = /"([^"]+)"/.exec(usersCol);
    const command = cmdMatch ? cmdMatch[1] : "?";
    const pid = pidMatch ? pidMatch[1] : "?";

    listeners.push({
      port,
      command,
      pid,
      user: "?",
      address: localAddr
    });
  }
  return listeners;
}

export function findPortListeners(port: number): PortListener[] {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf-8"
  });

  if (result.error && (result.error as any).code === "ENOENT") {
    if (process.platform === "linux") {
      const ssResult = spawnSync("ss", ["-H", "-lntp", "-p"], { encoding: "utf-8" });
      if (ssResult.status === 0 && ssResult.stdout) {
        return parseSsPortListeners(ssResult.stdout, port);
      }
    }
    return [];
  }

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
