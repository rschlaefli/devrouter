import { describe, expect, it } from "vitest";
import { controllerCapability } from "../controller-monitor";
import {
  claimRecoveryUnit,
  deriveRecoveryUnit,
  type RecoveryBudgetLimits,
  type RecoveryUnit,
  recoveryBudgetRefusal,
  recoverySelectors,
} from "../recovery-budget";
import { assertReliabilityState, type ReliabilityIncident } from "../reliability-contract";

const limits: RecoveryBudgetLimits = {
  maxProcessRestarts: 2,
  maxServiceRestarts: 1,
  windowSeconds: 600,
};

const webUnit: RecoveryUnit = { key: controllerCapability("app:web"), kind: "process" };
const blobUnit: RecoveryUnit = { key: controllerCapability("app:blob"), kind: "service" };

function incident(overrides: Partial<ReliabilityIncident> = {}): ReliabilityIncident {
  return { id: "incident", correctiveActionsTaken: 0, actionLimit: 3, ...overrides };
}

describe("recovery unit derivation", () => {
  it("splits declared selectors by the plan dimension that backs each app", () => {
    expect(
      recoverySelectors({
        apps: [
          { name: "web", upstreamHost: "ws-app" },
          { name: "blob", upstreamHost: "ws-azurite" },
          { name: "other", upstreamHost: "foreign-app" },
        ],
        aliasPrefix: "ws",
        services: ["azurite", "postgres"],
      }),
    ).toEqual({
      process: ["app:other", "app:web"],
      service: ["app:blob"],
    });
  });

  it("attributes a producing capability hash and ignores unattributable ones", () => {
    const selectors = { process: ["app:web"], service: ["app:blob"] };
    expect(
      deriveRecoveryUnit({
        capabilities: ["runtime", controllerCapability("app:web")],
        selectors,
        capabilityOf: controllerCapability,
      }),
    ).toEqual({ key: controllerCapability("app:web"), kind: "process" });
    expect(
      deriveRecoveryUnit({
        capabilities: ["runtime"],
        selectors,
        capabilityOf: controllerCapability,
      }),
    ).toBeUndefined();
  });

  it("claims exactly one deterministic unit when several capabilities fail together", () => {
    const selectors = { process: ["app:web", "app:pwa"], service: ["app:blob"] };
    const capabilities = ["app:web", "app:pwa", "app:blob"].map(controllerCapability);
    const first = deriveRecoveryUnit({
      capabilities,
      selectors,
      capabilityOf: controllerCapability,
    });
    const second = deriveRecoveryUnit({
      capabilities: [...capabilities].reverse(),
      selectors,
      capabilityOf: controllerCapability,
    });
    expect(first).toEqual(second);
    expect(first?.kind).toBe("service");
    expect(first?.key).toBe(
      [
        controllerCapability("app:blob"),
        controllerCapability("app:pwa"),
        controllerCapability("app:web"),
      ]
        .sort()
        .find((key) => key === first?.key),
    );
  });
});

