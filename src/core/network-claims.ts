import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";
import { withFileLockSync } from "./file-lock";
import {
  collectNetworkCapacityReport,
  type NetworkCapacityInventory,
  type NetworkCapacityPrefixLength,
  type NetworkCapacityReport,
  type NetworkCapacityRouteInventory,
  parseIPv4Cidr,
} from "./network-capacity";
import { type NetworkPolicy, parseNetworkPolicy } from "./network-policy";
import type { ReliabilityFence } from "./reliability-contract";
import { DEVROUTER_HOME } from "./router";

export const NETWORK_CLAIMS_VERSION = 1 as const;
export const NETWORK_CLAIMS_ROOT = path.join(DEVROUTER_HOME, "networks");
export const NETWORK_CLAIMS_MAX_RECORDS = 256;
export const NETWORK_CLAIMS_MAX_FILE_BYTES = 512 * 1024;
export const NETWORK_CLAIMS_DEFAULT_PREFIX: NetworkCapacityPrefixLength = 26;
export const NETWORK_CLAIMS_DEFAULT_LOCK_WAIT_MS = 5_000;

export type NetworkClaimState = "reserved" | "attached" | "uncertain";
export type NetworkClaimProvider = "devpod" | "devsy";

export type NetworkClaim = {
  ownerKey: string;
  providerId: string;
  provider: NetworkClaimProvider;
  providerContext: string;
  definitionSha256: string;
  endpoint: string;
  daemonId: string;
  configFingerprint: string;
  subnet: string;
  prefix: NetworkCapacityPrefixLength;
  operationId: string;
  fence: ReliabilityFence;
  workerId: string;
  state: NetworkClaimState;
  networkId?: string;
};

export type NetworkClaimIdentity = Pick<
  NetworkClaim,
  | "ownerKey"
  | "providerId"
  | "provider"
  | "providerContext"
  | "definitionSha256"
  | "endpoint"
  | "daemonId"
  | "configFingerprint"
>;

export type NetworkClaimOperation = Pick<NetworkClaim, "operationId" | "fence" | "workerId">;

export type NetworkClaimExpected = NetworkClaimOperation & {
  state?: NetworkClaimState;
};

export type NetworkClaimAttachedProof = {
  networkId: string;
  endpoint: string;
  daemonId: string;
  subnet: string;
};

export type NetworkClaimCapacitySnapshot = {
  policy: NetworkPolicy;
  inventory: NetworkCapacityInventory;
  routes?: NetworkCapacityRouteInventory;
  endpointDemand?: number | null;
};

export type NetworkClaimReservationRequest = NetworkClaimIdentity &
  NetworkClaimOperation & {
    /** Re-read policy and the pinned daemon inventory while holding the claim lock. */
    revalidate: () => NetworkClaimCapacitySnapshot;
    endpointDemand?: number | null;
    prefixLength?: NetworkCapacityPrefixLength;
    /** An existing claim may only be reused at its exact persisted subnet. */
    subnet?: string;
    attachedProof?: NetworkClaimAttachedProof;
  };

export type NetworkClaimTransitionRequest = NetworkClaimIdentity & {
  expected: NetworkClaimExpected;
  nextState: Extract<NetworkClaimState, "attached" | "uncertain">;
  attachedProof?: NetworkClaimAttachedProof;
};

export type NetworkClaimReleaseProof = {
  terminalWorkerSettled: boolean;
  noFutureEffects: boolean;
  effects: {
    binding: "absent" | "present" | "unknown";
    registration: "absent" | "present" | "unknown";
    containers: "absent" | "present" | "unknown";
    network: "absent" | "present" | "unknown";
  };
};

export type NetworkClaimReleaseRequest = NetworkClaimIdentity & {
  expected: NetworkClaimExpected;
  proof: NetworkClaimReleaseProof;
};

export type NetworkClaimsStoreOptions = {
  /** Test-only or isolated state root. Production defaults to DEVROUTER_HOME/networks. */
  root?: string;
  lockWaitMs?: number;
  /** Test-only fault injection. The production writer is writeFileAtomically. */
  writeAtomic?: (filePath: string, contents: string) => void;
};

