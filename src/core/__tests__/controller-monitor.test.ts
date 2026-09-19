import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ControllerCapacityDirective,
  ControllerMonitor,
  type ControllerObservationBatch,
  controllerCapability,
  environmentIdentity,
  sessionConsumerId,
} from "../controller-monitor";
import { ControllerSessions } from "../controller-sessions";
import { ControllerStore } from "../controller-store";
import { createReliabilityState } from "../reliability-contract";
import type {
  ReliabilityIdentity,
  ReliabilityOperationRecord,
} from "../reliability-operation-store";

const directories: string[] = [];
const monitors: ControllerMonitor[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const environment = {
  id: "env",
  repoPath: "/fixture/checkout",
  workspace: "fixture",
  provider: "devsy" as const,
  providerId: "provider",
  profile: "web",
  fingerprint: "a".repeat(64),
};
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-monitor-"));
  directories.push(directory);
  const sessions = new ControllerSessions(new ControllerStore(directory));
  const first = sessions.acquire("one", environment, ["runtime"], 100, Date.now());
  const state = createReliabilityState("environment", 0, "manual");
  state.desired = "running";
  state.phase = "stable";
  const batch: ControllerObservationBatch = {
    environment,
    identity: {
      repoPath: environment.repoPath,
      workspace: environment.workspace,
      provider: "devsy",
    },
    journal: {
      version: 1,
      identity: {
        repoPath: environment.repoPath,
        workspace: environment.workspace,
        provider: "devsy",
      },
      revision: 1,
      state,
      worker: null,
      effectSequence: 0,
      outcome: null,
    },
    sampledAtMs: 100,
    runtimeFingerprint: "b".repeat(64),
    capabilities: [
      {
        capability: "runtime",
        infrastructure: "healthy",
        application: "verified",
        observedAtMs: 0,
        validForMs: 15000,
      },
    ],
    stopped: false,
    revalidatePersisted: () => true,
  };
  return { sessions, first, batch };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
it("coalesces consumers and independently projects their declared capabilities", async () => {
  const { sessions, batch } = fixture();
  sessions.acquire("two", environment, ["app:web"], 100, Date.now());
  batch.capabilities.push({
    capability: controllerCapability("app:web"),
    infrastructure: "healthy",
    application: "unready",
    observedAtMs: 0,
    validForMs: 15000,
  });
  const collect = vi.fn(async () => batch);
  const monitor = new ControllerMonitor(
    sessions,
    collect,
    async (operation) => operation(),
    () => 100,
    (_identity, _revision, publish) => publish(batch.journal),
  );
  monitors.push(monitor);
  monitor.tick();
  monitor.tick();
  await flush();
  expect(collect).toHaveBeenCalledTimes(1);
  const snapshot = sessions.read();
  expect(sessions.projection(snapshot.sessions[0], 101).status).toBe("READY");
  expect(sessions.projection(snapshot.sessions[1], 101).status).toBe("APP_ERROR");
  expect(sessions.projection(snapshot.sessions[0], 15100).status).toBe("UNKNOWN");
});
it("does not publish an old batch to a reacquired session generation", async () => {
  const { sessions, first, batch } = fixture();
  let finish: (batch: ControllerObservationBatch) => void = () => {};
  const collect = vi.fn(
    () =>
      new Promise<ControllerObservationBatch>((resolve) => {
        finish = resolve;
      }),
  );
  const monitor = new ControllerMonitor(
    sessions,
    collect,
    async (operation) => operation(),
    () => 102,
    (_identity, _revision, publish) => publish(batch.journal),
  );
  monitors.push(monitor);
  monitor.tick();
  sessions.release(first, 102, Date.now());
  sessions.acquire("one", environment, ["runtime"], 102, Date.now());
  batch.sampledAtMs = 102;
  finish(batch);
  await flush();
  expect(sessions.read().sessions[0].observation).toBeUndefined();
});
it("discards readiness when the publication journal fence changed", async () => {
  const { sessions, batch } = fixture();
  const monitor = new ControllerMonitor(
    sessions,
    async () => batch,
    async (operation) => operation(),
    () => 100,
    () => {
      throw new Error("manual stop advanced revision");
    },
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  expect(sessions.read().sessions[0].observation).toBeUndefined();
});
it("keeps only two batches active and schedules the next environment after completion", async () => {
  const { sessions, batch } = fixture();
  sessions.acquire(
    "two",
    { ...environment, id: "second", repoPath: "/fixture/second" },
    ["runtime"],
    100,
    Date.now(),
  );
  sessions.acquire(
    "three",
    { ...environment, id: "third", repoPath: "/fixture/third" },
    ["runtime"],
    100,
    Date.now(),
  );
  const finishers: Array<() => void> = [];
  const collect = vi.fn(
    (env) =>
      new Promise<ControllerObservationBatch>((resolve) => {
        finishers.push(() => resolve({ ...batch, environment: env }));
      }),
  );
  const monitor = new ControllerMonitor(
    sessions,
    collect,
    async (operation) => operation(),
    () => 100,
    (_identity, _revision, publish) => publish(batch.journal),
  );
  monitors.push(monitor);
  monitor.tick();
  monitor.tick();
  expect(collect).toHaveBeenCalledTimes(2);
  finishers[0]();
  await flush();
  monitor.tick();
  expect(collect).toHaveBeenCalledTimes(3);
  expect(collect.mock.calls[2][0].id).toBe("third");
});
it("expires cached readiness with an invalidation event while retaining a live lease", async () => {
  const { sessions, batch } = fixture();
  const monitor = new ControllerMonitor(
    sessions,
    async () => batch,
    async (operation) => operation(),
    () => 100,
    (_identity, _revision, publish) => publish(batch.journal),
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  sessions.tick(10_100, Date.now() + 10_000);
  const before = sessions.read().nextSequence;
  sessions.tick(15_100, Date.now() + 15_000);
  const snapshot = sessions.read();
  expect(snapshot.sessions).toHaveLength(1);
  expect(snapshot.sessions[0].observation).toBeUndefined();
  expect(snapshot.nextSequence).toBe(before + 1);
  expect(snapshot.events.at(-1)?.kind).toBe("invalidated");
});
it("does not let a delayed failure invalidate a replacement generation", async () => {
  const { sessions, first } = fixture();
  let fail: (error: Error) => void = () => {};
  const collect = () =>
    new Promise<ControllerObservationBatch>((_resolve, reject) => {
      fail = reject;
    });
  const monitor = new ControllerMonitor(
    sessions,
    collect,
    async (operation) => operation(),
    () => 100,
  );
  monitors.push(monitor);
  monitor.tick();
  sessions.release(first, 100, Date.now());
  const replacement = sessions.acquire("one", environment, ["runtime"], 100, Date.now());
  fail(new Error("old probe failed"));
  await flush();
  expect(sessions.validate(replacement).generation).toBe(replacement.generation);
});
it("requires reacquisition after proven binding drift", async () => {
  const { ControllerObservationBindingChanged } = await import("../controller-monitor");
  const { sessions, first } = fixture();
  const monitor = new ControllerMonitor(
    sessions,
    async () => {
      throw new ControllerObservationBindingChanged("config changed");
    },
    async (operation) => operation(),
    () => 100,
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  expect(() => sessions.validate(first)).toThrow();
  expect(sessions.read().environments).toEqual([]);
});
it("does not replace timed-out batches whose probes have not drained", async () => {
  const { sessions } = fixture();
  sessions.acquire(
    "two",
    { ...environment, id: "second", repoPath: "/fixture/second" },
    ["runtime"],
    100,
    Date.now(),
  );
  sessions.acquire(
    "three",
    { ...environment, id: "third", repoPath: "/fixture/third" },
    ["runtime"],
    100,
    Date.now(),
  );
  vi.useFakeTimers();
  let now = 100;
  const collect = vi.fn(() => new Promise<ControllerObservationBatch>(() => {}));
  const monitor = new ControllerMonitor(
    sessions,
    collect,
    async (operation) => operation(),
    () => now,
  );
  monitors.push(monitor);
  try {
    monitor.tick();
    expect(collect).toHaveBeenCalledTimes(2);
    now = 10101;
    await vi.advanceTimersByTimeAsync(10001);
    monitor.tick();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(sessions.read().sessions.every((session) => session.observation === undefined)).toBe(
      true,
    );
  } finally {
    monitor.stop();
    vi.useRealTimers();
  }
});

it("asks the operations owner to recover a required capability that failed", async () => {
  const { sessions, batch } = fixture();
  sessions.acquire("two", environment, ["app:web"], 100, Date.now());
  batch.capabilities.push({
    capability: controllerCapability("app:web"),
    infrastructure: "failed",
    application: "unverified",
    observedAtMs: 0,
    validForMs: 15000,
  });
  const recover = vi.fn(
    async (_environment: unknown, _failedCapabilities: string[], _signal: AbortSignal) => {},
  );
  const monitor = new ControllerMonitor(
    sessions,
    async () => batch,
    async (operation) => operation(),
    () => 100,
    (_identity, _revision, publish) => publish(batch.journal),
    recover,
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(recover.mock.calls[0][1]).toEqual([controllerCapability("app:web")]);
});

it("stays idle when a capability outside the required set fails", async () => {
  const { sessions, batch } = fixture();
  batch.capabilities.push({
    capability: controllerCapability("app:web"),
    infrastructure: "failed",
    application: "unverified",
    observedAtMs: 0,
    validForMs: 15000,
  });
  const recover = vi.fn(async () => {});
  const monitor = new ControllerMonitor(
    sessions,
    async () => batch,
    async (operation) => operation(),
    () => 100,
    (_identity, _revision, publish) => publish(batch.journal),
    recover,
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  expect(recover).not.toHaveBeenCalled();
});

it.each([
  "stale",
  "pre-tick",
  "future",
  "released",
  "reacquired",
  "changed-environment",
])("does not recover from a rejected observation (%s)", async (reason) => {
  const { sessions, first, batch } = fixture();
  batch.capabilities[0].infrastructure = "failed";
  let now = 100;
  let finish!: (value: ControllerObservationBatch) => void;
  const recover = vi.fn(async () => {});
  const monitor = new ControllerMonitor(
    sessions,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    async (operation) => operation(),
    () => now,
    (_identity, _revision, publish) => publish(batch.journal),
    recover,
  );
  monitors.push(monitor);
  monitor.tick();
  if (reason === "stale") now = 15_100;
  if (reason === "pre-tick") batch.sampledAtMs = 99;
  if (reason === "future") batch.sampledAtMs = 101;
  if (reason === "released" || reason === "reacquired") {
    sessions.release(first, 100, Date.now());
    if (reason === "reacquired") sessions.acquire("one", environment, ["runtime"], 100, Date.now());
  }
  if (reason === "changed-environment")
    batch.environment = { ...environment, fingerprint: "c".repeat(64) };
  finish(batch);
  await flush();
  expect(recover).not.toHaveBeenCalled();
});

it("recovers only capabilities still required by a matching live consumer", async () => {
  const { sessions, first, batch } = fixture();
  sessions.acquire("two", environment, ["app:web"], 100, Date.now());
  batch.capabilities[0].infrastructure = "failed";
  batch.capabilities.push({
    capability: controllerCapability("app:web"),
    infrastructure: "failed",
    application: "unverified",
    observedAtMs: 0,
    validForMs: 15_000,
  });
  let finish!: (value: ControllerObservationBatch) => void;
  const recover = vi.fn(async (_env: unknown, _failed: string[], _signal: AbortSignal) => {});
  const monitor = new ControllerMonitor(
    sessions,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    async (operation) => operation(),
    () => 100,
    (_identity, _revision, publish) => publish(batch.journal),
    recover,
  );
  monitors.push(monitor);
  monitor.tick();
  sessions.release(first, 100, Date.now());
  finish(batch);
  await flush();
  expect(recover).toHaveBeenCalledOnce();
  expect(recover.mock.calls[0][1]).toEqual([controllerCapability("app:web")]);
});

it.each([
  "released",
  "reacquired",
  "expired",
  "journal",
  "persisted",
  "stopped",
  "remaining",
])("revalidates recovery after asynchronous resolution (%s)", async (reason) => {
  const { sessions, first, batch } = fixture();
  sessions.acquire("two", environment, ["app:web"], 100, Date.now());
  batch.capabilities[0].infrastructure = "failed";
  batch.capabilities.push({
    capability: controllerCapability("app:web"),
    infrastructure: "failed",
    application: "unverified",
    observedAtMs: 0,
    validForMs: 15_000,
  });
  let now = 100;
  let changedJournal = false;
  let validate: (() => { journalRevision: number; failedCapabilities: string[] }) | undefined;
  const monitor = new ControllerMonitor(
    sessions,
    async () => batch,
    async (operation) => operation(),
    () => now,
    (_identity, _revision, publish) => {
      if (changedJournal) throw new Error("Journal revision changed");
      return publish(batch.journal);
    },
    async (...args: unknown[]) => {
      validate = args[3] as typeof validate;
    },
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  expect(validate).toBeTypeOf("function");
  expect(validate!()).toEqual({
    journalRevision: 1,
    failedCapabilities: ["runtime", controllerCapability("app:web")],
  });
  if (reason === "released" || reason === "reacquired" || reason === "remaining") {
    sessions.release(first, now, Date.now());
    if (reason !== "remaining") {
      const second = sessions.read().sessions.find((entry) => entry.id === "two")!;
      const snapshot = sessions.read();
      sessions.release(
        {
          store: snapshot.store,
          epoch: snapshot.epoch,
          session: second.id,
          generation: second.generation,
        },
        now,
        Date.now(),
      );
    }
    if (reason === "reacquired") sessions.acquire("one", environment, ["runtime"], now, Date.now());
  }
  if (reason === "expired") now = 15_100;
  if (reason === "journal") changedJournal = true;
  if (reason === "persisted") batch.revalidatePersisted = () => false;
  if (reason === "stopped") monitor.stop();
  if (reason === "remaining") {
    expect(validate!()).toEqual({
      journalRevision: 1,
      failedCapabilities: [controllerCapability("app:web")],
    });
  } else if (reason === "released" || reason === "reacquired") {
    expect(validate!().failedCapabilities).toEqual([]);
  } else {
    expect(() => validate!()).toThrow();
  }
});

it("requires a current failed capability for every consenting parking consumer", async () => {
  const { sessions, first, batch } = fixture();
  const second = sessions.acquire("two", environment, ["app:web"], 100, Date.now());
  sessions.setParkingConsent(first, 0, "allow-unusable", 100, Date.now());
  sessions.setParkingConsent(second, 0, "allow-unusable", 100, Date.now());
  batch.capabilities[0].infrastructure = "failed";
  batch.capabilities.push({
    capability: controllerCapability("app:web"),
    infrastructure: "failed",
    application: "unverified",
    observedAtMs: 0,
    validForMs: 15000,
  });
  const fence = vi.fn((_identity, _revision, publish) => publish(batch.journal));
  const monitor = new ControllerMonitor(
    sessions,
    async () => batch,
    async (operation) => operation(),
    () => 100,
    fence,
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  const calls = fence.mock.calls.length;
  expect(monitor.parkingObservation(environment, batch.journal)).toBe("unusable-consumers-proven");
  expect(fence).toHaveBeenCalledTimes(calls);
});

async function parkingFixture(prepare?: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  const time = { now: 100 };
  const wall = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => wall + time.now - 100);
  f.sessions.setParkingConsent(f.first, 0, "allow-unusable", 100, Date.now());
  f.batch.capabilities[0].infrastructure = "failed";
  prepare?.(f);
  const collect = vi.fn(async () => f.batch);
  const fence = vi.fn((_identity, _revision, publish) => publish(f.batch.journal));
  const monitor = new ControllerMonitor(
    f.sessions,
    collect,
    async (operation) => operation(),
    () => time.now,
    fence,
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  return {
    ...f,
    time,
    collect,
    fence,
    monitor,
    proof: () => monitor.parkingObservation(environment, f.batch.journal),
  };
}
afterEach(() => vi.restoreAllMocks());

it.each([
  ["healthy", "consumer-usable"],
  ["unknown", "capability-unknown"],
  ["unready", "application-error"],
  ["missing", "capability-unknown"],
  ["duplicate", "observation-unavailable"],
] as const)("refuses parking observation with %s required evidence", async (kind, reason) => {
  const f = await parkingFixture(({ batch }) => {
    if (kind === "healthy" || kind === "unknown") batch.capabilities[0].infrastructure = kind;
    else if (kind === "unready") batch.capabilities[0].application = "unready";
    else if (kind === "missing") batch.capabilities = [];
    else batch.capabilities.push({ ...batch.capabilities[0] });
  });
  expect(f.proof()).toBe(reason);
});

it("vetoes a usable second consumer even when another consumer's requirement failed", async () => {
  const f = await parkingFixture(({ sessions, batch }) => {
    const binding = sessions.acquire("two", environment, ["app:web"], 100, Date.now());
    sessions.setParkingConsent(binding, 0, "allow-unusable", 100, Date.now());
    batch.capabilities.push({
      ...batch.capabilities[0],
      capability: controllerCapability("app:web"),
      infrastructure: "healthy",
    });
  });
  expect(f.proof()).toBe("consumer-usable");
});

it("allows a healthy sibling requirement alongside positive failure for the same consumer", async () => {
  const f = await parkingFixture(({ sessions, first, batch }) => {
    sessions.release(first, 100, Date.now());
    const binding = sessions.acquire("one", environment, ["runtime", "app:web"], 100, Date.now());
    sessions.setParkingConsent(binding, 0, "allow-unusable", 100, Date.now());
    batch.capabilities.push({
      ...batch.capabilities[0],
      capability: controllerCapability("app:web"),
      infrastructure: "healthy",
    });
  });
  expect(f.proof()).toBe("unusable-consumers-proven");
});

it.each([
  "added",
  "released",
  "reacquired",
  "consent",
  "expired",
  "clock",
  "environment",
] as const)("invalidates original parking consumers after %s", async (kind) => {
  const f = await parkingFixture();
  expect(f.proof()).toBe("unusable-consumers-proven");
  if (kind === "added") f.sessions.acquire("two", environment, ["runtime"], 100, Date.now());
  if (kind === "released" || kind === "reacquired") f.sessions.release(f.first, 100, Date.now());
  if (kind === "reacquired") f.sessions.acquire("one", environment, ["runtime"], 100, Date.now());
  if (kind === "consent") f.sessions.setParkingConsent(f.first, 1, "protected", 100, Date.now());
  if (kind === "expired") {
    for (const now of [10100, 20100, 30100]) {
      f.time.now = now;
      f.sessions.tick(now, Date.now());
    }
  }
  if (kind === "clock") f.time.now = 99;
  if (kind === "environment") {
    expect(
      f.monitor.parkingObservation(
        { ...environment, fingerprint: "c".repeat(64) },
        f.batch.journal,
      ),
    ).toBe("consumer-set-changed");
  } else expect(f.proof()).toBe("consumer-set-changed");
});

it("retains uncertainty about an expired consumer through a fresh consenting observation", async () => {
  let lost: ReturnType<ControllerSessions["acquire"]> | undefined;
  const f = await parkingFixture(({ sessions }) => {
    lost = sessions.acquire("lost", environment, ["runtime"], 100, Date.now());
  });
  for (const now of [10100, 20100, 30100]) {
    f.time.now = now;
    f.sessions.renew(f.first, now, Date.now());
  }
  f.batch.sampledAtMs = f.time.now;
  f.monitor.tick();
  await flush();
  expect(f.sessions.read().retainedSessions).toHaveLength(1);
  expect(f.proof()).toBe("unresolved-consumers");
  f.sessions.release(lost!, f.time.now, Date.now());
  expect(f.proof()).toBe("consumer-set-changed");
  expect(f.sessions.validate(f.first).generation).toBe(f.first.generation);
});

it("rejects incomplete migrated history even with a fresh consenting observation", async () => {
  const f = await parkingFixture(({ sessions }) => {
    const read = sessions.read.bind(sessions);
    vi.spyOn(sessions, "read").mockImplementation(() => ({ ...read(), history: "legacy-unknown" }));
  });
  expect(f.proof()).toBe("history-unproven");
});

it("preserves default protection in a fresh observation", async () => {
  const f = await parkingFixture(({ sessions, first }) =>
    sessions.setParkingConsent(first, 1, "protected", 100, Date.now()),
  );
  expect(f.proof()).toBe("consent-withheld");
});

it("does not revive old evidence after a newer probe fails", async () => {
  const f = await parkingFixture();
  expect(f.proof()).toBe("unusable-consumers-proven");
  f.collect.mockRejectedValueOnce(new Error("fixture probe failed"));
  f.time.now = 5100;
  f.monitor.tick();
  await flush();
  expect(f.collect).toHaveBeenCalledTimes(2);
  expect(f.proof()).toBe("observation-stale");
});

it.each([
  "sample",
  "fingerprint",
  "expiry",
  "revision",
] as const)("requires the producing current projection (%s)", async (change) => {
  const f = await parkingFixture();
  const observation = { ...f.sessions.validate(f.first).observation! };
  if (change === "sample") observation.sampledAtMs++;
  if (change === "fingerprint") observation.runtimeFingerprint = "c".repeat(64);
  if (change === "expiry") observation.validUntilMs++;
  if (change === "revision") observation.journalRevision++;
  f.time.now = 101;
  f.sessions.publish([f.first], new Map([[f.first.session, observation]]), 101, Date.now());
  expect(f.proof()).toBe("observation-stale");
});

it("expires parking evidence while an ordinary renewal keeps its exact consumer alive", async () => {
  const f = await parkingFixture();
  f.time.now = 10100;
  f.sessions.renew(f.first, f.time.now, Date.now());
  f.time.now = 15100;
  expect(f.proof()).toBe("observation-stale");
  expect(f.sessions.validate(f.first)).toBeDefined();
});

it.each([
  "false",
  "throw",
] as const)("refuses missing producing ownership proof (%s)", async (result) => {
  let valid = true;
  const f = await parkingFixture(({ batch }) => {
    batch.revalidatePersisted = () => {
      if (!valid && result === "throw") throw new Error("private fixture path");
      return valid;
    };
  });
  valid = false;
  expect(f.proof()).toBe("ownership-unproven");
});

it.each([
  "identity",
  "revision",
  "pin",
  "stop",
  "parked",
  "phase",
  "worker",
  "undrained",
  "unknown-exec",
  "interrupted-exec",
] as const)("preserves the current journal parking veto (%s)", async (change) => {
  const f = await parkingFixture();
  const journal = f.batch.journal;
  if (change === "identity") journal.identity = { ...journal.identity, workspace: "other" };
  if (change === "revision") journal.revision++;
  if (change === "pin") journal.consumerProtection = { version: 1, revision: 1, humanPinned: true };
  if (change === "stop") journal.state.desired = "stopped-by-user";
  if (change === "parked") journal.state.desired = "parked-for-capacity";
  if (change === "phase") journal.state.phase = "starting";
  if (change === "worker")
    journal.worker = { id: "worker", operationId: "op", pid: 123, birth: "fixture" };
  if (change === "undrained" || change === "unknown-exec" || change === "interrupted-exec")
    journal.state.operation = {
      id: "op",
      kind: "exec",
      drained: change !== "undrained",
      status:
        change === "unknown-exec"
          ? "COMPLETION_UNKNOWN"
          : change === "interrupted-exec"
            ? "INTERRUPTED"
            : "COMPLETED",
      exitCode: null,
    };
  expect(f.proof()).toBe(
    change === "identity" || change === "revision"
      ? "journal-changed"
      : change === "pin"
        ? "human-pinned"
        : change === "stop" || change === "parked"
          ? "intent-protected"
          : "lifecycle-unsettled",
  );
});

it("preserves an uncertain historical command despite a settled current ensure", async () => {
  const f = await parkingFixture();
  f.batch.journal.state.operation = {
    id: "ensure",
    kind: "ensure",
    drained: true,
    status: "INTERRUPTED",
    exitCode: null,
  };
  expect(f.proof()).toBe("unusable-consumers-proven");
  f.batch.journal.state.operationHistory.push({
    id: "exec",
    kind: "exec",
    drained: true,
    status: "INTERRUPTED",
    exitCode: null,
    key: "key",
    profile: "web",
    consumer: { id: "consumer", requiredCapabilities: ["runtime"], pinned: false },
  });
  expect(f.proof()).toBe("lifecycle-unsettled");
});

it("discards parking evidence when stopped or its environment is removed", async () => {
  const f = await parkingFixture();
  f.sessions.release(f.first, 100, Date.now());
  f.monitor.tick();
  expect(f.proof()).toBe("observation-unavailable");
  f.monitor.stop();
  expect(f.proof()).toBe("observation-unavailable");
});

it("keeps retained capability evidence independent from later collector mutations", async () => {
  const f = await parkingFixture();
  f.batch.capabilities[0].infrastructure = "healthy";
  f.batch.environment = { ...environment, fingerprint: "c".repeat(64) };
  expect(f.proof()).toBe("unusable-consumers-proven");
});

it("does not grant exact-set proof to a consumer added while the batch was running", async () => {
  const { sessions, first, batch } = fixture();
  sessions.setParkingConsent(first, 0, "allow-unusable", 100, Date.now());
  batch.capabilities[0].infrastructure = "failed";
  let finish!: (value: typeof batch) => void;
  const monitor = new ControllerMonitor(
    sessions,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    async (operation) => operation(),
    () => 100,
    (_identity, _revision, publish) => publish(batch.journal),
  );
  monitors.push(monitor);
  monitor.tick();
  const added = sessions.acquire("second", environment, ["runtime"], 100, Date.now());
  sessions.setParkingConsent(added, 0, "allow-unusable", 100, Date.now());
  finish(batch);
  await flush();
  expect(sessions.validate(first).observation).toBeDefined();
  expect(sessions.validate(added).observation).toBeUndefined();
  expect(monitor.parkingObservation(environment, batch.journal)).toBe("consumer-set-changed");
});

it("does not retain an in-flight batch after its environment was released", async () => {
  const { sessions, first, batch } = fixture();
  let finish!: (value: typeof batch) => void;
  const monitor = new ControllerMonitor(
    sessions,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    async (operation) => operation(),
    () => 100,
    (_identity, _revision, publish) => publish(batch.journal),
  );
  monitors.push(monitor);
  monitor.tick();
  sessions.release(first, 100, Date.now());
  finish(batch);
  await flush();
  expect(monitor.parkingObservation(environment, batch.journal)).toBe("observation-unavailable");
});

/**
 * One committed parking observation plus the exact journal a capacity pass reads.
 * The directive is injected, so these tests observe the proof the monitor hands
 * the controller rather than re-testing controller policy.
 */
async function capacityPassFixture(options: {
  desired: "running" | "parked-for-capacity";
  settled?: boolean;
}) {
  const f = fixture();
  const time = { now: 100 };
  const wall = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => wall + time.now - 100);
  f.sessions.setParkingConsent(f.first, 0, "allow-unusable", 100, Date.now());
  f.batch.capabilities[0].infrastructure = "failed";
  // The pass reads the same journal the observation committed, so the proof is
  // evaluated against the revision the environment actually published.
  const journal = f.batch.journal as unknown as { version: number; revision: number };
  journal.version = 2;
  journal.revision = 7;
  const state = createReliabilityState("environment", 0);
  state.desired = options.desired;
  state.phase = options.desired === "parked-for-capacity" ? "idle" : "stable";
  state.profile = "web";
  state.admission = "waiting";
  state.stopProof = {
    workloadsStopped: options.settled === true,
    routesRemoved: options.settled === true,
  };
  f.batch.journal.state = state;
  const record = f.batch.journal as unknown as ReliabilityOperationRecord;
  const calls: {
    kind: string;
    revision: number;
    proof?: string;
    demand?: string[] | undefined;
    error?: string;
    identity?: ReliabilityIdentity;
  }[] = [];
  const demand: { run?: () => string[] } = {};
  const directive: ControllerCapacityDirective = {
    park: vi.fn(async (_environment, revision, observation) => {
      calls.push({ kind: "park", revision, proof: observation(record) });
      return true;
    }),
    parkedStop: vi.fn(async (identity) => {
      calls.push({ kind: "parkedStop", revision: record.revision, identity });
      return true;
    }),
    resume: vi.fn(async (_environment, revision, liveDemand) => {
      demand.run = liveDemand;
      let value: string[] | undefined;
      let error: string | undefined;
      try {
        value = liveDemand();
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
      calls.push({ kind: "resume", revision, demand: value, ...(error ? { error } : {}) });
      return true;
    }),
  };
  const monitor = new ControllerMonitor(
    f.sessions,
    async () => f.batch,
    async (operation) => operation(),
    () => time.now,
    (_identity, _revision, publish) => publish(f.batch.journal),
    undefined,
    directive,
    () => record,
    () => [record],
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  // Park eligibility is only meaningful for running intent; a parked environment
  // correctly reports protected intent instead.
  if (options.desired === "running")
    expect(monitor.parkingObservation(environment, record)).toBe("unusable-consumers-proven");
  monitor.tick();
  await flush();
  return { ...f, time, journal: record, calls, demand, directive, monitor };
}

it("parks a running environment once with the live observation proof", async () => {
  const f = await capacityPassFixture({ desired: "running" });
  expect(f.directive.park).toHaveBeenCalledTimes(1);
  expect(f.calls).toEqual([{ kind: "park", revision: 7, proof: "unusable-consumers-proven" }]);
  f.time.now += 1_000;
  f.monitor.tick();
  await flush();
  expect(f.directive.park).toHaveBeenCalledTimes(1);
});

it("refuses to park when the environment proved a usable consumer", async () => {
  const f = await capacityPassFixture({ desired: "running" });
  f.batch.capabilities[0].infrastructure = "healthy";
  // A committed batch is retained independently, so the refusal requires a fresh
  // observation: re-collect, then let the next pass decide against it.
  f.time.now += 6_000;
  f.batch.sampledAtMs = f.time.now;
  f.monitor.tick();
  await flush();
  f.time.now += 6_000;
  f.batch.sampledAtMs = f.time.now;
  f.monitor.tick();
  await flush();
  expect(f.directive.park).toHaveBeenCalledTimes(3);
  expect(f.calls.at(-1)).toEqual({
    kind: "park",
    revision: 7,
    proof: "consumer-usable",
  });
});

it("resumes a settled park with exact live demand and reconciles an unsettled one", async () => {
  const settled = await capacityPassFixture({ desired: "parked-for-capacity", settled: true });
  expect(settled.directive.resume).toHaveBeenCalledTimes(1);
  expect(settled.directive.parkedStop).not.toHaveBeenCalled();
  const live = settled.sessions.read().sessions[0];
  expect(settled.calls[0]).toEqual({
    kind: "resume",
    revision: 7,
    demand: [
      sessionConsumerId({
        store: settled.sessions.read().store,
        epoch: settled.sessions.read().epoch,
        session: live.id,
        generation: live.generation,
      }),
    ],
  });
  const unsettled = await capacityPassFixture({ desired: "parked-for-capacity" });
  expect(unsettled.directive.parkedStop).toHaveBeenCalledTimes(1);
  expect(unsettled.calls.at(-1)).toMatchObject({
    kind: "parkedStop",
    identity: environmentIdentity(environment),
  });
  expect(unsettled.directive.resume).not.toHaveBeenCalled();
});

it("re-drives a committed park from the durable journal after the last session is gone", async () => {
  const f = fixture();
  const time = { now: 100 };
  f.sessions.release(f.first, time.now, Date.now());
  const record = {
    version: 2,
    identity: environmentIdentity(environment),
    revision: 9,
    state: createReliabilityState("environment", 0, "capacity-managed"),
    worker: null,
    effectSequence: 0,
    outcome: null,
  } as unknown as ReliabilityOperationRecord;
  record.state.desired = "parked-for-capacity";
  record.state.phase = "idle";
  record.state.stopProof = { workloadsStopped: false, routesRemoved: false };
  const parkedStop = vi.fn(async (_identity: ReliabilityIdentity) => true);
  const directive: ControllerCapacityDirective = {
    park: vi.fn(async () => false),
    parkedStop,
    resume: vi.fn(async () => false),
  };
  const monitor = new ControllerMonitor(
    f.sessions,
    async () => f.batch,
    async (operation) => operation(),
    () => time.now,
    (_identity, _revision, publish) => publish(f.batch.journal),
    undefined,
    directive,
    () => record,
    () => [record],
  );
  monitors.push(monitor);
  monitor.tick();
  await flush();
  expect(parkedStop).toHaveBeenCalledTimes(1);
  expect(parkedStop.mock.calls[0][0]).toEqual(environmentIdentity(environment));
  expect(directive.park).not.toHaveBeenCalled();
  expect(directive.resume).not.toHaveBeenCalled();
  // One bounded action per pass: the same park is not re-driven inside the scan interval.
  monitor.tick();
  await flush();
  expect(parkedStop).toHaveBeenCalledTimes(1);
  time.now += 10_000;
  monitor.tick();
  await flush();
  expect(parkedStop).toHaveBeenCalledTimes(2);
});

it("refuses resume demand when the consumer set changed after the observation", async () => {
  const f = await capacityPassFixture({ desired: "parked-for-capacity", settled: true });
  const demand = f.demand.run;
  expect(demand).toBeDefined();
  const added = f.sessions.acquire("late", environment, ["runtime"], 100, Date.now());
  f.sessions.setParkingConsent(added, 0, "allow-unusable", 100, Date.now());
  expect(() => demand!()).toThrow(/demand/);
});
