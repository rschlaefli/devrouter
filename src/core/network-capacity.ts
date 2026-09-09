import { isIP } from "node:net";

/**
 * Pure, read-only network capacity diagnostics.
 *
 * A bounded Docker adapter supplies the snapshot. This module only normalizes
 * IPv4 CIDRs, classifies candidate blocks, and builds a report. It never runs
 * Docker commands and never plans deletion or allocation.
 */

export type NetworkCapacityEvidenceStatus = "complete" | "unknown";
export type NetworkCapacityCount = number | "unknown";
export type NetworkCapacityPrefixLength = 24 | 25 | 26;

export type DockerEndpointIdentity = {
  endpoint: string;
  daemonId: string;
};

export type NetworkCapacityRoute = {
  cidr: string;
  interface?: string;
  source?: "lan" | "vpn" | "host" | "guest" | "other";
};

export type NetworkCapacityRouteInventory = {
  status: NetworkCapacityEvidenceStatus;
  routes: NetworkCapacityRoute[];
};

export type NetworkCapacityPool = {
  /** Docker's default-address-pool Base value, for example 10.0.0.0/16. */
  base: string;
  /** Docker's allocation Size value, represented as an IPv4 prefix length. */
  size: number;
};

export type NetworkCapacityNetwork = {
  id: string;
  name: string;
  driver: string;
  subnets: string[];
  activeEndpoints: number | null;
  retainedContainerIds: string[] | null;
  composeProject?: string;
  composeNetwork?: string;
};

/** Shape exposed by the bounded Docker inventory adapter. */
export type NetworkCapacityInventory = DockerEndpointIdentity & {
  status: NetworkCapacityEvidenceStatus;
  pools: NetworkCapacityPool[];
  networks: NetworkCapacityNetwork[];
  observedAt?: string;
  reasons: string[];
  /** Route collection is a separate host/guest concern and may be supplied here. */
  routes?: NetworkCapacityRouteInventory;
};

export type NetworkCapacityCollectionRequest = DockerEndpointIdentity & {
  /** An explicit prefix overrides each Docker pool's allocation size. */
  prefixLength?: NetworkCapacityPrefixLength;
  endpointDemand?: number | null;
  endpointReserve?: number;
  routes?: NetworkCapacityRouteInventory;
};

export type NetworkCapacityCollector = (
  request: NetworkCapacityCollectionRequest,
) => NetworkCapacityInventory;

export type NetworkCapacityDependencies = {
  collectInventory: NetworkCapacityCollector;
};

export type NetworkCapacityCandidateStatus =
  | "free"
  | "occupied"
  | "route-conflict"
  | "endpoint-insufficient"
  | "unknown";

export type NetworkCapacityRouteStatus = "clear" | "conflict" | "unknown";

export type NetworkCapacityRouteClassification = {
  status: NetworkCapacityRouteStatus;
  overlappingRouteCidrs: string[];
};

export type NetworkCapacityCandidate = {
  cidr: string;
  poolBaseCidr: string;
  status: NetworkCapacityCandidateStatus;
  routeStatus: NetworkCapacityRouteStatus;
  overlappingNetworkIds: string[];
  overlappingRouteCidrs: string[];
  conventionalUsableEndpoints: number;
  endpointReserve: number | "unknown";
  endpointCapacity: number | "unknown";
  endpointDemand: number | "unknown";
};

export type NetworkCapacityPoolReport = {
  baseCidr: string;
  daemonPoolSize: number;
  status: "available" | "occupied" | "endpoint-insufficient" | "unknown";
  candidatePrefixLength: NetworkCapacityPrefixLength;
  potentialFreeBlockCount: number | "unknown";
  candidates: NetworkCapacityCandidate[];
};

export type NetworkCapacityCleanupReport = {
  /** Cleanup is intentionally never authorized by this report. */
  status: "blocked";
  activeEndpoints: NetworkCapacityCount;
  retainedReferences: NetworkCapacityCount;
  reasons: string[];
};

export type NetworkCapacityNetworkReport = {
  id: string;
  name: string;
  driver: string;
  ipv4Subnets: string[];
  ipv6Subnets: string[];
  composeProject?: string;
  composeNetwork?: string;
  activeEndpoints: NetworkCapacityCount;
  retainedReferences: NetworkCapacityCount;
  cleanup: NetworkCapacityCleanupReport;
};

export type NetworkCapacityEndpointReport = {
  prefixLength: NetworkCapacityPrefixLength;
  totalAddresses: number;
  conventionalUsableEndpoints: number;
  reserve: number | "unknown";
  availableEndpoints: number | "unknown";
  demand: number | "unknown";
  status: "available" | "insufficient" | "unknown";
};