export type NetworkClaimsReadOptions = Pick<NetworkClaimsStoreOptions, "root"> & {
  daemonId: string;
};

export class NetworkClaimError extends Error {
  readonly code:
    | "invalid-input"
    | "invalid-state"
    | "capacity-unknown"
    | "capacity-exhausted"
    | "repair-required"
    | "compare-and-swap-failed"
    | "release-denied";

  constructor(code: NetworkClaimError["code"], message: string) {
    super(message);
    this.name = "NetworkClaimError";
    this.code = code;
  }
}

type NetworkClaimsDocument = {
  version: typeof NETWORK_CLAIMS_VERSION;
  daemonId: string;
  claims: NetworkClaim[];
};

type ClaimStore = {
  root: string;
  daemonId: string;
  filePath: string;
  lockPath: string;
  writeAtomic: (filePath: string, contents: string) => void;
};

type ValidatedReservationRequest = NetworkClaimReservationRequest & NetworkClaimCapacitySnapshot;

const CLAIM_CORE_KEYS = [
  "ownerKey",
  "providerId",
  "provider",
  "providerContext",
  "definitionSha256",
  "endpoint",
  "daemonId",
  "configFingerprint",
  "subnet",
  "prefix",
  "operationId",
  "fence",
  "workerId",
  "state",
] as const;
const CLAIM_KEYS = [...CLAIM_CORE_KEYS, "networkId"] as const;
const FENCE_KEYS = [
  "environmentId",
  "intentRevision",
  "runtimeGeneration",
  "controllerEpoch",
] as const;
const DOCUMENT_KEYS = ["version", "daemonId", "claims"] as const;
const MAX_CLAIM_TEXT = 512;
const MAX_ENDPOINT_TEXT = 2_048;
const MAX_LOCK_WAIT_MS = 60_000;

export function networkClaimsPath(daemonId: string, root = NETWORK_CLAIMS_ROOT): string {
  validateText(daemonId, "daemon identity", false);
  const resolvedRoot = validateRoot(root);
  return path.join(resolvedRoot, `${hashKey(daemonId)}.json`);
}

export function networkClaimsLockPath(daemonId: string, root = NETWORK_CLAIMS_ROOT): string {
  validateText(daemonId, "daemon identity", false);
  const resolvedRoot = validateRoot(root);
  return path.join(resolvedRoot, `${hashKey(daemonId)}.lock`);
}

/** Read a single daemon's bounded claim document without changing it. */
export function readNetworkClaims(options: NetworkClaimsReadOptions): NetworkClaim[] {
  const store = createStore(options.daemonId, options);
  const document = readDocument(store);
  return document ? cloneClaims(document.claims) : [];
}

export function readNetworkClaim(
  options: NetworkClaimsReadOptions & { ownerKey: string },
): NetworkClaim | undefined {
  const ownerKey = validateOpaque(options.ownerKey, "owner key");
  return readNetworkClaims(options).find((claim) => claim.ownerKey === ownerKey);
}

/**
 * Bounded lookup for stop guards. It scans only one daemon file and never
 * treats absent or drifted policy as proof that a saved claim is removable.
 */
/**
 * Reserve the first policy-aligned free block. This function only persists a
 * claim; provider adapters must dispatch separately after it returns.
 */
export function reserveNetworkClaim(
  request: NetworkClaimReservationRequest,
  options: NetworkClaimsStoreOptions = {},
): NetworkClaim {
  const input = validateReservationRequest(request);
  return withStoreLock(input.daemonId, options, (store) => {
    const document = readDocument(store) ?? emptyDocument(input.daemonId);
    const existing = document.claims.find((claim) => claim.ownerKey === input.ownerKey);
    if (existing) return reuseOrRejectExisting(existing, input);

    const refreshed = readReservationSnapshot(input);

    if (input.subnet !== undefined) {
      throw claimError("repair-required", "a requested subnet has no durable claim");
    }

    const prefix = resolvePrefix(refreshed.policy, input.prefixLength);
    const selected = selectSubnet({ ...input, ...refreshed }, document.claims, prefix);
    const claim: NetworkClaim = {
      ownerKey: input.ownerKey,
      providerId: input.providerId,
      provider: input.provider,
      providerContext: input.providerContext,
      definitionSha256: input.definitionSha256,
      endpoint: input.endpoint,
      daemonId: input.daemonId,
      configFingerprint: input.configFingerprint,
      subnet: selected,
      prefix,
      operationId: input.operationId,
      fence: cloneFence(input.fence),
      workerId: input.workerId,
      state: "reserved",
    };
    persistReservation(store, document, claim);
    return cloneClaim(claim);
  });
}

