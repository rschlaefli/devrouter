import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReliabilityState, reliabilityFence } from "../reliability-contract";
import { stepReliability } from "../reliability-model";
import type { ReliabilityOperationRecord } from "../reliability-operation-store";
import {
  LifecycleOutput,
  type LifecycleWorkerRequest,
  runLifecycleWorker,
} from "../reliability-worker";

const fixture = vi.hoisted(() => ({
  fork: vi.fn(),
  update: vi.fn(),
  read: vi.fn(),
  capacity: vi.fn(),
}));
vi.mock("node:child_process", () => ({ fork: fixture.fork }));
vi.mock("node:fs", () => ({ default: { existsSync: () => true } }));
vi.mock("../file-lock", () => ({ processBirthIdentity: () => "proc:123" }));
vi.mock("../reliability-operation-store", () => ({
  updateReliabilityOperation: fixture.update,
  readReliabilityOperation: fixture.read,
  assertCapacityEffect: fixture.capacity,
}));

function prepared(admit = false) {
  const identity = { repoPath: "/synthetic", workspace: null, provider: "devpod" as const };
  const initial = createReliabilityState("synthetic", 0, "manual");
  const state = admit
    ? stepReliability(
        initial,
        {
          ...reliabilityFence(initial),
          type: "operation-request",
          kind: "exec",
          key: "request",
          operationId: "operation",
          profile: "full",
          runtimeRunning: true,
          consumer: { id: "manual", requiredCapabilities: [], pinned: false },
        },
        0,
      ).state
    : initial;
  let record: ReliabilityOperationRecord = {
    version: 1,
    identity,
    revision: 0,
    effectSequence: 0,
    worker: null,
    outcome: null,
    state,
  };
  fixture.update.mockImplementation((_identity, operation) => {
    const next = structuredClone(record);
    const result = operation(next);
    record = next;
    return result;
  });
  fixture.read.mockImplementation(() => record);
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as string | null,
    send: vi.fn((_message, callback) => callback(null)),
  });
  fixture.fork.mockReturnValue(child);
  const request: LifecycleWorkerRequest = {
    kind: "exec",
    repoPath: identity.repoPath,
    identity,
    requestId: "request",
    operationId: "operation",
    workerId: "worker",
    fence: reliabilityFence(state),
    options: {},
    command: ["synthetic"],
    admission: {
      expectedRevision: 0,
      profile: "full",
      runtimeRunning: true,
      consumer: { id: "manual", requiredCapabilities: [], pinned: false },
    },
  };
  const close = () => {
    child.exitCode = 0;
    child.emit("close", 0, null);
  };
  return { child, request, close, record: () => record };
}

