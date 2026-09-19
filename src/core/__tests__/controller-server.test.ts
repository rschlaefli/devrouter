import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { observeControllerBinding } from "../controller-client";
import { type ControllerObservationCollector, controllerCapability } from "../controller-monitor";
import { CONTROLLER_FRAME_BYTES } from "../controller-protocol";
import {
  type ControllerOperations,
  type ControllerStartup,
  runController,
} from "../controller-server";
import { ControllerSessions } from "../controller-sessions";
import * as fileLocks from "../file-lock";
import { createReliabilityState } from "../reliability-contract";
import * as operationStore from "../reliability-operation-store";

const journalFixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../router", async (original) => {
  const actual = await original<typeof import("../router")>();
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  journalFixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "controller-pin-journal-"));
  return { ...actual, DEVROUTER_HOME: journalFixture.root };
});

const directories: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterAll(() => fs.rmSync(journalFixture.root, { recursive: true, force: true }));
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
async function fixture(
  collect?: ControllerObservationCollector,
  operations?: ControllerOperations,
  createOperations?: (controller: ControllerStartup) => ControllerOperations,
) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-")));
  directories.push(directory);
  const abort = new AbortController();
  let listening: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const run = runController({
    directory,
    signal: abort.signal,
    onListening: listening,
    collect,
    operations,
    createOperations,
    resolve: async () => ({
      id: "env",
      repoPath: "/fixture/checkout",
      workspace: "fixture",
      provider: "devsy",
      providerId: "provider",
      profile: "web",
      fingerprint: "a".repeat(64),
    }),
  });
  await Promise.race([ready, run]);
  stops.push(async () => {
    abort.abort();
    await run;
  });
  return { directory, run, abort };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

function connect(directory: string) {
  const socket = net.createConnection(path.join(directory, "control.sock"));
  let pending: ((value: any) => void) | undefined;
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const value = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending?.(value);
      pending = undefined;
    }
  });
  return {
    socket,
    request: (request: object) =>
      new Promise<any>((resolve) => {
        pending = resolve;
        socket.write(`${JSON.stringify({ version: 1, id: "request", ...request })}\n`);
      }),
  };
}

it("binds observations through the canonical client contract", async () => {
  const { directory } = await fixture();
  const binding = await observeControllerBinding(directory, {
    path: "/fixture/checkout",
    session: "session-1",
    profile: "web",
    require: ["runtime"],
  });
  expect(binding).toEqual({
    session: "session-1",
    store: expect.any(String),
    epoch: expect.any(Number),
    generation: expect.any(String),
  });
});

it("creates managed operations from the handshake identity and closes them once", async () => {
  const tickEntered = deferred<void>();
  const releaseTick = deferred<void>();
  const tick = vi.fn(async () => {
    tickEntered.resolve();
    await releaseTick.promise;
  });
  const close = vi.fn();
  const createOperations = vi.fn(
    (_controller: { store: string; epoch: number }): ControllerOperations => ({
      submit: vi.fn(),
      watch: vi.fn(),
      tick,
      close,
    }),
  );
  const { directory, abort, run } = await fixture(undefined, undefined, createOperations);
  const client = connect(directory);
  try {
    const handshake = await client.request({ method: "handshake" });
    expect(handshake).toMatchObject({
      ok: true,
      result: { store: expect.any(String), epoch: expect.any(Number) },
    });
    expect(createOperations).toHaveBeenCalledOnce();
    expect(createOperations).toHaveBeenCalledWith(
      {
        store: handshake.result.store,
        epoch: handshake.result.epoch,
        directory,
        consumeStartup: expect.any(Function),
      },
      expect.any(Function),
    );

    await tickEntered.promise;
    expect(tick).toHaveBeenCalledOnce();
    expect(await client.request({ method: "status" })).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(tick).toHaveBeenCalledOnce();

    releaseTick.resolve();
    abort.abort();
    await run;
    expect(close).toHaveBeenCalledOnce();
  } finally {
    client.socket.destroy();
  }
});

it.each([
  false,
  true,
])("expires startup authority after its factory returns (consumed: %s)", async (consume) => {
  let startup!: ControllerStartup;
  await fixture(undefined, undefined, (value) => {
    startup = value;
    if (consume) {
      value.consumeStartup(value.directory);
      expect(() => value.consumeStartup(value.directory)).toThrow();
    }
    return { submit: vi.fn(), watch: vi.fn() };
  });
  expect(() => startup.consumeStartup(startup.directory)).toThrow();
});

it("expires startup authority when the factory throws", async () => {
  let startup!: ControllerStartup;
  await expect(
    fixture(undefined, undefined, (value) => {
      startup = value;
      value.consumeStartup(value.directory);
      throw new Error("Synthetic initialization failure");
    }),
  ).rejects.toThrow("Synthetic initialization failure");
  expect(() => startup.consumeStartup(startup.directory)).toThrow();
});