export function transitionNetworkClaim(
  request: NetworkClaimTransitionRequest,
  options: NetworkClaimsStoreOptions = {},
): NetworkClaim {
  const input = validateTransitionRequest(request);
  return withStoreLock(input.daemonId, options, (store) => {
    const document = readDocument(store) ?? emptyDocument(input.daemonId);
    const index = document.claims.findIndex((claim) => claim.ownerKey === input.ownerKey);
    const current = index >= 0 ? document.claims[index] : undefined;
    if (!current || !sameIdentity(current, input)) {
      throw claimError("repair-required", "the durable claim is absent or has changed identity");
    }
    assertExpected(current, input.expected);

    if (input.nextState === "attached") {
      if (current.state !== "reserved") {
        throw claimError("compare-and-swap-failed", "only a reserved claim can become attached");
      }
      const networkId = exactAttachedNetworkId(input.attachedProof, current);
      const next: NetworkClaim = { ...current, state: "attached", networkId };
      const claims = document.claims.slice();
      claims[index] = next;
      persistDocument(store, { ...document, claims });
      return cloneClaim(next);
    }

    if (current.state === "attached") {
      throw claimError("compare-and-swap-failed", "an attached claim cannot become uncertain");
    }
    const next: NetworkClaim = { ...current, state: "uncertain" };
    const claims = document.claims.slice();
    claims[index] = next;
    persistDocument(store, { ...document, claims });
    return cloneClaim(next);
  });
}

export function attachNetworkClaim(
  request: Omit<NetworkClaimTransitionRequest, "nextState">,
  options: NetworkClaimsStoreOptions = {},
): NetworkClaim {
  return transitionNetworkClaim({ ...request, nextState: "attached" }, options);
}

export function markNetworkClaimUncertain(
  request: Omit<NetworkClaimTransitionRequest, "nextState" | "attachedProof">,
  options: NetworkClaimsStoreOptions = {},
): NetworkClaim {
  return transitionNetworkClaim({ ...request, nextState: "uncertain" }, options);
}

/**
 * Remove only reservation metadata after a positive terminal-worker proof.
 * This never removes a provider binding, container, network, or registration.
 */
export function releaseNetworkClaim(
  request: NetworkClaimReleaseRequest,
  options: NetworkClaimsStoreOptions = {},
): boolean {
  const input = validateReleaseRequest(request);
  return withStoreLock(input.daemonId, options, (store) => {
    const document = readDocument(store) ?? emptyDocument(input.daemonId);
    const current = document.claims.find((claim) => claim.ownerKey === input.ownerKey);
    if (!current || !sameIdentity(current, input) || current.state === "attached") return false;
    if (!matchesExpected(current, input.expected) || !hasNoEffectProof(input.proof)) return false;
    persistDocument(store, {
      ...document,
      claims: document.claims.filter((claim) => claim.ownerKey !== input.ownerKey),
    });
    return true;
  });
}

function validateReservationRequest(
  request: NetworkClaimReservationRequest,
): NetworkClaimReservationRequest {
  validateIdentity(request);
  validateOperation(request);
  if (typeof request.revalidate !== "function") {
    throw claimError("invalid-input", "network capacity revalidation is required");
  }
  if (
    request.endpointDemand !== undefined &&
    request.endpointDemand !== null &&
    (!Number.isSafeInteger(request.endpointDemand) || request.endpointDemand < 0)
  ) {
    throw claimError("invalid-input", "endpoint demand is invalid");
  }
  if (request.prefixLength !== undefined && !isPrefix(request.prefixLength)) {
    throw claimError("invalid-input", "network prefix is invalid");
  }
  if (request.subnet !== undefined) {
    validateClaimSubnet(request.subnet, request.prefixLength);
  }
  if (request.attachedProof !== undefined) validateAttachedProof(request.attachedProof);
  return request;
}

