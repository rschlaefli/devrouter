import { spawnSync } from "node:child_process";
import { type NetworkCapacityRouteInventory, parseIPv4Cidr } from "./network-capacity";
import type { NetworkClaim } from "./network-claims";

function bounds(cidr: string): [number, number] {
  const canonical = parseIPv4Cidr(cidr);
  if (!canonical) throw new Error("Invalid connected route.");
  const [ip, prefix] = canonical.split("/");
  const start = ip.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
  return [start, start + 2 ** (32 - Number(prefix)) - 1];
}

/** Exempt only routes contained by the claimed subnet on the verified bridge. */
export function exemptClaimedConnectedRoutes(
  routes: NetworkCapacityRouteInventory,
  subnet: string,
  bridge: string,
): NetworkCapacityRouteInventory {
  if (!bridge || routes.status !== "complete") return { status: "unknown", routes: [] };
  const [start, end] = bounds(subnet);
  return {
    ...routes,
    routes: routes.routes.filter((route) => {
      if (route.interface !== bridge) return true;
      const [routeStart, routeEnd] = bounds(route.cidr);
      return routeStart < start || routeEnd > end;
    }),
  };
}

export function inspectClaimedBridge(claim: NetworkClaim, networkId: string): string {
  if (!/^[a-f0-9]{64}$/.test(networkId)) throw new Error("Invalid claimed network identity.");
  const env = { ...process.env };
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_HOST;
  const result = spawnSync(
    "docker",
    [
      "--host",
      claim.endpoint,
      "network",
      "inspect",
      networkId,
      "--format",
      '{"id":{{json .Id}},"driver":{{json .Driver}},"options":{{json .Options}},"ipam":{{json .IPAM.Config}}}',
    ],
    { env, encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
  );
  try {
    if (result.error || result.status !== 0) throw new Error();
    const value = JSON.parse(result.stdout);
    if (value.id !== networkId || value.driver !== "bridge") throw new Error();
    const bridge =
      value.options?.["com.docker.network.bridge.name"] ?? `br-${networkId.slice(0, 12)}`;
    if (typeof bridge !== "string" || !/^[a-zA-Z0-9_.-]{1,15}$/.test(bridge)) throw new Error();
    if (!Array.isArray(value.ipam) || value.ipam.length !== 1) throw new Error();
    const config = value.ipam[0];
    if (config.Subnet !== claim.subnet || typeof config.Gateway !== "string") throw new Error();
    const gateway = parseIPv4Cidr(`${config.Gateway}/32`);
    if (!gateway) throw new Error();
    const [first, last] = bounds(claim.subnet);
    const [address] = bounds(gateway);
    if (address <= first || address >= last) throw new Error();
    // A name derived from a network ID alone does not prove interface ownership.
    // Match the actual bridge kind and gateway in the qualified daemon namespace.
    const interfaces = spawnSync("ip", ["-j", "-d", "-4", "address", "show", "dev", bridge], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    });
    if (interfaces.error || interfaces.status !== 0) throw new Error();
    const rows = JSON.parse(interfaces.stdout);
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error();
    const iface = rows[0];
    if (
      iface.ifname !== bridge ||
      iface.linkinfo?.info_kind !== "bridge" ||
      !Array.isArray(iface.addr_info)
    )
      throw new Error();
    const ipv4 = iface.addr_info.filter((entry: { family?: string }) => entry.family === "inet");
    if (ipv4.length !== 1 || ipv4[0].local !== config.Gateway || ipv4[0].prefixlen !== claim.prefix)
      throw new Error();
    return bridge;
  } catch {
    throw new Error("Exact Docker bridge evidence is unavailable; route exemption denied.");
  }
}
