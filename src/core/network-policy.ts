import fs from "node:fs";
import path from "node:path";
import { DEVROUTER_HOME } from "./router";

export const NETWORK_POLICY_VERSION = 1 as const;
export const NETWORK_POLICY_FILE = path.join(DEVROUTER_HOME, "network-policy.json");
export const DEFAULT_NETWORK_POLICY_ENDPOINT_RESERVE = 8;
export const NETWORK_POLICY_PREFIX_LENGTHS = [24, 25, 26] as const;
export const MAX_NETWORK_POLICY_FILE_BYTES = 64 * 1024;
export const MAX_NETWORK_POLICY_ARRAY_ENTRIES = 128;
export const MAX_NETWORK_POLICY_DAEMON_ID_LENGTH = 256;

export type NetworkPolicyPrefixLength = (typeof NETWORK_POLICY_PREFIX_LENGTHS)[number];

export type NetworkPolicy = {
  version: typeof NETWORK_POLICY_VERSION;
  daemonId: string;
  pools: string[];
  exclusions: string[];
  allowedPrefixes: NetworkPolicyPrefixLength[];
  endpointReserve: number;
};

export type NetworkPolicyReadResult =
  | { status: "absent"; path: string }
  | { status: "valid"; path: string; policy: NetworkPolicy }
  | { status: "invalid"; path: string; error: string };

export class NetworkPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyValidationError";
  }
}

type ParsedIPv4Cidr = {
  cidr: string;
  start: number;
  end: number;
  prefixLength: number;
};

const NETWORK_POLICY_KEYS = new Set([
  "version",
  "daemonId",
  "pools",
  "exclusions",
  "allowedPrefixes",
  "endpointReserve",
]);

const PRIVATE_IPV4_RANGES = [
  parseIPv4Range("10.0.0.0/8"),
  parseIPv4Range("172.16.0.0/12"),
  parseIPv4Range("192.168.0.0/16"),
];

export function parseNetworkPolicy(value: unknown): NetworkPolicy {
  const objectValue = asObject(value, "network policy must be an object");
  if (Object.keys(objectValue).some((key) => !NETWORK_POLICY_KEYS.has(key))) {
    throw new NetworkPolicyValidationError("network policy contains unsupported keys");
  }

  if (objectValue.version !== NETWORK_POLICY_VERSION) {
    throw new NetworkPolicyValidationError("network policy.version must be 1");
  }

  const daemonId = parseDaemonId(objectValue.daemonId);
  const pools = parseCidrs(objectValue.pools, "network policy.pools", true);
  const exclusions = parseCidrs(objectValue.exclusions, "network policy.exclusions", false);
  const allowedPrefixes = parseAllowedPrefixes(objectValue.allowedPrefixes);
  const endpointReserve = parseEndpointReserve(objectValue.endpointReserve);
  const parsedPools = pools.map((cidr) => parsePrivateCidr(cidr));
  const parsedExclusions = exclusions.map((cidr) => parsePrivateCidr(cidr));

  assertDisjoint(parsedPools, "network policy contains overlapping pools");
  assertDisjoint(parsedExclusions, "network policy contains overlapping exclusions");
  if (
    parsedExclusions.some(
      (exclusion) =>
        !parsedPools.some((pool) => pool.start <= exclusion.start && exclusion.end <= pool.end),
    )
  ) {
    throw new NetworkPolicyValidationError("network policy exclusions must be inside a pool");
  }

  return {
    version: NETWORK_POLICY_VERSION,
    daemonId,
    pools,
    exclusions,
    allowedPrefixes,
    endpointReserve,
  };
}

export function readNetworkPolicy(filePath = NETWORK_POLICY_FILE): NetworkPolicyReadResult {
  const file = readPolicyFile(filePath);
  if (file.status === "absent") return { status: "absent", path: filePath };
  if (file.status === "invalid") {
    return { status: "invalid", path: filePath, error: file.error };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.raw) as unknown;
  } catch {
    return { status: "invalid", path: filePath, error: "network policy JSON is invalid" };
  }

  try {
    return { status: "valid", path: filePath, policy: parseNetworkPolicy(parsed) };
  } catch (error) {
    return {
      status: "invalid",
      path: filePath,
      error:
        error instanceof NetworkPolicyValidationError ? error.message : "network policy is invalid",
    };
  }
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NetworkPolicyValidationError(message);
  }
  return value as Record<string, unknown>;
}

function parseDaemonId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_NETWORK_POLICY_DAEMON_ID_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new NetworkPolicyValidationError(
      "network policy.daemonId must be a non-empty string of at most 256 characters",
    );
  }
  return value;
}

function parseCidrs(value: unknown, label: string, required: boolean): string[] {
  if (
    !Array.isArray(value) ||
    (required && value.length === 0) ||
    value.length > MAX_NETWORK_POLICY_ARRAY_ENTRIES
  ) {
    throw new NetworkPolicyValidationError(
      required
        ? `${label} must be a non-empty array of at most 128 entries`
        : `${label} must be an array of at most 128 entries`,
    );
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry) {
      throw new NetworkPolicyValidationError(`${label}[${index}] must be a private IPv4 CIDR`);
    }
    return parsePrivateCidr(entry).cidr;
  });
}

