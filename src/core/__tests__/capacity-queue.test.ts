import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapacityDomainBudget, CapacityDomainSample } from "../capacity-accounting";
import { CapacityQueue } from "../capacity-queue";
import type { CapacityAdmissionContext } from "../capacity-request";
import type { CapacityReservation } from "../capacity-store";
import type { LifecycleWorkerRequest } from "../reliability-worker";

const fixture = vi.hoisted(() => ({
  admitLifecycleCapacity: vi.fn(),
  collect: vi.fn(),
  retireQueuedLifecycle: vi.fn(),
  runLifecycleWorker: vi.fn(),
  readCapacityPolicy: vi.fn(),
  renewLifecycleCapacity: vi.fn(),
}));

vi.mock("../capacity-policy", () => ({ readCapacityPolicy: fixture.readCapacityPolicy }));

vi.mock("../reliability-lifecycle", () => ({
  admitLifecycleCapacity: fixture.admitLifecycleCapacity,
  retireQueuedLifecycle: fixture.retireQueuedLifecycle,
  renewLifecycleCapacity: fixture.renewLifecycleCapacity,
}));

vi.mock("../reliability-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reliability-worker")>()),
  runLifecycleWorker: fixture.runLifecycleWorker,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

function request(
  operationId: string,
  environmentId = `environment-${operationId}`,
  command = ["devrouter", "ensure"],
): LifecycleWorkerRequest {
  const repoPath = `/tmp/capacity-queue-${operationId}`;
  return {
    kind: "ensure",
    repoPath,
    identity: { repoPath, workspace: null, provider: "devsy" },
    requestId: `request-${operationId}`,
    operationId,
    workerId: `worker-${operationId}`,
    fence: {
      environmentId,
      intentRevision: 1,
      runtimeGeneration: 1,
      controllerEpoch: 1,
    },
    options: {},
    command,
  };
}

function reservation(
  operationId: string,
  environmentId: string,
  domains: string[],
): CapacityReservation {
  return {
    environmentId,
    operationId,
    reservationId: `reservation-${operationId}`,
    policyRevision: 1,
    totals: Object.fromEntries(domains.map((domain) => [domain, 100])),
    startup: false,
    heavy: false,
  };
}

const budgets: Record<string, CapacityDomainBudget> = {
  "domain-a": {
    capacityBytes: 1_000,
    protectedHeadroomBytes: 100,
    startupSlots: 2,
    heavySlots: 2,
  },
  "domain-b": {
    capacityBytes: 1_000,
    protectedHeadroomBytes: 100,
    startupSlots: 2,
    heavySlots: 2,
  },
};

const samples: Record<string, CapacityDomainSample> = {
  "domain-a": {
    sampledAtMs: 1,
    pressure: "normal",
    unmanagedBytes: 0,
    sharedBytes: 0,
    ownedBytes: {},
  },
  "domain-b": {
    sampledAtMs: 1,
    pressure: "normal",
    unmanagedBytes: 0,
    sharedBytes: 0,
    ownedBytes: {},
  },
};

type QueueScheduling = {
  maxQueuedTotal: number;
  maxQueuedPerDomain: number;
  queueLifetimeSeconds: number;
};