function readReservationSnapshot(
  input: NetworkClaimReservationRequest,
): NetworkClaimCapacitySnapshot {
  let snapshot: NetworkClaimCapacitySnapshot;
  try {
    snapshot = input.revalidate();
  } catch {
    throw claimError("capacity-unknown", "network capacity revalidation failed");
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw claimError("capacity-unknown", "network capacity revalidation is invalid");
  }
  let policy: NetworkPolicy;
  try {
    policy = parseNetworkPolicy(snapshot.policy);
  } catch {
    throw claimError("capacity-unknown", "network policy revalidation is invalid");
  }
  if (policy.daemonId !== input.daemonId) {
    throw claimError("capacity-unknown", "network policy daemon identity changed");
  }
  if (!snapshot.inventory || typeof snapshot.inventory !== "object") {
    throw claimError("capacity-unknown", "network inventory revalidation is invalid");
  }
  if (snapshot.routes !== undefined && !isRouteInventory(snapshot.routes)) {
    throw claimError("capacity-unknown", "network route revalidation is invalid");
  }
  const endpointDemand =
    snapshot.endpointDemand !== undefined ? snapshot.endpointDemand : input.endpointDemand;
  if (
    endpointDemand !== undefined &&
    endpointDemand !== null &&
    (!Number.isSafeInteger(endpointDemand) || endpointDemand < 0)
  ) {
    throw claimError("capacity-unknown", "endpoint demand revalidation is invalid");
  }
  return { ...snapshot, policy, endpointDemand };
}

function validateTransitionRequest(
  request: NetworkClaimTransitionRequest,
): NetworkClaimTransitionRequest {
  validateIdentity(request);
  validateOperation(request.expected);
  if (request.nextState !== "attached" && request.nextState !== "uncertain") {
    throw claimError("invalid-input", "network claim transition is invalid");
  }
  if (request.attachedProof !== undefined) validateAttachedProof(request.attachedProof);
  return request;
}

function validateReleaseRequest(request: NetworkClaimReleaseRequest): NetworkClaimReleaseRequest {
  validateIdentity(request);
  validateOperation(request.expected);
  if (!request.proof || typeof request.proof !== "object" || Array.isArray(request.proof)) {
    throw claimError("invalid-input", "release proof is invalid");
  }
  assertExactKeys(request.proof, ["terminalWorkerSettled", "noFutureEffects", "effects"]);
  if (
    typeof request.proof.terminalWorkerSettled !== "boolean" ||
    typeof request.proof.noFutureEffects !== "boolean" ||
    !request.proof.effects ||
    typeof request.proof.effects !== "object" ||
    Array.isArray(request.proof.effects)
  ) {
    throw claimError("invalid-input", "release proof is invalid");
  }
  assertExactKeys(request.proof.effects, ["binding", "registration", "containers", "network"]);
  for (const effect of Object.values(request.proof.effects)) {
    if (effect !== "absent" && effect !== "present" && effect !== "unknown") {
      throw claimError("invalid-input", "release proof is invalid");
    }
  }
  return request;
}

function validateIdentity(value: NetworkClaimIdentity): void {
  validateOpaque(value.ownerKey, "owner key");
  validateOpaque(value.providerId, "provider identity");
  if (value.provider !== "devpod" && value.provider !== "devsy") {
    throw claimError("invalid-input", "network provider is invalid");
  }
  validateProviderContext(value.providerContext);
  validateDefinitionSha256(value.definitionSha256);
  validateText(value.endpoint, "provider endpoint", true);
  validateOpaque(value.daemonId, "daemon identity");
  validateOpaque(value.configFingerprint, "configuration fingerprint");
}

function validateOperation(value: NetworkClaimOperation): void {
  validateOpaque(value.operationId, "operation identity");
  validateOpaque(value.workerId, "worker identity");
  validateFence(value.fence);
}

function validateProviderContext(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw claimError("invalid-input", "provider context is invalid");
  }
  return value;
}

function validateDefinitionSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw claimError("invalid-input", "provider definition hash is invalid");
  }
  return value;
}