function parseAllowedPrefixes(value: unknown): NetworkPolicyPrefixLength[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_NETWORK_POLICY_ARRAY_ENTRIES
  ) {
    throw new NetworkPolicyValidationError(
      "network policy.allowedPrefixes must be a non-empty array of at most 128 entries",
    );
  }

  const prefixes = value.map((entry) => {
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      !NETWORK_POLICY_PREFIX_LENGTHS.includes(entry as NetworkPolicyPrefixLength)
    ) {
      throw new NetworkPolicyValidationError(
        "network policy.allowedPrefixes must contain only 24, 25, or 26",
      );
    }
    return entry as NetworkPolicyPrefixLength;
  });
  if (new Set(prefixes).size !== prefixes.length) {
    throw new NetworkPolicyValidationError("network policy.allowedPrefixes contains duplicates");
  }
  return prefixes;
}

function parseEndpointReserve(value: unknown): number {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new NetworkPolicyValidationError(
      "network policy.endpointReserve must be a non-negative integer",
    );
  }
  return value === undefined ? DEFAULT_NETWORK_POLICY_ENDPOINT_RESERVE : value;
}

function parsePrivateCidr(value: string): ParsedIPv4Cidr {
  const parsed = parseCidr(value);
  if (!parsed) {
    throw new NetworkPolicyValidationError(
      "network policy CIDRs must be canonical private IPv4 ranges",
    );
  }
  if (
    !PRIVATE_IPV4_RANGES.some((range) => range.start <= parsed.start && parsed.end <= range.end)
  ) {
    throw new NetworkPolicyValidationError("network policy CIDRs must be private IPv4 ranges");
  }
  return parsed;
}

function parseCidr(value: string): ParsedIPv4Cidr | undefined {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !/^(?:0|[1-9]|[12]\d|3[0-2])$/.test(parts[1])) {
    return undefined;
  }
  const address = parseIPv4Address(parts[0]);
  const prefixLength = Number(parts[1]);
  if (address === undefined || prefixLength === 0) return undefined;

  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  const start = (address & mask) >>> 0;
  if (address !== start) return undefined;

  return {
    cidr: `${formatIPv4(start)}/${prefixLength}`,
    start,
    end: start + 2 ** (32 - prefixLength) - 1,
    prefixLength,
  };
}

function parseIPv4Range(value: string): ParsedIPv4Cidr {
  const parsed = parseCidr(value);
  if (!parsed) throw new Error("invalid network policy private range");
  return parsed;
}

function parseIPv4Address(value: string): number | undefined {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  ) {
    return undefined;
  }
  const octets = parts.map(Number);
  return (((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function formatIPv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

type PolicyFileReadResult =
  | { status: "absent" }
  | { status: "invalid"; error: string }
  | { status: "valid"; raw: string };

function readPolicyFile(filePath: string): PolicyFileReadResult {
  let initialStats: fs.Stats;
  try {
    initialStats = fs.lstatSync(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { status: "absent" };
    return { status: "invalid", error: "network policy could not be read" };
  }
  if (!initialStats.isFile()) {
    return { status: "invalid", error: "network policy must be a regular file" };
  }
  if (initialStats.size > MAX_NETWORK_POLICY_FILE_BYTES) {
    return { status: "invalid", error: "network policy exceeds the file size limit" };
  }

  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { status: "absent" };
    return { status: "invalid", error: "network policy could not be read" };
  }

  try {
    const openedStats = fs.fstatSync(fileDescriptor);
    if (!openedStats.isFile()) {
      return { status: "invalid", error: "network policy must be a regular file" };
    }
    if (openedStats.size > MAX_NETWORK_POLICY_FILE_BYTES) {
      return { status: "invalid", error: "network policy exceeds the file size limit" };
    }
    if (openedStats.size !== initialStats.size) {
      return { status: "invalid", error: "network policy changed during read" };
    }

    const buffer = Buffer.alloc(openedStats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fileDescriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0)
        return { status: "invalid", error: "network policy changed during read" };
      offset += bytesRead;
    }

    const finalStats = fs.fstatSync(fileDescriptor);
    if (!finalStats.isFile() || finalStats.size !== openedStats.size) {
      return { status: "invalid", error: "network policy changed during read" };
    }
    return { status: "valid", raw: buffer.toString("utf8") };
  } catch {
    return { status: "invalid", error: "network policy could not be read" };
  } finally {
    try {
      fs.closeSync(fileDescriptor);
    } catch {
      // The policy result is already conservative if close fails.
    }
  }
}

function assertDisjoint(cidrs: ParsedIPv4Cidr[], message: string): void {
  for (let index = 0; index < cidrs.length; index += 1) {
    for (let other = index + 1; other < cidrs.length; other += 1) {
      if (cidrs[index].start <= cidrs[other].end && cidrs[other].start <= cidrs[index].end) {
        throw new NetworkPolicyValidationError(message);
      }
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