it("queries durable operation history only through a valid session binding", async () => {
  const { directory } = await fixture();
  const client = connect(directory);
  await client.request({ method: "handshake" });
  const acquired = await client.request({
    method: "observe",
    path: "/fixture/checkout",
    session: "reader",
    profile: "web",
    require: ["runtime"],
  });
  const read = vi.spyOn(operationStore, "readReliabilityOperation").mockReturnValue({
    state: {
      operation: null,
      operationHistory: [
        { id: "previous", kind: "exec", drained: true, status: "COMPLETED", exitCode: 7 },
      ],
    },
  } as unknown as operationStore.ReliabilityOperationRecord);
  try {
    const result = await client.request({
      ...acquired.result,
      method: "operation-status",
      operationId: "previous",
    });
    expect(result).toMatchObject({
      ok: true,
      result: { operation: { operationId: "previous", outcome: "COMPLETED", exitCode: 7 } },
    });
    expect(read).toHaveBeenCalledWith({
      repoPath: "/fixture/checkout",
      workspace: "fixture",
      provider: "devsy",
    });
    read.mockClear();
    const rejected = await client.request({
      ...acquired.result,
      method: "operation-status",
      operationId: "previous",
      generation: "stale-generation",
    });
    expect(rejected.ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    client.socket.destroy();
  }
});

it("reconnects through a fresh session to retained operation history without launching work", async () => {
  const { directory } = await fixture();
  const first = connect(directory);
  await first.request({ method: "handshake" });
  const acquired = await first.request({
    method: "observe",
    path: "/fixture/checkout",
    session: "original",
    profile: "web",
    require: ["runtime"],
  });
  await first.request({ ...acquired.result, method: "release" });
  first.socket.destroy();
  const second = connect(directory);
  await second.request({ method: "handshake" });
  const reconnected = await second.request({
    method: "observe",
    path: "/fixture/checkout",
    session: "replacement",
    profile: "web",
    require: ["runtime"],
  });
  const read = vi.spyOn(operationStore, "readReliabilityOperation").mockReturnValue({
    state: {
      operation: null,
      operationHistory: [
        { id: "retained-command", kind: "exec", drained: true, status: "COMPLETED", exitCode: 3 },
      ],
    },
  } as unknown as operationStore.ReliabilityOperationRecord);
  const mutate = vi.spyOn(operationStore, "updateReliabilityOperation");
  try {
    const result = await second.request({
      ...reconnected.result,
      method: "operation-status",
      operationId: "retained-command",
    });
    expect(result).toMatchObject({
      ok: true,
      result: { operation: { operationId: "retained-command", outcome: "COMPLETED", exitCode: 3 } },
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith({
      repoPath: "/fixture/checkout",
      workspace: "fixture",
      provider: "devsy",
    });
  } finally {
    mutate.mockRestore();
    read.mockRestore();
    second.socket.destroy();
  }
});

it("keeps status responsive during an operation watch and binds submission to its session", async () => {
  const { submitControllerOperation, followControllerOperation } = await import(
    "../controller-client"
  );
  const queued = {
    operationId: "accepted",
    phase: "queued",
    outcome: null,
    reason: null,
    exitCode: null,
  };
  let finishWatch: (value: unknown) => void = () => {};
  let enteredWatch: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enteredWatch = resolve;
  });
  const operations: ControllerOperations = {
    submit: vi.fn(async () => ({ operation: queued })),
    watch: vi.fn(async () => {
      enteredWatch();
      return new Promise((resolve) => {
        finishWatch = resolve;
      });
    }),
  };
  const { directory } = await fixture(undefined, operations);
  const first = connect(directory);
  const second = connect(directory);
  try {
    await first.request({ method: "handshake" });
    await second.request({ method: "handshake" });
    const acquired = await first.request({
      method: "observe",
      path: "/fixture/checkout",
      session: "operator",
      profile: "web",
      require: ["runtime"],
    });
    const submitted = await submitControllerOperation(
      directory,
      {
        ...acquired.result,
        requestId: "durable-request",
        kind: "ensure",
      },
      { waitSeconds: 0 },
    );
    expect(submitted).toMatchObject({
      status: "pending",
      operationId: "accepted",
      operation: { phase: "queued" },
    });
    expect(operations.submit).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "durable-request" }),
      expect.objectContaining({ repoPath: "/fixture/checkout", providerId: "provider" }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    const watched = first.request({
      ...acquired.result,
      method: "operation-watch",
      operationId: "accepted",
      timeout: 30,
    });
    await entered;
    expect(await second.request({ method: "status" })).toMatchObject({ ok: true });
    finishWatch({ operationId: "accepted", phase: "queued" });
    expect(await watched).toMatchObject({ ok: true, result: { operationId: "accepted" } });
    vi.mocked(operations.watch).mockResolvedValue({
      operation: { ...queued, phase: "terminal", outcome: "COMPLETED", exitCode: 7 },
      output: null,
    });
    expect(
      await followControllerOperation(
        directory,
        {
          ...acquired.result,
          operationId: submitted.operationId,
        },
        { waitSeconds: 1 },
      ),
    ).toMatchObject({ status: "terminal", operation: { exitCode: 7 } });
    expect(
      await first.request({
        ...acquired.result,
        generation: "stale",
        method: "operation-submit",
        requestId: "other",
        kind: "ensure",
      }),
    ).toMatchObject({ ok: false });
    expect(operations.submit).toHaveBeenCalledOnce();
  } finally {
    finishWatch({});
    first.socket.destroy();
    second.socket.destroy();
  }
});

