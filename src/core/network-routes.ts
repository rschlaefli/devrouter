import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { type NetworkCapacityRouteInventory, parseIPv4Cidr } from "./network-capacity";
import { hasLocalDockerNetworkNamespace } from "./network-local-daemon";

export function parseLinuxNetworkRoutes(output: string): NetworkCapacityRouteInventory {
  try {
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows) || rows.length > 4096) throw new Error();
    const routes: NetworkCapacityRouteInventory["routes"] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
      const value = row as Record<string, unknown>;
      if (typeof value.dst !== "string") throw new Error();
      if (value.dst === "default") continue;
      if (isIP(value.dst.split("/")[0]) === 6) continue;
      const cidr = parseIPv4Cidr(value.dst.includes("/") ? value.dst : `${value.dst}/32`);
      if (!cidr || typeof value.dev !== "string" || !value.dev) throw new Error();
      routes.push({ cidr, interface: value.dev, source: "host" });
    }
    return { status: "complete", routes };
  } catch {
    return { status: "unknown", routes: [] };
  }
}

/** Virtualized daemons need separately qualified guest evidence. */
export function collectNetworkRoutes(options: {
  platform?: string;
  endpoint: string;
}): NetworkCapacityRouteInventory {
  if (
    (options.platform ?? process.platform) !== "linux" ||
    !hasLocalDockerNetworkNamespace(options.endpoint)
  )
    return { status: "unknown", routes: [] };
  const result = spawnSync("ip", ["-j", "-4", "route", "show", "table", "all"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return { status: "unknown", routes: [] };
  return parseLinuxNetworkRoutes(result.stdout);
}
