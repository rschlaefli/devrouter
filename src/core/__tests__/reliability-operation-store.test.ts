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
  type CapacityPhaseSettlement,
  enrollStoppedLifecycle,
  listReliabilityOperations,
  type ReliabilityIdentity,
  type ReliabilityOperationRecord,
  type ReliabilityPreparationReceipt,
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

  function stoppedRecord(target: ReliabilityIdentity = identity) {
    updateReliabilityOperation(target, (record) => {
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
    return readReliabilityOperation(target)!;
  }

  function preparationReceipt(
    record: ReliabilityOperationRecord,
    operationId = "prepared-operation",
    profile = "full",
  ): ReliabilityPreparationReceipt {
    return {
      operationId,
      profile,
      fence: {
        ...reliabilityFence(record.state),
        intentRevision: 7,
        runtimeGeneration: 3,
        controllerEpoch: 4,
      },
    };
  }

  function completedPreparationRecord(target: ReliabilityIdentity = identity) {
    const before = stoppedRecord(target);
    enrollStoppedLifecycle(target, before.revision, enrollment);
    updateReliabilityOperation(target, (record) => {
      const prepared = {
        id: "prepared-operation",
        kind: "ensure",
        drained: true,
        status: "COMPLETED",
        exitCode: 0,
        key: "prepared-key",
        profile: "full",
        consumer: { id: "synthetic", requiredCapabilities: [], pinned: false },
      } satisfies ReliabilityOperationRecord["state"]["operationHistory"][number];
      const current = {
        id: "current-operation",
        kind: "exec",
        drained: true,
        status: "COMPLETED",
        exitCode: 0,
        key: "current-key",
        profile: "full",
        consumer: { id: "synthetic-current", requiredCapabilities: [], pinned: false },
      } satisfies ReliabilityOperationRecord["state"]["operationHistory"][number];
      record.state.operationHistory.push(prepared, current);
      record.state.operation = {
        id: current.id,
        kind: current.kind,
        drained: current.drained,
        status: current.status,
        exitCode: current.exitCode,
      };
      record.activeProfile = "full";
      record.preparation = preparationReceipt(record, prepared.id, prepared.profile);
    });
    return readReliabilityOperation(target)!;
  }

  function phaseSettlement(record: ReliabilityOperationRecord): CapacityPhaseSettlement {
    if (!record.capacity || !record.enrollment)
      throw new Error("Fixture requires capacity enrollment and binding.");
    return {
      id: "phase-settlement",
      fence: {
        environmentId: record.state.environmentId,
        intentRevision: 1,
        runtimeGeneration: 1,
        controllerEpoch: 1,
      },
      target: {
        environmentId: record.state.environmentId,
        operationId: record.capacity.operationId,
        reservationId: record.capacity.reservationId,
        policyRevision: record.capacity.policyRevision,
        totals: {
          [record.enrollment.hostDomain]: 0,
          [record.enrollment.runtimeDomain]: 1,
        },
        startup: false,
        heavy: false,
      },
      estimatesDigest: record.enrollment.estimatesDigest,
    };
  }

  function phaseSettledRecord(): ReliabilityOperationRecord {
    const record = completedPreparationRecord();
    updateReliabilityOperation(identity, (current) => {
      current.capacity = {
        reservationId: "settlement-reservation",
        operationId: "prepared-operation",
        workerId: "settlement-worker",
        policyRevision: 1,
        validUntilMs: 0,
      };
      current.phaseSettlement = phaseSettlement(current);
    });
    return record;
  }

  function journalDirectory(): string {
    return path.join(fixture.root, "reliability");
  }

  function extraIdentity(provider: ReliabilityIdentity["provider"]): ReliabilityIdentity {
    const target = {
      repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "reliability-enumeration-checkout-")),
      workspace: null,
      provider,
    } satisfies ReliabilityIdentity;
    checkouts.push(target.repoPath);
    return target;
  }

  function resetJournalDirectory(): void {
    fs.rmSync(journalDirectory(), { recursive: true, force: true });
  }

  function writeKnownSidecars(file: string): void {
    const uuid = "11111111-1111-4111-8111-111111111111";
    const lock = `${file}.lock`;
    const options = { mode: 0o600 } as const;
    fs.writeFileSync(lock, "", options);
    fs.writeFileSync(`${lock}.${process.pid}.${uuid}.candidate`, "", options);
    fs.writeFileSync(`${lock}.queue.1234567890123.0000000001.${uuid}.candidate`, "", options);
    fs.writeFileSync(
      path.join(journalDirectory(), `.${path.basename(file)}.${process.pid}.${uuid}.tmp`),
      "",
      options,
    );
  }

  it("returns no records when the reliability directory is absent", () => {
    resetJournalDirectory();
    expect(listReliabilityOperations()).toEqual([]);
  });

  it("lists mixed manual and enrolled journals while ignoring known lock sidecars", () => {
    resetJournalDirectory();
    updateReliabilityOperation(identity, () => undefined);
    const enrolledIdentity = extraIdentity("devpod");
    const before = stoppedRecord(enrolledIdentity);
    enrollStoppedLifecycle(enrolledIdentity, before.revision, enrollment);
    writeKnownSidecars(reliabilityOperationPath(identity));
    writeKnownSidecars(reliabilityOperationPath(enrolledIdentity));

    const records = listReliabilityOperations();
    expect(records).toHaveLength(2);
    const manual = records.find((record) => record.identity.repoPath === identity.repoPath);
    const enrolled = records.find(
      (record) => record.identity.repoPath === enrolledIdentity.repoPath,
    );
    expect(manual?.version).toBe(1);
    expect(manual?.enrollment).toBeUndefined();
    expect(enrolled).toMatchObject({
      version: 2,
      enrollment,
      capacity: null,
    });
  });

  it("rejects corrupt journals without returning partial results", () => {
    resetJournalDirectory();
    updateReliabilityOperation(identity, () => undefined);
    fs.writeFileSync(reliabilityOperationPath(identity), "{", { mode: 0o600 });
    expect(() => listReliabilityOperations()).toThrow();
  });

  it("rejects symlinked journal entries", () => {
    resetJournalDirectory();
    updateReliabilityOperation(identity, () => undefined);
    const file = reliabilityOperationPath(identity);
    fs.unlinkSync(file);
    fs.symlinkSync("/tmp/synthetic-missing-reliability-journal", file);
    expect(() => listReliabilityOperations()).toThrow("symlink");
  });

  it("rejects non-private journal files and directories", () => {
    resetJournalDirectory();
    updateReliabilityOperation(identity, () => undefined);
    const file = reliabilityOperationPath(identity);
    fs.chmodSync(file, 0o644);
    expect(() => listReliabilityOperations()).toThrow("bounded private file");
    fs.chmodSync(file, 0o600);
    fs.chmodSync(journalDirectory(), 0o755);
    expect(() => listReliabilityOperations()).toThrow("not private");
    fs.chmodSync(journalDirectory(), 0o700);
  });

  it("rejects a journal filename that does not match its identity hash", () => {
    resetJournalDirectory();
    updateReliabilityOperation(identity, () => undefined);
    const file = reliabilityOperationPath(identity);
    const wrong = path.join(journalDirectory(), `${"0".repeat(64)}.json`);
    fs.renameSync(file, wrong);
    expect(() => listReliabilityOperations()).toThrow("filename does not match");
  });

  it("rejects more than the bounded journal count", () => {
    resetJournalDirectory();
    fs.mkdirSync(journalDirectory(), { mode: 0o700 });
    for (let index = 0; index <= 256; index += 1) {
      const name = `${index.toString(16).padStart(64, "0")}.json`;
      fs.writeFileSync(path.join(journalDirectory(), name), "{}\n", { mode: 0o600 });
    }
    expect(() => listReliabilityOperations()).toThrow("journal limit");
  });

  it("rejects more than the bounded directory entry count", () => {
    resetJournalDirectory();
    fs.mkdirSync(journalDirectory(), { mode: 0o700 });
    for (let index = 0; index <= 512; index += 1) {
      const name = `${index.toString(16).padStart(64, "0")}.json.lock`;
      fs.writeFileSync(path.join(journalDirectory(), name), "", { mode: 0o600 });
    }
    expect(() => listReliabilityOperations()).toThrow("entry limit");
  });

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
    ).toThrow();
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

  it("rejects an atomic enrollment downgrade without changing durable bytes", () => {
    const initial = stoppedRecord();
    enrollStoppedLifecycle(identity, initial.revision, enrollment);
    const before = fs.readFileSync(reliabilityOperationPath(identity), "utf8");
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.version = 1;
        delete record.enrollment;
        delete record.activeProfile;
        delete record.capacity;
        record.state.executionPolicy = "manual";
        record.state.admission = "not-applicable";
        record.state.chargeHeld = false;
      }),
    ).toThrow();
    expect(fs.readFileSync(reliabilityOperationPath(identity), "utf8")).toBe(before);
    expect(() =>
      assertCapacityEffect(readReliabilityOperation(identity)!, "worker", 100),
    ).toThrow();
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

  it("persists a completed preparation receipt independently of the current operation", () => {
    const record = completedPreparationRecord();
    expect(record).toMatchObject({
      version: 2,
      preparation: {
        operationId: "prepared-operation",
        profile: "full",
        fence: {
          environmentId: record.state.environmentId,
          intentRevision: 7,
          runtimeGeneration: 3,
          controllerEpoch: 4,
        },
      },
      state: { operation: { id: "current-operation", kind: "exec" } },
    });

    updateReliabilityOperation(identity, (current) => {
      current.preparation = null;
    });
    expect(readReliabilityOperation(identity)?.preparation).toBeNull();
  });

  it("persists a phase settlement independently of the current fence and operation", () => {
    const initial = completedPreparationRecord();
    updateReliabilityOperation(identity, (current) => {
      current.capacity = {
        reservationId: "settlement-reservation",
        operationId: "prepared-operation",
        workerId: "settlement-worker",
        policyRevision: 1,
        validUntilMs: 0,
      };
      current.phaseSettlement = phaseSettlement(current);
    });

    const record = readReliabilityOperation(identity)!;
    expect(record.phaseSettlement).toEqual({
      id: "phase-settlement",
      fence: {
        environmentId: initial.state.environmentId,
        intentRevision: 1,
        runtimeGeneration: 1,
        controllerEpoch: 1,
      },
      target: {
        environmentId: initial.state.environmentId,
        operationId: "prepared-operation",
        reservationId: "settlement-reservation",
        policyRevision: 1,
        totals: { host: 0, guest: 1 },
        startup: false,
        heavy: false,
      },
      estimatesDigest: enrollment.estimatesDigest,
    });
  });

  it("accepts an absent or null phase settlement on an enrolled v2 journal", () => {
    completedPreparationRecord();
    expect(readReliabilityOperation(identity)?.phaseSettlement).toBeUndefined();
    updateReliabilityOperation(identity, (record) => {
      record.phaseSettlement = null;
    });
    expect(readReliabilityOperation(identity)?.phaseSettlement).toBeNull();
  });

  it.each([
    [
      "unsafe target total",
      (settlement: CapacityPhaseSettlement) => ({
        ...settlement,
        target: { ...settlement.target, totals: { host: Number.MAX_SAFE_INTEGER + 1, guest: 1 } },
      }),
    ],
    [
      "startup target",
      (settlement: CapacityPhaseSettlement) => ({
        ...settlement,
        target: { ...settlement.target, startup: true },
      }),
    ],
    [
      "wrong enrolled domains",
      (settlement: CapacityPhaseSettlement) => ({
        ...settlement,
        target: { ...settlement.target, totals: { host: 1, other: 1 } },
      }),
    ],
    [
      "digest mismatch",
      (settlement: CapacityPhaseSettlement) => ({
        ...settlement,
        estimatesDigest: "b".repeat(64),
      }),
    ],
    [
      "unsettled capacity binding",
      (settlement: CapacityPhaseSettlement) => ({
        ...settlement,
        target: { ...settlement.target },
      }),
    ],
  ] as const)("rejects a %s phase settlement", (_label, alter) => {
    phaseSettledRecord();
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        if (_label === "unsettled capacity binding") record.capacity!.validUntilMs = 1;
        record.phaseSettlement = alter(record.phaseSettlement!);
      }),
    ).toThrow();
  });

  it("rejects a phase settlement without durable enrollment", () => {
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.version = 2;
        record.capacity = {
          reservationId: "settlement-reservation",
          operationId: "settlement-operation",
          workerId: "settlement-worker",
          policyRevision: 1,
          validUntilMs: 0,
        };
        record.phaseSettlement = {
          id: "phase-settlement",
          fence: {
            environmentId: record.state.environmentId,
            intentRevision: 1,
            runtimeGeneration: 1,
            controllerEpoch: 1,
          },
          target: {
            environmentId: record.state.environmentId,
            operationId: "settlement-operation",
            reservationId: "settlement-reservation",
            policyRevision: 1,
            totals: { host: 0, guest: 1 },
            startup: false,
            heavy: false,
          },
          estimatesDigest: enrollment.estimatesDigest,
        };
      }),
    ).toThrow("durable capacity enrollment");
  });

  it("rejects a phase settlement field on a version1 journal", () => {
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.phaseSettlement = null;
      }),
    ).toThrow("unsupported fields");
  });

  it.each([
    [
      "malformed profile",
      (receipt: ReliabilityPreparationReceipt) => ({ ...receipt, profile: "" }),
    ],
    [
      "malformed fence",
      (receipt: ReliabilityPreparationReceipt) => ({
        ...receipt,
        fence: { ...receipt.fence, runtimeGeneration: -1 },
      }),
    ],
    [
      "wrong environment",
      (receipt: ReliabilityPreparationReceipt) => ({
        ...receipt,
        fence: { ...receipt.fence, environmentId: "f".repeat(64) },
      }),
    ],
    [
      "missing history",
      (receipt: ReliabilityPreparationReceipt) => ({
        ...receipt,
        operationId: "missing-operation",
      }),
    ],
  ] as const)("rejects a %s preparation receipt", (_label, alter) => {
    completedPreparationRecord();
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.preparation = alter(record.preparation!);
      }),
    ).toThrow();
  });

  it("rejects a nonnull preparation receipt without durable enrollment", () => {
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        const operation = {
          id: "unowned-operation",
          kind: "ensure" as const,
          drained: true,
          status: "COMPLETED" as const,
          exitCode: 0,
          key: "unowned-key",
          profile: "full",
          consumer: { id: "synthetic", requiredCapabilities: [], pinned: false },
        };
        record.version = 2;
        record.capacity = null;
        record.state.operationHistory.push(operation);
        record.state.operation = {
          id: operation.id,
          kind: operation.kind,
          drained: operation.drained,
          status: operation.status,
          exitCode: operation.exitCode,
        };
        record.preparation = {
          operationId: operation.id,
          profile: operation.profile,
          fence: reliabilityFence(record.state),
        };
      }),
    ).toThrow("durable capacity enrollment");
  });

  it("rejects a nonnull preparation receipt on a version1 record", () => {
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        const operation = {
          id: "manual-prepared",
          kind: "ensure" as const,
          drained: true,
          status: "COMPLETED" as const,
          exitCode: 0,
          key: "manual-key",
          profile: "full",
          consumer: { id: "synthetic", requiredCapabilities: [], pinned: false },
        };
        record.state.operationHistory.push(operation);
        record.state.operation = { ...operation };
        record.preparation = {
          operationId: operation.id,
          profile: operation.profile,
          fence: reliabilityFence(record.state),
        };
      }),
    ).toThrow("unsupported fields");
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