it("fences submitted operations through the real session callback across release and reacquisition", async () => {
  const { controllerRequest, submitControllerOperation } = await import("../controller-client");
  const settle: Array<() => void> = [];
  const submit = vi.fn(
    (...args: unknown[]) =>
      new Promise<unknown>((resolve) => {
        settle.push(() =>
          resolve({
            operation: {
              operationId: "accepted",
              phase: "queued",
              outcome: null,
              reason: null,
              exitCode: null,
            },
          }),
        );
        void args;
      }),
  );
  const operations: ControllerOperations = { submit, watch: vi.fn() };
  const { directory } = await fixture(undefined, operations);
  const client = connect(directory);
  const second = connect(directory);
  try {
    await client.request({ method: "handshake" });
    await second.request({ method: "handshake" });
    let binding: any;
    await controllerRequest(
      directory,
      {
        method: "observe",
        path: "/fixture/checkout",
        session: "operator",
        profile: "web",
        require: ["runtime", "app:web"],
      },
      (value: any) => {
        binding = value.result;
      },
    );

    const held = submitControllerOperation(
      directory,
      { ...binding, requestId: "first", kind: "ensure" },
      { waitSeconds: 0 },
    );
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const callback = submit.mock.calls[0][3] as () => {
      id: string;
      requiredCapabilities: string[];
      pinned: boolean;
    };
    expect(typeof callback).toBe("function");
    const consumer = callback();
    expect(consumer).toEqual({
      id: expect.stringMatching(/^session-[a-f0-9]{64}$/),
      requiredCapabilities: [controllerCapability("app:web"), "runtime"],
      pinned: false,
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "first", kind: "ensure" }),
      expect.objectContaining({ repoPath: "/fixture/checkout", providerId: "provider" }),
      expect.any(AbortSignal),
      expect.any(Function),
    );

    // The exact callback rejects once its session is released, with the
    // submission still held open on a live socket.
    expect((await second.request({ ...binding, method: "release" })).ok).toBe(true);
    expect(() => callback()).toThrow("stale or absent");

    // Same-ID reacquisition rebuilds the callback with a fresh generation while
    // the original socket stays open.
    const reacquired = await client.request({
      method: "observe",
      path: "/fixture/checkout",
      session: "operator",
      profile: "web",
      require: ["runtime", "app:web"],
    });
    expect(reacquired.result.generation).not.toBe(binding.generation);
    expect(() => callback()).toThrow("stale or absent");
    const reHeld = submitControllerOperation(
      directory,
      { ...reacquired.result, requestId: "released", kind: "ensure" },
      { waitSeconds: 0 },
    );
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    const reCallback = submit.mock.calls[1][3] as () => { id: string };
    expect(reCallback).not.toThrow();
    expect(reCallback().id).not.toBe(consumer.id);
    expect(reCallback().id).toBe(reCallback().id);

    settle[0]();
    expect(await held).toMatchObject({ status: "pending", operationId: "accepted" });
    settle[1]();
    expect(await reHeld).toMatchObject({ status: "pending", operationId: "accepted" });
    expect(submit).toHaveBeenCalledTimes(2);
  } finally {
    client.socket.destroy();
    second.socket.destroy();
  }
});