export type NetworkCapacityAllocationReport = {
  status: "available" | "exhausted" | "unknown";
  freeBlockCount: number | "unknown";
  blockers: string[];
};

export type NetworkCapacityReport = DockerEndpointIdentity & {
  evidence: {
    inventory: NetworkCapacityEvidenceStatus;
    containers: NetworkCapacityEvidenceStatus;
    routes: NetworkCapacityEvidenceStatus;
    observedAt?: string;
    reasons: string[];
  };
  endpointCapacity: NetworkCapacityEndpointReport;
  pools: NetworkCapacityPoolReport[];
  networks: NetworkCapacityNetworkReport[];
  allocation: NetworkCapacityAllocationReport;
};

type ParsedIPv4Cidr = {
  cidr: string;
  prefixLength: number;
  start: number;
  end: number;
};

const DEFAULT_PREFIX_LENGTH: NetworkCapacityPrefixLength = 24;
const DEFAULT_ENDPOINT_RESERVE = 8;
const MAX_CANDIDATE_BLOCKS = 4096;

/** Returns a canonical IPv4 CIDR, or undefined for IPv6/invalid input. */
export function parseIPv4Cidr(value: string): string | undefined {
  return parseCidr(value)?.cidr;
}

export function calculateIPv4EndpointCapacity(
  prefixLength: NetworkCapacityPrefixLength,
  endpointReserve = DEFAULT_ENDPOINT_RESERVE,
  endpointDemand: number | null = 0,
): NetworkCapacityEndpointReport {
  const totalAddresses = 2 ** (32 - prefixLength);
  // Docker bridge capacity excludes network, broadcast, and the gateway.
  const conventionalUsableEndpoints = totalAddresses - 3;
  const reserve =
    Number.isSafeInteger(endpointReserve) && endpointReserve >= 0 ? endpointReserve : "unknown";
  const availableEndpoints =
    reserve === "unknown" ? "unknown" : conventionalUsableEndpoints - reserve;
  const demand =
    endpointDemand === null || !Number.isSafeInteger(endpointDemand) || endpointDemand < 0
      ? "unknown"
      : endpointDemand;
  const status =
    reserve === "unknown" || demand === "unknown" || availableEndpoints === "unknown"
      ? "unknown"
      : demand <= availableEndpoints
        ? "available"
        : "insufficient";
  return {
    prefixLength,
    totalAddresses,
    conventionalUsableEndpoints,
    reserve,
    availableEndpoints,
    demand,
    status,
  };
}

export function classifyIPv4RouteOverlap(
  cidr: string,
  routes: NetworkCapacityRouteInventory,
): NetworkCapacityRouteClassification {
  const candidate = parseCidr(cidr);
  if (!candidate || routes.status === "unknown") {
    return { status: "unknown", overlappingRouteCidrs: [] };
  }
  const overlappingRouteCidrs: string[] = [];
  for (const route of routes.routes) {
    const parsedRoute = parseCidr(route.cidr);
    if (!parsedRoute) {
      return { status: "unknown", overlappingRouteCidrs: [] };
    }
    // A default route is not a concrete LAN, VPN, host, or split-tunnel block.
    if (parsedRoute.prefixLength === 0) continue;
    if (overlaps(candidate, parsedRoute)) overlappingRouteCidrs.push(route.cidr);
  }
  return {
    status: overlappingRouteCidrs.length > 0 ? "conflict" : "clear",
    overlappingRouteCidrs,
  };
}

export function collectNetworkCapacityReport(
  request: NetworkCapacityCollectionRequest,
  dependencies: NetworkCapacityDependencies,
): NetworkCapacityReport {
  let inventory: NetworkCapacityInventory;
  try {
    inventory = dependencies.collectInventory(request);
  } catch {
    return buildUnknownReport(request, "network inventory collection failed");
  }

  if (
    inventory.endpoint !== request.endpoint ||
    inventory.daemonId !== request.daemonId ||
    !request.endpoint.trim() ||
    !request.daemonId.trim()
  ) {
    return buildUnknownReport(
      request,
      "network inventory endpoint or daemon identity does not match the requested identity",
    );
  }

  try {
    return buildReport(request, inventory);
  } catch {
    return buildUnknownReport(request, "network inventory is malformed");
  }
}

