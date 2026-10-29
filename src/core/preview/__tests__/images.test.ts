import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  imageConfigurationDigest,
  type PreviewImageProducerIdentity,
  type PreviewImageReceipt,
  type PreviewImageRequestInput,
  parsePreviewImageReceipts,
  preparePreviewImageRequest,
  resolvePreviewImages,
  selectOciPlatformDigest,
} from "../images";
import type { PreviewPlanReport } from "../types";

const revision = "a".repeat(40);
const controlRevision = "b".repeat(40);
const producer: PreviewImageProducerIdentity = {
  repository: "ghcr.io/example/preview",
  workflow: "preview.yml",
  controlRevision,
};
const digestA = `sha256:${"1".repeat(64)}`;
const digestB = `sha256:${"2".repeat(64)}`;

function planResources(): PreviewPlanReport["resources"] {
  return [
    {
      id: "web",
      kind: "service",
      imageTarget: "runtime",
      dependsOn: ["worker"],
      ports: [{ name: "http", port: 3000, public: true }],
      command: ["node", "server.js"],
    },
    {
      id: "worker",
      kind: "job",
      imageTarget: "runtime",
      dependsOn: ["db"],
      command: ["node", "worker.js"],
    },
    { id: "db", kind: "postgres" },
    { id: "base", kind: "service", image: `ghcr.io/example/base@${digestB}` },
  ];
}

function plan(): PreviewPlanReport {
  return {
    schemaVersion: 1,
    status: "planned",
    aliases: ["web"],
    profiles: ["full"],
    resources: planResources(),
    reasons: [],
    manifestDigest: "c".repeat(64),
    localConfigDigest: "d".repeat(64),
    omissions: [],
  };
}

function requestInput(): PreviewImageRequestInput {
  return { revision, platform: "linux/amd64" };
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: PreviewImageReceipt = {
    revision,
    repository: producer.repository,
    workflow: producer.workflow,
    controlRevision: producer.controlRevision,
    runId: "12345",
    attempt: 1,
    target: "runtime",
    platform: "linux/amd64",
    configurationDigest: imageConfigurationDigest({}),
    image: `${producer.repository}@${digestA}`,
    inputFingerprint: `sha256:${"3".repeat(64)}`,
    ciPassed: true,
    admissionPassed: true,
  };
  return { ...base, ...overrides };
}