it("streams a later application failure while an independent runtime consumer stays ready", async () => {
  const { controllerRequest } = await import("../controller-client");
  const state = createReliabilityState("environment", 0, "manual");
  state.desired = "running";
  state.phase = "stable";
  const identity = {
    repoPath: "/fixture/checkout",
    workspace: "fixture",
    provider: "devsy" as const,
  };
  const journal: operationStore.ReliabilityOperationRecord = {
    version: 1,
    identity,
    revision: 1,
    state,
    worker: null,
    effectSequence: 0,
    outcome: null,
  };
  const fence = vi
    .spyOn(operationStore, "withReliabilityObservationFence")
    .mockImplementation((_identity, _revision, publish) => publish(journal));
  let applicationReady = true;
  const collect: ControllerObservationCollector = async (environment) => ({
    environment,
    identity,
    journal,
    sampledAtMs: Math.floor(performance.now()),
    runtimeFingerprint: "b".repeat(64),
    stopped: false,
    revalidatePersisted: () => true,
    capabilities: [
      {
        capability: "runtime",
        infrastructure: "healthy",
        application: "verified",
        observedAtMs: 0,
        validForMs: 15000,
      },
      {
        capability: controllerCapability("app:web"),
        infrastructure: "healthy",
        application: applicationReady ? "verified" : "unready",
        observedAtMs: 0,
        validForMs: 15000,
      },
    ],
  });
  try {
    const { directory } = await fixture(collect);
    let binding: Record<string, unknown> = {};
    for (const [session, requirement] of [
      ["application", "app:web"],
      ["tooling", "runtime"],
    ]) {
      await controllerRequest(
        directory,
        {
          method: "observe",
          path: identity.repoPath,
          session,
          profile: "web",
          require: [requirement],
        },
        (value: any) => {
          if (session === "application") binding = value.result;
        },
      );
    }
    const statuses: string[] = [];
    await controllerRequest(
      directory,
      { method: "watch", ...binding, timeout: 8 },
      (value: any) => {
        if (value.result.kind !== "snapshot") return;
        statuses.push(value.result.status);
        if (value.result.status === "READY") applicationReady = false;
      },
    );
    expect(statuses).toContain("READY");
    expect(statuses).toContain("APP_ERROR");
    expect(statuses.indexOf("APP_ERROR")).toBeGreaterThan(statuses.indexOf("READY"));
    await controllerRequest(directory, { method: "status", session: "tooling" }, (value: any) => {
      expect(value.result.sessions[0].status).toBe("READY");
    });
    expect(journal.revision).toBe(1);
    expect(journal.state.observations).toEqual([]);
  } finally {
    fence.mockRestore();
  }
}, 12000);
it("serves two durable consumer bindings and keeps the socket private", async () => {
  const { directory } = await fixture();
  const first = connect(directory);
  const second = connect(directory);
  expect((await first.request({ method: "handshake" })).ok).toBe(true);
  expect((await second.request({ method: "handshake" })).ok).toBe(true);
  const acquired = await first.request({
    method: "observe",
    path: "/fixture/checkout",
    session: "one",
    profile: "web",
    require: ["runtime"],
  });
  expect(acquired.ok).toBe(true);
  expect(
    (
      await second.request({
        method: "observe",
        path: "/fixture/checkout",
        session: "two",
        profile: "web",
        require: ["runtime"],
      })
    ).ok,
  ).toBe(true);
  expect((await first.request({ method: "status" })).result.sessions).toHaveLength(2);
  expect((await first.request({ method: "release", ...acquired.result })).ok).toBe(true);
  expect((await second.request({ method: "status" })).result.sessions).toHaveLength(1);
  expect(fs.statSync(path.join(directory, "control.sock")).mode & 0o777).toBe(0o600);
  first.socket.destroy();
  second.socket.destroy();
});
it("rejects a second live owner without changing its snapshot", async () => {
  const { directory } = await fixture();
  const snapshot = fs.readFileSync(path.join(directory, "snapshot.json"));
  await expect(
    runController({
      directory,
      signal: new AbortController().signal,
      resolve: async () => {
        throw new Error("unused");
      },
    }),
  ).rejects.toThrow();
  expect(fs.readFileSync(path.join(directory, "snapshot.json"))).toEqual(snapshot);
});
it("refuses lost history before exposing a new controller or creating operations", async () => {
  const { directory, abort, run } = await fixture();
  abort.abort();
  await run;
  const snapshotPath = path.join(directory, "snapshot.json");
  fs.unlinkSync(snapshotPath);
  const next = new AbortController();
  const createOperations = vi.fn();
  const listening = vi.fn(() => next.abort());
  await expect(
    runController({
      directory,
      signal: next.signal,
      onListening: listening,
      createOperations,
      resolve: async () => {
        throw new Error("unused");
      },
    }),
  ).rejects.toThrow();
  expect(listening).not.toHaveBeenCalled();
  expect(createOperations).not.toHaveBeenCalled();
  expect(fs.existsSync(snapshotPath)).toBe(false);
});
it("preserves a surviving controller socket when its history is absent", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-")));
  directories.push(directory);
  const original = path.join(directory, "original.sock");
  const socketPath = path.join(directory, "control.sock");
  const stale = net.createServer();
  await new Promise<void>((resolve, reject) => {
    stale.once("error", reject);
    stale.listen(original, resolve);
  });
  fs.chmodSync(original, 0o600);
  fs.renameSync(original, socketPath);
  await new Promise<void>((resolve) => stale.close(() => resolve()));
  const before = fs.lstatSync(socketPath);
  const abort = new AbortController();
  const listening = vi.fn(() => abort.abort());
  await expect(
    runController({
      directory,
      signal: abort.signal,
      onListening: listening,
      resolve: async () => {
        throw new Error("unused");
      },
    }),
  ).rejects.toThrow();
  expect(listening).not.toHaveBeenCalled();
  expect(fs.lstatSync(socketPath).ino).toBe(before.ino);
  expect(fs.existsSync(path.join(directory, "snapshot.json"))).toBe(false);
});
it("preserves owner-lock-only loss evidence across repeated startup attempts", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-")));
  directories.push(directory);
  const lock = path.join(directory, "owner.lock");
  fs.writeFileSync(lock, "interrupted owner evidence", { mode: 0o600 });
  const before = fs.readFileSync(lock);
  const createOperations = vi.fn();
  const listening = vi.fn();
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      runController({
        directory,
        signal: new AbortController().signal,
        onListening: listening,
        createOperations,
        resolve: async () => {
          throw new Error("unused");
        },
      }),
    ).rejects.toThrow();
    expect(fs.readFileSync(lock)).toEqual(before);
    expect(fs.existsSync(path.join(directory, "snapshot.json"))).toBe(false);
  }
  expect(createOperations).not.toHaveBeenCalled();
  expect(listening).not.toHaveBeenCalled();
});
it("rejects an unsupported watch deadline before emitting a successful snapshot", async () => {
  const { controllerRequest } = await import("../controller-client");
  const { directory } = await fixture();
  let binding: Record<string, unknown> = {};
  await controllerRequest(
    directory,
    {
      method: "observe",
      path: "/fixture/checkout",
      session: "one",
      profile: "web",
      require: ["runtime"],
    },
    (value: any) => {
      binding = value.result;
    },
  );
  const emit = vi.fn();
  await expect(
    controllerRequest(directory, { method: "watch", ...binding, timeout: 2_147_484 }, emit),
  ).rejects.toThrow();
  expect(emit).not.toHaveBeenCalled();
});
it("disconnects a client that skips the protocol handshake", async () => {
  const { directory } = await fixture();
  const client = connect(directory);
  const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
  client.socket.write(`${JSON.stringify({ version: 1, id: "request", method: "status" })}\n`);
  await closed;
});
it("streams a gap for a replaced store and ends at the watch deadline", async () => {
  const { controllerRequest } = await import("../controller-client");
  const { directory } = await fixture();
  let binding: Record<string, unknown> = {};
  await controllerRequest(
    directory,
    {
      method: "observe",
      path: "/fixture/checkout",
      session: "one",
      profile: "web",
      require: ["runtime"],
    },
    (value: any) => {
      binding = value.result;
    },
  );
  const results: any[] = [];
  await controllerRequest(
    directory,
    { method: "watch", ...binding, after: "1:0", afterStore: "replaced", timeout: 0 },
    (value: any) => results.push(value.result),
  );
  expect(results[0].kind).toBe("gap");
  expect(results.at(-1).kind).toBe("end");
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, "snapshot.json"), "utf8"));
  expect(snapshot.sessions).toHaveLength(1);
});
it("replays valid cursors, accepts the oldest retained boundary, and gaps future or mismatched cursors", async () => {
  const { controllerRequest } = await import("../controller-client");
  const { directory } = await fixture();
  let binding: Record<string, any> = {};
  await controllerRequest(
    directory,
    {
      method: "observe",
      path: "/fixture/checkout",
      session: "one",
      profile: "web",
      require: ["runtime"],
    },
    (value: any) => {
      binding = value.result;
    },
  );

  const initialResults: any[] = [];
  await controllerRequest(
    directory,
    {
      method: "watch",
      ...binding,
      after: `${binding.epoch}:0`,
      afterStore: binding.store,
      timeout: 0,
    },
    (value: any) => initialResults.push(value.result),
  );
  expect(initialResults.map((result) => result.kind)).toEqual(["snapshot", "event", "end"]);
  expect(initialResults[1].event.sequence).toBe(1);

  for (let index = 0; index < 256; index += 1) {
    await controllerRequest(directory, { method: "renew", ...binding }, (value: any) => {
      binding = value.result;
    });
  }

  const boundaryResults: any[] = [];
  await controllerRequest(
    directory,
    {
      method: "watch",
      ...binding,
      after: `${binding.epoch}:1`,
      afterStore: binding.store,
      timeout: 0,
    },
    (value: any) => boundaryResults.push(value.result),
  );
  const retainedEvents = boundaryResults
    .filter((result) => result.kind === "event")
    .map((result) => result.event.sequence);
  expect(boundaryResults[0].kind).toBe("snapshot");
  expect(retainedEvents[0]).toBe(2);
  expect(retainedEvents.at(-1)).toBe(257);

  const gapCases = [
    { after: `${binding.epoch}:258`, afterStore: binding.store },
    { after: `${binding.epoch + 1}:1`, afterStore: binding.store },
    { after: `${binding.epoch}:1`, afterStore: "other-store" },
  ];
  for (const cursor of gapCases) {
    const results: any[] = [];
    await controllerRequest(
      directory,
      { method: "watch", ...binding, ...cursor, timeout: 0 },
      (value: any) => results.push(value.result),
    );
    expect(results[0].kind).toBe("gap");
    expect(results.at(-1).kind).toBe("end");
  }
}, 15_000);
it("signals a live watch gap when events expire between deliveries", async () => {
  const { controllerRequest } = await import("../controller-client");
  let owner: ControllerSessions | undefined;
  const acquire = ControllerSessions.prototype.acquire;
  const capture = vi.spyOn(ControllerSessions.prototype, "acquire").mockImplementation(function (
    this: ControllerSessions,
    ...args: Parameters<typeof acquire>
  ) {
    owner = this;
    return acquire.apply(this, args);
  });
  try {
    const { directory } = await fixture();
    let binding: any;
    await controllerRequest(
      directory,
      {
        method: "observe",
        path: "/fixture/checkout",
        session: "one",
        profile: "web",
        require: ["runtime"],
      },
      (value: any) => {
        binding = value.result;
      },
    );
    const results: any[] = [];
    await controllerRequest(
      directory,
      { method: "watch", ...binding, timeout: 0 },
      (value: any) => {
        results.push(value.result);
        if (results.length === 1) {
          // Synchronous durable renewals fill the event window before the next delivery tick.
          for (let index = 0; index < 257; index++)
            owner?.renew(binding, Math.floor(performance.now()), Date.now());
        }
      },
    );
    expect(results.map((value) => value.kind)).toEqual(["snapshot", "gap", "end"]);
    expect(results[1].sequence).toBeGreaterThan(results[0].sequence + 256);
    expect(results[1].session.id).toBe("one");
  } finally {
    capture.mockRestore();
  }
}, 15_000);