function buildReport(
  request: NetworkCapacityCollectionRequest,
  inventory: NetworkCapacityInventory,
): NetworkCapacityReport {
  const routeInventory = request.routes ?? inventory.routes ?? { status: "unknown", routes: [] };
  const parsedNetworks = inventory.networks.map((network) => ({
    network,
    subnets: network.subnets
      .filter((subnet) => !isIPv6Cidr(subnet))
      .map((subnet) => parseCidr(subnet)),
  }));
  const networkEvidenceUnknown =
    inventory.status === "unknown" ||
    parsedNetworks.some(({ subnets }) => subnets.some((subnet) => subnet === undefined));
  const containerEvidenceUnknown =
    inventory.status === "unknown" ||
    inventory.networks.some((network) => network.retainedContainerIds === null);
  const routeEvidenceUnknown = routeInventory.status === "unknown";
  const parsedRoutes = routeInventory.routes.map((route) => ({
    route,
    cidr: parseCidr(route.cidr),
  }));
  const malformedRouteEvidence = parsedRoutes.some(({ cidr }) => cidr === undefined);
  const endpointPrefix = resolveReportPrefix(request, inventory);
  const endpointCapacity = calculateIPv4EndpointCapacity(
    endpointPrefix,
    request.endpointReserve,
    request.endpointDemand,
  );
  const networks = parsedNetworks.map(({ network, subnets }) =>
    buildNetworkReport(network, subnets, inventory.status),
  );
  const ipv4Pools = inventory.pools.filter((pool) => !isIPv6Cidr(pool.base));
  const pools = ipv4Pools.map((pool) =>
    buildPoolReport(
      pool,
      request,
      parsedNetworks,
      routeInventory,
      networkEvidenceUnknown,
      routeEvidenceUnknown || malformedRouteEvidence,
    ),
  );
  const parsedPools = ipv4Pools.map((pool) => parseCidr(pool.base));
  const overlappingPools = parsedPools.some(
    (pool, index) =>
      pool && parsedPools.slice(index + 1).some((other) => other && overlaps(pool, other)),
  );
  const unknownEvidence =
    ipv4Pools.length === 0 ||
    inventory.status === "unknown" ||
    networkEvidenceUnknown ||
    containerEvidenceUnknown ||
    routeEvidenceUnknown ||
    malformedRouteEvidence ||
    overlappingPools ||
    pools.some((pool) => pool.status === "unknown") ||
    endpointCapacity.status === "unknown";
  const blockers = [
    ...(overlappingPools ? ["configured Docker address pools overlap"] : []),
    ...(inventory.status === "unknown" ? ["Docker network inventory is unknown"] : []),
    ...(networkEvidenceUnknown && inventory.status === "complete"
      ? ["one or more Docker network subnets are unknown"]
      : []),
    ...(containerEvidenceUnknown ? ["retained container references are unknown"] : []),
    ...(routeEvidenceUnknown || malformedRouteEvidence
      ? ["route evidence is incomplete or unknown"]
      : []),
    ...(endpointCapacity.status === "insufficient"
      ? ["endpoint demand exceeds the requested prefix"]
      : []),
    ...(pools.some((pool) => pool.status === "endpoint-insufficient")
      ? ["endpoint demand exceeds one or more candidate prefixes"]
      : []),
    ...(ipv4Pools.length === 0 ? ["no configured Docker IPv4 address pools were observed"] : []),
  ];
  const freeBlockCount = overlappingPools ? "unknown" : summarizeFreeBlocks(pools);

  return {
    endpoint: request.endpoint,
    daemonId: request.daemonId,
    evidence: {
      inventory: inventory.status,
      containers: containerEvidenceUnknown ? "unknown" : "complete",
      routes: routeEvidenceUnknown || malformedRouteEvidence ? "unknown" : "complete",
      observedAt: inventory.observedAt,
      reasons: inventory.reasons.slice(),
    },
    endpointCapacity,
    pools,
    networks,
    allocation: {
      status:
        unknownEvidence || freeBlockCount === "unknown"
          ? "unknown"
          : freeBlockCount > 0
            ? "available"
            : "exhausted",
      freeBlockCount,
      blockers,
    },
  };
}