function validateFence(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw claimError("invalid-input", "reliability fence is invalid");
  }
  const fence = value as Partial<ReliabilityFence>;
  assertExactKeys(fence, FENCE_KEYS);
  if (
    typeof fence.environmentId !== "string" ||
    fence.environmentId.length === 0 ||
    fence.environmentId.length > MAX_CLAIM_TEXT ||
    fence.environmentId.trim() !== fence.environmentId ||
    hasControlCharacter(fence.environmentId) ||
    !isCounter(fence.intentRevision) ||
    !isCounter(fence.runtimeGeneration) ||
    !isCounter(fence.controllerEpoch)
  ) {
    throw claimError("invalid-input", "reliability fence is invalid");
  }
}

function validateAttachedProof(value: NetworkClaimAttachedProof): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw claimError("invalid-input", "attached network proof is invalid");
  }
  assertExactKeys(value, ["networkId", "endpoint", "daemonId", "subnet"]);
  validateOpaque(value.networkId, "network identity");
  validateText(value.endpoint, "proof endpoint", true);
  validateOpaque(value.daemonId, "proof daemon identity");
  validateClaimSubnet(value.subnet);
}

function validateClaimSubnet(value: unknown, expectedPrefix?: NetworkCapacityPrefixLength): void {
  if (typeof value !== "string") {
    throw claimError("invalid-input", "network claim subnet is invalid");
  }
  const canonical = parseIPv4Cidr(value);
  if (!canonical || canonical !== value) {
    throw claimError("invalid-input", "network claim subnet is not canonical IPv4 CIDR");
  }
  const prefix = Number(value.slice(value.lastIndexOf("/") + 1));
  if (!isPrefix(prefix) || (expectedPrefix !== undefined && prefix !== expectedPrefix)) {
    throw claimError("invalid-input", "network claim prefix is invalid");
  }
}

function validateOpaque(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CLAIM_TEXT ||
    value.trim() !== value ||
    hasControlCharacter(value) ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw claimError("invalid-input", `${label} is invalid`);
  }
  return value;
}

function validateText(value: unknown, label: string, allowSlash: boolean): string {
  const limit = label.includes("endpoint") ? MAX_ENDPOINT_TEXT : MAX_CLAIM_TEXT;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value ||
    hasControlCharacter(value) ||
    (!allowSlash && (value.includes("/") || value.includes("\\")))
  ) {
    throw claimError("invalid-input", `${label} is invalid`);
  }
  return value;
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPrefix(value: unknown): value is NetworkCapacityPrefixLength {
  return value === 24 || value === 25 || value === 26;
}

function isRouteInventory(value: NetworkCapacityRouteInventory): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value.status === "complete" || value.status === "unknown") &&
    Array.isArray(value.routes)
  );
}

function resolvePrefix(
  policy: NetworkPolicy,
  requested: NetworkCapacityPrefixLength | undefined,
): NetworkCapacityPrefixLength {
  const prefix = requested ?? NETWORK_CLAIMS_DEFAULT_PREFIX;
  if (!policy.allowedPrefixes.includes(prefix)) {
    throw claimError("invalid-input", "requested network prefix is not permitted by policy");
  }
  return prefix;
}

function selectSubnet(
  input: ValidatedReservationRequest,
  claims: NetworkClaim[],
  prefix: NetworkCapacityPrefixLength,
): string {
  const routes = input.routes ?? input.inventory.routes;
  const report = buildAllocationReport(input, claims, prefix, routes);
  if (report.allocation.status === "unknown") {
    throw claimError("capacity-unknown", "network capacity or route evidence is unknown");
  }
  const candidate = report.pools
    .flatMap((pool) => pool.candidates)
    .find((candidate) => candidate.status === "free" && !isExcluded(candidate.cidr, input.policy));
  if (!candidate) {
    throw claimError("capacity-exhausted", "no policy-aligned network block is available");
  }
  return candidate.cidr;
}