it("disconnects a subscriber at the output bound while other clients remain responsive", async () => {
  const { controllerRequest } = await import("../controller-client");
  const { directory } = await fixture();
  let binding: any;
  await controllerRequest(
    directory,
    {
      method: "observe",
      path: "/fixture/checkout",
      session: "one",
      profile: "web",
      require: ["runtime"],
    },
    (value: any) => {
      binding = value.result;
    },
  );
  const write = net.Socket.prototype.write;
  let pressured: net.Socket | undefined;
  const pressure = vi.spyOn(net.Socket.prototype, "write").mockImplementation(function (
    this: net.Socket,
    ...args: Parameters<typeof write>
  ) {
    const result = write.apply(this, args);
    const frame = String(args[0]);
    if (frame.includes('"kind":"snapshot"') && frame.includes('"session"')) {
      pressured = this;
      Object.defineProperty(this, "writableLength", { configurable: true, get: () => 262_144 });
    }
    return result;
  } as typeof write);
  try {
    const results: any[] = [];
    // The initial snapshot is delivered; the terminal frame crosses the fixed queue bound.
    await expect(
      controllerRequest(directory, { method: "watch", ...binding, timeout: 0 }, (value: any) =>
        results.push(value.result),
      ),
    ).rejects.toThrow();
    expect(results[0].kind).toBe("snapshot");
    expect(pressured?.destroyed).toBe(true);
    let status: any;
    await controllerRequest(directory, { method: "status", session: "one" }, (value: any) => {
      status = value.result;
    });
    expect(status.sessions[0].id).toBe("one");
  } finally {
    pressure.mockRestore();
  }
});

it("rejects connection 33 while 32 controller clients remain active", async () => {
  const { directory } = await fixture();
  const clients = Array.from({ length: 32 }, () => connect(directory));
  try {
    const handshakes = await Promise.all(
      clients.map((client) => client.request({ method: "handshake" })),
    );
    expect(handshakes.every((result) => result.ok)).toBe(true);

    const rejected = net.createConnection(path.join(directory, "control.sock"));
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        rejected.destroy();
        resolve();
      };
      rejected.once("error", finish);
      rejected.once("close", finish);
    });
  } finally {
    for (const client of clients) client.socket.destroy();
  }
});
it("disconnects a client that sends an oversized frame", async () => {
  const { directory } = await fixture();
  const socket = net.createConnection(path.join(directory, "control.sock"));
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve();
    };
    socket.once("error", finish);
    socket.once("close", finish);
    socket.write(Buffer.alloc(CONTROLLER_FRAME_BYTES + 1, 0x78));
  });
});

