import { createHash } from "node:crypto";

export const SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS = "full-lifecycle-demand";

type JsonRecord = Record<string, unknown>;

export type ComposeNetworkStatus = "eligible" | "unsupported" | "unknown";

export interface ComposeNetworkReason {
  code: string;
  message: string;
}

export interface NormalizedComposeJson {
  services?: unknown;
  networks?: unknown;
  [key: string]: unknown;
}

export interface AuthoredNetworkDeclaration {
  name?: unknown;
  external?: unknown;
  driver?: unknown;
  driver_opts?: unknown;
  ipam?: unknown;
  enable_ipv6?: unknown;
  [key: string]: unknown;
}

export type AuthoredNetworkDeclarations = Record<
  string,
  AuthoredNetworkDeclaration | null | undefined
>;

export interface ComposeNetworkEligibilityInput {
  compose: NormalizedComposeJson;
  authoredNetworks?: AuthoredNetworkDeclarations;
  mode?: unknown;
  metadata?: unknown;
}

export interface ComposeNetworkEligibility {
  status: ComposeNetworkStatus;
  eligible: boolean;
  targetNetwork: "default";
  privateNetworks: string[];
  externalNetworks: string[];
  reasons: ComposeNetworkReason[];
}

export interface ComposeEndpointUpperBound {
  value: number;
  semantics: string;
}

export interface ComposeNetworkDemandInput extends ComposeNetworkEligibilityInput {
  targetNetwork?: string;
  helperEndpoints?: unknown;
  retainedEndpoints?: unknown;
  recreationSurge?: unknown;
  staticReservations?: unknown;
  endpointUpperBound?: unknown;
  endpointUpperBoundSemantics?: unknown;
}

export interface ComposeNetworkDemand {
  status: "known" | "unknown";
  targetNetwork: string;
  lowerBound: number;
  upperBound?: number;
  upperBoundSource?: "known" | "explicit";
  observed: {
    serviceEndpoints: number;
    helperEndpoints: number;
    retainedEndpoints: number;
    recreationSurge: number;
    staticReservations: number;
  };
  serviceEndpointsByService: Record<string, number>;
  replicasByService: Record<string, number>;
  reasons: ComposeNetworkReason[];
}

export interface ComposeNetworkOverlay {
  networks: {
    default: {
      ipam: {
        config: Array<{ subnet: string }>;
      };
    };
  };
}

export interface ComposeNetworkOverlayResult {
  status: "ready" | "unknown";
  overlay?: ComposeNetworkOverlay;
  reasons: ComposeNetworkReason[];
}

export interface EffectiveComposeConfigResult<T extends JsonRecord = JsonRecord> {
  status: "ready" | "unknown";
  config?: T & { dockerComposeFile: string[] };
  reasons: ComposeNetworkReason[];
}

export interface ComposeNetworkFingerprintInput {
  compose: NormalizedComposeJson;
  authoredNetworks?: AuthoredNetworkDeclarations;
  demand?: Pick<
    ComposeNetworkDemandInput,
    | "helperEndpoints"
    | "retainedEndpoints"
    | "recreationSurge"
    | "staticReservations"
    | "endpointUpperBound"
    | "endpointUpperBoundSemantics"
  >;
  overlay?: unknown;
}

interface NetworkInspection {
  names: string[];
  normalized: JsonRecord;
  authored: JsonRecord;
}

interface ParsedCount {
  value: number;
  known: boolean;
}

interface ParsedReplicas extends ParsedCount {
  dynamic: boolean;
}

interface ParsedServiceNetworks {
  names: string[];
  known: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.hasOwn(record, key);
}

function reason(code: string, message: string): ComposeNetworkReason {
  return { code, message };
}

