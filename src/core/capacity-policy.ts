import fs from "node:fs";
import path from "node:path";

const MAX_DOMAINS = 256;
const MAX_ENROLLMENTS = 256;
const MAX_PROFILES_PER_ENROLLMENT = 64;
const MAX_STRING_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;

/** Missing policy means no enrollment; malformed or unsafe policy never does. */
export function readCapacityPolicy(directory: string): CapacityPolicy | undefined {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe capacity policy directory.");
    if (current === absolute && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
      throw new Error("Capacity policy directory is not private.");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      path.join(absolute, "capacity-policy.json"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    const limit = 1_048_576;
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > limit
    )
      throw new Error("Capacity policy is not a bounded private file.");
    const bytes = Buffer.alloc(limit + 1);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > limit) throw new Error("Capacity policy exceeds byte limit.");
    return parseCapacityPolicy(JSON.parse(bytes.subarray(0, count).toString("utf8")));
  } finally {
    fs.closeSync(descriptor);
  }
}

const DOMAIN_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROFILE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WORKSPACE_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type CapacityPolicyScheduling = {
  maxQueuedPerDomain: number;
  maxQueuedTotal: number;
  queueLifetimeSeconds: number;
  clientWaitSeconds: number;
  maxClientWaitSeconds: number;
  watchSeconds: number;
  sampleIntervalSeconds: number;
  maxSampleAgeSeconds: number;
};

export type CapacityHostDomain =
  | {
      kind: "host";
      adapter: "macos-host-v1";
      capacityBytes: number;
      protectedHeadroomBytes: number;
      startupSlots: number;
      heavySlots: number;
    }
  | {
      kind: "host";
      adapter: "macos-declared-v1";
      capacityBytes: number;
      protectedHeadroomBytes: number;
      unmanagedAllowanceBytes: number;
      startupSlots: number;
      heavySlots: number;
    };

export type CapacityRuntimeDomain =
  | {
      kind: "runtime";
      adapter: "orbstack-local-v1";
      endpoint: string;
      daemonId: string;
      hostDomain: string;
      hostChargeCeilingBytes: number;
      capacityBytes: number;
      protectedHeadroomBytes: number;
      startupSlots: number;
      heavySlots: number;
    }
  | {
      kind: "runtime";
      adapter: "orbstack-declared-v1";
      endpoint: string;
      daemonId: string;
      hostDomain: string;
      hostChargeCeilingBytes: number;
      capacityBytes: number;
      protectedHeadroomBytes: number;
      guestUnmanagedAllowanceBytes: number;
      startupSlots: number;
      heavySlots: number;
    };

export type CapacityPolicyDomain = CapacityHostDomain | CapacityRuntimeDomain;

export type CapacityPolicyEnrollment = {
  repoPath: string;
  gitCommonDir: string;
  workspace: string;
  provider: "devsy" | "devpod";
  providerId: string;
  hostDomain: string;
  runtimeDomain: string;
  profiles: string[];
  estimatesDigest: string;
  defaultOperation: {
    hostIncrementBytes: number;
    runtimeIncrementBytes: number;
  };
};

export type CapacityPolicy = {
  version: 1;
  revision: number;
  admissions: "enabled" | "paused";
  scheduling: CapacityPolicyScheduling;
  domains: Record<string, CapacityPolicyDomain>;
  enrollments: CapacityPolicyEnrollment[];
};

type UnknownObject = Record<string, unknown>;

function ensureObject(value: unknown, label: string): UnknownObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as UnknownObject;
}

function ensureAllowedKeys(
  value: UnknownObject,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} is not supported.`);
    }
  }
}

function parseBoundedString(value: unknown, label: string, maxLength = MAX_STRING_LENGTH): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} exceeds the maximum length of ${maxLength} characters.`);
  }
  if (
    [...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  ) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return value;
}

function parseSafeInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new Error(`${label} must be a safe integer.`);
  }
  if (value < minimum) {
    throw new Error(`${label} must be at least ${minimum}.`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, label: string): number {
  return parseSafeInteger(value, label, 1);
}

function parseCanonicalAbsolutePath(value: unknown, label: string): string {
  const parsed = parseBoundedString(value, label, MAX_PATH_LENGTH);
  if (!path.posix.isAbsolute(parsed)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  if (path.posix.resolve(parsed) !== parsed) {
    throw new Error(`${label} must be a canonical absolute path.`);
  }
  return parsed;
}

function parseDomainId(value: unknown, label: string): string {
  const id = parseBoundedString(value, label, 64);
  if (!DOMAIN_ID_RE.test(id)) {
    throw new Error(`${label} must be a lowercase alphanumeric or hyphen domain ID.`);
  }
  return id;
}

function parseProfileName(value: unknown, label: string): string {
  const combination = parseBoundedString(value, label, 64);
  const names = combination.split(",");
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error(
        `${label}[${index}] must be a lowercase alphanumeric or hyphen profile name.`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`${label} contains duplicate profile '${name}'.`);
    }
    seen.add(name);
  }
  return [...names].sort().join(",");
}

