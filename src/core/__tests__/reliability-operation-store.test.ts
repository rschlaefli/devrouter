import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomically } from "../atomic-file";
import { CapacityStore } from "../capacity-store";
import { reliabilityFence } from "../reliability-contract";
import { stepReliability } from "../reliability-model";
import {
  assertCapacityEffect,
  enrollStoppedLifecycle,
  type ReliabilityIdentity,
  readReliabilityOperation,
  reliabilityOperationPath,
  updateReliabilityOperation,
  withReliabilityObservationFence,
} from "../reliability-operation-store";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../router", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "reliability-store-"));
  return { DEVROUTER_HOME: fixture.root };
});
vi.mock("../atomic-file", async (original) => {
  const actual = await original<typeof import("../atomic-file")>();
  return { ...actual, writeFileAtomically: vi.fn(actual.writeFileAtomically) };
});

let identity: ReliabilityIdentity;
beforeEach(() => {
  identity = {
    repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "reliability-checkout-")),
    workspace: null,
    provider: "devsy",
  };
});
const checkouts: string[] = [];
beforeEach(() => checkouts.push(identity.repoPath));
afterAll(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  for (const checkout of checkouts) fs.rmSync(checkout, { recursive: true, force: true });
});

describe("durable reliability records", () => {
  const enrollment = {
    policyRevision: 1,
    gitCommonDir: "/tmp/synthetic-common",
    providerId: "synthetic-provider",
    hostDomain: "host",
    runtimeDomain: "guest",
    endpoint: "/tmp/synthetic-docker.sock",
    daemonId: "synthetic:daemon",
    estimatesDigest: "a".repeat(64),
  };

  function stoppedRecord() {
    updateReliabilityOperation(identity, (record) => {
      record.state = stepReliability(
        record.state,
        { ...reliabilityFence(record.state), type: "stop" },
        100,
      ).state;
      record.state = stepReliability(
        record.state,
        {
          ...reliabilityFence(record.state),
          type: "stop-proof",
          workloadsStopped: true,
          routesRemoved: true,
        },
        100,
      ).state;
    });
    return readReliabilityOperation(identity)!;
  }

  it("persists enrollment independently of reservation and session lifetime", () => {
    const before = stoppedRecord();
    enrollStoppedLifecycle(identity, before.revision, enrollment);
    const converted = readReliabilityOperation(identity)!;
    expect(converted).toMatchObject({
      version: 2,
      enrollment,
      capacity: null,
      activeProfile: null,
      state: { executionPolicy: "capacity-managed", desired: "stopped-by-user" },
    });
    expect(() => assertCapacityEffect(converted, "worker", 100)).toThrow("absent or stale");
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        delete record.enrollment;
      }),
    ).toThrow("requires durable");
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.state.executionPolicy = "manual";
      }),
    ).toThrow();
    expect(readReliabilityOperation(identity)!.enrollment).toEqual(enrollment);
    expect(() =>
      enrollStoppedLifecycle(identity, converted.revision, {
        ...enrollment,
        daemonId: "replacement",
      }),
    ).toThrow("different capacity enrollment");
  });

  it.each([
    "no-proof",
    "routes",
    "worker",
    "revision",
  ] as const)("rejects enrollment with incomplete or changed evidence (%s)", (condition) => {
    if (condition === "no-proof") updateReliabilityOperation(identity, () => undefined);
    else stoppedRecord();
    if (condition === "routes")
      updateReliabilityOperation(identity, (record) => {
        record.state.stopProof.routesRemoved = false;
      });
    if (condition === "worker")
      updateReliabilityOperation(identity, (record) => {
        record.state.operation = {
          id: "operation",
          kind: "ensure",
          status: "NOT_STARTED",
          drained: true,
          exitCode: null,
        };
        record.state.operationHistory.push({
          ...record.state.operation,
          key: "request",
          profile: "full",
          consumer: { id: "synthetic", requiredCapabilities: [], pinned: false },
        });
        record.worker = { id: "worker", operationId: "operation", pid: 123, birth: "proc:123" };
      });
    const before = readReliabilityOperation(identity)!;
    expect(() =>
      enrollStoppedLifecycle(
        identity,
        before.revision + (condition === "revision" ? 1 : 0),
        enrollment,
      ),
    ).toThrow();
    expect(readReliabilityOperation(identity)).toEqual(before);
  });

  it("persists a settled v2 record with null capacity but rejects it as effect authority", () => {
    updateReliabilityOperation(identity, (record) => {
      record.version = 2;
      record.capacity = null;
    });

    const record = readReliabilityOperation(identity);
    expect(record).toMatchObject({ version: 2, capacity: null });
    expect(() =>
      assertCapacityEffect(record!, "worker", 100, path.join(fixture.root, "controller")),
    ).toThrow("absent or stale");
  });

  it("rejects missing or undefined capacity on a v2 journal", () => {
    updateReliabilityOperation(identity, (record) => {
      record.version = 2;
      record.capacity = null;
    });

    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.capacity = undefined;
      }),
    ).toThrow("Invalid capacity authority binding");

    const file = reliabilityOperationPath(identity);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete persisted.capacity;
    fs.writeFileSync(file, `${JSON.stringify(persisted)}\n`);
    expect(() => readReliabilityOperation(identity)).toThrow("Invalid capacity authority binding");
  });

  it("binds capacity effects to the durable operation, worker and unexpired reservation", () => {
    updateReliabilityOperation(identity, (record) => {
      record.state = stepReliability(
        record.state,
        {
          ...reliabilityFence(record.state),
          type: "operation-request",
          kind: "ensure",
          key: "key",
          operationId: "operation",
          profile: "full",
          runtimeRunning: false,
          consumer: { id: "manual", requiredCapabilities: [], pinned: false },
        },
        100,
      ).state;
    });
    const record = readReliabilityOperation(identity)!;
    const directory = path.join(fixture.root, "controller");
    const store = new CapacityStore(directory);
    const sample = {
      sampledAtMs: 100,
      pressure: "normal" as const,
      unmanagedBytes: 0,
      sharedBytes: 0,
      ownedBytes: {},
    };
    const expectedRevision = store.read().revision;
    store.reserve(
      {
        environmentId: record.state.environmentId,
        operationId: "operation",
        reservationId: "reservation",
        policyRevision: 1,
        totals: { host: 1 },
        startup: true,
        heavy: false,
      },
      { host: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 1, heavySlots: 1 } },
      { host: sample },
      100,
      15,
      undefined,
      expectedRevision,
    );
    updateReliabilityOperation(identity, (current) => {
      current.version = 2;
      current.capacity = {
        reservationId: "reservation",
        operationId: "operation",
        workerId: "worker",
        policyRevision: 1,
        validUntilMs: 115,
      };
    });
    updateReliabilityOperation(identity, (current) =>
      assertCapacityEffect(current, "worker", 100, directory),
    );
    for (const [worker, now] of [
      ["other", 100],
      ["worker", 115],
    ] as const) {
      expect(() =>
        updateReliabilityOperation(identity, (current) =>
          assertCapacityEffect(current, worker, now, directory),
        ),
      ).toThrow("absent or stale");
    }
    const current = readReliabilityOperation(identity)!;
    current.capacity!.policyRevision++;
    expect(() => assertCapacityEffect(current, "worker", 100, directory)).toThrow("does not match");
    expect(store.read().reservations).toHaveLength(1);
  });
  it("writes private bounded manual state and refuses mismatched provider ownership", () => {
    expect(readReliabilityOperation(identity)).toBeUndefined();
    updateReliabilityOperation(identity, () => undefined);
    const record = readReliabilityOperation(identity);
    expect(record).toMatchObject({
      revision: 1,
      state: { executionPolicy: "manual", admission: "not-applicable" },
    });
    expect(fs.statSync(reliabilityOperationPath(identity)).mode & 0o777).toBe(0o600);
    expect(() => readReliabilityOperation({ ...identity, provider: "devpod" })).toThrow();
  });

  it("does not persist raw fields or redirect an update to another identity", () => {
    updateReliabilityOperation(identity, () => undefined);
    const original = fs.readFileSync(reliabilityOperationPath(identity), "utf8");
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        Object.assign(record.state, { argv: ["synthetic-payload"] });
      }),
    ).toThrow();
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.identity.repoPath = path.join(identity.repoPath, "other");
      }),
    ).toThrow();
    expect(fs.readFileSync(reliabilityOperationPath(identity), "utf8")).toBe(original);
  });

  it("rejects malformed, oversize, symlinked and non-private persisted records", () => {
    updateReliabilityOperation(identity, () => undefined);
    const file = reliabilityOperationPath(identity);
    const valid = fs.readFileSync(file);
    fs.writeFileSync(file, "{");
    expect(() => readReliabilityOperation(identity)).toThrow();
    fs.writeFileSync(file, Buffer.alloc(1_048_577));
    expect(() => readReliabilityOperation(identity)).toThrow();
    fs.writeFileSync(file, valid);
    fs.chmodSync(file, 0o644);
    expect(() => readReliabilityOperation(identity)).toThrow();
    fs.renameSync(file, `${file}.saved`);
    fs.symlinkSync(`${file}.saved`, file);
    expect(() => readReliabilityOperation(identity)).toThrow();
  });

  it("never acknowledges a failed write before rename", () => {
    updateReliabilityOperation(identity, () => undefined);
    vi.mocked(writeFileAtomically).mockImplementationOnce(() => {
      throw new Error("fixture before rename");
    });
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.effectSequence += 1;
      }),
    ).toThrow();
    expect(readReliabilityOperation(identity)).toMatchObject({ revision: 1, effectSequence: 0 });
  });

  it("recovers a post-rename error only by syncing the exact newly persisted record", async () => {
    const actual = await vi.importActual<typeof import("../atomic-file")>("../atomic-file");
    vi.mocked(writeFileAtomically).mockImplementationOnce((file, contents) => {
      actual.writeFileAtomically(file, contents);
      throw new Error("fixture after rename");
    });
    updateReliabilityOperation(identity, (record) => {
      record.effectSequence = 1;
    });
    expect(readReliabilityOperation(identity)).toMatchObject({ revision: 1, effectSequence: 1 });
  });

  it("refuses acknowledgement when the post-rename durability check also fails", async () => {
    const actual = await vi.importActual<typeof import("../atomic-file")>("../atomic-file");
    vi.mocked(writeFileAtomically).mockImplementationOnce((file, contents) => {
      actual.writeFileAtomically(file, contents);
      vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
        throw new Error("fixture sync failure");
      });
      throw new Error("fixture after rename");
    });
    expect(() => updateReliabilityOperation(identity, () => undefined)).toThrow();
    vi.restoreAllMocks();
    expect(readReliabilityOperation(identity)?.revision).toBe(1);
  });

  it("rejects asynchronous updates and exhausted counters before persistence", () => {
    updateReliabilityOperation(identity, (record) => {
      record.revision = Number.MAX_SAFE_INTEGER - 1;
    });
    expect(() => updateReliabilityOperation(identity, () => undefined)).toThrow();
    const other = { ...identity, repoPath: path.join(identity.repoPath, "other") };
    expect(() => updateReliabilityOperation(other, async () => undefined)).toThrow();
    expect(readReliabilityOperation(other)).toBeUndefined();
  });
});

it("fences observation publication without changing manual state", () => {
  expect(() => withReliabilityObservationFence(identity, 0, () => undefined)).toThrow();
  updateReliabilityOperation(identity, () => undefined);
  const bytes = fs.readFileSync(reliabilityOperationPath(identity));
  const publish = vi.fn(() => "published");
  expect(withReliabilityObservationFence(identity, 1, publish)).toBe("published");
  expect(fs.readFileSync(reliabilityOperationPath(identity))).toEqual(bytes);
  updateReliabilityOperation(identity, () => undefined);
  expect(() => withReliabilityObservationFence(identity, 1, publish)).toThrow();
  expect(publish).toHaveBeenCalledTimes(1);
});