function addReason(reasons: ComposeNetworkReason[], next: ComposeNetworkReason): void {
  if (!reasons.some((current) => current.code === next.code && current.message === next.message)) {
    reasons.push(next);
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function readMap(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function readMode(input: ComposeNetworkEligibilityInput): unknown {
  if (input.mode !== undefined) {
    return input.mode;
  }

  if (!isRecord(input.metadata)) {
    return undefined;
  }

  for (const key of ["mode", "runtimeMode", "checkoutMode"]) {
    if (input.metadata[key] !== undefined) {
      return input.metadata[key];
    }
  }

  return undefined;
}

function readExternal(value: unknown): { value?: boolean; known: boolean } {
  if (value === undefined) {
    return { known: true };
  }
  if (typeof value === "boolean") {
    return { value, known: true };
  }
  if (isRecord(value)) {
    return { value: true, known: true };
  }
  return { known: false };
}

function readDriver(value: unknown): { value?: string; known: boolean } {
  if (value === undefined) {
    return { value: "bridge", known: true };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { known: false };
  }
  return { value: value.toLowerCase(), known: true };
}

function inspectNetworks(
  input: ComposeNetworkEligibilityInput,
  reasons: ComposeNetworkReason[],
): NetworkInspection {
  const compose = isRecord(input.compose) ? input.compose : {};
  const normalizedValue = compose.networks;
  const authoredValue = input.authoredNetworks;
  const normalized = normalizedValue === undefined ? {} : readMap(normalizedValue);
  const authored = authoredValue === undefined ? {} : readMap(authoredValue);

  if (normalizedValue !== undefined && normalized === undefined) {
    addReason(
      reasons,
      reason("malformed-normalized-networks", "Normalized Compose networks must be an object."),
    );
  }
  if (authoredValue !== undefined && authored === undefined) {
    addReason(
      reasons,
      reason("malformed-authored-networks", "Authored network declarations must be an object."),
    );
  }

  const names: string[] = [...Object.keys(normalized ?? {}), ...Object.keys(authored ?? {})];

  const services = readMap(compose.services);
  if (services === undefined) {
    addReason(
      reasons,
      reason(
        "missing-normalized-services",
        "Normalized Compose services are required to prove topology.",
      ),
    );
  } else {
    for (const [serviceName, rawService] of Object.entries(services)) {
      if (!isRecord(rawService)) {
        addReason(reasons, reason("malformed-service", `Service ${serviceName} is not an object.`));
        continue;
      }
      const membership = parseServiceNetworks(rawService.networks, serviceName, reasons);
      names.push(...membership.names);
    }
  }

  if (names.length === 0) {
    names.push("default");
  }

  return {
    names: sortedUnique(names),
    normalized: normalized ?? {},
    authored: authored ?? {},
  };
}

function parseServiceNetworks(
  value: unknown,
  serviceName: string,
  reasons: ComposeNetworkReason[],
): ParsedServiceNetworks {
  if (value === undefined) {
    return { names: ["default"], known: true };
  }

  if (Array.isArray(value)) {
    const names: string[] = [];
    for (const networkName of value) {
      if (typeof networkName !== "string" || networkName.trim() === "") {
        addReason(
          reasons,
          reason(
            "malformed-service-networks",
            `Service ${serviceName} has a malformed network name.`,
          ),
        );
        continue;
      }
      names.push(networkName);
    }
    if (new Set(names).size !== names.length) {
      addReason(
        reasons,
        reason("duplicate-service-network", `Service ${serviceName} repeats a network attachment.`),
      );
      return { names: sortedUnique(names), known: false };
    }
    return { names: sortedUnique(names), known: true };
  }

  if (!isRecord(value)) {
    addReason(
      reasons,
      reason(
        "malformed-service-networks",
        `Service ${serviceName} networks must be an array or object.`,
      ),
    );
    return { names: [], known: false };
  }

  let known = true;
  for (const [networkName, attachment] of Object.entries(value)) {
    if (networkName.trim() === "") {
      known = false;
      addReason(
        reasons,
        reason("malformed-service-networks", `Service ${serviceName} has an empty network name.`),
      );
      continue;
    }
    if (attachment !== null && !isRecord(attachment)) {
      known = false;
      addReason(
        reasons,
        reason(
          "malformed-network-attachment",
          `Service ${serviceName} has a malformed ${networkName} attachment.`,
        ),
      );
    }
  }

  return { names: sortedUnique(Object.keys(value)), known };
}

function authoredHas(authored: JsonRecord, name: string, key: string): boolean {
  const declaration = authored[name];
  return isRecord(declaration) && hasOwn(declaration, key);
}

function authoredValue(authored: JsonRecord, name: string, key: string): unknown {
  const declaration = authored[name];
  return isRecord(declaration) ? declaration[key] : undefined;
}

function normalizedValue(normalized: JsonRecord, name: string, key: string): unknown {
  const declaration = normalized[name];
  return isRecord(declaration) ? declaration[key] : undefined;
}

function classifyNetwork(
  name: string,
  inspection: NetworkInspection,
  reasons: ComposeNetworkReason[],
): { external: boolean; private: boolean } {
  const authoredDeclaration = inspection.authored[name];
  const normalizedDeclaration = inspection.normalized[name];

  if (authoredDeclaration !== undefined && !isRecord(authoredDeclaration)) {
    addReason(
      reasons,
      reason("malformed-authored-network", `Authored network ${name} is not an object.`),
    );
    return { external: false, private: false };
  }
  if (normalizedDeclaration !== undefined && !isRecord(normalizedDeclaration)) {
    addReason(
      reasons,
      reason("malformed-normalized-network", `Normalized network ${name} is not an object.`),
    );
    return { external: false, private: false };
  }

  const authoredExternal = readExternal(authoredValue(inspection.authored, name, "external"));
  const normalizedExternal = readExternal(normalizedValue(inspection.normalized, name, "external"));
  if (!authoredExternal.known || !normalizedExternal.known) {
    addReason(
      reasons,
      reason("malformed-external-network", `Network ${name} has malformed external metadata.`),
    );
    return { external: false, private: false };
  }
  if (
    authoredExternal.value !== undefined &&
    normalizedExternal.value !== undefined &&
    authoredExternal.value !== normalizedExternal.value
  ) {
    addReason(
      reasons,
      reason(
        "network-declaration-conflict",
        `Network ${name} has conflicting authored and normalized external metadata.`,
      ),
    );
    return { external: false, private: false };
  }
  if (authoredHas(inspection.authored, name, "external") && authoredExternal.value !== true) {
    addReason(
      reasons,
      reason("explicit-authored-external", `Network ${name} has an authored external declaration.`),
    );
  }
  if (authoredExternal.value === true || normalizedExternal.value === true) {
    return { external: true, private: false };
  }

  const authoredDriver = readDriver(authoredValue(inspection.authored, name, "driver"));
  const normalizedDriver = readDriver(normalizedValue(inspection.normalized, name, "driver"));
  if (!authoredDriver.known || !normalizedDriver.known) {
    addReason(
      reasons,
      reason("malformed-network-driver", `Network ${name} has malformed driver metadata.`),
    );
    return { external: false, private: false };
  }
  if (authoredDriver.value !== "bridge") {
    addReason(
      reasons,
      reason("custom-network-driver", `Network ${name} uses driver ${authoredDriver.value}.`),
    );
  }
  if (normalizedDriver.value !== "bridge") {
    addReason(
      reasons,
      reason(
        "custom-network-driver",
        `Network ${name} uses normalized driver ${normalizedDriver.value}.`,
      ),
    );
  }

  if (authoredHas(inspection.authored, name, "name")) {
    const value = authoredValue(inspection.authored, name, "name");
    if (typeof value !== "string" || value.trim() === "") {
      addReason(
        reasons,
        reason("malformed-authored-name", `Network ${name} has a malformed authored name.`),
      );
    } else {
      addReason(
        reasons,
        reason("explicit-authored-name", `Network ${name} has an authored fixed name.`),
      );
    }
  }

  if (authoredHas(inspection.authored, name, "ipam")) {
    addReason(
      reasons,
      reason("explicit-authored-ipam", `Network ${name} has authored IPAM settings.`),
    );
  } else {
    const normalizedIpam = normalizedValue(inspection.normalized, name, "ipam");
    if (normalizedIpam !== undefined) {
      if (!isRecord(normalizedIpam)) {
        addReason(
          reasons,
          reason("malformed-normalized-ipam", `Network ${name} has malformed normalized IPAM.`),
        );
      } else if (hasOwn(normalizedIpam, "config") && normalizedIpam.config !== undefined) {
        if (!Array.isArray(normalizedIpam.config)) {
          addReason(
            reasons,
            reason(
              "malformed-normalized-ipam",
              `Network ${name} has malformed normalized IPAM config.`,
            ),
          );
        }
      }
    }
  }

  if (authoredHas(inspection.authored, name, "driver_opts")) {
    addReason(
      reasons,
      reason("custom-network-options", `Network ${name} has authored driver options.`),
    );
  }

  if (authoredHas(inspection.authored, name, "enable_ipv6")) {
    const enableIpv6 = authoredValue(inspection.authored, name, "enable_ipv6");
    if (enableIpv6 !== false) {
      addReason(
        reasons,
        reason("ipv6-network-unsupported", `Network ${name} has authored IPv6 settings.`),
      );
    }
  }

  return { external: false, private: true };
}

export function classifyComposeNetworkEligibility(
  input: ComposeNetworkEligibilityInput,
): ComposeNetworkEligibility {
  const reasons: ComposeNetworkReason[] = [];
  const mode = readMode(input);
  if (mode === "primary" || mode === "image") {
    addReason(
      reasons,
      reason("mode-unsupported", `Compose network allocation is unsupported for ${mode} mode.`),
    );
  } else if (mode !== undefined && typeof mode !== "string") {
    addReason(reasons, reason("malformed-mode", "Compose runtime mode metadata must be a string."));
  }

  const inspection = inspectNetworks(input, reasons);
  const privateNetworks: string[] = [];
  const externalNetworks: string[] = [];
  for (const name of inspection.names) {
    const classification = classifyNetwork(name, inspection, reasons);
    if (classification.external) {
      externalNetworks.push(name);
    } else if (classification.private) {
      privateNetworks.push(name);
    }
  }

  const isUnknownReason = (current: ComposeNetworkReason): boolean =>
    current.code.startsWith("malformed-") ||
    current.code.startsWith("missing-") ||
    current.code === "network-declaration-conflict";
  const knownTopology = reasons.every((current) => !isUnknownReason(current));
  if (privateNetworks.length === 0 && knownTopology) {
    addReason(
      reasons,
      reason(
        "no-private-network",
        "No private Compose network is available for managed allocation.",
      ),
    );
  }
  if (privateNetworks.length > 1) {
    addReason(
      reasons,
      reason(
        "multiple-private-networks",
        "Multiple private Compose networks cannot share one managed subnet.",
      ),
    );
  }
  if (privateNetworks.length === 1 && privateNetworks[0] !== "default") {
    addReason(
      reasons,
      reason(
        "non-default-private-network",
        "Only the implicit/default private Compose network is eligible.",
      ),
    );
  }

  const hasUnknownReason = reasons.some(isUnknownReason);
  const hasUnsupportedReason = reasons.some((current) => !isUnknownReason(current));
  const eligible =
    reasons.length === 0 && privateNetworks.length === 1 && privateNetworks[0] === "default";

  return {
    status: eligible
      ? "eligible"
      : hasUnknownReason
        ? "unknown"
        : hasUnsupportedReason
          ? "unsupported"
          : "unknown",
    eligible,
    targetNetwork: "default",
    privateNetworks: sortedUnique(privateNetworks),
    externalNetworks: sortedUnique(externalNetworks),
    reasons,
  };
}

function parseCount(value: unknown, field: string, reasons: ComposeNetworkReason[]): ParsedCount {
  if (value === undefined) {
    return { value: 0, known: true };
  }

  const candidate = isRecord(value) && hasOwn(value, "count") ? value.count : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    addReason(reasons, reason("malformed-count", `${field} must be a non-negative integer.`));
    return { value: 0, known: false };
  }

  return { value: candidate, known: true };
}

function parseReplicas(
  service: JsonRecord,
  serviceName: string,
  reasons: ComposeNetworkReason[],
): ParsedReplicas {
  const candidates: Array<{ field: string; value: unknown }> = [];
  if (hasOwn(service, "replicas")) {
    candidates.push({ field: "replicas", value: service.replicas });
  }
  if (hasOwn(service, "scale")) {
    candidates.push({ field: "scale", value: service.scale });
  }

  if (hasOwn(service, "deploy")) {
    if (!isRecord(service.deploy)) {
      addReason(
        reasons,
        reason("malformed-replicas", `Service ${serviceName} deploy metadata is malformed.`),
      );
      return { value: 0, known: false, dynamic: false };
    }
    if (hasOwn(service.deploy, "replicas")) {
      candidates.unshift({ field: "deploy.replicas", value: service.deploy.replicas });
    }
  }

  if (candidates.length === 0) {
    return { value: 1, known: true, dynamic: false };
  }

  const parsed: number[] = [];
  for (const candidate of candidates) {
    if (
      typeof candidate.value === "number" &&
      Number.isSafeInteger(candidate.value) &&
      candidate.value >= 0
    ) {
      parsed.push(candidate.value);
      continue;
    }
    if (typeof candidate.value === "string" && /^\d+$/.test(candidate.value)) {
      const numeric = Number(candidate.value);
      if (Number.isSafeInteger(numeric)) {
        parsed.push(numeric);
        continue;
      }
    }
    const dynamic =
      candidate.value === null ||
      candidate.value === "*" ||
      candidate.value === "dynamic" ||
      candidate.value === "unbounded" ||
      (typeof candidate.value === "string" && /\$\{[^}]+\}/.test(candidate.value));
    if (!dynamic) {
      addReason(
        reasons,
        reason(
          "malformed-replicas",
          `Service ${serviceName} has unbounded or malformed ${candidate.field}.`,
        ),
      );
    }
    return { value: 0, known: false, dynamic };
  }

  if (new Set(parsed).size !== 1) {
    addReason(
      reasons,
      reason("contradictory-replicas", `Service ${serviceName} has contradictory replica counts.`),
    );
    return { value: 0, known: false, dynamic: false };
  }

  return { value: parsed[0], known: true, dynamic: false };
}

function parseUpperBound(
  input: ComposeNetworkDemandInput,
  reasons: ComposeNetworkReason[],
): ParsedCount & { explicit: boolean } {
  if (input.endpointUpperBound === undefined) {
    return { value: 0, known: true, explicit: false };
  }

  const raw = input.endpointUpperBound;
  let value: unknown = raw;
  let semantics: unknown = input.endpointUpperBoundSemantics;
  if (isRecord(raw)) {
    value = raw.value ?? raw.endpoints ?? raw.count;
    semantics = raw.semantics ?? semantics;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    addReason(
      reasons,
      reason(
        "malformed-endpoint-upper-bound",
        "Endpoint upper bound must be a non-negative integer.",
      ),
    );
    return { value: 0, known: false, explicit: true };
  }
  if (semantics !== SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS) {
    addReason(
      reasons,
      reason(
        "unsafe-endpoint-upper-bound",
        `Endpoint upper bound must state ${SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS} semantics.`,
      ),
    );
    return { value, known: false, explicit: true };
  }

  return { value, known: true, explicit: true };
}

function parseIpv4Cidr(value: unknown): { prefixLength?: number; canonical?: string } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const octets = match[1].split(".").map(Number);
  const prefixLength = Number(match[2]);
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ||
    prefixLength < 0 ||
    prefixLength > 32
  ) {
    return undefined;
  }
  const address = octets[0] * 2 ** 24 + octets[1] * 2 ** 16 + octets[2] * 2 ** 8 + octets[3];
  const blockSize = 2 ** (32 - prefixLength);
  const network = Math.floor(address / blockSize) * blockSize;
  if (network !== address) {
    return undefined;
  }
  const canonical = [
    Math.floor(network / 2 ** 24),
    Math.floor(network / 2 ** 16) % 256,
    Math.floor(network / 2 ** 8) % 256,
    network % 256,
  ].join(".");
  return { prefixLength, canonical: `${canonical}/${prefixLength}` };
}

