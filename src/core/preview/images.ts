import { createHash } from "node:crypto";
import type { PreviewWriteGate } from "./engine";
import type { PreviewPoolEntry } from "./state";
import type { PreviewPlanReport } from "./types";

const MAX_COLLECTION_ENTRIES = 256;
const MAX_CONFIGURATION_ENTRIES = 128;
const MAX_CONFIGURATION_KEY_LENGTH = 128;
const MAX_CONFIGURATION_VALUE_BYTES = 16 * 1024;
const MAX_IDENTIFIER_LENGTH = 512;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const IMAGE_COMPONENT_RE = /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*$/;

export const PREVIEW_IMAGE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

export type PreviewImagePlatform = (typeof PREVIEW_IMAGE_PLATFORMS)[number];

/** Public CI inputs. Credentials and other secret values must never be placed here. */
export type PreviewImageConfiguration = Record<string, string>;

export type PreviewImageTarget = {
  target: string;
  configuration: PreviewImageConfiguration;
};

export type PreviewImageRequest = {
  revision: string;
  platform: PreviewImagePlatform;
  targets: PreviewImageTarget[];
};

export type PreviewImageProducerIdentity = {
  repository: string;
  workflow: string;
  controlRevision: string;
};

export type PreviewImageReceipt = {
  revision: string;
  repository: string;
  workflow: string;
  controlRevision: string;
  runId: string;
  attempt: number;
  target: string;
  platform: PreviewImagePlatform;
  configurationDigest: `sha256:${string}`;
  image: string;
  inputFingerprint: `sha256:${string}`;
  ciPassed: true;
  admissionPassed: true;
};

export type PreviewImageRequestInput = {
  revision: string;
  platform: PreviewImagePlatform;
  configurations?: Record<string, PreviewImageConfiguration>;
};

export type PreviewImagePreparedRequest = {
  request: PreviewImageRequest;
  resources: Record<string, PreviewImageTarget>;
};

export type PreviewImageResolution =
  | { status: "waiting"; missing: string[] }
  | {
      status: "ready";
      plan: PreviewPlanReport;
      images: Record<string, PreviewImageReceipt>;
    };

export interface PreviewImageBackend {
  prepare(
    entry: PreviewPoolEntry,
    gate: PreviewWriteGate,
  ): Promise<{ phase: "pending" } | { phase: "ready"; plan: PreviewPlanReport }>;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be a mapping.`);
  return value;
}

function requireFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${label} has unsupported keys: ${unknown.sort().join(", ")}.`);
  }
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail(`${label} is missing keys: ${missing.join(", ")}.`);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function readString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) fail(`${label} exceeds the ${maxLength}-character limit.`);
  if (hasControlCharacters(value)) fail(`${label} must not contain control characters.`);
  return value;
}

function readName(value: unknown, label: string): string {
  const name = readString(value, label, 63);
  if (!NAME_RE.test(name)) {
    fail(`${label} must be 1-63 lowercase alphanumeric or hyphen-separated characters.`);
  }
  return name;
}

function readRevision(value: unknown, label: string): string {
  const revision = readString(value, label, 64);
  if (!REVISION_RE.test(revision)) fail(`${label} must be a full lowercase Git revision.`);
  return revision;
}

function readDigest(value: unknown, label: string): `sha256:${string}` {
  const digest = readString(value, label, 71);
  if (!DIGEST_RE.test(digest)) fail(`${label} must be a sha256 digest.`);
  return digest as `sha256:${string}`;
}

function readPlatform(value: unknown, label: string): PreviewImagePlatform {
  if (value !== "linux/amd64" && value !== "linux/arm64") {
    fail(`${label} must be linux/amd64 or linux/arm64.`);
  }
  return value;
}

function readRepository(value: unknown, label: string): string {
  const repository = readString(value, label, 512);
  const components = repository.split("/");
  if (
    components.some((component, index) => {
      if (component === "" || component === "." || component === "..") return true;
      const withoutPort = index === 0 ? component.replace(/:\d+$/, "") : component;
      return withoutPort !== component && index > 0 ? true : !IMAGE_COMPONENT_RE.test(withoutPort);
    })
  ) {
    fail(`${label} must be a lowercase OCI repository without credentials or tags.`);
  }
  return repository;
}

