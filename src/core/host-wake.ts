import { spawnSync } from "node:child_process";

export type HostWakeEpoch = string | null | undefined;

/** Unsupported hosts use timer evidence; a failed supported probe is unavailable. */
export function readHostWakeEpoch(platform: NodeJS.Platform = process.platform): HostWakeEpoch {
  if (platform !== "darwin") return undefined;
  try {
    const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.wake_abs_time"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 250,
      maxBuffer: 256,
    });
    if (result.error || result.status !== 0) return null;
    const value = result.stdout.trim();
    if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n)
      return null;
    return value;
  } catch {
    return null;
  }
}