export function deriveComposeNetworkDemand(input: ComposeNetworkDemandInput): ComposeNetworkDemand {
  const reasons: ComposeNetworkReason[] = [];
  const targetNetwork = input.targetNetwork ?? "default";
  if (targetNetwork !== "default") {
    addReason(
      reasons,
      reason(
        "unsupported-target-network",
        "Managed Compose allocation currently targets only the default network.",
      ),
    );
  }

  const compose = isRecord(input.compose) ? input.compose : {};
  const services = readMap(compose.services);
  const serviceEndpointsByService: Record<string, number> = {};
  const replicasByService: Record<string, number> = {};
  let serviceEndpoints = 0;
  let serviceDemandKnown = true;
  let hasDynamicScale = false;

  if (services === undefined) {
    addReason(
      reasons,
      reason(
        "missing-normalized-services",
        "Normalized Compose services are required to derive endpoint demand.",
      ),
    );
    serviceDemandKnown = false;
  } else {
    for (const [serviceName, rawService] of Object.entries(services)) {
      if (!isRecord(rawService)) {
        addReason(reasons, reason("malformed-service", `Service ${serviceName} is not an object.`));
        serviceDemandKnown = false;
        continue;
      }
      const membership = parseServiceNetworks(rawService.networks, serviceName, reasons);
      const replicas = parseReplicas(rawService, serviceName, reasons);
      if (!membership.known || !replicas.known) {
        if (replicas.dynamic) {
          hasDynamicScale = true;
        } else {
          serviceDemandKnown = false;
        }
        if (!membership.known) {
          serviceDemandKnown = false;
        }
        continue;
      }
      const targetAttachments = membership.names.filter((name) => name === targetNetwork).length;
      const endpoints = replicas.value * targetAttachments;
      serviceEndpointsByService[serviceName] = endpoints;
      replicasByService[serviceName] = replicas.value;
      serviceEndpoints += endpoints;
    }
  }

  const helperEndpoints = parseCount(input.helperEndpoints, "helperEndpoints", reasons);
  const retainedEndpoints = parseCount(input.retainedEndpoints, "retainedEndpoints", reasons);
  const recreationSurge = parseCount(input.recreationSurge, "recreationSurge", reasons);
  const staticReservations = parseCount(input.staticReservations, "staticReservations", reasons);
  const upperBound = parseUpperBound(input, reasons);
  const lowerBound =
    serviceEndpoints +
    helperEndpoints.value +
    retainedEndpoints.value +
    recreationSurge.value +
    staticReservations.value;
  let demandKnown =
    serviceDemandKnown &&
    helperEndpoints.known &&
    retainedEndpoints.known &&
    recreationSurge.known &&
    staticReservations.known &&
    upperBound.known;
  let calculatedUpperBound: number | undefined;
  let upperBoundSource: "known" | "explicit" | undefined;

  if (hasDynamicScale && !(upperBound.explicit && upperBound.known)) {
    addReason(
      reasons,
      reason("unbounded-replicas", "Dynamic scale requires a safe full-lifecycle endpoint bound."),
    );
    demandKnown = false;
  }

  if (upperBound.explicit && upperBound.known) {
    if (upperBound.value < lowerBound) {
      addReason(
        reasons,
        reason(
          "contradictory-endpoint-upper-bound",
          "Endpoint upper bound is below the known lower bound.",
        ),
      );
      demandKnown = false;
    } else {
      calculatedUpperBound = upperBound.value;
      upperBoundSource = "explicit";
    }
  } else if (demandKnown) {
    calculatedUpperBound = lowerBound;
    upperBoundSource = "known";
  }

  return {
    status: demandKnown ? "known" : "unknown",
    targetNetwork,
    lowerBound,
    upperBound: calculatedUpperBound,
    upperBoundSource,
    observed: {
      serviceEndpoints,
      helperEndpoints: helperEndpoints.value,
      retainedEndpoints: retainedEndpoints.value,
      recreationSurge: recreationSurge.value,
      staticReservations: staticReservations.value,
    },
    serviceEndpointsByService,
    replicasByService,
    reasons,
  };
}