async function protectionFixture(collect?: ControllerObservationCollector) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "controller-pin-")));
  directories.push(directory);
  const environment = {
    id: "pin-env",
    repoPath: directory,
    workspace: "pin-workspace",
    provider: "devsy" as const,
    providerId: "provider",
    profile: "web",
    fingerprint: "a".repeat(64),
  };
  const identity = {
    repoPath: directory,
    workspace: environment.workspace,
    provider: environment.provider,
  };
  operationStore.updateReliabilityOperation(identity, () => {});
  const control = {
    proof: () => true,
    held: undefined as Promise<void> | undefined,
    observeHeld: undefined as Promise<void> | undefined,
    observeEntered: () => {},
    cancelled: () => {},
    entered: () => {},
  };
  const start = async () => {
    const abort = new AbortController();
    const ready = deferred<void>();
    const run = runController({
      directory,
      signal: abort.signal,
      onListening: () => ready.resolve(),
      collect,
      resolve: async (_request, _signal, capture) => {
        if (capture) {
          _signal.addEventListener("abort", () => control.cancelled(), { once: true });
          capture(() => control.proof());
          control.entered();
          await control.held;
        }
        if (!capture) {
          control.observeEntered();
          await control.observeHeld;
        }
        return environment;
      },
    });
    await Promise.race([ready.promise, run]);
    const stop = async () => {
      abort.abort();
      await run;
    };
    stops.push(stop);
    return stop;
  };
  const stop = await start();
  const client = connect(directory);
  await client.request({ method: "handshake" });
  const acquired = await client.request({
    method: "observe",
    path: directory,
    session: "pin-session",
    profile: "web",
    require: ["runtime"],
  });
  return { directory, identity, client, binding: acquired.result, control, start, stop };
}

it("persists explicit human pins across release and controller restart without starting a runtime", async () => {
  const f = await protectionFixture();
  const pin = await f.client.request({
    method: "protection-pin",
    ...f.binding,
    expectedProtectionRevision: 0,
    pinned: true,
  });
  expect(pin).toMatchObject({
    ok: true,
    result: {
      protection: { revision: 1, humanPinned: true },
      liveConsumers: 1,
      protectedConsumers: 1,
    },
  });
  const file = operationStore.reliabilityOperationPath(f.identity);
  const bytes = fs.readFileSync(file);
  const replay = await f.client.request({
    method: "protection-pin",
    ...f.binding,
    expectedProtectionRevision: 0,
    pinned: true,
  });
  expect(replay).toMatchObject({
    ok: true,
    result: { protection: { revision: 1, humanPinned: true } },
  });
  expect(fs.readFileSync(file)).toEqual(bytes);
  await f.client.request({ method: "release", ...f.binding });
  f.client.socket.destroy();
  await f.stop();
  await f.start();
  const next = connect(f.directory);
  await next.request({ method: "handshake" });
  const acquired = await next.request({
    method: "observe",
    path: f.directory,
    session: "new-session",
    profile: "web",
    require: ["runtime"],
  });
  expect(acquired.result.epoch).toBeGreaterThan(f.binding.epoch);
  const status = await next.request({ method: "protection-status", ...acquired.result });
  expect(status).toMatchObject({
    ok: true,
    result: { protection: { revision: 1, humanPinned: true }, continuity: "continuity-unknown" },
  });
  expect(fs.readFileSync(file)).toEqual(bytes);
  const unpin = await next.request({
    method: "protection-pin",
    ...acquired.result,
    expectedProtectionRevision: 1,
    pinned: false,
  });
  expect(unpin).toMatchObject({
    ok: true,
    result: { protection: { revision: 2, humanPinned: false } },
  });
  next.socket.destroy();
});

it("rejects a held pin request after another socket releases and reacquires its session", async () => {
  const f = await protectionFixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  f.control.entered = () => entered.resolve();
  f.control.held = held.promise;
  const file = operationStore.reliabilityOperationPath(f.identity);
  const bytes = fs.readFileSync(file);
  const pending = f.client.request({
    method: "protection-pin",
    ...f.binding,
    expectedProtectionRevision: 0,
    pinned: true,
  });
  await entered.promise;
  const other = connect(f.directory);
  await other.request({ method: "handshake" });
  await other.request({ method: "release", ...f.binding });
  const newer = await other.request({
    method: "observe",
    path: f.directory,
    session: "pin-session",
    profile: "web",
    require: ["runtime"],
  });
  expect(newer.result.generation).not.toBe(f.binding.generation);
  held.resolve();
  expect(await pending).toMatchObject({ ok: false });
  expect(fs.readFileSync(file)).toEqual(bytes);
  other.socket.destroy();
  f.client.socket.destroy();
});

it("rechecks persisted ownership after resolution before acknowledging status or pin", async () => {
  const f = await protectionFixture();
  f.control.proof = () => false;
  const file = operationStore.reliabilityOperationPath(f.identity);
  const bytes = fs.readFileSync(file);
  for (const method of ["protection-status", "protection-pin"]) {
    const result = await f.client.request({
      method,
      ...f.binding,
      ...(method === "protection-pin" ? { expectedProtectionRevision: 0, pinned: true } : {}),
    });
    expect(result).toMatchObject({ ok: false });
    expect(fs.readFileSync(file)).toEqual(bytes);
  }
  f.client.socket.destroy();
});

it("refuses pin, replay and status when their absolute deadline passes during journal lock wait", async () => {
  const f = await protectionFixture();
  const pin = await f.client.request({
    method: "protection-pin",
    ...f.binding,
    expectedProtectionRevision: 0,
    pinned: true,
  });
  expect(pin.ok).toBe(true);
  const file = operationStore.reliabilityOperationPath(f.identity);
  const bytes = fs.readFileSync(file);
  const realLock = fileLocks.withFileLockSync;
  const realNow = performance.now.bind(performance);
  let offset = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
  const lock = vi.spyOn(fileLocks, "withFileLockSync").mockImplementation((name, options, run) =>
    realLock(name, options, () => {
      offset += 3001;
      return run();
    }),
  );
  try {
    for (const fields of [
      { method: "protection-status" },
      { method: "protection-pin", expectedProtectionRevision: 0, pinned: true },
      { method: "protection-pin", expectedProtectionRevision: 1, pinned: false },
    ]) {
      expect(await f.client.request({ ...fields, ...f.binding })).toMatchObject({ ok: false });
      expect(fs.readFileSync(file)).toEqual(bytes);
    }
  } finally {
    lock.mockRestore();
    clock.mockRestore();
    f.client.socket.destroy();
  }
});

