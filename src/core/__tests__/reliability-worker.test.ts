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

function prepared() {
  const identity = { repoPath: "/synthetic", workspace: null, provider: "devpod" as const };
  const initial = createReliabilityState("synthetic", 0, "manual");
  const state = stepReliability(
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
  ).state;
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
  };
  const close = () => {
    child.exitCode = 0;
    child.emit("close", 0, null);
  };
  return { child, request, close, record: () => record };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.capacity.mockReset();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("absent"), { code: "ESRCH" });
  });
});

afterEach(() => vi.restoreAllMocks());

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
    setup.child.emit("message", { ready: true });
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
    expect(output.readPage(page.sequence).sequence).toEqual({ sequence: 10, offset: 0 });
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
    setup.child.emit("message", { ready: true });
    setup.child.emit("message", { ready: true });
    expect(setup.child.send).toHaveBeenCalledTimes(1);
    setup.child.emit("message", { ok: true, value: 7 });
    setup.close();
    await expect(pending).resolves.toBe(7);
    expect(setup.record().worker).toBeNull();
    expect(setup.record().state.operation?.drained).toBe(true);
  });

  it("rejects duplicate dispatch without allowing its child to drain the original worker", async () => {
    const setup = prepared();
    const original = runLifecycleWorker(setup.request);
    setup.child.emit("message", { ready: true });
    const duplicate = Object.assign(new EventEmitter(), {
      pid: 456,
      exitCode: null as number | null,
      signalCode: null as string | null,
      send: vi.fn(),
    });
    fixture.fork.mockReturnValue(duplicate);
    const rejected = runLifecycleWorker(setup.request);
    const rejection = expect(rejected).rejects.toThrow("Lifecycle intent changed before dispatch");
    duplicate.emit("message", { ready: true });
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
    setup.child.emit("message", { ready: true });
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
    setup.child.emit("message", { ready: true });
    expect(setup.child.send).not.toHaveBeenCalled();
    setup.close();
    await result;
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
    setup.child.emit("message", { ready: true });
    expect(setup.child.send).not.toHaveBeenCalled();
    setup.close();
    await result;
  });
});
