import { spawnSync } from "node:child_process";
import { isTLSEnabled } from "./router";
import { getMkcertRootCAPath } from "./tls";

export type HttpRouteProbeResult = {
  ok: boolean;
  status?: number;
  details: string;
};

export function httpRouteUrl(host: string): string {
  return `${isTLSEnabled() ? "https" : "http"}://${host}`;
}

export function probeHttpRoute(
  host: string,
  options: { maxTimeSeconds?: number; repoPath?: string } = {},
): HttpRouteProbeResult {
  const tlsEnabled = isTLSEnabled();
  const url = `${tlsEnabled ? "https" : "http"}://${host}`;
  const args = [
    "--silent",
    "--show-error",
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}",
    "--max-time",
    String(options.maxTimeSeconds ?? 5),
  ];
  if (tlsEnabled) {
    args.push("--cacert", getMkcertRootCAPath({ repoPath: options.repoPath }));
  }
  args.push(url);

  const result = spawnSync("curl", args, { encoding: "utf-8" });
  const stdout = result.stdout?.trim() ?? "";
  const status = /^\d{3}$/.test(stdout) ? Number(stdout) : undefined;
  const ok = result.status === 0 && status !== undefined && status >= 100 && status < 500;
  const details = ok
    ? `HTTP ${status}`
    : [status === undefined ? undefined : `HTTP ${status}`, result.stderr?.trim()]
        .filter(Boolean)
        .join(": ") || `curl exited with status ${result.status ?? "unknown"}`;

  return { ok, status, details };
}