function buildAllocationReport(
  input: ValidatedReservationRequest,
  claims: NetworkClaim[],
  prefix: NetworkCapacityPrefixLength,
  routes: NetworkCapacityRouteInventory | undefined,
): NetworkCapacityReport {
  const syntheticClaimNetworks = claims.map((claim) => ({
    id: `claim-${hashKey(`${claim.ownerKey}:${claim.subnet}`)}`,
    name: "devrouter-claim",
    driver: "bridge",
    subnets: [claim.subnet],
    activeEndpoints: 0,
    retainedContainerIds: [],
  }));
  return collectNetworkCapacityReport(
    {
      endpoint: input.endpoint,
      daemonId: input.daemonId,
      prefixLength: prefix,
      endpointDemand: input.endpointDemand,
      endpointReserve: input.policy.endpointReserve,
      routes,
    },
    {
      collectInventory: () => ({
        ...input.inventory,
        pools: input.policy.pools.map((base) => ({ base, size: prefix })),
        networks: [...input.inventory.networks, ...syntheticClaimNetworks],
      }),
    },
  );
}

function isExcluded(cidr: string, policy: NetworkPolicy): boolean {
  const candidate = parseRange(cidr);
  if (!candidate) return true;
  return policy.exclusions.some((exclusion) => {
    const parsed = parseRange(exclusion);
    return !!parsed && overlaps(candidate, parsed);
  });
}

function parseRange(cidr: string): { start: number; end: number; prefix: number } | undefined {
  const canonical = parseIPv4Cidr(cidr);
  if (!canonical) return undefined;
  const [address, prefixText] = canonical.split("/");
  const octets = address.split(".").map(Number);
  const prefix = Number(prefixText);
  const start =
    (((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return { start, end: start + 2 ** (32 - prefix) - 1, prefix };
}

function overlaps(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function reuseOrRejectExisting(
  existing: NetworkClaim,
  input: NetworkClaimReservationRequest,
): NetworkClaim {
  if (
    !sameIdentity(existing, input) ||
    (input.subnet !== undefined && existing.subnet !== input.subnet)
  ) {
    throw claimError("repair-required", "an existing owner claim has incompatible identity");
  }
  if (existing.state === "attached") {
    if (!input.attachedProof || !sameAttachedProof(existing, input.attachedProof)) {
      throw claimError("repair-required", "attached claim proof is missing or does not match");
    }
    return cloneClaim(existing);
  }
  if (
    existing.state === "reserved" &&
    existing.operationId === input.operationId &&
    sameFence(existing.fence, input.fence) &&
    existing.workerId === input.workerId
  ) {
    return cloneClaim(existing);
  }
  throw claimError("repair-required", "an existing claim is unresolved and requires settlement");
}

function exactAttachedNetworkId(
  proof: NetworkClaimAttachedProof | undefined,
  current: NetworkClaim,
): string {
  if (!proof || !sameAttachedProof(current, proof)) {
    throw claimError("repair-required", "attached network proof is missing or does not match");
  }
  return proof.networkId;
}

function sameAttachedProof(claim: NetworkClaim, proof: NetworkClaimAttachedProof): boolean {
  return (
    (claim.state !== "attached" || claim.networkId === proof.networkId) &&
    proof.endpoint === claim.endpoint &&
    proof.daemonId === claim.daemonId &&
    proof.subnet === claim.subnet
  );
}

function sameIdentity(left: NetworkClaimIdentity, right: NetworkClaimIdentity): boolean {
  return (
    left.ownerKey === right.ownerKey &&
    left.providerId === right.providerId &&
    left.provider === right.provider &&
    left.providerContext === right.providerContext &&
    left.definitionSha256 === right.definitionSha256 &&
    left.endpoint === right.endpoint &&
    left.daemonId === right.daemonId &&
    left.configFingerprint === right.configFingerprint
  );
}

function sameFence(left: ReliabilityFence, right: ReliabilityFence): boolean {
  return FENCE_KEYS.every((key) => left[key] === right[key]);
}

function assertExpected(claim: NetworkClaim, expected: NetworkClaimExpected): void {
  if (!matchesExpected(claim, expected)) {
    throw claimError("compare-and-swap-failed", "network claim generation is stale");
  }
}

function matchesExpected(claim: NetworkClaim, expected: NetworkClaimExpected): boolean {
  return (
    claim.operationId === expected.operationId &&
    claim.workerId === expected.workerId &&
    sameFence(claim.fence, expected.fence) &&
    (expected.state === undefined || claim.state === expected.state)
  );
}

function hasNoEffectProof(proof: NetworkClaimReleaseProof): boolean {
  return (
    proof.terminalWorkerSettled === true &&
    proof.noFutureEffects === true &&
    proof.effects.binding === "absent" &&
    proof.effects.registration === "absent" &&
    proof.effects.containers === "absent" &&
    proof.effects.network === "absent"
  );
}

function assertExactKeys(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !keys.includes(key)) || keys.some((key) => !actual.includes(key))) {
    throw claimError("invalid-state", "network claim state contains unsupported fields");
  }
}

function readDocument(store: ClaimStore): NetworkClaimsDocument | undefined {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      store.filePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw claimError("invalid-state", "network claim state could not be read");
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > NETWORK_CLAIMS_MAX_FILE_BYTES || (stat.mode & 0o077) !== 0) {
      throw claimError("invalid-state", "network claim state is not a bounded private file");
    }
    const buffer = Buffer.alloc(NETWORK_CLAIMS_MAX_FILE_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    const finalStat = fs.fstatSync(descriptor);
    if (count > NETWORK_CLAIMS_MAX_FILE_BYTES || finalStat.size !== stat.size) {
      throw claimError("invalid-state", "network claim state changed during read");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, count).toString("utf8")) as unknown;
    } catch {
      throw claimError("invalid-state", "network claim state is invalid JSON");
    }
    return validateDocument(parsed, store.daemonId);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateDocument(value: unknown, daemonId: string): NetworkClaimsDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw claimError("invalid-state", "network claim state is invalid");
  }
  const document = value as Partial<NetworkClaimsDocument>;
  assertExactKeys(document, DOCUMENT_KEYS);
  if (document.version !== NETWORK_CLAIMS_VERSION || document.daemonId !== daemonId) {
    throw claimError("invalid-state", "network claim state has an invalid daemon binding");
  }
  if (!Array.isArray(document.claims) || document.claims.length > NETWORK_CLAIMS_MAX_RECORDS) {
    throw claimError("invalid-state", "network claim state exceeds its record bound");
  }
  const claims = document.claims.map((claim) => validateClaim(claim, daemonId));
  if (
    new Set(claims.map((claim) => claim.ownerKey)).size !== claims.length ||
    new Set(claims.map((claim) => claim.subnet)).size !== claims.length
  ) {
    throw claimError("invalid-state", "network claim state contains duplicate ownership");
  }
  return { version: NETWORK_CLAIMS_VERSION, daemonId, claims };
}