export function deriveComposeNetworkOverlay(subnet: unknown): ComposeNetworkOverlayResult {
  const parsed = parseIpv4Cidr(subnet);
  if (parsed === undefined || parsed.canonical === undefined) {
    return {
      status: "unknown",
      reasons: [
        reason("malformed-overlay-subnet", "Network overlay subnet must be a canonical IPv4 CIDR."),
      ],
    };
  }

  return {
    status: "ready",
    overlay: {
      networks: {
        default: {
          ipam: {
            config: [{ subnet: parsed.canonical }],
          },
        },
      },
    },
    reasons: [],
  };
}

export function extendDockerComposeFile<T extends JsonRecord>(
  nativeConfig: T,
  overlayPath: unknown,
): EffectiveComposeConfigResult<T> {
  if (!isRecord(nativeConfig)) {
    return {
      status: "unknown",
      reasons: [
        reason("malformed-native-config", "Native Dev Container configuration must be an object."),
      ],
    };
  }
  if (typeof overlayPath !== "string" || overlayPath.trim() === "") {
    return {
      status: "unknown",
      reasons: [
        reason(
          "malformed-overlay-path",
          "Generated Compose overlay path must be a non-empty string.",
        ),
      ],
    };
  }

  const existing = nativeConfig.dockerComposeFile;
  let dockerComposeFile: string[];
  if (existing === undefined) {
    dockerComposeFile = [overlayPath];
  } else if (typeof existing === "string" && existing.trim() !== "") {
    dockerComposeFile = [existing, overlayPath];
  } else if (
    Array.isArray(existing) &&
    existing.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ) {
    dockerComposeFile = [...existing, overlayPath];
  } else {
    return {
      status: "unknown",
      reasons: [
        reason(
          "malformed-docker-compose-file",
          "Native dockerComposeFile must be a string or an array of non-empty strings.",
        ),
      ],
    };
  }

  const config = { ...nativeConfig, dockerComposeFile };
  return { status: "ready", config, reasons: [] };
}

