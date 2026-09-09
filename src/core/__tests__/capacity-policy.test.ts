import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type CapacityPolicy, parseCapacityPolicy, readCapacityPolicy } from "../capacity-policy";

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

function declaredPolicy(unmanagedAllowanceBytes = 100): CapacityPolicy {
  const policy = validPolicy();
  policy.domains.host = {
    kind: "host",
    adapter: "macos-declared-v1",
    capacityBytes: 1_000,
    protectedHeadroomBytes: 100,
    unmanagedAllowanceBytes,
    startupSlots: 1,
    heavySlots: 1,
  };
  return policy;
}

function declaredRuntimePolicy(guestUnmanagedAllowanceBytes = 100): CapacityPolicy {
  const policy = validPolicy();
  policy.domains["runtime-a"] = {
    kind: "runtime",
    adapter: "orbstack-declared-v1",
    endpoint: "/tmp/orbstack-a.sock",
    daemonId: "daemon-a",
    hostDomain: "host",
    hostChargeCeilingBytes: 800,
    capacityBytes: 500,
    protectedHeadroomBytes: 50,
    guestUnmanagedAllowanceBytes,
    startupSlots: 1,
    heavySlots: 1,
  };
  return policy;
}

describe("parseCapacityPolicy", () => {
  it.each([
    ["maxQueuedTotal", 65],
    ["maxQueuedPerDomain", 33],
    ["queueLifetimeSeconds", 901],
    ["maxClientWaitSeconds", 901],
    ["watchSeconds", 31],
    ["maxSampleAgeSeconds", 16],
  ] as const)("rejects %s beyond the controller's supported bound", (field, value) => {
    const policy = validPolicy();
    policy.scheduling[field] = value;
    expect(() => parseCapacityPolicy(policy)).toThrow("supported controller bounds");
  });

  it("reads private operator policy and distinguishes absence from invalid authority", () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "capacity-policy-")));
    const file = path.join(directory, "capacity-policy.json");
    try {
      expect(readCapacityPolicy(directory)).toBeUndefined();
      fs.writeFileSync(file, JSON.stringify(validPolicy()), { mode: 0o600 });
      expect(readCapacityPolicy(directory)).toEqual(parseCapacityPolicy(validPolicy()));
      fs.chmodSync(file, 0o644);
      expect(() => readCapacityPolicy(directory)).toThrow("private file");
      fs.chmodSync(file, 0o600);
      fs.writeFileSync(file, "not-json");
      expect(() => readCapacityPolicy(directory)).toThrow();
      fs.writeFileSync(file, " ".repeat(1_048_577));
      expect(() => readCapacityPolicy(directory)).toThrow("private file");
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(directory, "absent"), file);
      expect(() => readCapacityPolicy(directory)).toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts named host and independent runtime domains with a qualified zero host increment", () => {
    const policy = parseCapacityPolicy(validPolicy());

    expect(policy.domains["runtime-b"]).toMatchObject({ hostDomain: "host" });
    expect(policy.enrollments[0].defaultOperation.hostIncrementBytes).toBe(0);
  });

  it.each([
    0, 100,
  ])("round-trips a declared host domain with explicit allowance %s", (allowance) => {
    const policy = declaredPolicy(allowance);

    expect(parseCapacityPolicy(policy)).toEqual(policy);
  });

  it("requires a nonnegative safe integer allowance for declared hosts", () => {
    const policy = declaredPolicy();
    const host = policy.domains.host;
    if (host.adapter !== "macos-declared-v1") throw new Error("Invalid test fixture");

    for (const allowance of [-1, -0, Number.MAX_SAFE_INTEGER + 1]) {
      host.unmanagedAllowanceBytes = allowance;
      expect(() => parseCapacityPolicy(policy)).toThrow(/unmanagedAllowanceBytes/);
    }

    const hostWithoutAllowance = { ...host };
    delete (hostWithoutAllowance as Partial<typeof hostWithoutAllowance>).unmanagedAllowanceBytes;
    expect(() =>
      parseCapacityPolicy({
        ...policy,
        domains: { ...policy.domains, host: hostWithoutAllowance },
      }),
    ).toThrow(/unmanagedAllowanceBytes/);
  });

  it("rejects an allowance on the legacy host adapter", () => {
    const policy = validPolicy();

    expect(() =>
      parseCapacityPolicy({
        ...policy,
        domains: {
          ...policy.domains,
          host: { ...policy.domains.host, unmanagedAllowanceBytes: 0 },
        },
      }),
    ).toThrow(/only supported for adapter/);
  });

  it.each([
    0, 100,
  ])("round-trips a declared runtime domain with explicit guest allowance %s", (allowance) => {
    const policy = declaredRuntimePolicy(allowance);

    expect(parseCapacityPolicy(policy)).toEqual(policy);
  });

  it("requires a nonnegative safe integer allowance for declared runtimes", () => {
    const policy = declaredRuntimePolicy();
    const runtime = policy.domains["runtime-a"];
    if (runtime.adapter !== "orbstack-declared-v1") throw new Error("Invalid test fixture");

    const runtimeWithoutAllowance = { ...runtime };
    delete (runtimeWithoutAllowance as Partial<typeof runtimeWithoutAllowance>)
      .guestUnmanagedAllowanceBytes;
    expect(() =>
      parseCapacityPolicy({
        ...policy,
        domains: { ...policy.domains, "runtime-a": runtimeWithoutAllowance },
      }),
    ).toThrow(/guestUnmanagedAllowanceBytes/);

    for (const allowance of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      runtime.guestUnmanagedAllowanceBytes = allowance;
      expect(() => parseCapacityPolicy(policy)).toThrow(/guestUnmanagedAllowanceBytes/);
    }
  });

  it("rejects a guest allowance on the legacy runtime adapter", () => {
    const policy = validPolicy();

    expect(() =>
      parseCapacityPolicy({
        ...policy,
        domains: {
          ...policy.domains,
          "runtime-a": {
            ...policy.domains["runtime-a"],
            guestUnmanagedAllowanceBytes: 0,
          },
        },
      }),
    ).toThrow(/only supported for adapter/);
  });

  it("allows an allowance at the available boundary and reserves it from runtime budgets", () => {
    const atBoundary = declaredPolicy(900);
    atBoundary.domains = { host: atBoundary.domains.host };
    atBoundary.enrollments = [];
    expect(() => parseCapacityPolicy(atBoundary)).not.toThrow();

    const beyondBoundary = declaredPolicy(901);
    beyondBoundary.domains = { host: beyondBoundary.domains.host };
    beyondBoundary.enrollments = [];
    expect(() => parseCapacityPolicy(beyondBoundary)).toThrow(/unmanagedAllowanceBytes/);

    expect(() => parseCapacityPolicy(declaredPolicy(101))).toThrow(/hostChargeCeilingBytes/);
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
