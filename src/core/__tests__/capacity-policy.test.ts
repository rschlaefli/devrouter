import { describe, expect, it } from "vitest";
import { type CapacityPolicy, parseCapacityPolicy } from "../capacity-policy";

function validPolicy(): CapacityPolicy {
  return {
    version: 1,
    revision: 7,
    admissions: "enabled",
    scheduling: {
      maxQueuedPerDomain: 32,
      maxQueuedTotal: 64,
      queueLifetimeSeconds: 900,
      clientWaitSeconds: 300,
      maxClientWaitSeconds: 900,
      watchSeconds: 30,
      sampleIntervalSeconds: 5,
      maxSampleAgeSeconds: 15,
    },
    domains: {
      host: {
        kind: "host",
        adapter: "macos-host-v1",
        capacityBytes: 1_000,
        protectedHeadroomBytes: 100,
        startupSlots: 1,
        heavySlots: 1,
      },
      "runtime-a": {
        kind: "runtime",
        adapter: "orbstack-local-v1",
        endpoint: "/tmp/orbstack-a.sock",
        daemonId: "daemon-a",
        hostDomain: "host",
        hostChargeCeilingBytes: 800,
        capacityBytes: 500,
        protectedHeadroomBytes: 50,
        startupSlots: 1,
        heavySlots: 1,
      },
      "runtime-b": {
        kind: "runtime",
        adapter: "orbstack-local-v1",
        endpoint: "/tmp/orbstack-b.sock",
        daemonId: "daemon-b",
        hostDomain: "host",
        hostChargeCeilingBytes: 700,
        capacityBytes: 400,
        protectedHeadroomBytes: 40,
        startupSlots: 1,
        heavySlots: 1,
      },
    },
    enrollments: [
      {
        repoPath: "/workspace/repo",
        gitCommonDir: "/workspace/repo/.git",
        workspace: "feature-one",
        provider: "devpod",
        providerId: "devpod-1",
        hostDomain: "host",
        runtimeDomain: "runtime-a",
        profiles: ["full", "web"],
        estimatesDigest: "a".repeat(64),
        defaultOperation: {
          hostIncrementBytes: 0,
          runtimeIncrementBytes: 10,
        },
      },
    ],
  };
}

describe("parseCapacityPolicy", () => {
  it("accepts named host and independent runtime domains with a qualified zero host increment", () => {
    const policy = parseCapacityPolicy(validPolicy());

    expect(policy.domains["runtime-b"]).toMatchObject({ hostDomain: "host" });
    expect(policy.enrollments[0].defaultOperation.hostIncrementBytes).toBe(0);
  });

  it("canonicalizes enrollment profile combinations and rejects aliases", () => {
    const policy = validPolicy();
    policy.enrollments[0] = {
      ...policy.enrollments[0],
      profiles: ["web,full"],
    };
    expect(parseCapacityPolicy(policy).enrollments[0].profiles).toEqual(["full,web"]);

    const aliased = validPolicy();
    aliased.enrollments[0] = {
      ...aliased.enrollments[0],
      profiles: ["full,web", "web,full"],
    };
    expect(() => parseCapacityPolicy(aliased)).toThrow(/duplicate or aliased/);
  });

  it.each([
    ["unknown top-level authority", (policy: CapacityPolicy) => ({ ...policy, authority: "live" })],
    [
      "unsafe scheduling bounds",
      (policy: CapacityPolicy) => ({
        ...policy,
        scheduling: { ...policy.scheduling, clientWaitSeconds: 901 },
      }),
    ],
    [
      "headroom equal to capacity",
      (policy: CapacityPolicy) => ({
        ...policy,
        domains: {
          ...policy.domains,
          host: { ...policy.domains.host, protectedHeadroomBytes: 1_000 },
        },
      }),
    ],
    [
      "missing domain reference",
      (policy: CapacityPolicy) => ({
        ...policy,
        enrollments: [{ ...policy.enrollments[0], runtimeDomain: "missing" }],
      }),
    ],
    [
      "wrong domain kind",
      (policy: CapacityPolicy) => ({
        ...policy,
        enrollments: [{ ...policy.enrollments[0], runtimeDomain: "host" }],
      }),
    ],
    [
      "mismatched host binding",
      (policy: CapacityPolicy) => ({
        ...policy,
        domains: {
          ...policy.domains,
          "other-host": { ...policy.domains.host },
        },
        enrollments: [{ ...policy.enrollments[0], hostDomain: "other-host" }],
      }),
    ],
    [
      "daemon alias collision",
      (policy: CapacityPolicy) => ({
        ...policy,
        domains: {
          ...policy.domains,
          "runtime-b": { ...policy.domains["runtime-b"], daemonId: "daemon-a" },
        },
      }),
    ],
    [
      "duplicate enrollment",
      (policy: CapacityPolicy) => ({
        ...policy,
        enrollments: [...policy.enrollments, { ...policy.enrollments[0] }],
      }),
    ],
  ])("rejects %s", (_case, mutate) => {
    expect(() => parseCapacityPolicy(mutate(validPolicy()))).toThrow();
    if (_case === "mismatched host binding") {
      const corrected = mutate(validPolicy()) as CapacityPolicy;
      corrected.enrollments[0].hostDomain = "host";
      expect(() => parseCapacityPolicy(corrected)).not.toThrow();
    }
    if (_case === "daemon alias collision") {
      const corrected = mutate(validPolicy()) as CapacityPolicy;
      const runtime = corrected.domains["runtime-b"];
      if (runtime.kind !== "runtime") throw new Error("Invalid test fixture");
      runtime.daemonId = "daemon-b";
      expect(() => parseCapacityPolicy(corrected)).not.toThrow();
    }
  });

  it("rejects non-safe numbers, unsupported adapters, and non-canonical paths", () => {
    expect(() =>
      parseCapacityPolicy({
        ...validPolicy(),
        revision: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/safe integer/);

    expect(() =>
      parseCapacityPolicy({
        ...validPolicy(),
        domains: {
          ...validPolicy().domains,
          "runtime-a": { ...validPolicy().domains["runtime-a"], adapter: "docker-context" },
        },
      }),
    ).toThrow(/adapter/);

    expect(() =>
      parseCapacityPolicy({
        ...validPolicy(),
        enrollments: [{ ...validPolicy().enrollments[0], repoPath: "/workspace/../repo" }],
      }),
    ).toThrow(/canonical absolute path/);
  });
});