function projectionNetworkMembership(value: unknown): string[] | "unknown" {
  const parsed = parseServiceNetworks(value, "fingerprint", []);
  return parsed.known ? parsed.names : "unknown";
}

function replicaProjection(service: JsonRecord): number | string {
  const reasons: ComposeNetworkReason[] = [];
  const replicas = parseReplicas(service, "fingerprint", reasons);
  return replicas.known ? replicas.value : "unknown";
}

function redactedNetworkProjection(value: unknown): unknown {
  if (!isRecord(value)) {
    return value === undefined ? undefined : "unknown";
  }
  const projection: JsonRecord = {};
  for (const key of ["external", "driver"]) {
    if (hasOwn(value, key)) {
      const item = value[key];
      projection[key] =
        key === "external"
          ? readExternal(item).known
            ? (readExternal(item).value ?? false)
            : "unknown"
          : (readDriver(item).value ?? "unknown");
    }
  }
  for (const key of ["name", "ipam", "driver_opts", "enable_ipv6"]) {
    if (hasOwn(value, key)) {
      if (key === "name") {
        projection.name = typeof value.name === "string" ? value.name : "unknown";
      } else if (key === "ipam") {
        const ipam = readMap(value.ipam);
        const config = Array.isArray(ipam?.config) ? ipam.config : undefined;
        projection.ipam = {
          config:
            config === undefined
              ? "unknown"
              : config.map((entry) =>
                  isRecord(entry) && typeof entry.subnet === "string" ? entry.subnet : "unknown",
                ),
        };
      } else if (key === "enable_ipv6") {
        projection.enableIpv6 =
          typeof value.enable_ipv6 === "boolean" ? value.enable_ipv6 : "unknown";
      } else {
        projection.driverOptionsPresent = true;
      }
    }
  }
  return projection;
}

