import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReliabilityState, reliabilityFence } from "../reliability-contract";
import { stepReliability } from "../reliability-model";
import type { ReliabilityOperationRecord } from "../reliability-operation-store";
import { type LifecycleWorkerRequest, runLifecycleWorker } from "../reliability-worker";

const fixture = vi.hoisted(() => ({ fork: vi.fn(), update: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: fixture.fork }));
vi.mock("node:fs", () => ({ default: { existsSync: () => true } }));
vi.mock("../file-lock", () => ({ processBirthIdentity: () => "proc:123" }));
vi.mock("../reliability-operation-store", () => ({
  updateReliabilityOperation: fixture.update,
  readReliabilityOperation: fixture.read,
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

async function ready(child: EventEmitter): Promise<void> {
  child.emit("message", { ready: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("absent"), { code: "ESRCH" });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("worker dispatch acknowledgement", () => {
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
    const setup = prepared();
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

  it("disposes a snapshot-race loser without journal changes or IPC launch", async () => {
    const setup = prepared();
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
    const rejection = expect(rejected).rejects.toThrow("Lifecycle intent changed before dispatch");
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