function parseUniqueProfiles(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array of profile names.`);
  }
  if (value.length > MAX_PROFILES_PER_ENROLLMENT) {
    throw new Error(
      `${label} exceeds the maximum of ${MAX_PROFILES_PER_ENROLLMENT} profile names.`,
    );
  }

  const profiles: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const profile = parseProfileName(entry, `${label}[${index}]`);
    if (seen.has(profile)) {
      throw new Error(`${label} contains duplicate or aliased profile combination '${profile}'.`);
    }
    seen.add(profile);
    profiles.push(profile);
  }
  return profiles;
}

function parseDigest(value: unknown, label: string): string {
  const digest = parseBoundedString(value, label, 64);
  if (!SHA256_RE.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
  }
  return digest;
}

function parseDomain(value: unknown, domainId: string): CapacityPolicyDomain {
  const label = `domains.${domainId}`;
  const domain = ensureObject(value, label);
  const kind = parseBoundedString(domain.kind, `${label}.kind`);

  if (kind === "host") {
    ensureAllowedKeys(
      domain,
      [
        "kind",
        "adapter",
        "capacityBytes",
        "protectedHeadroomBytes",
        "unmanagedAllowanceBytes",
        "startupSlots",
        "heavySlots",
      ],
      label,
    );
    const adapter = parseBoundedString(domain.adapter, `${label}.adapter`);
    if (adapter !== "macos-host-v1" && adapter !== "macos-declared-v1") {
      throw new Error(`${label}.adapter must be 'macos-host-v1' or 'macos-declared-v1'.`);
    }
    const capacityBytes = parsePositiveInteger(domain.capacityBytes, `${label}.capacityBytes`);
    const protectedHeadroomBytes = parsePositiveInteger(
      domain.protectedHeadroomBytes,
      `${label}.protectedHeadroomBytes`,
    );
    if (protectedHeadroomBytes >= capacityBytes) {
      throw new Error(`${label}.protectedHeadroomBytes must be less than capacityBytes.`);
    }
    const startupSlots = parsePositiveInteger(domain.startupSlots, `${label}.startupSlots`);
    const heavySlots = parsePositiveInteger(domain.heavySlots, `${label}.heavySlots`);

    if (adapter === "macos-host-v1") {
      if (Object.hasOwn(domain, "unmanagedAllowanceBytes")) {
        throw new Error(
          `${label}.unmanagedAllowanceBytes is only supported for adapter 'macos-declared-v1'.`,
        );
      }
      return {
        kind: "host",
        adapter: "macos-host-v1",
        capacityBytes,
        protectedHeadroomBytes,
        startupSlots,
        heavySlots,
      };
    }

    const unmanagedAllowanceBytes = parseSafeInteger(
      domain.unmanagedAllowanceBytes,
      `${label}.unmanagedAllowanceBytes`,
      0,
    );
    if (unmanagedAllowanceBytes > capacityBytes - protectedHeadroomBytes) {
      throw new Error(
        `${label}.unmanagedAllowanceBytes must not exceed capacityBytes minus protectedHeadroomBytes.`,
      );
    }
    return {
      kind: "host",
      adapter: "macos-declared-v1",
      capacityBytes,
      protectedHeadroomBytes,
      unmanagedAllowanceBytes,
      startupSlots,
      heavySlots,
    };
  }

  if (kind === "runtime") {
    ensureAllowedKeys(
      domain,
      [
        "kind",
        "adapter",
        "endpoint",
        "daemonId",
        "hostDomain",
        "hostChargeCeilingBytes",
        "capacityBytes",
        "protectedHeadroomBytes",
        "guestUnmanagedAllowanceBytes",
        "startupSlots",
        "heavySlots",
      ],
      label,
    );
    const adapter = parseBoundedString(domain.adapter, `${label}.adapter`);
    if (adapter !== "orbstack-local-v1" && adapter !== "orbstack-declared-v1") {
      throw new Error(`${label}.adapter must be 'orbstack-local-v1' or 'orbstack-declared-v1'.`);
    }
    const endpoint = parseCanonicalAbsolutePath(domain.endpoint, `${label}.endpoint`);
    const daemonId = parseBoundedString(domain.daemonId, `${label}.daemonId`);
    const hostDomain = parseDomainId(domain.hostDomain, `${label}.hostDomain`);
    const hostChargeCeilingBytes = parsePositiveInteger(
      domain.hostChargeCeilingBytes,
      `${label}.hostChargeCeilingBytes`,
    );
    const capacityBytes = parsePositiveInteger(domain.capacityBytes, `${label}.capacityBytes`);
    const protectedHeadroomBytes = parsePositiveInteger(
      domain.protectedHeadroomBytes,
      `${label}.protectedHeadroomBytes`,
    );
    if (protectedHeadroomBytes >= capacityBytes) {
      throw new Error(`${label}.protectedHeadroomBytes must be less than capacityBytes.`);
    }
    const startupSlots = parsePositiveInteger(domain.startupSlots, `${label}.startupSlots`);
    const heavySlots = parsePositiveInteger(domain.heavySlots, `${label}.heavySlots`);

    if (adapter === "orbstack-local-v1") {
      if (Object.hasOwn(domain, "guestUnmanagedAllowanceBytes")) {
        throw new Error(
          `${label}.guestUnmanagedAllowanceBytes is only supported for adapter 'orbstack-declared-v1'.`,
        );
      }
      return {
        kind: "runtime",
        adapter: "orbstack-local-v1",
        endpoint,
        daemonId,
        hostDomain,
        hostChargeCeilingBytes,
        capacityBytes,
        protectedHeadroomBytes,
        startupSlots,
        heavySlots,
      };
    }

    return {
      kind: "runtime",
      adapter: "orbstack-declared-v1",
      endpoint,
      daemonId,
      hostDomain,
      hostChargeCeilingBytes,
      capacityBytes,
      protectedHeadroomBytes,
      guestUnmanagedAllowanceBytes: parseSafeInteger(
        domain.guestUnmanagedAllowanceBytes,
        `${label}.guestUnmanagedAllowanceBytes`,
        0,
      ),
      startupSlots,
      heavySlots,
    };
  }

  throw new Error(`${label}.kind must be 'host' or 'runtime'.`);
}

function parseScheduling(value: unknown): CapacityPolicyScheduling {
  const label = "scheduling";
  const scheduling = ensureObject(value, label);
  ensureAllowedKeys(
    scheduling,
    [
      "maxQueuedPerDomain",
      "maxQueuedTotal",
      "queueLifetimeSeconds",
      "clientWaitSeconds",
      "maxClientWaitSeconds",
      "watchSeconds",
      "sampleIntervalSeconds",
      "maxSampleAgeSeconds",
    ],
    label,
  );

  const result: CapacityPolicyScheduling = {
    maxQueuedPerDomain: parsePositiveInteger(
      scheduling.maxQueuedPerDomain,
      `${label}.maxQueuedPerDomain`,
    ),
    maxQueuedTotal: parsePositiveInteger(scheduling.maxQueuedTotal, `${label}.maxQueuedTotal`),
    queueLifetimeSeconds: parsePositiveInteger(
      scheduling.queueLifetimeSeconds,
      `${label}.queueLifetimeSeconds`,
    ),
    clientWaitSeconds: parseSafeInteger(
      scheduling.clientWaitSeconds,
      `${label}.clientWaitSeconds`,
      0,
    ),
    maxClientWaitSeconds: parsePositiveInteger(
      scheduling.maxClientWaitSeconds,
      `${label}.maxClientWaitSeconds`,
    ),
    watchSeconds: parsePositiveInteger(scheduling.watchSeconds, `${label}.watchSeconds`),
    sampleIntervalSeconds: parsePositiveInteger(
      scheduling.sampleIntervalSeconds,
      `${label}.sampleIntervalSeconds`,
    ),
    maxSampleAgeSeconds: parsePositiveInteger(
      scheduling.maxSampleAgeSeconds,
      `${label}.maxSampleAgeSeconds`,
    ),
  };

  if (result.clientWaitSeconds > result.maxClientWaitSeconds) {
    throw new Error(`${label}.clientWaitSeconds must not exceed maxClientWaitSeconds.`);
  }
  if (
    result.maxQueuedTotal > 64 ||
    result.maxQueuedPerDomain > 32 ||
    result.queueLifetimeSeconds > 900 ||
    result.maxClientWaitSeconds > 900 ||
    result.watchSeconds > 30 ||
    result.maxSampleAgeSeconds > 15
  ) {
    throw new Error(`${label} exceeds supported controller bounds.`);
  }
  if (result.queueLifetimeSeconds < result.maxClientWaitSeconds) {
    throw new Error(`${label}.queueLifetimeSeconds must cover maxClientWaitSeconds.`);
  }
  if (result.maxSampleAgeSeconds < result.sampleIntervalSeconds) {
    throw new Error(`${label}.maxSampleAgeSeconds must be at least sampleIntervalSeconds.`);
  }

  return result;
}

function validateDomainReferences(domains: Record<string, CapacityPolicyDomain>): void {
  const daemonIds = new Map<string, string>();
  const endpoints = new Map<string, string>();
  for (const [domainId, domain] of Object.entries(domains)) {
    if (domain.kind !== "runtime") continue;

    const previousDaemon = daemonIds.get(domain.daemonId);
    if (previousDaemon) {
      throw new Error(
        `domains.${domainId}.daemonId duplicates runtime domain '${previousDaemon}'.`,
      );
    }
    daemonIds.set(domain.daemonId, domainId);

    const previousEndpoint = endpoints.get(domain.endpoint);
    if (previousEndpoint) {
      throw new Error(`domains.${domainId}.endpoint aliases runtime domain '${previousEndpoint}'.`);
    }
    endpoints.set(domain.endpoint, domainId);

    if (!Object.hasOwn(domains, domain.hostDomain)) {
      throw new Error(
        `domains.${domainId}.hostDomain references missing domain '${domain.hostDomain}'.`,
      );
    }
    const hostDomain = domains[domain.hostDomain];
    if (hostDomain.kind !== "host") {
      throw new Error(
        `domains.${domainId}.hostDomain must reference a host domain, not '${domain.hostDomain}'.`,
      );
    }
    const unmanagedAllowanceBytes =
      hostDomain.adapter === "macos-declared-v1" ? hostDomain.unmanagedAllowanceBytes : 0;
    const admissibleHostBytes =
      hostDomain.capacityBytes - hostDomain.protectedHeadroomBytes - unmanagedAllowanceBytes;
    if (domain.hostChargeCeilingBytes > admissibleHostBytes) {
      throw new Error(
        `domains.${domainId}.hostChargeCeilingBytes exceeds admissible capacity of host domain '${domain.hostDomain}'.`,
      );
    }
  }
}

function parseEnrollment(
  value: unknown,
  index: number,
  domains: Record<string, CapacityPolicyDomain>,
): CapacityPolicyEnrollment {
  const label = `enrollments[${index}]`;
  const enrollment = ensureObject(value, label);
  ensureAllowedKeys(
    enrollment,
    [
      "repoPath",
      "gitCommonDir",
      "workspace",
      "provider",
      "providerId",
      "hostDomain",
      "runtimeDomain",
      "profiles",
      "estimatesDigest",
      "defaultOperation",
    ],
    label,
  );

  const repoPath = parseCanonicalAbsolutePath(enrollment.repoPath, `${label}.repoPath`);
  const gitCommonDir = parseCanonicalAbsolutePath(enrollment.gitCommonDir, `${label}.gitCommonDir`);
  const workspace = parseBoundedString(enrollment.workspace, `${label}.workspace`, 32);
  if (!WORKSPACE_TOKEN_RE.test(workspace)) {
    throw new Error(`${label}.workspace must be an existing workspace token.`);
  }

  const provider = parseBoundedString(enrollment.provider, `${label}.provider`);
  if (provider !== "devsy" && provider !== "devpod") {
    throw new Error(`${label}.provider must be 'devsy' or 'devpod'.`);
  }
  const providerId = parseBoundedString(enrollment.providerId, `${label}.providerId`);
  const hostDomain = parseDomainId(enrollment.hostDomain, `${label}.hostDomain`);
  const runtimeDomain = parseDomainId(enrollment.runtimeDomain, `${label}.runtimeDomain`);
  if (!Object.hasOwn(domains, hostDomain)) {
    throw new Error(`${label}.hostDomain references missing domain '${hostDomain}'.`);
  }
  const host = domains[hostDomain];
  if (host.kind !== "host") {
    throw new Error(`${label}.hostDomain must reference a host domain.`);
  }
  if (!Object.hasOwn(domains, runtimeDomain)) {
    throw new Error(`${label}.runtimeDomain references missing domain '${runtimeDomain}'.`);
  }
  const runtime = domains[runtimeDomain];
  if (runtime.kind !== "runtime") {
    throw new Error(`${label}.runtimeDomain must reference a runtime domain.`);
  }
  if (runtime.hostDomain !== hostDomain) {
    throw new Error(
      `${label}.runtimeDomain '${runtimeDomain}' is bound to host domain '${runtime.hostDomain}', not '${hostDomain}'.`,
    );
  }

  const profiles = parseUniqueProfiles(enrollment.profiles, `${label}.profiles`);
  const estimatesDigest = parseDigest(enrollment.estimatesDigest, `${label}.estimatesDigest`);

  const defaultOperation = ensureObject(enrollment.defaultOperation, `${label}.defaultOperation`);
  ensureAllowedKeys(
    defaultOperation,
    ["hostIncrementBytes", "runtimeIncrementBytes"],
    `${label}.defaultOperation`,
  );

  return {
    repoPath,
    gitCommonDir,
    workspace,
    provider,
    providerId,
    hostDomain,
    runtimeDomain,
    profiles,
    estimatesDigest,
    defaultOperation: {
      hostIncrementBytes: parseSafeInteger(
        defaultOperation.hostIncrementBytes,
        `${label}.defaultOperation.hostIncrementBytes`,
        0,
      ),
      runtimeIncrementBytes: parsePositiveInteger(
        defaultOperation.runtimeIncrementBytes,
        `${label}.defaultOperation.runtimeIncrementBytes`,
      ),
    },
  };
}

export function parseCapacityPolicy(value: unknown): CapacityPolicy {
  const root = ensureObject(value, "capacity policy");
  ensureAllowedKeys(
    root,
    ["version", "revision", "admissions", "scheduling", "domains", "enrollments"],
    "capacity policy",
  );

  const version = parsePositiveInteger(root.version, "capacity policy.version");
  if (version !== 1) {
    throw new Error("capacity policy.version must be 1.");
  }
  const revision = parsePositiveInteger(root.revision, "capacity policy.revision");
  const admissions = parseBoundedString(root.admissions, "capacity policy.admissions");
  if (admissions !== "enabled" && admissions !== "paused") {
    throw new Error("capacity policy.admissions must be 'enabled' or 'paused'.");
  }
  const scheduling = parseScheduling(root.scheduling);

  const domainsValue = ensureObject(root.domains, "capacity policy.domains");
  const domainEntries = Object.entries(domainsValue);
  if (domainEntries.length > MAX_DOMAINS) {
    throw new Error(`capacity policy.domains exceeds the maximum of ${MAX_DOMAINS} domains.`);
  }
  const domains: Record<string, CapacityPolicyDomain> = {};
  for (const [domainId, domainValue] of domainEntries) {
    const parsedId = parseDomainId(domainId, "capacity policy.domains key");
    domains[parsedId] = parseDomain(domainValue, parsedId);
  }
  validateDomainReferences(domains);

  if (!Array.isArray(root.enrollments)) {
    throw new Error("capacity policy.enrollments must be an array.");
  }
  if (root.enrollments.length > MAX_ENROLLMENTS) {
    throw new Error(
      `capacity policy.enrollments exceeds the maximum of ${MAX_ENROLLMENTS} enrollments.`,
    );
  }

  const enrollments: CapacityPolicyEnrollment[] = [];
  const enrollmentKeys = new Set<string>();
  const providerIds = new Map<string, number>();
  for (const [index, enrollmentValue] of root.enrollments.entries()) {
    const enrollment = parseEnrollment(enrollmentValue, index, domains);
    const enrollmentKey = [enrollment.repoPath, enrollment.gitCommonDir, enrollment.workspace].join(
      "\0",
    );
    if (enrollmentKeys.has(enrollmentKey)) {
      throw new Error(`enrollments[${index}] duplicates an existing enrollment.`);
    }
    enrollmentKeys.add(enrollmentKey);

    const providerKey = `${enrollment.provider}\0${enrollment.providerId}`;
    const previousProviderIndex = providerIds.get(providerKey);
    if (previousProviderIndex !== undefined) {
      throw new Error(
        `enrollments[${index}].providerId duplicates enrollments[${previousProviderIndex}].`,
      );
    }
    providerIds.set(providerKey, index);
    enrollments.push(enrollment);
  }

  return {
    version: 1,
    revision,
    admissions,
    scheduling,
    domains,
    enrollments,
  };
}