it("refuses ownership changes during the journal lock wait without writing", async () => {
  const f = await protectionFixture();
  const file = operationStore.reliabilityOperationPath(f.identity);
  const bytes = fs.readFileSync(file);
  const realLock = fileLocks.withFileLockSync;
  const lock = vi.spyOn(fileLocks, "withFileLockSync").mockImplementation((name, options, run) =>
    realLock(name, options, () => {
      f.control.proof = () => false;
      return run();
    }),
  );
  try {
    expect(
      await f.client.request({
        method: "protection-pin",
        ...f.binding,
        expectedProtectionRevision: 0,
        pinned: true,
      }),
    ).toMatchObject({ ok: false });
    expect(fs.readFileSync(file)).toEqual(bytes);
  } finally {
    lock.mockRestore();
    f.client.socket.destroy();
  }
});

it("does not write a pin cancelled while its final transaction waits in the serializer", async () => {
  const f = await protectionFixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  f.control.entered = () => entered.resolve();
  f.control.held = held.promise;
  const file = operationStore.reliabilityOperationPath(f.identity);
  const bytes = fs.readFileSync(file);
  void f.client.request({
    method: "protection-pin",
    ...f.binding,
    expectedProtectionRevision: 0,
    pinned: true,
  });
  await entered.promise;
  const other = connect(f.directory);
  await other.request({ method: "handshake" });
  const blocked = deferred<void>();
  const observerEntered = deferred<void>();
  const cancelled = deferred<void>();
  f.control.observeEntered = () => observerEntered.resolve();
  f.control.cancelled = () => cancelled.resolve();
  f.control.observeHeld = blocked.promise;
  const observation = other.request({
    method: "observe",
    path: f.directory,
    session: "second",
    profile: "web",
    require: ["runtime"],
  });
  // The observer owns the serializer while this completed resolution queues its final transaction.
  await observerEntered.promise;
  held.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.client.socket.destroy();
  await cancelled.promise;
  blocked.resolve();
  await observation;
  const status = await other.request({ method: "status" });
  expect(status.ok).toBe(true);
  expect(fs.readFileSync(file)).toEqual(bytes);
  other.socket.destroy();
});

it("negotiates consent on the exact socket binding without submitting lifecycle work", async () => {
  const operations = { submit: vi.fn(), watch: vi.fn() };
  const { directory } = await fixture(undefined, operations);
  const client = connect(directory);
  try {
    await client.request({ method: "handshake" });
    const acquired = await client.request({
      method: "observe",
      path: "/fixture/checkout",
      session: "consent",
      profile: "web",
      require: ["runtime"],
    });
    expect(acquired.ok).toBe(true);
    const binding = acquired.result;
    expect(
      await client.request({
        method: "parking-consent",
        ...binding,
        expectedConsentRevision: 0,
        parkingConsent: "allow-unusable",
      }),
    ).toMatchObject({ ok: true, result: { consentRevision: 1, parkingConsent: "allow-unusable" } });
    const status = await client.request({ method: "status", session: "consent" });
    expect(status.result.sessions[0]).toMatchObject({
      consentRevision: 1,
      parkingConsent: "allow-unusable",
    });
    await client.request({ method: "release", ...binding });
    const observer = connect(directory);
    try {
      await observer.request({ method: "handshake" });
      expect(
        await observer.request({
          method: "parking-consent",
          ...binding,
          expectedConsentRevision: 1,
          parkingConsent: "protected",
        }),
      ).toMatchObject({ ok: false });
    } finally {
      observer.socket.destroy();
    }
    expect(operations.submit).not.toHaveBeenCalled();
    expect(operations.watch).not.toHaveBeenCalled();
  } finally {
    client.socket.destroy();
  }
});

it("reconnects retained generations only after fresh persisted ownership proof", async () => {
  const f = await protectionFixture();
  await f.client.request({
    method: "parking-consent",
    ...f.binding,
    expectedConsentRevision: 0,
    parkingConsent: "allow-unusable",
  });
  f.client.socket.destroy();
  await f.stop();
  await f.start();
  const request = {
    method: "observe",
    path: f.directory,
    session: "pin-session",
    profile: "web",
    require: ["runtime"],
    reconnect: f.binding,
  };
  const denied = connect(f.directory);
  try {
    await denied.request({ method: "handshake" });
    f.control.proof = () => false;
    expect(await denied.request(request)).toMatchObject({ ok: false });
  } finally {
    denied.socket.destroy();
  }
  f.control.proof = () => true;
  const client = connect(f.directory);
  try {
    await client.request({ method: "handshake" });
    const reconnected = await client.request(request);
    expect(reconnected.ok).toBe(true);
    expect(reconnected.result.generation).not.toBe(f.binding.generation);
    expect(reconnected.result.epoch).toBeGreaterThan(f.binding.epoch);
    const status = await client.request({ method: "status", session: "pin-session" });
    expect(status.result.sessions[0]).toMatchObject({
      parkingConsent: "protected",
      consentRevision: 0,
    });
    const proof = await client.request({ method: "protection-status", ...reconnected.result });
    expect(proof).toMatchObject({
      ok: true,
      result: { unresolvedConsumers: 0, consentSatisfied: false },
    });
  } finally {
    client.socket.destroy();
  }
});