function redactedCountProjection(value: unknown): number | "unknown" {
  if (value === undefined) {
    return 0;
  }
  const candidate = isRecord(value) && hasOwn(value, "count") ? value.count : value;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : "unknown";
}

function redactedUpperBoundProjection(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : "unknown";
  }
  if (!isRecord(value)) {
    return "unknown";
  }
  const candidate = value.value ?? value.endpoints ?? value.count;
  return {
    value:
      typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
        ? candidate
        : "unknown",
    semantics: typeof value.semantics === "string" ? value.semantics : "unknown",
  };
}

function normalizedFingerprintProjection(input: ComposeNetworkFingerprintInput): JsonRecord {
  const compose = isRecord(input.compose) ? input.compose : {};
  const services = readMap(compose.services);
  const serviceProjection: JsonRecord = {};
  for (const serviceName of Object.keys(services ?? {}).sort()) {
    const service = services?.[serviceName];
    serviceProjection[serviceName] = isRecord(service)
      ? {
          networks: projectionNetworkMembership(service.networks),
          replicas: replicaProjection(service),
        }
      : "unknown";
  }

  const networkNames = sortedUnique([
    ...Object.keys(readMap(compose.networks) ?? {}),
    ...Object.keys(input.authoredNetworks ?? {}),
  ]);
  const networkProjection: JsonRecord = {};
  for (const networkName of networkNames) {
    networkProjection[networkName] = {
      normalized: redactedNetworkProjection(readMap(compose.networks)?.[networkName]),
      authored: redactedNetworkProjection(input.authoredNetworks?.[networkName]),
    };
  }

  const demand = input.demand;
  return {
    services: serviceProjection,
    networks: networkProjection,
    demand:
      demand === undefined
        ? undefined
        : {
            helperEndpoints: redactedCountProjection(demand.helperEndpoints),
            retainedEndpoints: redactedCountProjection(demand.retainedEndpoints),
            recreationSurge: redactedCountProjection(demand.recreationSurge),
            staticReservations: redactedCountProjection(demand.staticReservations),
            endpointUpperBound: redactedUpperBoundProjection(demand.endpointUpperBound),
            endpointUpperBoundSemantics:
              typeof demand.endpointUpperBoundSemantics === "string"
                ? demand.endpointUpperBoundSemantics
                : "unknown",
          },
    overlay: redactedOverlayProjection(input.overlay),
  };
}

function redactedOverlayProjection(value: unknown): unknown {
  if (!isRecord(value)) {
    return value === undefined ? undefined : "unknown";
  }
  const networks = readMap(value.networks);
  const defaultNetwork = readMap(networks?.default);
  const ipam = readMap(defaultNetwork?.ipam);
  const config = Array.isArray(ipam?.config) ? ipam.config : undefined;
  if (
    config === undefined ||
    config.some((entry) => !isRecord(entry) || typeof entry.subnet !== "string")
  ) {
    return "unknown";
  }
  return {
    networks: { default: { ipam: { config: config.map((entry) => ({ subnet: entry.subnet })) } } },
  };
}

function stableValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableValue(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function fingerprintComposeNetworkModel(input: ComposeNetworkFingerprintInput): string {
  const projection = normalizedFingerprintProjection(input);
  return createHash("sha256").update(stableValue(projection), "utf8").digest("hex");
}
