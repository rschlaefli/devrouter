import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ControllerMonitor,
  type ControllerObservationBatch,
  controllerCapability,
} from "../controller-monitor";
import { ControllerSessions } from "../controller-sessions";
import { ControllerStore } from "../controller-store";
import { createReliabilityState } from "../reliability-contract";

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
