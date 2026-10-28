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

function fixture(images?: import("../images").PreviewImageBackend) {
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
  const engine = new PreviewEngine({
    store,
    policy,
    provider,
    images,
    workerId: "one",
    now: () => now,
  });
  const admit = (commandId = "start", previewIdentity = identity, selectedPlan = plan) =>
    engine.admit({
      identity: previewIdentity,
      commandId,
      createdAt: now,
      actorCanWrite: true,
      originalHumanRoot: true,
      open: true,
      sameProject: true,
      command: { kind: "start", aliases: ["chat"] },
      plan: selectedPlan,
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

  it("stores the actual confirmed first-ready expiry after provider rounding", async () => {
    const f = fixture();
    const original = f.provider.submit;
    f.provider.submit = async (effect, entry, gate) => {
      if (effect.kind === "deadline")
        return { phase: "terminal", resources: [], confirmedDeadline: effect.target! - 74_000 };
      return original(effect, entry, gate);
    };
    await f.admit();
    for (let step = 0; step < 4; step += 1) await f.engine.reconcile(identity);
    const ready = await f.engine.status(identity);
    expect(ready?.session.status).toBe("ready");
    expect(ready?.session.expiresAt).toBe(ready!.session.firstReadyAt! + 7_200_000 - 74_000);
    const sequence = Object.values(f.snapshot().sessions)[0].effectSequence;
    await f.engine.reconcile(identity);
    expect(Object.values(f.snapshot().sessions)[0].effectSequence).toBe(sequence);
    expect((await f.engine.status(identity))?.session.status).toBe("ready");
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
    f.provider.submit = async (effect, entry, gate) => {
      if (effect.kind === "deploy" && lost) {
        lost = false;
        f.calls.push("deploy");
        f.effects.set(effect.id, { phase: "terminal", resources: ["owned-web"], ready: true });
        throw new Error("transport-lost");
      }
      return original(effect, entry, gate);
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
    f.provider.submit = async (effect, entry, gate) => {
      if (effect.kind === "deadline") {
        f.effects.set(effect.id, { phase: "pending", resources: [] });
        return { phase: "pending", resources: [] };
      }
      if (effect.kind === "cancel") {
        for (const id of f.effects.keys())
          f.effects.set(id, { phase: "terminal", resources: [], outcome: "cancelled" });
      }
      return original(effect, entry, gate);
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
    f.provider.submit = async (effect, entry, gate) => {
      if (effect.kind === "destroy") {
        attempts.push(effect.id);
        if (attempts.length === 1) return { phase: "terminal", resources: [], outcome: "failed" };
      }
      return original(effect, entry, gate);
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
    f.provider.submit = async (effect, entry, gate) => {
      if (effect.kind === "deploy") {
        const ids = Array.from({ length: 40 }, (_, index) => `owned-${batch}-${index}`);
        batch += 1;
        for (const id of ids) f.resources.add(id);
        return { phase: "terminal", resources: ids, ready: true };
      }
      if (effect.kind === "destroy" && entry.ownershipOverflow) f.resources.clear();
      return original(effect, entry, gate);
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

  it("fences the next provider write when a stop arrives between stages", async () => {
    const f = fixture();
    const original = f.provider.submit;
    const writes: string[] = [];
    f.provider.submit = async (effect, entry, gate) => {
      if (effect.kind !== "deploy") return original(effect, entry, gate);
      expect(await gate.begin("create", "once")).toBe("write");
      writes.push("create");
      await gate.record("create", "accepted", "owned-container");
      await f.engine.close(identity);
      expect(await gate.begin("start-compute", "once")).toBe("fenced");
      return { phase: "terminal", resources: ["owned-container"], outcome: "cancelled" };
    };
    await f.admit();
    await f.engine.reconcile(identity);
    await f.engine.reconcile(identity);
    expect(writes).toEqual(["create"]);
    expect((await f.engine.status(identity))?.session.status).toBe("stopping");
  });

  it("preserves a once-only intent across a lost response and lease handover", async () => {
    const f = fixture();
    const original = f.provider.submit;
    f.provider.submit = async (effect, entry, gate) => {
      if (effect.kind !== "deploy") return original(effect, entry, gate);
      expect(await gate.begin("create", "once")).toBe("write");
      f.time(f.policy.leaseMs + 1);
      await expect(gate.record("create", "accepted", "owned-container")).rejects.toThrow("lease");
      throw new Error("lost-response");
    };
    f.provider.observe = async (_effect, _entry, gate) => {
      expect(await gate.begin("create", "once")).toBe("resolve");
      expect((await gate.read())[0].state).toBe("intent");
      await gate.record("create", "accepted", "owned-container");
      return { phase: "terminal", resources: ["owned-container"], ready: true };
    };
    await f.admit();
    await f.engine.reconcile(identity);
    await expect(f.engine.reconcile(identity)).rejects.toThrow("lost-response");
    const second = new PreviewEngine({
      store: f.store,
      provider: f.provider,
      policy: f.policy,
      workerId: "replacement",
      now: f.now,
    });
    await second.reconcile(identity);
    expect((await second.status(identity))?.session.ownedResources).toContain("owned-container");
  });

  it("keeps deadline writes independent when a new source is admitted during setup", async () => {
    const f = fixture();
    const original = f.provider.submit;
    let refreshed = false;
    f.provider.submit = async (effect, entry, gate) => {
      if (effect.kind === "deadline" && !refreshed) {
        refreshed = true;
        const changed = structuredClone(plan);
        changed.source!.head = "f".repeat(40);
        await f.engine.admit({
          identity,
          commandId: "refresh-during-deadline",
          createdAt: f.now(),
          actorCanWrite: true,
          originalHumanRoot: true,
          open: true,
          sameProject: true,
          command: { kind: "start", aliases: ["chat"] },
          plan: changed,
          hourlyCents: 10,
        });
        expect(await gate.begin("arm", "once")).toBe("write");
        await gate.record("arm", "accepted", "native-deadline");
      }
      return original(effect, entry, gate);
    };
    await f.admit();
    for (let step = 0; step < 5; step += 1) await f.engine.reconcile(identity);
    const ready = await f.engine.status(identity);
    expect(ready?.session.status).toBe("ready");
    expect(ready?.session.desiredRevision).toBe("f".repeat(40));
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

describe("CI image waiting", () => {
  const selected: PreviewPlanReport = {
    ...plan,
    resources: [{ id: "web", kind: "service", imageTarget: "web" }],
  };
  const ready = (entry: PreviewPoolEntry) => ({
    phase: "ready" as const,
    plan: {
      ...entry.plan,
      resources: entry.plan.resources.map(({ imageTarget: _target, ...resource }) => ({
        ...resource,
        image: `registry.example/app@sha256:${"1".repeat(64)}`,
      })),
    },
  });
  it("allocates nothing while images wait and starts native setup once on admission", async () => {
    let available = false;
    const f = fixture({
      prepare: async (entry) => (available ? ready(entry) : { phase: "pending" }),
    });
    await f.admit("images", identity, selected);
    await f.engine.reconcile(identity);
    f.time(25 * 60_000);
    await f.engine.reconcile(identity);
    expect(f.calls).toEqual([]);
    expect((await f.engine.status(identity))?.session.status).toBe("waiting-images");
    available = true;
    await f.engine.reconcile(identity);
    const entry = await f.engine.status(identity);
    expect(entry?.session.provisioningStartedAt).toBe(f.now());
    expect(entry?.session.setupDeadline).toBe(f.now() + 20 * 60_000);
    expect(entry?.imageReadyAt).toBe(f.now());
    await f.engine.reconcile(identity);
    expect(f.calls).toEqual(["deadline"]);
  });
  it("stop fences a late image result without allocating provider resources", async () => {
    let release: (value: ReturnType<typeof ready>) => void = () => {};
    const f = fixture({
      prepare: (entry) =>
        new Promise((resolve) => {
          release = () => resolve(ready(entry));
        }),
    });
    await f.admit("images", identity, selected);
    const pending = f.engine.reconcile(identity);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.engine.admit({
      identity,
      commandId: "stop",
      createdAt: f.now(),
      actorCanWrite: true,
      originalHumanRoot: true,
      open: true,
      sameProject: true,
      command: { kind: "stop" },
    });
    release({} as ReturnType<typeof ready>);
    await pending;
    await f.engine.reconcile(identity);
    expect(f.calls).toEqual([]);
    expect((await f.engine.status(identity))?.session.status).toBe("stopped");
  });
  it("expires an image wait without extending into native provisioning", async () => {
    const f = fixture({ prepare: async () => ({ phase: "pending" }) });
    await f.admit("images", identity, selected);
    f.time(45 * 60_000);
    await f.engine.reconcile(identity);
    expect(f.calls).toEqual([]);
    expect((await f.engine.status(identity))?.session.status).toBe("stopped");
  });
  it("does not restart a native setup clock on another explicit start", async () => {
    const f = fixture({ prepare: async (entry) => ready(entry) });
    await f.admit("images", identity, selected);
    await f.engine.reconcile(identity);
    const before = (await f.engine.status(identity))!.session;
    f.time(60_000);
    await f.admit("again", identity, selected);
    await f.engine.reconcile(identity);
    const after = (await f.engine.status(identity))!.session;
    expect(after.provisioningStartedAt).toBe(before.provisioningStartedAt);
    expect(after.setupDeadline).toBe(before.setupDeadline);
    expect(after.expiresAt).toBe(before.expiresAt);
  });
  it("discards an abandoned image deadline when switching to a pinned plan", async () => {
    const f = fixture({ prepare: async () => ({ phase: "pending" }) });
    await f.admit("images", identity, selected);
    await f.engine.reconcile(identity);
    f.time(60_000);
    await f.admit("pinned", identity, plan);
    expect((await f.engine.status(identity))?.imageDeadline).toBeUndefined();
    for (let step = 0; step < 4; step++) await f.engine.reconcile(identity);
    f.time(45 * 60_000);
    await f.engine.reconcile(identity);
    expect((await f.engine.status(identity))?.session.status).toBe("ready");
  });
  it("keeps an initial image wait across an explicit newer revision", async () => {
    const f = fixture({ prepare: async (entry) => ready(entry) });
    await f.admit("images", identity, selected);
    f.time(25 * 60_000);
    await f.admit("newer", identity, {
      ...selected,
      source: { ...selected.source!, head: "9".repeat(40) },
    });
    await f.engine.reconcile(identity);
    expect((await f.engine.status(identity))?.session.provisioningStartedAt).toBe(f.now());
    expect(f.calls).toEqual([]);
  });
  it("starts the native clock for a newer non-CI source after an initial wait", async () => {
    const f = fixture({ prepare: async () => ({ phase: "pending" }) });
    await f.admit("images", identity, selected);
    f.time(25 * 60_000);
    await f.admit("pinned", identity, {
      ...plan,
      source: { ...plan.source!, head: "9".repeat(40) },
    });
    expect((await f.engine.status(identity))?.session.provisioningStartedAt).toBe(f.now());
    await f.engine.reconcile(identity);
    expect(f.calls).toEqual(["deadline"]);
  });
  it.each([
    false,
    true,
  ])("preserves legacy clocks when an existing session selects CI images (ready=%s)", async (alreadyReady) => {
    const f = fixture({ prepare: async (entry) => ready(entry) });
    await f.admit();
    if (alreadyReady) for (let step = 0; step < 4; step++) await f.engine.reconcile(identity);
    const before = (await f.engine.status(identity))!.session;
    delete f.snapshot().sessions[previewIdentityKey(identity)].session.provisioningStartedAt;
    f.time(60_000);
    await f.admit("update", identity, {
      ...selected,
      source: { ...selected.source!, head: alreadyReady ? "9".repeat(40) : plan.source!.head },
    });
    for (let step = 0; step < 2; step++) await f.engine.reconcile(identity);
    const after = (await f.engine.status(identity))!.session;
    expect(after.provisioningStartedAt).toBe(before.createdAt);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.status).not.toBe("waiting-images");
  });
});