function readImmutableImage(value: unknown, label: string): string {
  const image = readString(value, label, 1024);
  const separator = image.lastIndexOf("@sha256:");
  if (separator <= 0) fail(`${label} must be an immutable repository@sha256 image.`);
  const imageRepository = image.slice(0, separator);
  const digest = image.slice(separator + 1);
  if (!imageRepository.includes("/")) {
    fail(`${label} must use a fully qualified image repository.`);
  }
  readRepository(imageRepository, `${label} repository`);
  readDigest(digest, `${label} digest`);
  return image;
}

function normalizeConfiguration(value: unknown, label: string): PreviewImageConfiguration {
  const configuration = requireRecord(value, label);
  const entries = Object.entries(configuration);
  if (entries.length > MAX_CONFIGURATION_ENTRIES) {
    fail(`${label} exceeds the ${MAX_CONFIGURATION_ENTRIES}-entry limit.`);
  }
  const normalized: Array<[string, string]> = entries.map(([rawKey, rawValue]) => {
    const key = readString(rawKey, `${label} key`, MAX_CONFIGURATION_KEY_LENGTH);
    if (hasControlCharacters(key)) fail(`${label} keys must not contain control characters.`);
    if (typeof rawValue !== "string") fail(`${label}.${key} must be a string.`);
    if (Buffer.byteLength(rawValue, "utf-8") > MAX_CONFIGURATION_VALUE_BYTES) {
      fail(`${label}.${key} exceeds the ${MAX_CONFIGURATION_VALUE_BYTES}-byte limit.`);
    }
    if (hasControlCharacters(rawValue)) {
      fail(`${label}.${key} must not contain control characters.`);
    }
    return [key, rawValue];
  });
  return Object.fromEntries(
    normalized.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/** Build arguments are public, non-secret configuration values. */
export function canonicalizeImageConfiguration(configuration: unknown): string {
  return JSON.stringify(normalizeConfiguration(configuration, "image configuration"));
}

export function imageConfigurationDigest(
  configuration: PreviewImageConfiguration,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalizeImageConfiguration(configuration), "utf-8")
    .digest("hex")}`;
}

function targetKey(target: string, configurationDigest: string): string {
  return `${target}\0${configurationDigest}`;
}

function normalizeImageTarget(value: unknown, label: string): PreviewImageTarget {
  const input = requireRecord(value, label);
  requireFields(input, ["target", "configuration"], [], label);
  return {
    target: readName(input.target, `${label}.target`),
    configuration: normalizeConfiguration(input.configuration, `${label}.configuration`),
  };
}

function normalizeImageRequest(value: unknown): PreviewImageRequest {
  const input = requireRecord(value, "image request");
  requireFields(input, ["revision", "platform", "targets"], [], "image request");
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    fail("image request targets must be a non-empty array.");
  }
  if (input.targets.length > MAX_COLLECTION_ENTRIES) {
    fail(`image request targets exceeds the ${MAX_COLLECTION_ENTRIES}-entry limit.`);
  }
  const targets = input.targets.map((target, index) =>
    normalizeImageTarget(target, `image request targets[${index}]`),
  );
  const keys = targets.map((target) =>
    targetKey(target.target, imageConfigurationDigest(target.configuration)),
  );
  if (new Set(keys).size !== keys.length) {
    fail("image request targets must not contain duplicate target/configuration pairs.");
  }
  return {
    revision: readRevision(input.revision, "image request revision"),
    platform: readPlatform(input.platform, "image request platform"),
    targets,
  };
}

function normalizeProducer(value: unknown): PreviewImageProducerIdentity {
  const input = requireRecord(value, "expected image producer");
  requireFields(
    input,
    ["repository", "workflow", "controlRevision"],
    [],
    "expected image producer",
  );
  return {
    repository: readRepository(input.repository, "expected image producer repository"),
    workflow: readString(input.workflow, "expected image producer workflow", MAX_IDENTIFIER_LENGTH),
    controlRevision: readRevision(input.controlRevision, "expected image producer controlRevision"),
  };
}

export function preparePreviewImageRequest(
  plan: PreviewPlanReport,
  input: PreviewImageRequestInput,
): PreviewImagePreparedRequest {
  const requestInput = requireRecord(input, "image request input");
  requireFields(requestInput, ["revision", "platform"], ["configurations"], "image request input");
  const configurations = normalizeConfigurations(requestInput.configurations);
  const planResources = indexPlanResources(plan);
  for (const id of Object.keys(configurations)) {
    const resource = planResources.get(id);
    if (!resource || resource.imageTarget === undefined) {
      fail(`image configuration references resource '${id}' without imageTarget.`);
    }
  }

  const resources: Record<string, PreviewImageTarget> = {};
  const uniqueTargets = new Map<string, PreviewImageTarget>();
  for (const resource of plan.resources) {
    if (resource.imageTarget === undefined) continue;
    const target = {
      target: readName(resource.imageTarget, `resources.${resource.id}.imageTarget`),
      configuration: configurations[resource.id] ?? {},
    };
    const digest = imageConfigurationDigest(target.configuration);
    const key = targetKey(target.target, digest);
    const existing = uniqueTargets.get(key);
    if (
      existing &&
      canonicalizeImageConfiguration(existing.configuration) !==
        canonicalizeImageConfiguration(target.configuration)
    ) {
      fail(`image target '${target.target}' has conflicting configurations.`);
    }
    uniqueTargets.set(key, existing ?? target);
    resources[resource.id] = target;
  }
  if (Object.keys(resources).length === 0) {
    fail("preview plan does not contain any imageTarget resources.");
  }
  const targets = [...uniqueTargets.values()].sort((left, right) => {
    if (left.target !== right.target) return left.target < right.target ? -1 : 1;
    const leftDigest = imageConfigurationDigest(left.configuration);
    const rightDigest = imageConfigurationDigest(right.configuration);
    return leftDigest < rightDigest ? -1 : leftDigest > rightDigest ? 1 : 0;
  });
  return {
    request: normalizeImageRequest({
      revision: input.revision,
      platform: input.platform,
      targets,
    }),
    resources,
  };
}

function indexPlanResources(
  plan: PreviewPlanReport,
): Map<string, PreviewPlanReport["resources"][number]> {
  const resources = new Map<string, PreviewPlanReport["resources"][number]>();
  for (const resource of plan.resources) {
    if (resources.has(resource.id)) fail(`plan contains duplicate resource '${resource.id}'.`);
    if (
      resource.imageTarget !== undefined &&
      ((resource.kind !== "service" && resource.kind !== "job") ||
        resource.image !== undefined ||
        resource.build !== undefined)
    ) {
      fail(`resources.${resource.id} imageTarget cannot fall back to an image or build.`);
    }
    resources.set(resource.id, resource);
  }
  return resources;
}

function normalizeConfigurations(value: unknown): Record<string, PreviewImageConfiguration> {
  if (value === undefined) return {};
  const input = requireRecord(value, "image configurations");
  if (Object.keys(input).length > MAX_COLLECTION_ENTRIES) {
    fail(`image configurations exceeds the ${MAX_COLLECTION_ENTRIES}-entry limit.`);
  }
  return Object.fromEntries(
    Object.entries(input).map(([id, configuration]) => [
      readName(id, `image configurations resource '${id}'`),
      normalizeConfiguration(configuration, `image configurations.${id}`),
    ]),
  );
}

const RECEIPT_FIELDS = [
  "revision",
  "repository",
  "workflow",
  "controlRevision",
  "runId",
  "attempt",
  "target",
  "platform",
  "configurationDigest",
  "image",
  "inputFingerprint",
  "ciPassed",
  "admissionPassed",
] as const;

function parseReceipt(
  value: unknown,
  label: string,
  request: PreviewImageRequest,
  expectedProducer: PreviewImageProducerIdentity,
  requested: Map<string, PreviewImageTarget>,
): PreviewImageReceipt {
  const input = requireRecord(value, label);
  requireFields(input, RECEIPT_FIELDS, [], label);
  const revision = readRevision(input.revision, `${label}.revision`);
  if (revision !== request.revision) fail(`${label}.revision does not match the request.`);
  const repository = readRepository(input.repository, `${label}.repository`);
  if (repository !== expectedProducer.repository) {
    fail(`${label}.repository does not match the expected producer.`);
  }
  const workflow = readString(input.workflow, `${label}.workflow`, MAX_IDENTIFIER_LENGTH);
  if (workflow !== expectedProducer.workflow) {
    fail(`${label}.workflow does not match the expected producer.`);
  }
  const controlRevision = readRevision(input.controlRevision, `${label}.controlRevision`);
  if (controlRevision !== expectedProducer.controlRevision) {
    fail(`${label}.controlRevision does not match the expected producer.`);
  }
  const runId = readString(input.runId, `${label}.runId`, MAX_IDENTIFIER_LENGTH);
  if (!Number.isSafeInteger(input.attempt) || (input.attempt as number) < 1) {
    fail(`${label}.attempt must be a positive integer.`);
  }
  const target = readName(input.target, `${label}.target`);
  const platform = readPlatform(input.platform, `${label}.platform`);
  if (platform !== request.platform) fail(`${label}.platform does not match the request.`);
  const configurationDigest = readDigest(input.configurationDigest, `${label}.configurationDigest`);
  const key = targetKey(target, configurationDigest);
  if (!requested.has(key)) {
    fail(`${label} does not match a requested target/configuration pair.`);
  }
  if (input.ciPassed !== true) fail(`${label}.ciPassed must be true.`);
  if (input.admissionPassed !== true) fail(`${label}.admissionPassed must be true.`);

  return {
    revision,
    repository,
    workflow,
    controlRevision,
    runId,
    attempt: input.attempt as number,
    target,
    platform,
    configurationDigest,
    image: readImmutableImage(input.image, `${label}.image`),
    inputFingerprint: readDigest(input.inputFingerprint, `${label}.inputFingerprint`),
    ciPassed: true,
    admissionPassed: true,
  };
}

export function parsePreviewImageReceipts(
  value: unknown,
  requestValue: PreviewImageRequest,
  producerValue: PreviewImageProducerIdentity,
): PreviewImageReceipt[] {
  // The trusted backend must check CI provenance and scans before supplying receipts.
  const request = normalizeImageRequest(requestValue);
  const expectedProducer = normalizeProducer(producerValue);
  const root = requireRecord(value, "image receipts");
  requireFields(root, ["receipts"], [], "image receipts");
  if (!Array.isArray(root.receipts)) fail("image receipts.receipts must be an array.");
  if (root.receipts.length > MAX_COLLECTION_ENTRIES) {
    fail(`image receipts.receipts exceeds the ${MAX_COLLECTION_ENTRIES}-entry limit.`);
  }
  const requested = new Map(
    request.targets.map((target) => [
      targetKey(target.target, imageConfigurationDigest(target.configuration)),
      target,
    ]),
  );
  const keys = new Set<string>();
  return root.receipts.map((receipt, index) => {
    const parsed = parseReceipt(
      receipt,
      `image receipts.receipts[${index}]`,
      request,
      expectedProducer,
      requested,
    );
    const key = targetKey(parsed.target, parsed.configurationDigest);
    if (keys.has(key)) {
      fail(
        `image receipts contains a duplicate target/configuration receipt for '${parsed.target}'.`,
      );
    }
    keys.add(key);
    return parsed;
  });
}

function validatePreparedRequest(
  plan: PreviewPlanReport,
  prepared: PreviewImagePreparedRequest,
): void {
  const request = normalizeImageRequest(prepared.request);
  const requestedKeys = new Set(
    request.targets.map((target) =>
      targetKey(target.target, imageConfigurationDigest(target.configuration)),
    ),
  );
  const planResources = indexPlanResources(plan);
  for (const [id, selection] of Object.entries(prepared.resources)) {
    const resource = planResources.get(id);
    if (!resource || resource.imageTarget !== selection.target) {
      fail(`prepared image resource '${id}' does not match the plan.`);
    }
    const key = targetKey(selection.target, imageConfigurationDigest(selection.configuration));
    if (!requestedKeys.has(key)) {
      fail(`prepared image resource '${id}' is absent from the request.`);
    }
  }
  for (const resource of plan.resources) {
    if (resource.imageTarget !== undefined && !Object.hasOwn(prepared.resources, resource.id)) {
      fail(`prepared image resources is missing resource '${resource.id}'.`);
    }
  }
}

export function resolvePreviewImages(
  plan: PreviewPlanReport,
  prepared: PreviewImagePreparedRequest,
  expectedProducer: PreviewImageProducerIdentity,
  value: unknown,
): PreviewImageResolution {
  validatePreparedRequest(plan, prepared);
  const receipts = parsePreviewImageReceipts(value, prepared.request, expectedProducer);
  const receiptsByKey = new Map(
    receipts.map((receipt) => [targetKey(receipt.target, receipt.configurationDigest), receipt]),
  );
  const resourceReceipts = new Map<string, PreviewImageReceipt>();
  const missing: string[] = [];
  for (const [id, selection] of Object.entries(prepared.resources)) {
    const receipt = receiptsByKey.get(
      targetKey(selection.target, imageConfigurationDigest(selection.configuration)),
    );
    if (receipt) resourceReceipts.set(id, receipt);
    else missing.push(id);
  }
  if (missing.length > 0) return { status: "waiting", missing: missing.sort() };

  const resources = plan.resources.map((resource) => {
    if (resource.imageTarget === undefined) return resource;
    const receipt = resourceReceipts.get(resource.id);
    if (!receipt) fail(`validated image receipt is missing resource '${resource.id}'.`);
    const { imageTarget: _imageTarget, ...metadata } = resource;
    return { ...metadata, image: receipt.image };
  });
  return {
    status: "ready",
    plan: { ...plan, resources },
    images: Object.fromEntries(resourceReceipts),
  };
}

function imageDigest(value: unknown, label: string): `sha256:${string}` {
  return readDigest(value, label);
}

export function selectOciPlatformDigest(
  indexValue: unknown,
  platformValue: PreviewImagePlatform,
): `sha256:${string}` {
  const platform = readPlatform(platformValue, "OCI platform");
  const [os, architecture] = platform.split("/") as ["linux", "amd64" | "arm64"];
  const index = requireRecord(indexValue, "OCI image index");
  if (!Array.isArray(index.manifests)) fail("OCI image index must contain a manifests array.");
  const matches: Array<`sha256:${string}`> = [];
  for (const [position, rawDescriptor] of index.manifests.entries()) {
    const descriptor = requireRecord(rawDescriptor, `OCI image index manifests[${position}]`);
    const descriptorPlatform = requireRecord(
      descriptor.platform,
      `OCI image index manifests[${position}].platform`,
    );
    const annotations =
      descriptor.annotations === undefined
        ? undefined
        : requireRecord(
            descriptor.annotations,
            `OCI image index manifests[${position}].annotations`,
          );
    if (
      descriptorPlatform.os === "unknown" ||
      descriptorPlatform.architecture === "unknown" ||
      annotations?.["vnd.docker.reference.type"] === "attestation-manifest"
    ) {
      continue;
    }
    if (descriptorPlatform.os === os && descriptorPlatform.architecture === architecture) {
      matches.push(imageDigest(descriptor.digest, `OCI image index manifests[${position}].digest`));
    }
  }
  if (matches.length === 0) fail(`OCI image index does not contain ${platform}.`);
  if (matches.length > 1)
    fail(`OCI image index contains multiple ambiguous ${platform} manifests.`);
  return matches[0];
}
