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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("absent"), { code: "ESRCH" });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("worker dispatch acknowledgement", () => {
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