function validateClaim(value: unknown, daemonId: string): NetworkClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw claimError("invalid-state", "network claim record is invalid");
  }
  const candidate = value as Partial<NetworkClaim>;
  assertExactKeys(candidate, candidate.state === "attached" ? CLAIM_KEYS : CLAIM_CORE_KEYS);
  validateOpaque(candidate.ownerKey, "owner key");
  validateOpaque(candidate.providerId, "provider identity");
  if (candidate.provider !== "devpod" && candidate.provider !== "devsy") {
    throw claimError("invalid-state", "network claim provider is invalid");
  }
  try {
    validateProviderContext(candidate.providerContext);
    validateDefinitionSha256(candidate.definitionSha256);
  } catch {
    throw claimError("invalid-state", "network claim provider binding is invalid");
  }
  validateText(candidate.endpoint, "provider endpoint", true);
  validateOpaque(candidate.daemonId, "daemon identity");
  if (candidate.daemonId !== daemonId) {
    throw claimError("invalid-state", "network claim daemon binding is invalid");
  }
  validateOpaque(candidate.configFingerprint, "configuration fingerprint");
  validateClaimSubnet(candidate.subnet, candidate.prefix);
  if (!isPrefix(candidate.prefix))
    throw claimError("invalid-state", "network claim prefix is invalid");
  validateOpaque(candidate.operationId, "operation identity");
  validateFence(candidate.fence);
  validateOpaque(candidate.workerId, "worker identity");
  if (
    candidate.state !== "reserved" &&
    candidate.state !== "attached" &&
    candidate.state !== "uncertain"
  ) {
    throw claimError("invalid-state", "network claim state is invalid");
  }
  if (candidate.state === "attached") {
    validateOpaque(candidate.networkId, "network identity");
  } else if (candidate.networkId !== undefined) {
    throw claimError("invalid-state", "unattached network claim contains a network identity");
  }
  return candidate as NetworkClaim;
}