function buildNetworkReport(
  network: NetworkCapacityNetwork,
  subnets: Array<ParsedIPv4Cidr | undefined>,
  inventoryStatus: NetworkCapacityEvidenceStatus,
): NetworkCapacityNetworkReport {
  const activeEndpoints =
    inventoryStatus === "complete" &&
    typeof network.activeEndpoints === "number" &&
    Number.isSafeInteger(network.activeEndpoints) &&
    network.activeEndpoints >= 0
      ? network.activeEndpoints
      : "unknown";
  const retainedReferences =
    inventoryStatus === "complete" && network.retainedContainerIds !== null
      ? new Set(network.retainedContainerIds).size
      : "unknown";
  const reasons = [
    "network deletion is outside this diagnostic",
    ...(activeEndpoints === "unknown" ? ["active endpoint evidence is unknown"] : []),
    ...(activeEndpoints !== "unknown" && activeEndpoints > 0
      ? [`${activeEndpoints} active endpoint(s) remain attached`]
      : []),
    ...(retainedReferences === "unknown" ? ["retained container references are unknown"] : []),
    ...(retainedReferences !== "unknown" && retainedReferences > 0
      ? [`${retainedReferences} retained container reference(s) remain attached`]
      : []),
    ...(subnets.some((subnet) => subnet === undefined)
      ? ["one or more IPv4 subnets are unknown"]
      : []),
  ];

  return {
    id: network.id,
    name: network.name,
    driver: network.driver,
    ipv4Subnets: network.subnets.filter((subnet) => !isIPv6Cidr(subnet)),
    ipv6Subnets: network.subnets.filter(isIPv6Cidr),
    composeProject: network.composeProject,
    composeNetwork: network.composeNetwork,
    activeEndpoints,
    retainedReferences,
    cleanup: {
      status: "blocked",
      activeEndpoints,
      retainedReferences,
      reasons,
    },
  };
}

function buildPoolReport(
  pool: NetworkCapacityPool,
  request: NetworkCapacityCollectionRequest,
  networks: Array<{ network: NetworkCapacityNetwork; subnets: Array<ParsedIPv4Cidr | undefined> }>,
  routes: NetworkCapacityRouteInventory,
  networkEvidenceUnknown: boolean,
  routeEvidenceUnknown: boolean,
): NetworkCapacityPoolReport {
  const parsedPool = parseCidr(pool.base);
  const candidatePrefixLength = request.prefixLength ?? toSupportedPrefix(pool.size);
  if (
    !parsedPool ||
    candidatePrefixLength === undefined ||
    parsedPool.prefixLength > candidatePrefixLength
  ) {
    return {
      baseCidr: parsedPool?.cidr ?? pool.base,
      daemonPoolSize: pool.size,
      status: "unknown",
      candidatePrefixLength: request.prefixLength ?? DEFAULT_PREFIX_LENGTH,
      potentialFreeBlockCount: "unknown",
      candidates: [],
    };
  }

  const candidateCount = 2 ** (candidatePrefixLength - parsedPool.prefixLength);
  if (candidateCount > MAX_CANDIDATE_BLOCKS) {
    return {
      baseCidr: parsedPool.cidr,
      daemonPoolSize: pool.size,
      status: "unknown",
      candidatePrefixLength,
      potentialFreeBlockCount: "unknown",
      candidates: [],
    };
  }

  const candidates = Array.from({ length: candidateCount }, (_, index) => {
    const candidate = parseCidr(
      `${formatIPv4(parsedPool.start + index * 2 ** (32 - candidatePrefixLength))}/${candidatePrefixLength}`,
    ) as ParsedIPv4Cidr;
    const overlappingNetworkIds = networks
      .filter(({ subnets }) => subnets.some((subnet) => subnet && overlaps(candidate, subnet)))
      .map(({ network }) => network.id);
    const routeClassification = classifyIPv4RouteOverlap(candidate.cidr, routes);
    const candidateEndpoint = calculateIPv4EndpointCapacity(
      candidatePrefixLength,
      request.endpointReserve,
      request.endpointDemand,
    );
    const candidateRouteStatus = routeEvidenceUnknown ? "unknown" : routeClassification.status;
    let status: NetworkCapacityCandidateStatus;
    if (networkEvidenceUnknown) {
      status = "unknown";
    } else if (overlappingNetworkIds.length > 0) {
      status = "occupied";
    } else if (candidateRouteStatus === "unknown") {
      status = "unknown";
    } else if (candidateRouteStatus === "conflict") {
      status = "route-conflict";
    } else if (candidateEndpoint.status === "unknown") {
      status = "unknown";
    } else if (candidateEndpoint.status === "insufficient") {
      status = "endpoint-insufficient";
    } else {
      status = "free";
    }

    return {
      cidr: candidate.cidr,
      poolBaseCidr: parsedPool.cidr,
      status,
      routeStatus: candidateRouteStatus,
      overlappingNetworkIds,
      overlappingRouteCidrs: routeClassification.overlappingRouteCidrs,
      conventionalUsableEndpoints: candidateEndpoint.conventionalUsableEndpoints,
      endpointReserve: candidateEndpoint.reserve,
      endpointCapacity: candidateEndpoint.availableEndpoints,
      endpointDemand: candidateEndpoint.demand,
    };
  });
  const freeCount = candidates.filter((candidate) => candidate.status === "free").length;
  const status = candidates.some((candidate) => candidate.status === "unknown")
    ? "unknown"
    : candidates.some((candidate) => candidate.status === "endpoint-insufficient")
      ? "endpoint-insufficient"
      : freeCount > 0
        ? "available"
        : "occupied";

  return {
    baseCidr: parsedPool.cidr,
    daemonPoolSize: pool.size,
    status,
    candidatePrefixLength,
    potentialFreeBlockCount: candidates.some((candidate) => candidate.status === "unknown")
      ? "unknown"
      : freeCount,
    candidates,
  };
}