it("reports the exact consumer observation under the journal fence without lifecycle mutation", async () => {
  const published = deferred<void>();
  const publish = ControllerSessions.prototype.publish;
  const observed = vi.spyOn(ControllerSessions.prototype, "publish").mockImplementation(function (
    this: ControllerSessions,
    ...args
  ) {
    publish.apply(this, args);
    published.resolve();
  });
  const collect: ControllerObservationCollector = async (environment) => {
    const identity = {
      repoPath: environment.repoPath,
      workspace: environment.workspace,
      provider: environment.provider,
    };
    return {
      environment,
      identity,
      journal: operationStore.readReliabilityOperation(identity)!,
      sampledAtMs: Math.floor(performance.now()),
      runtimeFingerprint: "b".repeat(64),
      stopped: false,
      revalidatePersisted: () => true,
      capabilities: [
        {
          capability: "runtime",
          infrastructure: "failed",
          application: "unverified",
          observedAtMs: 0,
          validForMs: 15000,
        },
      ],
    };
  };
  const f = await protectionFixture(collect);
  try {
    operationStore.updateReliabilityOperation(f.identity, (record) => {
      record.state.desired = "running";
      record.state.phase = "stable";
    });
    const consent = await f.client.request({
      method: "parking-consent",
      ...f.binding,
      expectedConsentRevision: 0,
      parkingConsent: "allow-unusable",
    });
    expect(consent.ok).toBe(true);
    await published.promise;
    const bytes = fs.readFileSync(operationStore.reliabilityOperationPath(f.identity));
    const status = await f.client.request({ method: "protection-status", ...f.binding });
    expect(status).toMatchObject({
      ok: true,
      result: {
        parkingObservation: "unusable-consumers-proven",
        consentSatisfied: true,
        liveConsumers: 1,
      },
    });
    expect(status.result).not.toHaveProperty("capabilities");
    expect(status.result).not.toHaveProperty("requirements");
    expect(fs.readFileSync(operationStore.reliabilityOperationPath(f.identity))).toEqual(bytes);
    const withdraw = await f.client.request({
      method: "parking-consent",
      ...f.binding,
      expectedConsentRevision: 1,
      parkingConsent: "protected",
    });
    expect(withdraw.ok).toBe(true);
    const invalidated = await f.client.request({ method: "protection-status", ...f.binding });
    expect(invalidated).toMatchObject({
      ok: true,
      result: { parkingObservation: "consumer-set-changed", consentSatisfied: false },
    });
    expect(fs.readFileSync(operationStore.reliabilityOperationPath(f.identity))).toEqual(bytes);
  } finally {
    f.client.socket.destroy();
    observed.mockRestore();
  }
});

it("creates the binding pair only after durable enrollment and passes its resolver to operations", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-binding-pair-")));
  directories.push(directory);
  const abort = new AbortController();
  const ready = deferred<void>();
  let resolveBinding:
    | Parameters<NonNullable<Parameters<typeof runController>[0]["createOperations"]>>[1]
    | undefined;
  const createOperations = vi.fn((_startup: ControllerStartup, resolver: typeof resolveBinding) => {
    expect(resolver).toBe(resolveBinding);
    return undefined;
  });
  const running = runController({
    directory,
    signal: abort.signal,
    onListening: () => ready.resolve(),
    createOperations,
    createBindings: (fingerprint) => {
      const snapshot = JSON.parse(fs.readFileSync(path.join(directory, "snapshot.json"), "utf8"));
      expect(snapshot.version).toBe(3);
      expect(fs.existsSync(path.join(directory, "store-identity.json"))).toBe(true);
      const binding = {
        id: "env",
        repoPath: "/fixture/checkout",
        workspace: "fixture",
        provider: "devsy" as const,
        providerId: "provider",
        profile: "web",
        fingerprint: fingerprint("owner", "config"),
      };
      resolveBinding = async () => binding;
      return {
        resolve: resolveBinding,
        collect: async () => {
          throw new Error("synthetic unavailable evidence");
        },
      };
    },
  });
  stops.push(async () => {
    abort.abort();
    await running;
  });
  await Promise.race([ready.promise, running]);
  expect(createOperations).toHaveBeenCalledOnce();
  const client = connect(directory);
  try {
    await client.request({ method: "handshake" });
    expect(
      await client.request({
        method: "observe",
        path: "/fixture/checkout",
        profile: "web",
        session: "one",
        require: ["runtime"],
      }),
    ).toMatchObject({ ok: true });
  } finally {
    client.socket.destroy();
  }
});

it("releases a retained binding over IPC without touching its replacement or human pin", async () => {
  const f = await protectionFixture();
  await f.client.request({
    method: "protection-pin",
    ...f.binding,
    expectedProtectionRevision: 0,
    pinned: true,
  });
  const file = operationStore.reliabilityOperationPath(f.identity);
  const bytes = fs.readFileSync(file);
  f.client.socket.destroy();
  await f.stop();
  await f.start();
  const client = connect(f.directory);
  try {
    await client.request({ method: "handshake" });
    const current = await client.request({
      method: "observe",
      path: f.directory,
      session: f.binding.session,
      profile: "web",
      require: ["runtime"],
    });
    expect(current).toMatchObject({ ok: true });
    expect(current.result.generation).not.toBe(f.binding.generation);
    expect(await client.request({ method: "release", ...f.binding })).toMatchObject({
      ok: true,
      result: { released: true },
    });
    expect(await client.request({ method: "renew", ...current.result })).toMatchObject({
      ok: true,
      result: current.result,
    });
    expect(await client.request({ method: "release", ...f.binding })).toMatchObject({ ok: false });
    expect(await client.request({ method: "protection-status", ...current.result })).toMatchObject({
      ok: true,
      result: { protection: { revision: 1, humanPinned: true }, unresolvedConsumers: 0 },
    });
    expect(fs.readFileSync(file)).toEqual(bytes);
  } finally {
    client.socket.destroy();
  }
});