function persistDocument(store: ClaimStore, document: NetworkClaimsDocument): void {
  const validated = validateDocument(document, store.daemonId);
  const contents = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(contents) > NETWORK_CLAIMS_MAX_FILE_BYTES) {
    throw claimError("invalid-state", "network claim state exceeds its byte bound");
  }
  store.writeAtomic(store.filePath, contents);
}

function persistReservation(
  store: ClaimStore,
  document: NetworkClaimsDocument,
  claim: NetworkClaim,
): void {
  const next = { ...document, claims: [...document.claims, claim] };
  try {
    persistDocument(store, next);
  } catch {
    try {
      const persisted = readDocument(store);
      const persistedClaim = persisted?.claims.find(
        (candidate) => candidate.ownerKey === claim.ownerKey,
      );
      if (persisted && persistedClaim && sameReservation(persistedClaim, claim)) {
        persistDocument(store, {
          ...persisted,
          claims: persisted.claims.map((candidate) =>
            candidate.ownerKey === claim.ownerKey
              ? { ...candidate, state: "uncertain" }
              : candidate,
          ),
        });
      }
    } catch {
      // Preserve the claim if the conservative uncertainty write also fails.
    }
    throw claimError("invalid-state", "network claim reservation persistence failed");
  }
}

function sameReservation(left: NetworkClaim, right: NetworkClaim): boolean {
  return (
    left.state === "reserved" &&
    sameIdentity(left, right) &&
    left.subnet === right.subnet &&
    left.prefix === right.prefix &&
    left.operationId === right.operationId &&
    left.workerId === right.workerId &&
    sameFence(left.fence, right.fence)
  );
}

function emptyDocument(daemonId: string): NetworkClaimsDocument {
  return { version: NETWORK_CLAIMS_VERSION, daemonId, claims: [] };
}

function withStoreLock<T>(
  daemonId: string,
  options: NetworkClaimsStoreOptions,
  operation: (store: ClaimStore) => T,
): T {
  const store = createStore(daemonId, options);
  const waitMs = options.lockWaitMs ?? NETWORK_CLAIMS_DEFAULT_LOCK_WAIT_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_LOCK_WAIT_MS) {
    throw claimError("invalid-input", "network claim lock wait is invalid");
  }
  fs.mkdirSync(store.root, { recursive: true, mode: 0o700 });
  assertDirectory(store.root);
  return withFileLockSync(
    store.lockPath,
    { activity: "network allocation", waitMs, fair: true },
    () => operation(store),
  );
}

function createStore(daemonId: string, options: NetworkClaimsStoreOptions): ClaimStore {
  validateOpaque(daemonId, "daemon identity");
  const root = validateRoot(options.root ?? NETWORK_CLAIMS_ROOT);
  const key = hashKey(daemonId);
  return {
    root,
    daemonId,
    filePath: path.join(root, `${key}.json`),
    lockPath: path.join(root, `${key}.lock`),
    writeAtomic: options.writeAtomic ?? writeFileAtomically,
  };
}

function validateRoot(root: string): string {
  if (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0")) {
    throw claimError("invalid-input", "network claim root is invalid");
  }
  const resolved = path.resolve(root);
  if (resolved !== root) throw claimError("invalid-input", "network claim root is invalid");
  return resolved;
}

function assertDirectory(directory: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw claimError("invalid-state", "network claim root could not be read");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw claimError("invalid-state", "network claim root is not a directory");
  }
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cloneFence(fence: ReliabilityFence): ReliabilityFence {
  return { ...fence };
}

function cloneClaim(claim: NetworkClaim): NetworkClaim {
  return { ...claim, fence: cloneFence(claim.fence) };
}

function cloneClaims(claims: NetworkClaim[]): NetworkClaim[] {
  return claims.map(cloneClaim);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function claimError(code: NetworkClaimError["code"], message: string): NetworkClaimError {
  return new NetworkClaimError(code, message);
}
