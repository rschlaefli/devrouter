import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type ControllerObservationCollector, controllerCapability } from "../controller-monitor";
import { CONTROLLER_FRAME_BYTES } from "../controller-protocol";
import { runController } from "../controller-server";
import { ControllerSessions } from "../controller-sessions";
import { createReliabilityState } from "../reliability-contract";
import * as operationStore from "../reliability-operation-store";

const directories: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
async function fixture(collect?: ControllerObservationCollector) {
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
});
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
});

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