async function ready(child: EventEmitter): Promise<void> {
  child.emit("message", { ready: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.capacity.mockReset();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("absent"), { code: "ESRCH" });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("worker dispatch acknowledgement", () => {
  it.each([
    1, 2,
  ])("never sends work after capacity validation fails at boundary %s", async (boundary) => {
    const setup = prepared();
    let claims = 0;
    fixture.capacity.mockImplementation(() => {
      if (++claims === boundary) throw new Error("capacity authority revoked");
    });
    const pending = runLifecycleWorker(setup.request);
    await ready(setup.child);
    expect(setup.child.send).not.toHaveBeenCalled();
    setup.close();
    await expect(pending).rejects.toThrow("capacity authority revoked");
  });

  it("drains controller-owned output without adding per-worker process signal listeners", async () => {
    const setup = prepared();
    const signal = new AbortController();
    const output = new LifecycleOutput();
    const interruptListeners = process.listenerCount("SIGINT");
    const terminateListeners = process.listenerCount("SIGTERM");
    const pending = runLifecycleWorker(setup.request, { signal: signal.signal, output });
    expect(process.listenerCount("SIGINT")).toBe(interruptListeners);
    expect(process.listenerCount("SIGTERM")).toBe(terminateListeners);
    setup.child.emit("message", { ready: true });
    setup.child.stdout.emit("data", Buffer.from("out"));
    setup.child.stderr.emit("data", Buffer.from("err"));
    expect(output.read().chunks.map(({ stream, data }) => [stream, data.toString()])).toEqual([
      ["stdout", "out"],
      ["stderr", "err"],
    ]);
    setup.child.emit("message", { ok: true, value: 0 });
    setup.close();
    await expect(pending).resolves.toBe(0);
    expect(setup.child.stdout.listenerCount("data")).toBe(0);
    expect(setup.child.stderr.listenerCount("data")).toBe(0);
  });

  it("reports bounded output loss while retaining independent output buffers", () => {
    const output = new LifecycleOutput();
    const other = new LifecycleOutput();
    for (let index = 0; index < 80; index++) output.append("stdout", Buffer.alloc(8192, index));
    const read = output.read();
    expect(read.gap).toBe(true);
    expect(read.chunks.reduce((sum, chunk) => sum + chunk.data.length, 0)).toBeLessThanOrEqual(
      262_144,
    );
    expect(output.read(read.sequence)).toEqual({ gap: false, sequence: read.sequence, chunks: [] });
    expect(other.read()).toEqual({ gap: false, sequence: 0, chunks: [] });
  });

  it("pages UTF8 and JSON-escaped output within the requested byte bound", () => {
    const output = new LifecycleOutput();
    const value = 'Grüße "quoted" \\ slash\n'.repeat(200);
    output.append("stdout", Buffer.from(value, "utf8"));
    const bytes = Buffer.byteLength(value, "utf8");
    const maxJsonBytes = 512;
    expect(Buffer.byteLength(JSON.stringify(output.readPage()), "utf8")).toBeLessThan(64 * 1024);
    let cursor = { sequence: 0, offset: 0 };
    let collected = Buffer.alloc(0);
    let pages = 0;

    while (cursor.offset < bytes) {
      const page = output.readPage(cursor, maxJsonBytes);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(maxJsonBytes);
      expect(page.encoding).toBe("base64");
      expect(page.gap).toBe(false);
      expect(page.sequence.sequence).toBe(1);
      expect(page.sequence.offset).toBeGreaterThan(cursor.offset);
      expect(page.sequence.offset).toBeLessThanOrEqual(bytes);
      collected = Buffer.concat([
        collected,
        ...page.chunks.map((chunk) => Buffer.from(chunk.data, "base64")),
      ]);
      cursor = page.sequence;
      pages++;
    }

    expect(pages).toBeGreaterThan(1);
    expect(collected).toEqual(Buffer.from(value, "utf8"));
    expect(cursor.offset).toBe(bytes);
    expect(() => output.readPage({ sequence: 2, offset: 0 }, maxJsonBytes)).toThrow(
      "Invalid output cursor.",
    );
    expect(() => output.readPage({ sequence: 1, offset: bytes + 1 }, maxJsonBytes)).toThrow(
      "Invalid output cursor.",
    );
  });

  it("keeps empty-chunk cursor advancement within the page byte bound", () => {
    const output = new LifecycleOutput();
    const bound = Buffer.byteLength(JSON.stringify(output.readPage()));
    for (let index = 0; index < 10; index++) output.append("stdout", Buffer.alloc(0));

    const page = output.readPage({ sequence: 0, offset: 0 }, bound);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(bound);
    expect(page.sequence).toEqual({ sequence: 9, offset: 0 });
    expect(() => output.readPage(page.sequence, bound)).toThrow(
      "Output page byte bound is too small.",
    );
    expect(output.readPage(page.sequence).sequence).toEqual({ sequence: 10, offset: 0 });
  });

  it("reports a gap when a cursor enters the retained tail of an oversized chunk", () => {
    const output = new LifecycleOutput();
    const discarded = Buffer.from("discarded prefix");
    const retained = Buffer.alloc(262_144, 0x80);
    output.append("stdout", Buffer.concat([discarded, retained]));

    const page = output.readPage({ sequence: 1, offset: 0 }, 1_024);
    expect(page.gap).toBe(true);
    expect(Buffer.from(page.chunks[0]!.data, "base64")).toEqual(
      retained.subarray(0, page.sequence.offset),
    );
  });

  it("preserves a UTF8 codepoint split across separate append calls", () => {
    const output = new LifecycleOutput();
    const emoji = Buffer.from("🙂", "utf8");
    const expected = Buffer.concat([Buffer.from("before:"), emoji, Buffer.from(":after")]);
    output.append("stdout", Buffer.concat([Buffer.from("before:"), emoji.subarray(0, 2)]));
    output.append("stdout", Buffer.concat([emoji.subarray(2), Buffer.from(":after")]));

    let cursor = { sequence: 0, offset: 0 };
    let collected = Buffer.alloc(0);
    for (let pages = 0; pages < 100; pages++) {
      const page = output.readPage(cursor, 192);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(192);
      collected = Buffer.concat([
        collected,
        ...page.chunks.map((chunk) => Buffer.from(chunk.data, "base64")),
      ]);
      if (page.chunks.length === 0) break;
      const next = page.sequence;
      expect(
        next.sequence > cursor.sequence ||
          (next.sequence === cursor.sequence && next.offset > cursor.offset),
      ).toBe(true);
      cursor = next;
    }

    expect(collected).toEqual(expected);
  });

  it("continues from a consumed evicted sequence and reports a gap for older cursors", () => {
    const output = new LifecycleOutput();
    output.append("stdout", Buffer.from("first"));
    const consumed = output.readPage({ sequence: 0, offset: 0 }, 256);
    expect(consumed.sequence).toEqual({ sequence: 1, offset: 5 });

    for (let index = 2; index <= 65; index++)
      output.append("stdout", Buffer.from(`chunk-${index}`));

    const continued = output.readPage(consumed.sequence, 256);
    expect(continued.gap).toBe(true);
    expect(continued.chunks[0]).toMatchObject({
      sequence: 2,
      data: Buffer.from("chunk-2").toString("base64"),
    });

    const stale = output.readPage({ sequence: 0, offset: 0 }, 256);
    expect(stale.gap).toBe(true);
    expect(stale.chunks[0]).toMatchObject({
      sequence: 2,
      data: Buffer.from("chunk-2").toString("base64"),
    });
  });

  it("reports a gap when a partial cursor points into an evicted chunk", () => {
    const output = new LifecycleOutput();
    output.append("stdout", Buffer.from("0123456789"));
    const partialCursor = { sequence: 1, offset: 3 };
    for (let index = 2; index <= 65; index++)
      output.append("stdout", Buffer.from(`chunk-${index}`));

    const page = output.readPage(partialCursor, 256);
    expect(page.gap).toBe(true);
    expect(page.chunks[0]).toMatchObject({ sequence: 2 });
  });

  it("does not fork an already-cancelled supervised request", async () => {
    const setup = prepared();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runLifecycleWorker(setup.request, {
        signal: controller.signal,
        output: new LifecycleOutput(),
      }),
    ).rejects.toThrow("cancelled before dispatch");
    expect(fixture.fork).not.toHaveBeenCalled();
  });
  it("launches once after both durable dispatch boundaries and ignores repeated readiness", async () => {
    const setup = prepared();
    setup.child.send.mockImplementation((_message, callback) => {
      expect(setup.record().state.operation?.status).toBe("DISPATCH_RECORDED");
      expect(setup.record().worker).toMatchObject({ pid: 123, birth: "proc:123" });
      callback(null);
    });
    const pending = runLifecycleWorker(setup.request);
    await ready(setup.child);
    await ready(setup.child);
    expect(setup.child.send).toHaveBeenCalledTimes(1);
    setup.child.emit("message", { ok: true, value: 7 });
    setup.close();
    await expect(pending).resolves.toBe(7);
    expect(setup.record().worker).toBeNull();
    expect(setup.record().state.operation?.drained).toBe(true);
  });

  it("admits and rolls history atomically with worker registration before launch", async () => {
    const setup = prepared(true);
    const record = setup.record();
    for (const event of [
      { type: "dispatch" },
      { type: "dispatch-persisted", operationId: "operation" },
      { type: "completion", operationId: "operation", exitCode: 0 },
      { type: "drained", operationId: "operation" },
    ] as const)
      record.state = stepReliability(
        record.state,
        { ...reliabilityFence(record.state), ...event },
        1,
      ).state;
    const current = record.state.operationHistory[0];
    record.state.operationHistory = [
      ...Array.from({ length: 127 }, (_, i) => ({ ...current, id: `old-${i}`, key: `old-${i}` })),
      current,
    ];
    const beforeFence = reliabilityFence(record.state);
    setup.request.requestId = "next";
    setup.request.operationId = "next";
    setup.request.fence = beforeFence;
    setup.request.admission = {
      expectedRevision: 0,
      profile: "full",
      runtimeRunning: true,
      consumer: { id: "manual", requiredCapabilities: [], pinned: false },
    };
    setup.child.send.mockImplementation((_message, callback) => {
      expect(fixture.update).toHaveBeenCalledTimes(2);
      expect(setup.record().state.intentRevision).toBe(beforeFence.intentRevision + 1);
      expect(setup.record().state.operationHistory).toHaveLength(128);
      expect(setup.record().state.operationHistory.some((entry) => entry.id === "old-0")).toBe(
        false,
      );
      expect(setup.record().state.operation?.id).toBe("next");
      expect(setup.record().worker?.operationId).toBe("next");
      callback(null);
    });
    const pending = runLifecycleWorker(setup.request);
    await ready(setup.child);
    expect(setup.child.send).toHaveBeenCalledOnce();
    setup.child.emit("message", { ok: true, value: 0 });
    setup.close();
    await expect(pending).resolves.toBe(0);
  });

  it.each([
    "ensure",
    "exec",
  ] as const)("%s disposes a snapshot-race loser without journal changes or IPC launch", async (kind) => {
    const setup = prepared();
    setup.request.kind = kind;
    setup.request.requestId = "next";
    setup.request.operationId = "next";
    setup.request.admission = {
      expectedRevision: 99,
      profile: "full",
      runtimeRunning: true,
      consumer: { id: "manual", requiredCapabilities: [], pinned: false },
    };
    const before = structuredClone(setup.record());
    const pending = runLifecycleWorker(setup.request);
    const rejection = expect(pending).rejects.toMatchObject({
      name: "LifecycleWorkerAdmissionBusyError",
    });
    await ready(setup.child);
    expect(setup.child.send).not.toHaveBeenCalled();
    setup.close();
    await rejection;
    expect(setup.record()).toEqual(before);
    expect(process.kill).toHaveBeenCalledWith(-123, "SIGTERM");
  });

  it("delivers pending cancellation before admitting a ready helper", async () => {
    const setup = prepared();
    const before = structuredClone(setup.record());
    const listeners = process.listenerCount("SIGTERM");
    const pending = runLifecycleWorker(setup.request);
    const rejection = expect(pending).rejects.toThrow();
    setup.child.emit("message", { ready: true });
    process.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    setup.close();
    await rejection;
    expect(setup.child.send).not.toHaveBeenCalled();
    expect(setup.record()).toEqual(before);
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  });

  it("rejects duplicate dispatch without allowing its child to drain the original worker", async () => {
    const setup = prepared();
    const original = runLifecycleWorker(setup.request);
    await ready(setup.child);
    const duplicate = Object.assign(new EventEmitter(), {
      pid: 456,
      exitCode: null as number | null,
      signalCode: null as string | null,
      send: vi.fn(),
    });
    fixture.fork.mockReturnValue(duplicate);
    const rejected = runLifecycleWorker(setup.request);
    const rejection = expect(rejected).rejects.toThrow("conflicts with an existing operation");
    await ready(duplicate);
    duplicate.exitCode = 0;
    duplicate.emit("close", 0, null);
    await rejection;
    expect(duplicate.send).not.toHaveBeenCalled();
    expect(setup.record().worker?.pid).toBe(123);
    expect(setup.record().state.operation?.drained).toBe(false);
    setup.child.emit("message", { ok: true, value: 0 });
    setup.close();
    await expect(original).resolves.toBe(0);
  });

  it("records interruption on worker loss while retaining an active process group", async () => {
    const setup = prepared();
    vi.mocked(process.kill).mockReturnValue(true);
    const pending = runLifecycleWorker(setup.request);
    const rejection = expect(pending).rejects.toThrow("completion is unknown");
    await ready(setup.child);
    setup.close();
    await rejection;
    expect(setup.record().state.operation?.status).toBe("INTERRUPTED");
    expect(setup.record().state.operation?.drained).toBe(false);
    expect(setup.record().worker?.pid).toBe(123);
  });

  it.each([1, 2])("never launches after failed persistence boundary %s", async (boundary) => {
    const setup = prepared();
    const actual = fixture.update.getMockImplementation();
    let updates = 0;
    fixture.update.mockImplementation((...args) => {
      updates++;
      if (updates === boundary) throw new Error("synthetic persistence failure");
      return actual?.(...args);
    });
    const pending = runLifecycleWorker(setup.request);
    const result = expect(pending).rejects.toThrow("synthetic persistence failure");
    await ready(setup.child);
    expect(setup.child.send).not.toHaveBeenCalled();
    setup.close();
    await result;
  });

  it.each([
    "ensure",
    "exec",
  ] as const)("%s preserves cancellation outcome without launching", async (kind) => {
    const setup = prepared();
    setup.request.kind = kind;
    const check = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("synthetic cancellation");
      });
    const pending = runLifecycleWorker(setup.request, undefined, check);
    const rejection = expect(pending).rejects.toThrow("synthetic cancellation");
    await ready(setup.child);
    expect(setup.child.send).not.toHaveBeenCalled();
    setup.close();
    await rejection;
    expect(setup.record().state.operation).toMatchObject({
      status: kind === "exec" ? "NOT_LAUNCHED" : "INTERRUPTED",
      drained: true,
    });
    const next = stepReliability(
      setup.record().state,
      {
        ...reliabilityFence(setup.record().state),
        type: "operation-request",
        kind,
        key: "next",
        operationId: "next",
        profile: "full",
        runtimeRunning: true,
        consumer: { id: "manual", requiredCapabilities: [], pinned: false },
      },
      Date.now(),
    );
    expect(next.outcome).toBe("accepted");
  });

  it("never registers a helper that closes while its ready callback yields", async () => {
    const setup = prepared();
    const before = structuredClone(setup.record());
    const pending = runLifecycleWorker(setup.request);
    const rejection = expect(pending).rejects.toThrow();
    setup.child.emit("message", { ready: true });
    setup.close();
    await rejection;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(setup.record()).toEqual(before);
    expect(setup.child.send).not.toHaveBeenCalled();
  });

  it("bounds unready helper lifetime without registering or launching it", async () => {
    vi.useFakeTimers();
    const setup = prepared();
    const before = structuredClone(setup.record());
    const pending = runLifecycleWorker(setup.request);
    const rejection = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(32_000);
    expect(process.kill).toHaveBeenCalledWith(-123, "SIGTERM");
    expect(process.kill).toHaveBeenCalledWith(-123, "SIGKILL");
    setup.close();
    await rejection;
    expect(setup.record()).toEqual(before);
    expect(setup.child.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop before dispatch claim prevents IPC launch", async () => {
    const setup = prepared();
    const record = setup.record();
    record.state = stepReliability(
      record.state,
      { ...reliabilityFence(record.state), type: "stop" },
      1,
    ).state;
    const pending = runLifecycleWorker(setup.request);
    const result = expect(pending).rejects.toThrow("Lifecycle intent changed before dispatch");
    await ready(setup.child);
    expect(setup.child.send).not.toHaveBeenCalled();
    setup.close();
    await result;
  });
});
