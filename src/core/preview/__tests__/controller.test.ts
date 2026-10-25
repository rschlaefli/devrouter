import { describe, expect, it } from "vitest";
import { PreviewController } from "../controller";
import { type PreviewAdmission, PreviewEngine, type PreviewProvider } from "../engine";
import { type ForgeComment, type PreviewForge, PreviewForgeNotSent } from "../forge/status";
import { createPreviewPool, PreviewStateConflict, type PreviewStateStore } from "../state";
import type { PreviewPlanReport } from "../types";

function fixture() {
  let now = 1_700_000_000_000;
  const records = new Map<string, { value: unknown; version: number }>([
    ["installations/test/pool", { value: createPreviewPool("test"), version: 1 }],
  ]);
  const store: PreviewStateStore = {
    async read<T>(key: string, validate: (raw: unknown) => T) {
      const row = records.get(key);
      return row
        ? { value: validate(structuredClone(row.value)), version: String(row.version) }
        : null;
    },
    async compareAndSwap(key, expected, value) {
      const row = records.get(key);
      if (expected !== (row ? String(row.version) : null)) throw new PreviewStateConflict();
      records.set(key, { value: structuredClone(value), version: (row?.version ?? 0) + 1 });
      return String((row?.version ?? 0) + 1);
    },
  };
  const identity = { forgeHost: "github.com", projectId: "123", change: 9 };
  const comments: ForgeComment[] = [];
  const plan: PreviewPlanReport = {
    schemaVersion: 1,
    status: "planned",
    aliases: ["web"],
    resources: [{ id: "web", kind: "service", image: `example/app@sha256:${"a".repeat(64)}` }],
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
  let commandAfter = 0;
  let failFind = false,
    failBeforePost = false;
  let interleaved = false;
  let beforePlan: (() => Promise<void>) | undefined;
  let open = true,
    canWrite = true,
    failHistory = false,
    failPublish = false,
    posted: { id: string; body: string } | undefined;
  let creates = 0;
  const effects: string[] = [];
  const resources = new Set<string>();
  const provider: PreviewProvider = {
    async submit(effect) {
      effects.push(effect.kind);
      if (effect.kind === "deadline")
        return { phase: "terminal", resources: [], confirmedDeadline: effect.target };
      if (effect.kind === "deploy") {
        resources.add("web");
        return { phase: "terminal", resources: ["web"], ready: true };
      }
      if (effect.kind === "destroy") resources.clear();
      return { phase: "terminal", resources: [] };
    },
    async observe() {
      return { phase: "terminal", resources: [] };
    },
    async absent() {
      return resources.size === 0;
    },
  };
  const engine = new PreviewEngine({
    store,
    provider,
    now: () => now,
    workerId: "worker",
    policy: {
      installationId: "test",
      maxActive: 2,
      maxReservedCents: 1000,
      maxCommandAgeMs: 60_000,
      startupBudgetMs: 20 * 60_000,
      leaseMs: 30_000,
      allowedProjects: ["github.com/123"],
      allowedAliases: ["web"],
      manifestDigests: [plan.manifestDigest],
      localConfigDigests: [plan.localConfigDigest],
    },
  });
  const forge: PreviewForge = {
    async snapshot(_change, withSource = true) {
      return {
        identity,
        open,
        sameProject: true,
        commandAfter,
        source: { ...structuredClone(plan.source!), complete: withSource },
      };
    },
    async commands(_change, since, until) {
      if (failHistory) throw new Error("synthetic missing page");
      return comments.filter((comment) => comment.createdAt >= since && comment.createdAt <= until);
    },
    async admission(_change, id) {
      const comment = comments.find((row) => row.id === id)!;
      return {
        identity,
        commandId: id,
        createdAt: comment.createdAt,
        actorCanWrite: canWrite,
        originalHumanRoot: true,
        open,
        sameProject: true,
        command: comment.command,
      } satisfies Omit<PreviewAdmission, "plan" | "hourlyCents">;
    },
    async changes() {
      return open ? [9] : [];
    },
    async findStatus() {
      if (failFind) {
        failFind = false;
        throw new Error("synthetic status lookup failed");
      }
      return posted?.id ?? null;
    },
    async publish(_change, body, previousId) {
      if (failBeforePost) {
        failBeforePost = false;
        throw new PreviewForgeNotSent();
      }
      if (!previousId) creates++;
      posted = { id: previousId ?? "99", body };
      if (failPublish) {
        failPublish = false;
        throw new Error("synthetic lost comment response");
      }
      return posted.id;
    },
  };
  const controller = new PreviewController({
    installationId: "test",
    forgeHost: "github.com",
    projectId: "123",
    forge,
    store,
    engine,
    now: () => now,
    maxCommandAgeMs: 60_000,
    plan: async (source) => {
      if (beforePlan && !interleaved) {
        interleaved = true;
        await beforePlan();
      }
      return { ...plan, source };
    },
    hourlyCents: () => 1,
    urls: () => ({ "web:http": "https://preview.example.org" }),
  });
  const command = (command: ForgeComment["command"]) => {
    now += 1;
    comments.push({ id: String(comments.length + 1), createdAt: now, command });
  };
  const scan = async (count = 10) => {
    for (let i = 0; i < count; i++) {
      now += 16_000;
      await controller.scan(9);
    }
    return engine.status(identity);
  };
  return {
    controller,
    engine,
    identity,
    effects,
    comments,
    plan,
    command,
    scan,
    records,
    now: () => now,
    creates: () => creates,
    failFind: () => {
      failFind = true;
    },
    failBeforePost: () => {
      failBeforePost = true;
    },
    interleaveStop: () => {
      beforePlan = async () => {
        command({ kind: "stop" });
        await controller.scan(9);
      };
    },
    reopened: () => {
      commandAfter = now;
    },
    close: () => {
      open = false;
    },
    failHistory: () => {
      failHistory = true;
    },
    failPublish: () => {
      failPublish = true;
    },
    revoke: () => {
      canWrite = false;
    },
    push: () => {
      plan.source!.head = "f".repeat(40);
    },
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("durable preview command controller", () => {
  it("recovers a missed command and starts only the admitted revision once", async () => {
    const f = fixture();
    f.command({ kind: "start", aliases: ["web"] });
    expect((await f.scan())?.session.status).toBe("ready");
    expect(f.effects.filter((kind) => kind === "deploy")).toHaveLength(1);
    f.push();
    await f.scan(1);
    expect((await f.engine.status(f.identity))?.session.stale).toBe(true);
    expect(f.effects.filter((kind) => kind === "deploy")).toHaveLength(1);
    expect(f.creates()).toBe(1);
  });
  it("a later stop prevents an earlier unprocessed start from allocating anything", async () => {
    const f = fixture();
    f.command({ kind: "start", aliases: ["web"] });
    f.command({ kind: "stop" });
    await f.scan(1);
    expect(f.effects).toEqual([]);
  });
  it("recovers an uncertain status POST without creating a duplicate", async () => {
    const f = fixture();
    f.command({ kind: "status" });
    f.failPublish();
    await expect(f.scan(1)).rejects.toThrow();
    await f.scan(1);
    expect(f.creates()).toBe(1);
  });
  it("does not allocate from incomplete history and still cleans a closed active change", async () => {
    const f = fixture();
    f.command({ kind: "start", aliases: ["web"] });
    await f.scan();
    f.close();
    f.failHistory();
    await f.scan(10);
    expect(await f.engine.identities()).toEqual([]);
    expect(f.effects.filter((kind) => kind === "deploy")).toHaveLength(1);
    const missing = fixture();
    missing.command({ kind: "start", aliases: ["web"] });
    missing.failHistory();
    await expect(missing.scan(1)).rejects.toThrow();
    expect(missing.effects).toEqual([]);
  });
  it("does not revive closed or expired generations from old commands", async () => {
    const f = fixture();
    f.command({ kind: "start", aliases: ["web"] });
    await f.scan();
    f.tick(3 * 60 * 60_000);
    await f.scan(10);
    expect(await f.engine.identities()).toEqual([]);
    expect(f.effects.filter((kind) => kind === "deploy")).toHaveLength(1);
  });
  it("rechecks current authority and never deploys a revoked actor command", async () => {
    const f = fixture();
    f.command({ kind: "start", aliases: ["web"] });
    f.revoke();
    await f.scan(1);
    expect(f.effects).toEqual([]);
    expect(f.creates()).toBe(0);
  });
  it("claims a single status creation across concurrent recovery scans", async () => {
    const f = fixture();
    f.command({ kind: "status" });
    await Promise.all([f.controller.scan(9), f.controller.scan(9)]);
    expect(f.creates()).toBe(1);
  });
  it("does not replay a start after a close/reopen fence discovered by the forge", async () => {
    const f = fixture();
    f.command({ kind: "start", aliases: ["web"] });
    await f.scan();
    f.reopened();
    await f.scan(10);
    expect(await f.engine.identities()).toEqual([]);
    expect(f.effects.filter((kind) => kind === "deploy")).toHaveLength(1);
  });
  it("admits a post-reopen start after the old generation is absent", async () => {
    const f = fixture();
    f.command({ kind: "start", aliases: ["web"] });
    await f.scan();
    f.reopened();
    f.command({ kind: "start", aliases: ["web"] });
    // Admission must wait for whole-generation cleanup, preserving the fresh command.
    for (let i = 0; i < 12; i++) {
      try {
        await f.scan(1);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("cannot accept start"))
          throw error;
      }
    }
    expect((await f.engine.status(f.identity))?.session.status).toBe("ready");
    expect(f.effects.filter((kind) => kind === "deploy")).toHaveLength(2);
  });
  it("an interleaved later stop fences a first start that is still planning", async () => {
    const f = fixture();
    f.command({ kind: "start", aliases: ["web"] });
    f.interleaveStop();
    await f.scan(1);
    expect(f.effects).toEqual([]);
  });
  it("recovers status failures that are proven to precede a create request", async () => {
    for (const fail of ["failFind", "failBeforePost"] as const) {
      const f = fixture();
      f.command({ kind: "status" });
      f[fail]();
      await expect(f.scan(1)).rejects.toThrow();
      await f.scan(1);
      expect(f.creates()).toBe(1);
    }
  });
  it("continues expired cleanup when an open change's command history is unavailable", async () => {
    const f = fixture();
    f.command({ kind: "start", aliases: ["web"] });
    await f.scan();
    f.tick(3 * 60 * 60_000);
    f.failHistory();
    for (let i = 0; i < 5; i++) await expect(f.scan(1)).rejects.toThrow();
    expect(await f.engine.identities()).toEqual([]);
    expect(f.effects).toContain("destroy");
  });
  it("bounds authority lookups before retaining or acting on a command burst", async () => {
    const f = fixture();
    f.revoke();
    for (let i = 0; i < 1100; i++) f.command({ kind: "start", aliases: ["web"] });
    await expect(f.scan(1)).rejects.toThrow("lookup window exceeds");
    const inbox = [...f.records.entries()].find(([key]) => key.includes("/inbox/"))?.[1].value as {
      processed: unknown[];
    };
    expect(inbox.processed).toEqual([]);
    expect(f.effects).toEqual([]);
    expect(f.creates()).toBe(0);
  });
});