describe("recovery budget claims", () => {
  it("claims the unit and the aggregate counter in one result", () => {
    const claim = claimRecoveryUnit({
      incident: incident(),
      limits,
      unit: webUnit,
      nowMs: 1_000,
      activeElapsedMs: null,
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.incident).toMatchObject({ startedAtMs: 1_000, correctiveActionsTaken: 1 });
    expect(claim.incident.units).toEqual([
      { key: webUnit.key, kind: "process", actions: 1, lastActionAtMs: 1_000 },
    ]);
  });

  it("refuses outside the window and allows the exact boundary", () => {
    const inside = claimRecoveryUnit({
      incident: incident({ startedAtMs: 0 }),
      limits,
      unit: webUnit,
      nowMs: 600_000,
      activeElapsedMs: null,
    });
    expect(inside.ok).toBe(true);
    const outside = claimRecoveryUnit({
      incident: incident({ startedAtMs: 0 }),
      limits,
      unit: webUnit,
      nowMs: 600_001,
      activeElapsedMs: null,
    });
    expect(outside).toEqual({ ok: false, reason: "window-closed" });
  });

  it("excludes capacity waiting from the window", () => {
    const claim = claimRecoveryUnit({
      incident: incident({ startedAtMs: 0, correctiveActionsTaken: 1 }),
      limits,
      unit: webUnit,
      nowMs: 900_000,
      activeElapsedMs: 300_000,
    });
    expect(claim.ok).toBe(true);
  });

  it("fails conservatively when the active duration is unobservable", () => {
    expect(
      recoveryBudgetRefusal({
        incident: incident({ startedAtMs: 0 }),
        limits,
        unit: webUnit,
        nowMs: 700_000,
        activeElapsedMs: null,
      }),
    ).toBe("window-closed");
    expect(
      recoveryBudgetRefusal({
        incident: incident({ startedAtMs: 0 }),
        limits,
        unit: webUnit,
        nowMs: 700_000,
        activeElapsedMs: 100_000,
      }),
    ).toBeUndefined();
  });

  it("bounds each kind separately", () => {
    const spentProcess = incident({
      units: [{ key: webUnit.key, kind: "process", actions: 2, lastActionAtMs: 1 }],
    });
    expect(
      recoveryBudgetRefusal({
        incident: spentProcess,
        limits,
        unit: webUnit,
        nowMs: 2,
        activeElapsedMs: null,
      }),
    ).toBe("unit-exhausted");

    const spentService = incident({
      units: [{ key: blobUnit.key, kind: "service", actions: 1, lastActionAtMs: 1 }],
    });
    expect(
      recoveryBudgetRefusal({
        incident: spentService,
        limits,
        unit: blobUnit,
        nowMs: 2,
        activeElapsedMs: null,
      }),
    ).toBe("unit-exhausted");
    // A spent service does not consume the process allowance of another unit.
    expect(
      recoveryBudgetRefusal({
        incident: spentService,
        limits,
        unit: webUnit,
        nowMs: 2,
        activeElapsedMs: null,
      }),
    ).toBeUndefined();
  });

  it("keeps the aggregate ceiling and charges unattributed actions against it", () => {
    const spent = incident({ correctiveActionsTaken: 3, actionLimit: 3 });
    expect(
      claimRecoveryUnit({
        incident: spent,
        limits,
        unit: undefined,
        nowMs: 2,
        activeElapsedMs: null,
      }),
    ).toEqual({ ok: false, reason: "budget-exhausted" });
    const claim = claimRecoveryUnit({
      incident: incident({ correctiveActionsTaken: 2 }),
      limits,
      unit: undefined,
      nowMs: 2,
      activeElapsedMs: null,
    });
    expect(claim.ok && claim.incident).toMatchObject({
      correctiveActionsTaken: 3,
      units: [],
    });
  });

  it("never refunds a claim and keeps one record per unit", () => {
    const first = claimRecoveryUnit({
      incident: incident(),
      limits,
      unit: webUnit,
      nowMs: 10,
      activeElapsedMs: null,
    });
    if (!first.ok) throw new Error("expected the first claim to be accepted");
    const second = claimRecoveryUnit({
      incident: first.incident,
      limits,
      unit: webUnit,
      nowMs: 20,
      activeElapsedMs: null,
    });
    if (!second.ok) throw new Error("expected the second claim to be accepted");
    expect(second.incident).toMatchObject({ correctiveActionsTaken: 2, startedAtMs: 10 });
    expect(second.incident.units).toEqual([
      { key: webUnit.key, kind: "process", actions: 2, lastActionAtMs: 20 },
    ]);
    expect(
      claimRecoveryUnit({
        incident: second.incident,
        limits,
        unit: webUnit,
        nowMs: 30,
        activeElapsedMs: null,
      }),
    ).toEqual({ ok: false, reason: "unit-exhausted" });
  });

  it("starts the window on the first later action of a record without a recorded start", () => {
    const claim = claimRecoveryUnit({
      incident: incident({ correctiveActionsTaken: 1 }),
      limits,
      unit: webUnit,
      nowMs: 5_000,
      activeElapsedMs: null,
    });
    expect(claim.ok && claim.incident).toMatchObject({
      startedAtMs: 5_000,
      correctiveActionsTaken: 2,
    });
  });

  it("leaves the incident untouched when the claim is refused", () => {
    const spent = incident({
      correctiveActionsTaken: 3,
      actionLimit: 3,
      startedAtMs: 7,
      units: [{ key: webUnit.key, kind: "process", actions: 2, lastActionAtMs: 9 }],
    });
    expect(
      claimRecoveryUnit({
        incident: spent,
        limits,
        unit: webUnit,
        nowMs: 10,
        activeElapsedMs: null,
      }),
    ).toEqual({ ok: false, reason: "unit-exhausted" });
    expect(spent).toEqual({
      id: "incident",
      correctiveActionsTaken: 3,
      actionLimit: 3,
      startedAtMs: 7,
      units: [{ key: webUnit.key, kind: "process", actions: 2, lastActionAtMs: 9 }],
    });
  });

  it("produces incident records the reliability contract accepts", () => {
    const claim = claimRecoveryUnit({
      incident: incident(),
      limits,
      unit: blobUnit,
      nowMs: 1,
      activeElapsedMs: null,
    });
    if (!claim.ok) throw new Error("expected the claim to be accepted");
    expect(() =>
      assertReliabilityState({
        contractVersion: 2,
        executionPolicy: "capacity-managed",
        operationHistory: [],
        environmentId: "env",
        controllerEpoch: 1,
        intentRevision: 0,
        runtimeGeneration: 0,
        observationsAfterMs: 0,
        desired: "running",
        phase: "recovering",
        profile: "full",
        admission: "unknown",
        chargeHeld: false,
        stopProof: { workloadsStopped: false, routesRemoved: false },
        consumers: [],
        requests: [],
        observations: [],
        operation: null,
        incident: claim.incident,
      }),
    ).not.toThrow();
  });
});
