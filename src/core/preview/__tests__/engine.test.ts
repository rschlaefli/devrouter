import { describe, expect, it } from "vitest";
import {
  type PreviewEffectReceipt,
  PreviewEngine,
  type PreviewProvider,
  previewIdentityKey,
} from "../engine";
import {
  createPreviewPool,
  decodePreviewPool,
  type PreviewEffect,
  type PreviewPoolEntry,
  PreviewStateConflict,
  type PreviewStateStore,
} from "../state";
import type { PreviewPlanReport } from "../types";

const identity = { forgeHost: "github.com", projectId: "123", change: 7 };
const plan: PreviewPlanReport = {
  schemaVersion: 1,
  status: "planned",
  aliases: ["chat"],
  resources: [{ id: "web", kind: "service", image: "example/app:1" }],
  reasons: [],
  omissions: [],
  manifestDigest: "d".repeat(64),
  localConfigDigest: "e".repeat(64),
  source: {
    head: "a".repeat(40),
    target: "b".repeat(40),
    mergeBase: "c".repeat(40),
    complete: true,
    changes: [{ status: "M", path: "src/app.ts" }],
  },
};

function fixture() {
  let now = 1_700_000_000_000;
  let version = 1;
  let pool = createPreviewPool("test");
  const store: PreviewStateStore = {
    async read<T>(_key: string, validate: (value: unknown) => T) {
      return { version: String(version), value: validate(structuredClone(pool)) };
    },
    async compareAndSwap(_key, expected, value) {
      if (expected !== String(version)) throw new PreviewStateConflict();
      pool = decodePreviewPool(value);
      version += 1;
      return String(version);
    },
  };
  const calls: string[] = [];
  const effects = new Map<string, PreviewEffectReceipt>();
  const resources = new Set<string>();
  let delayDeploy = false;
  const provider: PreviewProvider = {
    async submit(effect: PreviewEffect, _entry: PreviewPoolEntry) {
      calls.push(effect.kind);
      if (effect.kind === "deadline")
        return { phase: "terminal", resources: [], confirmedDeadline: effect.target };
      if (effect.kind === "deploy") {
        if (delayDeploy) {
          const receipt: PreviewEffectReceipt = { phase: "pending", resources: [] };
          effects.set(effect.id, receipt);
          return receipt;
        }
        resources.add("owned-web");
        return { phase: "terminal", resources: ["owned-web"], ready: true };
      }
      if (effect.kind === "destroy")
        for (const resource of effect.resources) resources.delete(resource);
      return { phase: "terminal", resources: [] };
    },
    async observe(effect) {
      return effects.get(effect.id) ?? { phase: "terminal", resources: [] };
    },
    async absent() {
      return resources.size === 0;
    },
  };
  const policy = {
    installationId: "test",
    maxActive: 2,
    maxReservedCents: 1000,
    maxCommandAgeMs: 60_000,
    startupBudgetMs: 20 * 60_000,
    leaseMs: 30_000,
    allowedProjects: ["github.com/123"],
    allowedAliases: ["chat"],
    manifestDigests: [plan.manifestDigest],
    localConfigDigests: [plan.localConfigDigest],
  };
  const engine = new PreviewEngine({ store, policy, provider, workerId: "one", now: () => now });
  const admit = (commandId = "start", previewIdentity = identity) =>
    engine.admit({
      identity: previewIdentity,
      commandId,
      createdAt: now,
      actorCanWrite: true,
      originalHumanRoot: true,
      open: true,
      sameProject: true,
      command: { kind: "start", aliases: ["chat"] },
      plan,
      hourlyCents: 10,
    });
  return {
    engine,
    store,
    provider,
    calls,
    effects,
    resources,
    admit,
    time: (delta: number) => {
      now += delta;
    },
    delay: () => {
      delayDeploy = true;
    },
    now: () => now,
    snapshot: () => pool,
    policy,
  };
}