function resolveReportPrefix(
  request: NetworkCapacityCollectionRequest,
  inventory: NetworkCapacityInventory,
): NetworkCapacityPrefixLength {
  if (request.prefixLength !== undefined) return request.prefixLength;
  const poolPrefix = inventory.pools.map((pool) => toSupportedPrefix(pool.size)).find(Boolean);
  return poolPrefix ?? DEFAULT_PREFIX_LENGTH;
}

function toSupportedPrefix(value: number): NetworkCapacityPrefixLength | undefined {
  return isSupportedPrefix(value) ? value : undefined;
}

function summarizeFreeBlocks(pools: NetworkCapacityPoolReport[]): number | "unknown" {
  if (pools.some((pool) => pool.potentialFreeBlockCount === "unknown")) {
    return "unknown";
  }
  return pools.reduce((total, pool) => total + (pool.potentialFreeBlockCount as number), 0);
}

function buildUnknownReport(
  request: NetworkCapacityCollectionRequest,
  reason: string,
): NetworkCapacityReport {
  const endpointPrefix = request.prefixLength ?? DEFAULT_PREFIX_LENGTH;
  const endpointCapacity = calculateIPv4EndpointCapacity(
    endpointPrefix,
    request.endpointReserve,
    request.endpointDemand,
  );
  return {
    endpoint: request.endpoint,
    daemonId: request.daemonId,
    evidence: {
      inventory: "unknown",
      containers: "unknown",
      routes: "unknown",
      reasons: [reason],
    },
    endpointCapacity,
    pools: [],
    networks: [],
    allocation: {
      status: "unknown",
      freeBlockCount: "unknown",
      blockers: [reason],
    },
  };
}

function isSupportedPrefix(value: number | undefined): value is NetworkCapacityPrefixLength {
  return value === 24 || value === 25 || value === 26;
}

function isIPv6Cidr(value: string): boolean {
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    isIP(parts[0]) === 6 &&
    /^\d{1,3}$/.test(parts[1]) &&
    Number(parts[1]) <= 128
  );
}

function parseCidr(value: string): ParsedIPv4Cidr | undefined {
  const [addressText, prefixText, ...extra] = value.trim().split("/");
  if (!addressText || !prefixText || extra.length > 0) return undefined;
  const address = parseIPv4Address(addressText);
  const prefixLength = parsePrefix(prefixText);
  if (address === undefined || prefixLength === undefined) return undefined;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const start = (address & mask) >>> 0;
  const end = start + 2 ** (32 - prefixLength) - 1;
  return {
    cidr: `${formatIPv4(start)}/${prefixLength}`,
    prefixLength,
    start,
    end,
  };
}

function parseIPv4Address(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (octet, index) =>
        !/^\d{1,3}$/.test(parts[index]) || !Number.isInteger(octet) || octet < 0 || octet > 255,
    )
  ) {
    return undefined;
  }
  return (((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function parsePrefix(value: string): number | undefined {
  if (/^\d+$/.test(value)) {
    const prefix = Number(value);
    return prefix >= 0 && prefix <= 32 ? prefix : undefined;
  }
  const mask = parseIPv4Address(value);
  if (mask === undefined) return undefined;
  let prefix = 0;
  let sawZero = false;
  for (let bit = 31; bit >= 0; bit -= 1) {
    if ((mask & (2 ** bit)) !== 0) {
      if (sawZero) return undefined;
      prefix += 1;
    } else {
      sawZero = true;
    }
  }
  return prefix;
}

function formatIPv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function overlaps(left: ParsedIPv4Cidr, right: ParsedIPv4Cidr): boolean {
  return left.start <= right.end && right.start <= left.end;
}