function queue(
  scheduling?: QueueScheduling,
  controller?: { store: string; epoch: number },
): CapacityQueue {
  fixture.readCapacityPolicy.mockReturnValue({
    revision: 1,
    admissions: "enabled",
    domains: budgets,
    scheduling: {
      maxSampleAgeSeconds: 15,
      maxQueuedTotal: 64,
      maxQueuedPerDomain: 32,
      queueLifetimeSeconds: 900,
      ...scheduling,
    },
  });
  return new CapacityQueue({
    directory: "/tmp/capacity-queue-test",
    policyRevision: 1,
    collect: fixture.collect,
    controller,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  fixture.admitLifecycleCapacity.mockReset();
  fixture.collect.mockReset();
  fixture.retireQueuedLifecycle.mockReset();
  fixture.runLifecycleWorker.mockReset();
  fixture.renewLifecycleCapacity.mockReset();
});

describe("CapacityQueue", () => {
  it("retains reviewed admission metadata independently of caller mutation", async () => {
    const queued = queue();
    const prepared = request("metadata");
    const charge = reservation("metadata", prepared.fence.environmentId, ["domain-a"]);
    const context: CapacityAdmissionContext = {
      estimates: { version: 1, profiles: {} },
      enrollment: {
        repoPath: prepared.repoPath,
        gitCommonDir: `${prepared.repoPath}/.git`,
        workspace: "",
        provider: "devsy",
        providerId: "synthetic",
        hostDomain: "domain-a",
        runtimeDomain: "domain-b",
        profiles: ["full"],
        estimatesDigest: "a".repeat(64),
        defaultOperation: { hostIncrementBytes: 1, runtimeIncrementBytes: 1 },
      },
    };
    const original = structuredClone(context);
    queued.enqueue(prepared, charge, context);
    context.enrollment.estimatesDigest = "b".repeat(64);
    expect(() => queued.enqueue(prepared, charge, context)).toThrow("another accepted request");
    expect(queued.enqueue(prepared, charge, original)).toBe(prepared.operationId);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: false, reason: "capacity" });
    fixture.collect.mockResolvedValue(samples);
    await queued.tick();
    expect(fixture.admitLifecycleCapacity.mock.calls[0]?.[8]).toEqual(original);
    queued.close();
  });
  it("renews running operations without queued work and never relaunches them", async () => {
    const controller = { store: "controller-store", epoch: 1 };
    const queued = queue(undefined, controller);
    const worker = deferred<{ ok: true }>();
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockReturnValue(worker.promise);
    fixture.renewLifecycleCapacity.mockReturnValue(true);
    queued.enqueue(request("running"), reservation("running", "environment-running", ["domain-a"]));
    await queued.tick();
    expect(fixture.admitLifecycleCapacity.mock.calls[0]?.[7]).toEqual(controller);
    await queued.tick();
    expect(fixture.renewLifecycleCapacity).toHaveBeenCalledOnce();
    expect(queued.observe("running")).toMatchObject({ phase: "running", reason: null });
    fixture.renewLifecycleCapacity.mockReturnValue(false);
    await queued.tick();
    expect(queued.observe("running")).toMatchObject({
      phase: "running",
      reason: "authority-unavailable",
    });
    expect(fixture.runLifecycleWorker).toHaveBeenCalledOnce();
    expect(fixture.retireQueuedLifecycle).not.toHaveBeenCalled();
    worker.resolve({ ok: true });
    await queued.wait("running", 1000);
  });

  it("uses operator domain budgets and sample age for admission", async () => {
    const queued = queue();
    const operatorBudgets = { "domain-a": { ...budgets["domain-a"], capacityBytes: 500 } };
    fixture.readCapacityPolicy.mockReturnValue({
      revision: 1,
      admissions: "enabled",
      domains: operatorBudgets,
      scheduling: { maxSampleAgeSeconds: 7 },
    });
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({
      admitted: false,
      domain: "domain-a",
      reason: "memory",
    });
    queued.enqueue(request("pending"), reservation("pending", "environment-pending", ["domain-a"]));
    await queued.tick();
    expect(fixture.admitLifecycleCapacity).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      operatorBudgets,
      samples,
      expect.any(Number),
      7000,
      "/tmp/capacity-queue-test",
      undefined,
      undefined,
    );
    expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
  });

  it.each([
    "paused",
    "removed",
    "revised",
  ])("does not dispatch if policy is %s during sampling", async (change) => {
    const queued = queue();
    fixture.collect.mockImplementation(async () => {
      fixture.readCapacityPolicy.mockReturnValue(
        change === "removed"
          ? undefined
          : {
              revision: change === "revised" ? 2 : 1,
              admissions: change === "paused" ? "paused" : "enabled",
            },
      );
      return samples;
    });
    queued.enqueue(request("pending"), reservation("pending", "environment-pending", ["domain-a"]));
    await queued.tick();
    expect(queued.observe("pending")).toMatchObject({ phase: "queued", reason: "policy-changed" });
    expect(fixture.admitLifecycleCapacity).not.toHaveBeenCalled();
    expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
  });

  it.each([
    "memory",
    "admission-unavailable",
  ] as const)("blocks overlapping followers on %s while dispatching unrelated domains", async (reason) => {
    const queued = queue();
    const worker = deferred<unknown>();
    const launched: string[] = [];
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockImplementation((item: LifecycleWorkerRequest) => {
      if (item.operationId !== "head") return { admitted: true };
      if (reason === "admission-unavailable") throw new Error("journal unavailable");
      return { admitted: false, domain: "domain-a", reason: "memory" };
    });
    fixture.runLifecycleWorker.mockImplementation(async (item: LifecycleWorkerRequest) => {
      launched.push(item.operationId);
      await worker.promise;
      return { ok: true };
    });
    queued.enqueue(request("head"), reservation("head", "environment-head", ["domain-a"]));
    queued.enqueue(request("overlap"), reservation("overlap", "environment-overlap", ["domain-a"]));
    queued.enqueue(
      request("unrelated"),
      reservation("unrelated", "environment-unrelated", ["domain-b"]),
    );
    await queued.tick();
    expect(
      fixture.admitLifecycleCapacity.mock.calls.map(
        ([item]) => (item as LifecycleWorkerRequest).operationId,
      ),
    ).toEqual(["head", "unrelated"]);
    expect(launched).toEqual(["unrelated"]);
    expect(queued.observe("head")).toMatchObject({ phase: "queued", reason });
    expect(queued.observe("overlap")).toMatchObject({ phase: "queued", reason: null });
    worker.resolve({ ok: true });
    await expect(queued.wait("unrelated", 1_000)).resolves.toBe(true);
  });

  it("retires a proven superseded head and admits its overlapping follower", async () => {
    const queued = queue();
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockImplementation((item: LifecycleWorkerRequest) => {
      if (item.operationId === "head") throw new Error("intent changed");
      return { admitted: true };
    });
    fixture.retireQueuedLifecycle.mockReturnValue(true);
    fixture.runLifecycleWorker.mockResolvedValue({ ok: true });
    queued.enqueue(request("head"), reservation("head", "environment-head", ["domain-a"]));
    queued.enqueue(request("next"), reservation("next", "environment-next", ["domain-a"]));
    await queued.tick();
    expect(fixture.retireQueuedLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "head" }),
      true,
    );
    expect(queued.observe("head")).toMatchObject({
      phase: "terminal",
      reason: "intent-superseded",
    });
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);
    expect(fixture.runLifecycleWorker.mock.calls[0][0].operationId).toBe("next");
  });

  it("does not abort or relaunch an accepted worker after caller timeout", async () => {
    const queued = queue();
    const worker = deferred<unknown>();
    const signals: AbortSignal[] = [];
    const launched: string[] = [];
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockImplementation(
      async (item: LifecycleWorkerRequest, supervision: { signal: AbortSignal }) => {
        launched.push(item.operationId);
        signals.push(supervision.signal);
        await worker.promise;
        return { ok: true };
      },
    );

    queued.enqueue(
      request("accepted"),
      reservation("accepted", "environment-accepted", ["domain-a"]),
    );
    await queued.tick();

    await expect(queued.wait("accepted", 0)).resolves.toBe(false);
    expect(signals[0]?.aborted).toBe(false);
    expect(queued.observe("accepted")?.reason).toBeNull();

    await queued.tick();
    expect(launched).toEqual(["accepted"]);
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);

    worker.resolve({ ok: true });
    await expect(queued.wait("accepted", 1_000)).resolves.toBe(true);
  });

  it("returns immediately for a terminal operation", async () => {
    const queued = queue();
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockResolvedValue({ ok: true });
    queued.enqueue(
      request("terminal-wait"),
      reservation("terminal-wait", "environment-terminal-wait", ["domain-a"]),
    );
    await queued.tick();
    await expect(queued.wait("terminal-wait", 0)).resolves.toBe(true);
  });

  it("cancels only the caller wait while the accepted worker continues once", async () => {
    const queued = queue();
    const worker = deferred<unknown>();
    let workerSignal: AbortSignal | undefined;
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockImplementation(
      async (_item: LifecycleWorkerRequest, supervision: { signal: AbortSignal }) => {
        workerSignal = supervision.signal;
        await worker.promise;
        return { ok: true };
      },
    );
    queued.enqueue(
      request("cancelled-wait"),
      reservation("cancelled-wait", "environment-cancelled-wait", ["domain-a"]),
    );
    await queued.tick();

    const controller = new AbortController();
    const wait = queued.wait("cancelled-wait", 10_000, controller.signal);
    controller.abort();
    await expect(wait).rejects.toThrow("Capacity wait was cancelled.");
    expect(workerSignal?.aborted).toBe(false);
    expect(queued.observe("cancelled-wait")?.phase).toBe("running");

    worker.resolve({ ok: true });
    await expect(queued.wait("cancelled-wait", 1_000)).resolves.toBe(true);
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);
  });

  it("cleans up repeated timed-out and cancelled wait subscriptions", async () => {
    const queued = queue();
    const worker = deferred<unknown>();
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockImplementation(async () => {
      await worker.promise;
      return { ok: true };
    });
    queued.enqueue(
      request("wait-cleanup"),
      reservation("wait-cleanup", "environment-wait-cleanup", ["domain-a"]),
    );
    await queued.tick();

    const timeoutController = new AbortController();
    const timeoutRemove = vi.spyOn(timeoutController.signal, "removeEventListener");
    for (let index = 0; index < 32; index++) {
      await expect(queued.wait("wait-cleanup", 0, timeoutController.signal)).resolves.toBe(false);
    }
    expect(timeoutRemove).toHaveBeenCalledTimes(32);

    for (let index = 0; index < 32; index++) {
      const abortController = new AbortController();
      const abortRemove = vi.spyOn(abortController.signal, "removeEventListener");
      const pending = queued.wait("wait-cleanup", 10_000, abortController.signal);
      abortController.abort();
      await expect(pending).rejects.toThrow("Capacity wait was cancelled.");
      expect(abortController.signal.aborted).toBe(true);
      expect(abortRemove).toHaveBeenCalledTimes(1);
    }

    worker.resolve({ ok: true });
    await expect(queued.wait("wait-cleanup", 1_000)).resolves.toBe(true);
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);
  });

  it("rejects a preaborted wait without changing the queued operation", async () => {
    const queued = queue();
    queued.enqueue(
      request("preaborted-wait"),
      reservation("preaborted-wait", "environment-preaborted-wait", ["domain-a"]),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(queued.wait("preaborted-wait", 10_000, controller.signal)).rejects.toThrow(
      "Capacity wait was cancelled.",
    );
    expect(queued.observe("preaborted-wait")).toMatchObject({ phase: "queued", reason: null });
  });

  it("rejects changed retained payloads without replacing the queued entry", async () => {
    const queued = queue();
    const original = request("duplicate");
    const originalReservation = reservation("duplicate", "environment-duplicate", ["domain-a"]);
    queued.enqueue(original, originalReservation);
    const before = queued.observe("duplicate");

    expect(() =>
      queued.enqueue({ ...original, command: ["devrouter", "changed"] }, originalReservation),
    ).toThrow(/another accepted request/);
    expect(() =>
      queued.enqueue(original, { ...originalReservation, totals: { "domain-a": 101 } }),
    ).toThrow(/another accepted request/);
    expect(() =>
      queued.enqueue(
        { ...original, fence: { ...original.fence, intentRevision: 2 } },
        originalReservation,
      ),
    ).toThrow(/another accepted request/);
    expect(queued.observe("duplicate")).toEqual(before);

    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockResolvedValue({ ok: true });
    await queued.tick();
    await expect(queued.wait("duplicate", 1_000)).resolves.toBe(true);
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);
  });

  it("joins an identical retained payload and launches it once", async () => {
    const queued = queue();
    const first = request("identical");
    const firstReservation = reservation("identical", "environment-identical", ["domain-a"]);
    expect(queued.enqueue(first, firstReservation)).toBe("identical");
    expect(
      queued.enqueue(
        request("identical"),
        reservation("identical", "environment-identical", ["domain-a"]),
      ),
    ).toBe("identical");

    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockResolvedValue({ ok: true });
    await queued.tick();
    await expect(queued.wait("identical", 1_000)).resolves.toBe(true);
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);
  });

  it("accepts a stable terminal duplicate without replaying discarded command payload", async () => {
    const queued = queue();
    const original = request("terminal-duplicate", "environment-terminal-duplicate", [
      "devrouter",
      "original",
    ]);
    const originalReservation = reservation(
      "terminal-duplicate",
      "environment-terminal-duplicate",
      ["domain-a"],
    );
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockResolvedValue({ ok: true });

    queued.enqueue(original, originalReservation);
    await queued.tick();
    await expect(queued.wait("terminal-duplicate", 1_000)).resolves.toBe(true);
    expect(queued.observe("terminal-duplicate")).toMatchObject({ phase: "terminal" });

    expect(
      queued.enqueue(
        { ...original, command: ["devrouter", "changed-after-terminal"] },
        originalReservation,
      ),
    ).toBe("terminal-duplicate");
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);
  });

  it("enforces command payload and retained output bounds", async () => {
    const queued = queue();
    const oversized = request("oversized", "environment-oversized", ["x".repeat(65_537)]);
    expect(() =>
      queued.enqueue(oversized, reservation("oversized", "environment-oversized", ["domain-a"])),
    ).toThrow(/payload exceeds byte limit/);

    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockImplementation(
      async (
        _item: LifecycleWorkerRequest,
        supervision: {
          output: { append: (stream: "stdout" | "stderr", data: Buffer) => void };
        },
      ) => {
        supervision.output.append("stdout", Buffer.alloc(262_145, 0x61));
        return { ok: true };
      },
    );

    queued.enqueue(request("output"), reservation("output", "environment-output", ["domain-a"]));
    await queued.tick();
    await expect(queued.wait("output", 1_000)).resolves.toBe(true);

    const output = queued.observe("output")?.output;
    expect(output?.gap).toBe(true);
    expect(output?.chunks).toHaveLength(1);
    expect(output?.chunks[0]?.data.byteLength).toBe(262_144);
  });

  it("exposes bounded base64 pages with supervised stream bytes", async () => {
    const queued = queue();
    const stdout = Buffer.from("stdout: 😀\\n\\u0000", "utf8");
    const stderr = Buffer.from("stderr: \\n\\t", "utf8");
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockImplementation(
      async (
        item: LifecycleWorkerRequest,
        supervision: {
          output: { append: (stream: "stdout" | "stderr", data: Buffer) => void };
        },
      ) => {
        if (item.operationId === "paged") {
          supervision.output.append("stdout", stdout);
          supervision.output.append("stderr", stderr);
        } else {
          supervision.output.append("stdout", Buffer.alloc(100_000, 0x61));
        }
        return { ok: true };
      },
    );

    queued.enqueue(request("paged"), reservation("paged", "environment-paged", ["domain-a"]));
    queued.enqueue(request("bounded"), reservation("bounded", "environment-bounded", ["domain-b"]));
    await queued.tick();
    await expect(queued.wait("paged", 1_000)).resolves.toBe(true);
    await expect(queued.wait("bounded", 1_000)).resolves.toBe(true);

    const page = queued.observePage("paged");
    expect(page).toMatchObject({ phase: "terminal", reason: null });
    expect(page?.output.gap).toBe(false);
    expect(page?.output.chunks).toHaveLength(2);
    expect(Buffer.from(page!.output.chunks[0]!.data, "base64")).toEqual(stdout);
    expect(Buffer.from(page!.output.chunks[1]!.data, "base64")).toEqual(stderr);

    const boundedPage = queued.observePage("bounded");
    expect(Buffer.byteLength(JSON.stringify(boundedPage?.output), "utf8")).toBeLessThan(64 * 1024);
    expect(
      boundedPage?.output.chunks.every((chunk) => /^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)),
    ).toBe(true);
  });

  it("reports a rejected worker as terminal with worker-unavailable reason", async () => {
    const queued = queue();
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockRejectedValue(new Error("worker failed"));

    queued.enqueue(
      request("rejected"),
      reservation("rejected", "environment-rejected", ["domain-a"]),
    );
    await queued.tick();

    await expect(queued.wait("rejected", 1_000)).resolves.toBe(true);
    expect(queued.observe("rejected")).toMatchObject({
      phase: "terminal",
      reason: "worker-unavailable",
    });
  });

  it("retires queued entries on close only when lifecycle proof succeeds", () => {
    const queued = queue();
    fixture.retireQueuedLifecycle.mockImplementation((item: LifecycleWorkerRequest) => {
      if (item.operationId === "unproven") throw new Error("worker still uncertain");
    });

    queued.enqueue(request("retired"), reservation("retired", "environment-retired", ["domain-a"]));
    queued.enqueue(
      request("unproven"),
      reservation("unproven", "environment-unproven", ["domain-b"]),
    );

    queued.close();

    expect(fixture.retireQueuedLifecycle).toHaveBeenCalledTimes(2);
    expect(queued.observe("retired")).toMatchObject({
      phase: "terminal",
      reason: "controller-stopped",
    });
    expect(queued.observe("unproven")).toMatchObject({
      phase: "queued",
      reason: "retirement-unproven",
    });
  });

  it("retires a queued entry when the monotonic 900-second lifetime expires", async () => {
    const queued = queue();
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0).mockReturnValue(900_000);
    fixture.collect.mockResolvedValue(samples);
    fixture.retireQueuedLifecycle.mockReturnValue(undefined);

    queued.enqueue(request("expired"), reservation("expired", "environment-expired", ["domain-a"]));
    await queued.tick();

    expect(fixture.retireQueuedLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "expired" }),
    );
    expect(queued.observe("expired")).toMatchObject({
      phase: "terminal",
      reason: "queue-expired",
    });
  });

  it("retires after admission if the deadline passes before worker dispatch", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const queued = queue({ maxQueuedTotal: 1, maxQueuedPerDomain: 1, queueLifetimeSeconds: 1 });
    fixture.collect.mockResolvedValue(samples);
    fixture.retireQueuedLifecycle.mockReturnValue(undefined);
    fixture.admitLifecycleCapacity.mockImplementation(() => {
      now.mockReturnValue(1_000);
      return { admitted: true };
    });
    fixture.runLifecycleWorker.mockResolvedValue({ ok: true });

    queued.enqueue(
      request("admission-raced"),
      reservation("admission-raced", "environment-admission-raced", ["domain-a"]),
    );
    await queued.tick();

    expect(fixture.admitLifecycleCapacity).toHaveBeenCalledTimes(1);
    expect(fixture.retireQueuedLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "admission-raced" }),
    );
    expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
    expect(queued.observe("admission-raced")).toMatchObject({
      phase: "terminal",
      reason: "queue-expired",
    });
  });

  it("keeps an expired unretired head ahead of overlapping work", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const queued = queue({ maxQueuedTotal: 3, maxQueuedPerDomain: 2, queueLifetimeSeconds: 1 });
    fixture.collect.mockResolvedValue(samples);
    fixture.retireQueuedLifecycle.mockImplementation(() => {
      throw new Error("Journal unavailable");
    });
    fixture.admitLifecycleCapacity.mockImplementation(() => {
      now.mockReturnValue(1_000);
      return { admitted: true };
    });
    fixture.runLifecycleWorker.mockResolvedValue({ ok: true });
    queued.enqueue(request("head"), reservation("head", "environment-head", ["domain-a"]));
    now.mockReturnValue(500);
    queued.enqueue(
      request("follower"),
      reservation("follower", "environment-follower", ["domain-a"]),
    );
    queued.enqueue(
      request("independent"),
      reservation("independent", "environment-independent", ["domain-b"]),
    );
    await queued.tick();
    expect(queued.observe("head")).toMatchObject({
      phase: "queued",
      reason: "retirement-unproven",
    });
    expect(queued.observe("follower")).toMatchObject({ phase: "queued" });
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);
    expect(fixture.runLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "independent" }),
      expect.anything(),
    );
  });

  it("honors lower scheduling limits and rejects unsupported bounds", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const queued = queue({ maxQueuedTotal: 2, maxQueuedPerDomain: 1, queueLifetimeSeconds: 1 });
    fixture.collect.mockResolvedValue(samples);
    fixture.retireQueuedLifecycle.mockReturnValue(undefined);

    queued.enqueue(
      request("limited-a1"),
      reservation("limited-a1", "environment-limited-a1", ["domain-a"]),
    );
    expect(() =>
      queued.enqueue(
        request("limited-a2"),
        reservation("limited-a2", "environment-limited-a2", ["domain-a"]),
      ),
    ).toThrow(/queue is full/);
    queued.enqueue(
      request("limited-b1"),
      reservation("limited-b1", "environment-limited-b1", ["domain-b"]),
    );
    expect(() =>
      queued.enqueue(
        request("limited-c1"),
        reservation("limited-c1", "environment-limited-c1", ["domain-c"]),
      ),
    ).toThrow(/queue is full/);

    now.mockReturnValue(1_000);
    await queued.tick();
    expect(queued.observe("limited-a1")).toMatchObject({
      phase: "terminal",
      reason: "queue-expired",
    });
    expect(queued.observe("limited-b1")).toMatchObject({
      phase: "terminal",
      reason: "queue-expired",
    });

    const unsupported = [
      { maxQueuedTotal: 65, maxQueuedPerDomain: 1, queueLifetimeSeconds: 1 },
      { maxQueuedTotal: 1, maxQueuedPerDomain: 33, queueLifetimeSeconds: 1 },
      { maxQueuedTotal: 1, maxQueuedPerDomain: 1, queueLifetimeSeconds: 901 },
      { maxQueuedTotal: 0, maxQueuedPerDomain: 1, queueLifetimeSeconds: 1 },
      { maxQueuedTotal: 1.5, maxQueuedPerDomain: 1, queueLifetimeSeconds: 1 },
      { maxQueuedTotal: 1, maxQueuedPerDomain: 1, queueLifetimeSeconds: 0.5 },
      {
        maxQueuedTotal: Number.MAX_SAFE_INTEGER + 1,
        maxQueuedPerDomain: 1,
        queueLifetimeSeconds: 1,
      },
    ];
    for (const scheduling of unsupported) {
      expect(() => queue(scheduling)).toThrow(/supported bounds/);
    }
  });

  it("aborts accepted workers and prevents dispatch after close", async () => {
    const queued = queue();
    const worker = deferred<unknown>();
    let signal: AbortSignal | undefined;
    const launched: string[] = [];
    fixture.collect.mockResolvedValue(samples);
    fixture.admitLifecycleCapacity.mockReturnValue({ admitted: true });
    fixture.runLifecycleWorker.mockImplementation(
      async (item: LifecycleWorkerRequest, supervision: { signal: AbortSignal }) => {
        launched.push(item.operationId);
        signal = supervision.signal;
        await worker.promise;
        return { ok: true };
      },
    );

    queued.enqueue(request("running"), reservation("running", "environment-running", ["domain-a"]));
    await queued.tick();
    expect(signal?.aborted).toBe(false);

    queued.close();
    expect(signal?.aborted).toBe(true);
    await queued.tick();
    expect(launched).toEqual(["running"]);
    expect(fixture.collect).toHaveBeenCalledTimes(1);
    expect(() =>
      queued.enqueue(
        request("after-close"),
        reservation("after-close", "environment-after-close", ["domain-b"]),
      ),
    ).toThrow(/queue is closed/);

    worker.resolve({ ok: true });
    await expect(queued.wait("running", 1_000)).resolves.toBe(true);
  });
});