describe("preview images", () => {
  it("defaults absent configuration even for an inherited object property name", () => {
    const selected = plan();
    selected.resources = [{ id: "constructor", kind: "service", imageTarget: "runtime" }];
    expect(preparePreviewImageRequest(selected, requestInput()).request.targets).toEqual([
      { target: "runtime", configuration: {} },
    ]);
  });
  it("canonicalizes configuration and deduplicates shared target/configuration pairs", () => {
    const prepared = preparePreviewImageRequest(plan(), requestInput());

    expect(prepared.request.targets).toEqual([{ target: "runtime", configuration: {} }]);
    expect(prepared.resources.web).toEqual({ target: "runtime", configuration: {} });
    expect(prepared.resources.worker).toEqual({ target: "runtime", configuration: {} });

    const left = imageConfigurationDigest({ B: "2", A: "1" });
    const right = imageConfigurationDigest({ A: "1", B: "2" });
    expect(left).toBe(right);
    expect(left).toBe(`sha256:${createHash("sha256").update('{"A":"1","B":"2"}').digest("hex")}`);
  });

  it("represents the same target with distinct configurations without using the bare target as the key", () => {
    const prepared = preparePreviewImageRequest(plan(), {
      ...requestInput(),
      configurations: {
        web: { flavor: "web" },
        worker: { flavor: "worker" },
      },
    });

    expect(prepared.request.targets).toHaveLength(2);
    expect(prepared.request.targets).toEqual(
      expect.arrayContaining([
        { target: "runtime", configuration: { flavor: "web" } },
        { target: "runtime", configuration: { flavor: "worker" } },
      ]),
    );
    expect(
      parsePreviewImageReceipts(
        {
          receipts: [
            receipt({ configurationDigest: imageConfigurationDigest({ flavor: "web" }) }),
            receipt({ configurationDigest: imageConfigurationDigest({ flavor: "worker" }) }),
          ],
        },
        prepared.request,
        producer,
      ),
    ).toHaveLength(2);
  });

  it("rejects image or build fallback on a logical target", () => {
    const fallback = plan();
    fallback.resources[0] = {
      ...fallback.resources[0],
      build: { context: ".", dockerfile: "Dockerfile" },
    };
    expect(() => preparePreviewImageRequest(fallback, requestInput())).toThrow();
  });

  it("returns only the selected missing resources and no partial deployable plan", () => {
    const previewPlan = plan();
    const prepared = preparePreviewImageRequest(previewPlan, requestInput());
    const result = resolvePreviewImages(previewPlan, prepared, producer, { receipts: [] });

    expect(result).toEqual({ status: "waiting", missing: ["web", "worker"] });
  });

  it("normalizes shared receipts once and preserves pinned images and graph metadata", () => {
    const previewPlan = plan();
    const prepared = preparePreviewImageRequest(previewPlan, requestInput());
    const shared = receipt();
    const result = resolvePreviewImages(previewPlan, prepared, producer, { receipts: [shared] });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.images.web).toEqual(shared);
    expect(result.images.worker).toEqual(shared);
    expect(result.plan.resources[0]).toEqual({
      id: "web",
      kind: "service",
      dependsOn: ["worker"],
      ports: [{ name: "http", port: 3000, public: true }],
      command: ["node", "server.js"],
      image: shared.image,
    });
    expect(result.plan.resources[3]).toEqual(previewPlan.resources[3]);
    expect(result.plan.aliases).toBe(previewPlan.aliases);
    expect(result.plan.source).toBe(previewPlan.source);
  });

  it("keeps the producer repository independent from the image registry path", () => {
    const previewPlan = plan();
    const prepared = preparePreviewImageRequest(previewPlan, requestInput());
    const image = `registry.example.com/team/runtime@${digestA}`;
    const result = resolvePreviewImages(previewPlan, prepared, producer, {
      receipts: [receipt({ image })],
    });

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.plan.resources[0].image).toBe(image);
    }
  });

  it.each([
    ["revision", { revision: "e".repeat(40) }],
    ["producer repository", { repository: "ghcr.io/example/other" }],
    ["workflow", { workflow: "other.yml" }],
    ["control revision", { controlRevision: "f".repeat(40) }],
    ["platform", { platform: "linux/arm64" }],
    ["configuration", { configurationDigest: imageConfigurationDigest({ changed: "true" }) }],
    ["CI success", { ciPassed: false }],
    ["admission", { admissionPassed: false }],
    ["input SHA", { inputFingerprint: "sha256:not-a-digest" }],
    ["image SHA", { image: `${producer.repository}@sha256:${"1".repeat(63)}` }],
    ["unqualified image", { image: `runtime@${digestA}` }],
  ])("rejects a wrong %s", (_label, override) => {
    const prepared = preparePreviewImageRequest(plan(), requestInput());
    expect(() =>
      parsePreviewImageReceipts({ receipts: [receipt(override)] }, prepared.request, producer),
    ).toThrow();
  });

  it("rejects duplicate and unrequested target/configuration receipts", () => {
    const prepared = preparePreviewImageRequest(plan(), {
      ...requestInput(),
      configurations: {
        web: { flavor: "web" },
        worker: { flavor: "worker" },
      },
    });
    const web = receipt({
      configurationDigest: imageConfigurationDigest({ flavor: "web" }),
    });

    expect(() =>
      parsePreviewImageReceipts({ receipts: [web, web] }, prepared.request, producer),
    ).toThrow();
    expect(() =>
      parsePreviewImageReceipts(
        {
          receipts: [
            receipt({
              configurationDigest: imageConfigurationDigest({ unrequested: "true" }),
            }),
          ],
        },
        prepared.request,
        producer,
      ),
    ).toThrow();
  });

  it("rejects receipt extras and non-public or oversized configuration values", () => {
    const prepared = preparePreviewImageRequest(plan(), requestInput());
    expect(() =>
      parsePreviewImageReceipts(
        { receipts: [{ ...receipt(), unexpected: true }] },
        prepared.request,
        producer,
      ),
    ).toThrow();
    expect(() => imageConfigurationDigest({ FLAG: "line\nbreak" })).toThrow();
    expect(() =>
      imageConfigurationDigest({ KLICKER_DEPLOYMENT_BUILD_ENV_JSON: "x".repeat(16 * 1024) }),
    ).not.toThrow();
    expect(() =>
      imageConfigurationDigest({ KLICKER_DEPLOYMENT_BUILD_ENV_JSON: "x".repeat(16 * 1024 + 1) }),
    ).toThrow();
  });

  it("selects a concrete OCI platform while ignoring unknown attestations", () => {
    const index = {
      manifests: [
        {
          digest: `sha256:${"4".repeat(64)}`,
          platform: { os: "unknown", architecture: "unknown" },
          annotations: { "vnd.docker.reference.type": "attestation-manifest" },
        },
        {
          digest: `sha256:${"5".repeat(64)}`,
          platform: { os: "linux", architecture: "arm64" },
        },
        {
          digest: `sha256:${"6".repeat(64)}`,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    };

    expect(selectOciPlatformDigest(index, "linux/amd64")).toBe(`sha256:${"6".repeat(64)}`);
    expect(selectOciPlatformDigest(index, "linux/arm64")).toBe(`sha256:${"5".repeat(64)}`);
  });

  it("rejects absent and multiple concrete OCI platform manifests", () => {
    expect(() =>
      selectOciPlatformDigest(
        { manifests: [{ digest: digestA, platform: { os: "linux", architecture: "arm64" } }] },
        "linux/amd64",
      ),
    ).toThrow();
    expect(() =>
      selectOciPlatformDigest(
        {
          manifests: [
            { digest: digestA, platform: { os: "linux", architecture: "amd64" } },
            { digest: digestB, platform: { os: "linux", architecture: "amd64" } },
          ],
        },
        "linux/amd64",
      ),
    ).toThrow();
  });
});