describe("durable preview reconciliation", () => {
  it("arms the deadline before deployment and tightens it before first readiness", async () => {
    const f = fixture();
    const admitted = await f.admit();
    expect(admitted?.session.status).toBe("provisioning");
    await f.engine.reconcile(identity);
    expect(f.calls).toEqual(["deadline"]);
    await f.engine.reconcile(identity);
    expect(f.calls).toEqual(["deadline", "deploy"]);
    f.time(60_000);
    await f.engine.reconcile(identity);
    await f.engine.reconcile(identity);
    const ready = await f.engine.status(identity);
    expect(ready?.session.status).toBe("ready");
    expect(ready?.session.expiresAt).toBe(f.now() + 2 * 60 * 60_000);
    await f.admit();
    expect((await f.engine.status(identity))?.session.generation).toBe(
      admitted?.session.generation,
    );
    expect(f.calls.filter((kind) => kind === "deploy")).toHaveLength(1);
  });

  it("retains a stopped preview until a pending create settles and its late resources disappear", async () => {
    const f = fixture();
    f.delay();
    await f.admit();
    await f.engine.reconcile(identity);
    await f.engine.reconcile(identity);
    await f.engine.close(identity);
    await f.engine.reconcile(identity);
    expect(f.calls).toContain("cancel");
    await f.engine.reconcile(identity);
    expect((await f.engine.status(identity))?.session.reservationHeld).toBe(true);
    const operation = Object.values(Object.values(f.snapshot().sessions)[0].operations).find(
      (effect) => effect.kind === "deploy",
    );
    expect(operation).toBeDefined();
    f.resources.add("late-db");
    f.effects.set(operation!.id, { phase: "terminal", resources: ["late-db"] });
    await f.engine.reconcile(identity);
    expect((await f.engine.status(identity))?.session.ownedResources).toContain("late-db");
    await f.engine.reconcile(identity);
    await f.engine.reconcile(identity);
    expect(f.resources.size).toBe(0);
    expect((await f.engine.status(identity))?.session.reservationHeld).toBe(false);
  });

  it("reconciles a lost provider response without dispatching a second create", async () => {
    const f = fixture();
    const original = f.provider.submit;
    let lost = true;
    f.provider.submit = async (effect, entry) => {
      if (effect.kind === "deploy" && lost) {
        lost = false;
        f.calls.push("deploy");
        f.effects.set(effect.id, { phase: "terminal", resources: ["owned-web"], ready: true });
        throw new Error("transport-lost");
      }
      return original(effect, entry);
    };
    await f.admit();
    await f.engine.reconcile(identity);
    await expect(f.engine.reconcile(identity)).rejects.toThrow();
    await f.engine.reconcile(identity);
    expect(f.calls.filter((kind) => kind === "deploy")).toHaveLength(1);
    expect((await f.engine.status(identity))?.session.ownedResources).toContain("owned-web");
  });

  it("admits within pool limits atomically when two controllers race", async () => {
    const f = fixture();
    f.policy.maxActive = 1;
    const second = new PreviewEngine({
      store: f.store,
      policy: f.policy,
      provider: f.provider,
      workerId: "two",
      now: f.now,
    });
    const result = await Promise.allSettled([
      f.admit("first"),
      second.admit({
        identity: { ...identity, change: 8 },
        commandId: "second",
        createdAt: f.now(),
        actorCanWrite: true,
        originalHumanRoot: true,
        open: true,
        sameProject: true,
        command: { kind: "start", aliases: ["chat"] },
        plan,
        hourlyCents: 10,
      }),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(Object.values(f.snapshot().sessions)).toHaveLength(1);
    const corrupt = structuredClone(f.snapshot());
    Object.values(corrupt.sessions)[0].session.ownershipVersion = 0;
    expect(() => decodePreviewPool(corrupt)).toThrow();
  });

  it("confirms an extension while an explicit refresh remains pending", async () => {
    const f = fixture();
    await f.admit();
    await f.engine.reconcile(identity);
    await f.engine.reconcile(identity);
    f.time(60_000);
    await f.engine.reconcile(identity);
    await f.engine.reconcile(identity);
    const before = await f.engine.status(identity);
    f.delay();
    const changed = structuredClone(plan);
    changed.source!.head = "f".repeat(40);
    await f.engine.admit({
      identity,
      commandId: "update",
      createdAt: f.now(),
      actorCanWrite: true,
      originalHumanRoot: true,
      open: true,
      sameProject: true,
      command: { kind: "start", aliases: ["chat"] },
      plan: changed,
      hourlyCents: 10,
    });
    await f.engine.reconcile(identity);
    await f.engine.admit({
      identity,
      commandId: "extend",
      createdAt: f.now(),
      actorCanWrite: true,
      originalHumanRoot: true,
      open: true,
      sameProject: true,
      command: { kind: "extend" },
    });
    await f.engine.reconcile(identity);
    const extended = await f.engine.status(identity);
    expect(extended?.session.expiresAt).toBe(before!.session.expiresAt + 3_600_000);
    expect(extended?.session.status).toBe("updating");
    expect(extended?.session.outstandingOperations.length).toBeGreaterThan(0);
  });

  it("cleans up when stop cancels a pending deadline without confirmation", async () => {
    const f = fixture();
    const original = f.provider.submit;
    f.provider.submit = async (effect, entry) => {
      if (effect.kind === "deadline") {
        f.effects.set(effect.id, { phase: "pending", resources: [] });
        return { phase: "pending", resources: [] };
      }
      if (effect.kind === "cancel") {
        for (const id of f.effects.keys())
          f.effects.set(id, { phase: "terminal", resources: [], outcome: "cancelled" });
      }
      return original(effect, entry);
    };
    await f.admit();
    await f.engine.reconcile(identity);
    await f.engine.close(identity);
    for (let step = 0; step < 3; step += 1) await f.engine.reconcile(identity);
    const stopped = await f.engine.status(identity);
    expect(stopped?.session.reservationHeld).toBe(false);
    expect(stopped?.session.status).toBe("stopped");
    expect(f.calls).not.toContain("deploy");
  });

  it("purges verified terminal generations and receipts after the recovery window", async () => {
    const f = fixture();
    for (let change = 1; change <= 130; change += 1) {
      const previewIdentity = { ...identity, change };
      await f.admit(`start-${change}`, previewIdentity);
      await f.engine.close(previewIdentity);
      await f.engine.reconcile(previewIdentity);
      expect((await f.engine.status(previewIdentity))?.session.reservationHeld).toBe(false);
      f.time(f.policy.maxCommandAgeMs + 1);
    }
    expect(Object.values(f.snapshot().sessions)).toHaveLength(1);
    expect(f.snapshot().processedCommands).toHaveLength(1);
    expect(await f.engine.status({ ...identity, change: 1 })).toBeNull();
    await expect(
      f.engine.admit({
        identity,
        commandId: "start-1",
        createdAt: f.now() - f.policy.maxCommandAgeMs - 1,
        actorCanWrite: true,
        originalHumanRoot: true,
        open: true,
        sameProject: true,
        command: { kind: "start", aliases: ["chat"] },
        plan,
        hourlyCents: 10,
      }),
    ).rejects.toThrow("not eligible");
  });

  it("uses a new destroy attempt after a terminal failure", async () => {
    const f = fixture();
    await f.admit();
    for (let step = 0; step < 4; step += 1) await f.engine.reconcile(identity);
    const original = f.provider.submit;
    const attempts: string[] = [];
    f.provider.submit = async (effect, entry) => {
      if (effect.kind === "destroy") {
        attempts.push(effect.id);
        if (attempts.length === 1) return { phase: "terminal", resources: [], outcome: "failed" };
      }
      return original(effect, entry);
    };
    await f.engine.close(identity);
    for (let step = 0; step < 4; step += 1) await f.engine.reconcile(identity);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(2);
    expect((await f.engine.status(identity))?.session.reservationHeld).toBe(false);
  });

  it("rejects contradictory successful deadline receipts before deployment", async () => {
    const f = fixture();
    f.provider.submit = async () => ({ phase: "terminal", resources: [], outcome: "succeeded" });
    await f.admit();
    await f.engine.reconcile(identity);
    const stopped = await f.engine.status(identity);
    expect(stopped?.session.status).toBe("stopping");
    expect(f.calls).not.toContain("deploy");
  });

  it("retains overflow as a cleanup state and destroys the complete generation", async () => {
    const f = fixture();
    const original = f.provider.submit;
    let batch = 0;
    f.provider.submit = async (effect, entry) => {
      if (effect.kind === "deploy") {
        const ids = Array.from({ length: 40 }, (_, index) => `owned-${batch}-${index}`);
        batch += 1;
        for (const id of ids) f.resources.add(id);
        return { phase: "terminal", resources: ids, ready: true };
      }
      if (effect.kind === "destroy" && entry.ownershipOverflow) f.resources.clear();
      return original(effect, entry);
    };
    await f.admit();
    for (let step = 0; step < 4; step += 1) await f.engine.reconcile(identity);
    const changed = structuredClone(plan);
    changed.source!.head = "f".repeat(40);
    await f.engine.admit({
      identity,
      commandId: "refresh",
      createdAt: f.now(),
      actorCanWrite: true,
      originalHumanRoot: true,
      open: true,
      sameProject: true,
      command: { kind: "start", aliases: ["chat"] },
      plan: changed,
      hourlyCents: 10,
    });
    await f.engine.reconcile(identity);
    expect((await f.engine.status(identity))?.ownershipOverflow).toBe(true);
    expect((await f.engine.status(identity))?.session.status).toBe("stopping");
    for (let step = 0; step < 3; step += 1) await f.engine.reconcile(identity);
    expect(f.resources.size).toBe(0);
    expect((await f.engine.status(identity))?.session.reservationHeld).toBe(false);
  });

  it("keeps immutable identity stable across object ordering and rejects corrupted stored policy state", async () => {
    expect(previewIdentityKey(identity)).toBe(
      previewIdentityKey({
        change: identity.change,
        projectId: identity.projectId,
        forgeHost: identity.forgeHost,
      }),
    );
    const f = fixture();
    await f.admit();
    for (const corrupt of [
      (entry: PreviewPoolEntry) => {
        entry.reservedCents = -1;
      },
      (entry: PreviewPoolEntry) => {
        entry.session.setupDeadline += 1;
      },
      (entry: PreviewPoolEntry) => {
        entry.session.outstandingOperations = ["missing"];
      },
      (entry: PreviewPoolEntry) => {
        entry.plan.resources[0].id = "__proto__";
      },
      (entry: PreviewPoolEntry) => {
        Object.assign(entry.session, { secret: "forbidden" });
      },
    ]) {
      const pool = structuredClone(f.snapshot());
      corrupt(Object.values(pool.sessions)[0]);
      expect(() => decodePreviewPool(pool)).toThrow();
    }
  });

  it("refuses untrusted or incomplete plans before any provider request", async () => {
    const f = fixture();
    await expect(
      f.engine.admit({
        identity,
        commandId: "bad",
        createdAt: f.now(),
        actorCanWrite: false,
        originalHumanRoot: true,
        open: true,
        sameProject: true,
        command: { kind: "start", aliases: ["chat"] },
        plan,
        hourlyCents: 10,
      }),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(Object.values(f.snapshot().sessions)).toHaveLength(0);
    expect(
      () =>
        new PreviewEngine({
          store: f.store,
          provider: f.provider,
          policy: { ...f.policy, maxActive: 5 },
          workerId: "over-bound",
          now: f.now,
        }),
    ).toThrow("at most four");
  });
});
