import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReliabilityEvent } from "../reliability-contract";
import type { ReliabilityIdentity } from "../reliability-operation-store";
import type { LifecycleWorkerRequest } from "../reliability-worker";

const fixture = vi.hoisted(() => ({
  roots: [] as string[],
  checkouts: [] as string[],
  runLifecycleWorker: vi.fn(),
  newLifecycleIds: vi.fn(),
  workerGroupAbsent: vi.fn(),
  processBirthIdentity: vi.fn(),
  inspectManagedStopContainers: vi.fn(),
  inspectWorkspaceContainers: vi.fn(),
  resolveRunningWorkspaceContainer: vi.fn(),
  listHostRouteState: vi.fn(),
  readManagedRuntimeState: vi.fn(),
  withWorkspaceLifecycleLock: vi.fn(),
}));

vi.mock("../router", async () => {
  const actualFs = await import("node:fs");
  const actualOs = await import("node:os");
  const actualPath = await import("node:path");
  const root = actualFs.mkdtempSync(actualPath.join(actualOs.tmpdir(), "reliability-lifecycle-"));
  actualFs.chmodSync(root, 0o700);
  fixture.roots.push(root);
  return { DEVROUTER_HOME: root };
});

vi.mock("../devpod-environment", () => ({
  inspectManagedStopContainers: fixture.inspectManagedStopContainers,
  inspectWorkspaceContainers: fixture.inspectWorkspaceContainers,
  resolveRunningWorkspaceContainer: fixture.resolveRunningWorkspaceContainer,
}));

vi.mock("../file-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../file-lock")>();
  return {
    ...actual,
    processBirthIdentity: fixture.processBirthIdentity,
    withFileLockSync: vi.fn((_lockPath: string, _options: unknown, operation: () => unknown) =>
      operation(),
    ),
  };
});

vi.mock("../host-routes", () => ({ listHostRouteState: fixture.listHostRouteState }));

vi.mock("../managed-runtime-state", () => ({
  readManagedRuntimeState: fixture.readManagedRuntimeState,
}));

vi.mock("../reliability-worker", () => ({
  newLifecycleIds: fixture.newLifecycleIds,
  runLifecycleWorker: fixture.runLifecycleWorker,
  workerGroupAbsent: fixture.workerGroupAbsent,
}));

vi.mock("../workspace", () => ({
  comparableWorkspacePath: (repoPath: string) => repoPath,
  isLinkedWorktree: () => false,
  readPersistedWorkspace: () => undefined,
  resolveWorktreeWorkspace: () => undefined,
  sameWorkspacePath: (left: string, right: string) => left === right,
  withWorkspaceLifecycleLock: fixture.withWorkspaceLifecycleLock,
}));

vi.mock("../workspace-ensure", () => ({ resolveLinkedTarget: vi.fn() }));
vi.mock("../workspace-runtime", () => ({ resolveWorkspaceRuntimeOrDefault: () => "devsy" }));

const originalConnectedDescriptor = Object.getOwnPropertyDescriptor(process, "connected");

function setProcessConnected(value: boolean): void {
  Object.defineProperty(process, "connected", {
    configurable: true,
    enumerable: originalConnectedDescriptor?.enumerable ?? false,
    value,
    writable: originalConnectedDescriptor?.writable ?? true,
  });
}

function restoreProcessConnected(): void {
  if (originalConnectedDescriptor) {
    Object.defineProperty(process, "connected", originalConnectedDescriptor);
  } else {
    Reflect.deleteProperty(process, "connected");
  }
}

function newCheckout(): string {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "reliability-lifecycle-checkout-"));
  fs.chmodSync(checkout, 0o700);
  fixture.checkouts.push(checkout);
  return checkout;
}

function defaultContainer(repoPath: string) {
  return {
    id: "container-1",
    state: { Running: false },
    labels: {
      "com.docker.compose.project": "synthetic-project",
      "com.docker.compose.project.working_dir": path.join(repoPath, ".devcontainer"),
    },
    mounts: [],
    networks: {},
  };
}

async function loadLifecycleModules() {
  const lifecycle = await import("../reliability-lifecycle");
  const contract = await import("../reliability-contract");
  const model = await import("../reliability-model");
  const store = await import("../reliability-operation-store");
  return { contract, lifecycle, model, store };
}

async function seedWorkerRequest(kind: "ensure" | "exec" = "ensure") {
  const { contract, lifecycle, model, store } = await loadLifecycleModules();
  const identity: ReliabilityIdentity = {
    repoPath: newCheckout(),
    workspace: null,
    provider: "devsy",
  };
  store.updateReliabilityOperation(identity, (record) => {
    const event: ReliabilityEvent = {
      ...contract.reliabilityFence(record.state),
      type: "operation-request",
      kind,
      key: "request-key",
      operationId: "operation-id",
      profile: "full",
      consumer: { id: "manual-cli", requiredCapabilities: [], pinned: false },
      runtimeRunning: true,
    };
    let transition = model.stepReliability(record.state, event, 1);
    expect(transition.outcome).toBe("accepted");
    transition = model.stepReliability(
      transition.state,
      { ...contract.reliabilityFence(transition.state), type: "dispatch" },
      2,
    );
    expect(transition.outcome).toBe("accepted");
    transition = model.stepReliability(
      transition.state,
      {
        ...contract.reliabilityFence(transition.state),
        type: "dispatch-persisted",
        operationId: "operation-id",
      },
      3,
    );
    expect(transition.outcome).toBe("accepted");
    record.state = transition.state;
    record.worker = {
      id: "worker-id",
      operationId: "operation-id",
      pid: process.pid,
      birth: "proc:worker",
    };
  });
  const record = store.readReliabilityOperation(identity);
  if (!record) throw new Error("Synthetic worker fixture was not persisted.");
  const request: LifecycleWorkerRequest = {
    kind,
    repoPath: identity.repoPath,
    identity,
    requestId: "request-key",
    operationId: "operation-id",
    workerId: "worker-id",
    fence: contract.reliabilityFence(record.state),
    options: {},
  };
  return { contract, identity, lifecycle, model, request, store };
}

async function seedStopRequest() {
  const { contract, lifecycle, model, store } = await loadLifecycleModules();
  const identity: ReliabilityIdentity = {
    repoPath: newCheckout(),
    workspace: null,
    provider: "devsy",
  };
  store.updateReliabilityOperation(identity, (record) => {
    const event: ReliabilityEvent = {
      ...contract.reliabilityFence(record.state),
      type: "stop",
    };
    const transition = model.stepReliability(record.state, event, 1);
    expect(transition.outcome).toBe("accepted");
    record.state = transition.state;
  });
  const record = store.readReliabilityOperation(identity);
  if (!record) throw new Error("Synthetic stop fixture was not persisted.");
  const request: LifecycleWorkerRequest = {
    kind: "stop",
    repoPath: identity.repoPath,
    identity,
    requestId: "stop-request",
    operationId: "stop-operation",
    workerId: "stop-worker",
    fence: contract.reliabilityFence(record.state),
    options: {},
  };
  return { identity, lifecycle, request, store };
}

beforeEach(() => {
  for (const root of fixture.roots)
    fs.rmSync(path.join(root, "controller"), { recursive: true, force: true });
  vi.resetModules();
  vi.clearAllMocks();
  fixture.newLifecycleIds.mockReturnValue({
    requestId: "request-key",
    operationId: "operation-id",
    workerId: "worker-id",
  });
  fixture.runLifecycleWorker.mockResolvedValue({ ok: true });
  fixture.workerGroupAbsent.mockReturnValue(true);
  fixture.processBirthIdentity.mockReturnValue("proc:test");
  fixture.inspectManagedStopContainers.mockReturnValue([]);
  fixture.inspectWorkspaceContainers.mockReturnValue([]);
  fixture.resolveRunningWorkspaceContainer.mockReturnValue(undefined);
  fixture.listHostRouteState.mockReturnValue([]);
  fixture.readManagedRuntimeState.mockReturnValue(undefined);
  fixture.withWorkspaceLifecycleLock.mockImplementation(
    async (_repoPath: string, operation: () => Promise<unknown>) => operation(),
  );
});

it("persists an operation reference without dispatch and lets stop supersede it", async () => {
  const { lifecycle, store, contract } = await loadLifecycleModules();
  const repoPath = newCheckout();
  const request = lifecycle.prepareLifecycleOperation("ensure", repoPath, { profile: "full" });
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
  const pending = store.readReliabilityOperation(request.identity)!;
  expect(pending.worker).toBeNull();
  expect(pending.state.operation).toMatchObject({ id: request.operationId, status: "NOT_STARTED" });
  const stop = lifecycle.prepareLifecycleOperation("stop", repoPath);
  expect(stop.fence.intentRevision).toBeGreaterThan(request.fence.intentRevision);
  expect(
    contract.reliabilityFence(store.readReliabilityOperation(request.identity)!.state),
  ).toEqual(stop.fence);
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
});

it.each([
  false,
  true,
])("binds a persisted reservation only to current intent (stop intervenes: %s)", async (stopped) => {
  const { lifecycle, store } = await loadLifecycleModules();
  const { CapacityStore } = await import("../capacity-store");
  const { DEVROUTER_HOME } = await import("../router");
  const request = lifecycle.prepareLifecycleOperation("ensure", newCheckout());
  const record = store.readReliabilityOperation(request.identity)!;
  const now = Date.now();
  const capacities = new CapacityStore(path.join(DEVROUTER_HOME, "controller"));
  const admission = capacities.reserve(
    {
      environmentId: record.state.environmentId,
      operationId: request.operationId,
      reservationId: "reserved",
      policyRevision: 1,
      totals: { host: 1 },
      startup: true,
      heavy: false,
    },
    { host: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 1, heavySlots: 1 } },
    {
      host: {
        sampledAtMs: now,
        pressure: "normal",
        unmanagedBytes: 0,
        sharedBytes: 0,
        ownedBytes: {},
      },
    },
    now,
    15_000,
    undefined,
    capacities.read().revision,
  );
  expect(admission.admitted).toBe(true);
  if (stopped) lifecycle.prepareLifecycleOperation("stop", request.repoPath);
  const bind = () =>
    lifecycle.bindLifecycleCapacity(request, {
      reservationId: "reserved",
      policyRevision: 1,
      validUntilMs: now + 15_000,
    });
  if (stopped) expect(bind).toThrow("intent changed");
  else {
    expect(bind).not.toThrow();
    expect(store.readReliabilityOperation(request.identity)).toMatchObject({
      version: 2,
      capacity: { workerId: request.workerId },
    });
  }
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
});

it.each([
  30, 100,
])("rebinds drained intent only after admitting exec growth of %s bytes", async (bytes) => {
  const { lifecycle, store } = await loadLifecycleModules();
  const { CapacityStore } = await import("../capacity-store");
  const { DEVROUTER_HOME } = await import("../router");
  const capacities = new CapacityStore(path.join(DEVROUTER_HOME, "controller"));
  const first = lifecycle.prepareLifecycleOperation("ensure", newCheckout());
  const now = Date.now();
  const budgets = {
    host: { capacityBytes: 100, protectedHeadroomBytes: 10, startupSlots: 1, heavySlots: 1 },
  };
  const samples = {
    host: {
      sampledAtMs: now,
      pressure: "normal" as const,
      unmanagedBytes: 0,
      sharedBytes: 0,
      ownedBytes: {},
    },
  };
  const reservation = {
    environmentId: store.readReliabilityOperation(first.identity)!.state.environmentId,
    operationId: first.operationId,
    reservationId: "first-reservation",
    policyRevision: 1,
    totals: { host: 20 },
    startup: true,
    heavy: false,
  };
  expect(
    lifecycle.admitLifecycleCapacity(first, reservation, budgets, samples, now, 15_000).admitted,
  ).toBe(true);
  fixture.newLifecycleIds.mockReturnValue({
    requestId: "next-request",
    operationId: "next-operation",
    workerId: "next-worker",
  });
  fixture.resolveRunningWorkspaceContainer.mockReturnValue({ id: "synthetic-running" });
  const next = lifecycle.prepareLifecycleOperation("exec", first.repoPath, {}, ["true"]);
  const expanded = {
    ...reservation,
    operationId: next.operationId,
    reservationId: "next-reservation",
    totals: { host: bytes },
    heavy: true,
  };
  const decision = lifecycle.admitLifecycleCapacity(next, expanded, budgets, samples, now, 15_000);
  expect(decision.admitted).toBe(bytes === 30);
  expect(capacities.read().reservations).toEqual([bytes === 30 ? expanded : reservation]);
  const record = store.readReliabilityOperation(first.identity)!;
  if (bytes === 30) {
    expect(record.capacity?.operationId).toBe(next.operationId);
    expect(() => store.assertCapacityEffect(record, next.workerId, now)).not.toThrow();
  } else {
    expect(record.capacity?.validUntilMs).toBe(0);
    expect(() => store.assertCapacityEffect(record, first.workerId, now)).toThrow();
  }
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
});

it("freshly re-admits the same request but revokes stale or changed retries", async () => {
  const { lifecycle, store } = await loadLifecycleModules();
  const { CapacityStore } = await import("../capacity-store");
  const { DEVROUTER_HOME } = await import("../router");
  const capacities = new CapacityStore(path.join(DEVROUTER_HOME, "controller"));
  const request = lifecycle.prepareLifecycleOperation("ensure", newCheckout());
  const environmentId = store.readReliabilityOperation(request.identity)!.state.environmentId;
  const now = Date.now();
  const maxSampleAgeMs = 15_000;
  const budgets = {
    host: { capacityBytes: 100, protectedHeadroomBytes: 10, startupSlots: 1, heavySlots: 1 },
  };
  const sample = (sampledAtMs: number) => ({
    host: {
      sampledAtMs,
      pressure: "normal" as const,
      unmanagedBytes: 0,
      sharedBytes: 0,
      ownedBytes: {},
    },
  });
  const reservation = {
    environmentId,
    operationId: request.operationId,
    reservationId: "retry-reservation",
    policyRevision: 1,
    totals: { host: 20 },
    startup: true,
    heavy: false,
  };

  expect(
    lifecycle.admitLifecycleCapacity(
      request,
      reservation,
      budgets,
      sample(now),
      now,
      maxSampleAgeMs,
    ).admitted,
  ).toBe(true);
  const firstSnapshot = capacities.read();
  expect(firstSnapshot.reservations).toEqual([reservation]);

  expect(
    lifecycle.admitLifecycleCapacity(
      request,
      reservation,
      budgets,
      sample(now + 1),
      now + 1,
      maxSampleAgeMs,
    ).admitted,
  ).toBe(true);
  expect(capacities.read().revision).toBe(firstSnapshot.revision + 1);
  const rebound = store.readReliabilityOperation(request.identity)!;
  expect(rebound.capacity).toMatchObject({
    operationId: request.operationId,
    reservationId: reservation.reservationId,
    workerId: request.workerId,
    policyRevision: reservation.policyRevision,
  });
  expect(() => store.assertCapacityEffect(rebound, request.workerId, now + 1)).not.toThrow();

  const beforeStale = capacities.read();
  const staleNow = now + maxSampleAgeMs + 1;
  expect(
    lifecycle.admitLifecycleCapacity(
      request,
      reservation,
      budgets,
      sample(now),
      staleNow,
      maxSampleAgeMs,
    ),
  ).toEqual({ admitted: false, domain: "host", reason: "stale" });
  expect(capacities.read()).toEqual(beforeStale);
  const revoked = store.readReliabilityOperation(request.identity)!;
  expect(revoked.capacity).toMatchObject({
    operationId: request.operationId,
    reservationId: reservation.reservationId,
    workerId: request.workerId,
    policyRevision: reservation.policyRevision,
    validUntilMs: 0,
  });
  expect(() => store.assertCapacityEffect(revoked, request.workerId, staleNow)).toThrow(
    "absent or stale",
  );

  const beforeChangedRequirements = capacities.read();
  expect(() =>
    lifecycle.admitLifecycleCapacity(
      request,
      { ...reservation, totals: { host: 21 } },
      budgets,
      sample(staleNow),
      staleNow,
      maxSampleAgeMs,
    ),
  ).toThrow("Repeated capacity request changed its admitted requirements.");
  expect(capacities.read()).toEqual(beforeChangedRequirements);
  expect(store.readReliabilityOperation(request.identity)!.capacity?.validUntilMs).toBe(0);
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
});

it("fences an initial reservation when stop settles before publication", async () => {
  const { lifecycle, store } = await loadLifecycleModules();
  const { CapacityStore } = await import("../capacity-store");
  const { DEVROUTER_HOME } = await import("../router");
  const capacities = new CapacityStore(path.join(DEVROUTER_HOME, "controller"));
  const request = lifecycle.prepareLifecycleOperation("ensure", newCheckout());
  const environmentId = store.readReliabilityOperation(request.identity)!.state.environmentId;
  const reserve = CapacityStore.prototype.reserve;
  vi.spyOn(CapacityStore.prototype, "reserve").mockImplementationOnce(function (
    this: InstanceType<typeof CapacityStore>,
    ...args
  ) {
    expect(store.readReliabilityOperation(request.identity)).toMatchObject({
      version: 2,
      capacity: null,
    });
    lifecycle.prepareLifecycleOperation("stop", request.repoPath);
    capacities.settleEnvironmentAfterStop(environmentId, capacities.read().revision);
    return reserve.apply(this, args);
  });
  const now = Date.now();
  expect(() =>
    lifecycle.admitLifecycleCapacity(
      request,
      {
        environmentId,
        operationId: request.operationId,
        reservationId: "late",
        policyRevision: 1,
        totals: { host: 1 },
        startup: true,
        heavy: false,
      },
      { host: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 1, heavySlots: 1 } },
      {
        host: {
          sampledAtMs: now,
          pressure: "normal",
          unmanagedBytes: 0,
          sharedBytes: 0,
          ownedBytes: {},
        },
      },
      now,
      15_000,
    ),
  ).toThrow("Capacity snapshot changed");
  expect(capacities.read().reservations).toEqual([]);
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
});

it("retires queued intent durably without allowing it to dispatch again", async () => {
  const { lifecycle, store } = await loadLifecycleModules();
  const request = lifecycle.prepareLifecycleOperation("ensure", newCheckout());
  lifecycle.retireQueuedLifecycle(request);
  expect(store.readReliabilityOperation(request.identity)?.state.operation).toMatchObject({
    id: request.operationId,
    status: "NOT_STARTED",
    drained: true,
  });
  expect(() =>
    lifecycle.bindLifecycleCapacity(request, {
      reservationId: "unused",
      policyRevision: 1,
      validUntilMs: Date.now() + 15_000,
    }),
  ).toThrow("intent changed");
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
});

it("retains potentially dispatched intent when queued retirement cannot prove absence", async () => {
  const { lifecycle, store, request, identity } = await seedWorkerRequest();
  const before = store.readReliabilityOperation(identity);
  expect(() => lifecycle.retireQueuedLifecycle(request)).toThrow("absence is not proven");
  expect(store.readReliabilityOperation(identity)).toEqual(before);
});

it("retires stop-superseded undispatched intent without changing the newer intent", async () => {
  const { lifecycle, store } = await loadLifecycleModules();
  const request = lifecycle.prepareLifecycleOperation("ensure", newCheckout());
  expect(lifecycle.retireQueuedLifecycle(request, true)).toBe(false);
  expect(store.readReliabilityOperation(request.identity)?.state.operation?.drained).toBe(false);
  lifecycle.prepareLifecycleOperation("stop", request.repoPath);
  const before = store.readReliabilityOperation(request.identity)!;
  expect(before.state.operation).toMatchObject({
    id: request.operationId,
    status: "NOT_STARTED",
    drained: true,
  });
  expect(lifecycle.retireQueuedLifecycle(request, true)).toBe(true);
  const after = store.readReliabilityOperation(request.identity)!;
  expect(after.state).toEqual(before.state);
  expect(after.capacity).toEqual(before.capacity);
  expect(after.worker).toEqual(before.worker);
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
});

it("keeps prior capacity authority when replacement lacks drainage proof", async () => {
  const { lifecycle, store } = await loadLifecycleModules();
  const { CapacityStore } = await import("../capacity-store");
  const { DEVROUTER_HOME } = await import("../router");
  const capacities = new CapacityStore(path.join(DEVROUTER_HOME, "controller"));
  const request = lifecycle.prepareLifecycleOperation("ensure", newCheckout());
  const now = Date.now();
  const budgets = {
    host: { capacityBytes: 100, protectedHeadroomBytes: 10, startupSlots: 1, heavySlots: 1 },
  };
  const samples = {
    host: {
      sampledAtMs: now,
      pressure: "normal" as const,
      unmanagedBytes: 0,
      sharedBytes: 0,
      ownedBytes: {},
    },
  };
  const reservation = {
    environmentId: store.readReliabilityOperation(request.identity)!.state.environmentId,
    operationId: request.operationId,
    reservationId: "previous-reservation",
    policyRevision: 1,
    totals: { host: 20 },
    startup: true,
    heavy: false,
  };
  expect(
    lifecycle.admitLifecycleCapacity(request, reservation, budgets, samples, now, 15_000).admitted,
  ).toBe(true);
  fixture.newLifecycleIds.mockReturnValue({
    requestId: "replacement-request",
    operationId: "replacement-operation",
    workerId: "replacement-worker",
  });
  const next = lifecycle.prepareLifecycleOperation("ensure", request.repoPath);
  store.updateReliabilityOperation(request.identity, (record) => {
    record.state.operationHistory.find(
      (operation) => operation.id === request.operationId,
    )!.drained = false;
  });
  const before = store.readReliabilityOperation(request.identity);
  const snapshot = capacities.read();
  expect(() =>
    lifecycle.admitLifecycleCapacity(
      next,
      {
        ...reservation,
        operationId: next.operationId,
        reservationId: "replacement-reservation",
      },
      budgets,
      samples,
      now,
      15_000,
    ),
  ).toThrow("drainage is not proven");
  expect(store.readReliabilityOperation(request.identity)).toEqual(before);
  expect(capacities.read()).toEqual(snapshot);
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
});

afterEach(() => {
  restoreProcessConnected();
  vi.restoreAllMocks();
  vi.resetModules();
});

afterAll(() => {
  for (const root of fixture.roots) fs.rmSync(root, { recursive: true, force: true });
  for (const checkout of fixture.checkouts) fs.rmSync(checkout, { recursive: true, force: true });
});

describe("reliability lifecycle supervision", () => {
  it("persists explicit stop intent before the worker supervisor waits", async () => {
    const { lifecycle, store } = await loadLifecycleModules();
    const repoPath = newCheckout();
    const identity: ReliabilityIdentity = { repoPath, workspace: null, provider: "devsy" };
    let observed: Awaited<ReturnType<typeof store.readReliabilityOperation>>;
    let release!: () => void;
    const waitForSupervisor = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.runLifecycleWorker.mockImplementation(async () => {
      observed = store.readReliabilityOperation(identity);
      await waitForSupervisor;
      return { stopped: true };
    });

    const pending = lifecycle.superviseLifecycle("stop", repoPath);

    expect(observed).toMatchObject({
      state: {
        desired: "stopped-by-user",
        phase: "stopping",
        intentRevision: 1,
        stopProof: { workloadsStopped: false, routesRemoved: false },
      },
    });
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);

    release();
    await expect(pending).resolves.toEqual({ stopped: true });
  });

  it("does not let a stale worker claim increment effectSequence", async () => {
    setProcessConnected(true);
    const { contract, lifecycle, model, request, store, identity } = await seedWorkerRequest();

    await expect(
      lifecycle.executeLifecycleWorker(request, async () => {
        store.updateReliabilityOperation(identity, (record) => {
          const transition = model.stepReliability(
            record.state,
            { ...contract.reliabilityFence(record.state), type: "stop" },
            2,
          );
          expect(transition.outcome).toBe("accepted");
          record.state = transition.state;
        });
        expect(() => lifecycle.claimLifecycleEffect()).toThrow(
          "Lifecycle intent superseded this worker.",
        );
        return "completed";
      }),
    ).resolves.toBe("completed");

    expect(store.readReliabilityOperation(identity)).toMatchObject({ effectSequence: 1 });
  });

  it("retains a definitive result when acknowledgement fails after the atomic outcome write", async () => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedWorkerRequest("exec");
    await expect(
      lifecycle.executeLifecycleWorker(request, async () => {
        const rename = fs.renameSync;
        const sync = fs.fsyncSync;
        let renamed = false;
        const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
          rename(from, to);
          if (String(to) === store.reliabilityOperationPath(identity)) renamed = true;
        });
        const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
          if (renamed) throw new Error("synthetic lost acknowledgement");
          sync(descriptor);
        });
        try {
          lifecycle.recordLifecycleOutcome({
            status: "completed",
            exitCode: 7,
            transport: { exitCode: 0, signal: null },
          });
        } finally {
          renameSpy.mockRestore();
          syncSpy.mockRestore();
        }
      }),
    ).rejects.toThrow("synthetic lost acknowledgement");
    expect(store.readReliabilityOperation(identity)).toMatchObject({
      outcome: { status: "completed", exitCode: 7 },
      state: { operation: { status: "COMPLETED", exitCode: 7, drained: false } },
    });
    fixture.newLifecycleIds.mockReturnValue({
      requestId: "next-request",
      operationId: "next-operation",
      workerId: "next-worker",
    });
    await expect(lifecycle.superviseLifecycle("ensure", identity.repoPath)).resolves.toEqual({
      ok: true,
    });
    expect(store.readReliabilityOperation(identity)?.state.operationHistory[0]).toMatchObject({
      status: "COMPLETED",
      exitCode: 7,
      drained: true,
    });
  });

  it("preserves zero-launch evidence without releasing an undrained worker", async () => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity, model, contract } =
      await seedWorkerRequest("exec");
    await lifecycle.executeLifecycleWorker(request, async () => {
      lifecycle.recordLifecycleOutcome({
        status: "not-started",
        exitCode: null,
        transport: { exitCode: null, signal: null },
      });
      const record = store.readReliabilityOperation(identity);
      expect(record?.state.operation).toMatchObject({
        status: "NOT_LAUNCHED",
        drained: false,
        exitCode: null,
      });
      if (!record) throw new Error("missing fixture");
      expect(
        model.stepReliability(
          record.state,
          { ...contract.reliabilityFence(record.state), type: "dispatch" },
          Date.now(),
        ).outcome,
      ).toBe("stale");
    });
    fixture.newLifecycleIds.mockReturnValue({
      requestId: "next-request",
      operationId: "next-operation",
      workerId: "next-worker",
    });
    fixture.workerGroupAbsent.mockReturnValue(false);
    await expect(lifecycle.superviseLifecycle("ensure", identity.repoPath)).rejects.toThrow();
    fixture.workerGroupAbsent.mockReturnValue(true);
    await expect(lifecycle.superviseLifecycle("ensure", identity.repoPath)).resolves.toEqual({
      ok: true,
    });
    expect(store.readReliabilityOperation(identity)?.state.operationHistory[0]).toMatchObject({
      status: "NOT_LAUNCHED",
      exitCode: null,
      drained: true,
    });
  });

  it("increments effectSequence for a matching worker claim", async () => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedWorkerRequest();

    await expect(lifecycle.executeLifecycleWorker(request, async () => "completed")).resolves.toBe(
      "completed",
    );

    expect(store.readReliabilityOperation(identity)).toMatchObject({ effectSequence: 1 });
  });

  it("keeps stop unproven when workload inspection cannot provide proof", async () => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedStopRequest();
    const container = defaultContainer(identity.repoPath);
    fixture.inspectWorkspaceContainers.mockReturnValue([container]);
    fixture.inspectManagedStopContainers.mockReturnValueOnce([]).mockImplementation(() => {
      throw new Error("synthetic workload proof unavailable");
    });

    await expect(
      lifecycle.executeLifecycleWorker(request, async () => {
        lifecycle.proveLifecycleStopped();
      }),
    ).rejects.toThrow("synthetic workload proof unavailable");

    expect(store.readReliabilityOperation(identity)).toMatchObject({
      state: { stopProof: { workloadsStopped: false, routesRemoved: false } },
    });
  });

  it("bounds settlement contention without publishing stop proof", async () => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedStopRequest();
    const { CapacityStore, CapacitySnapshotChangedError } = await import("../capacity-store");
    store.updateReliabilityOperation(identity, (record) => {
      record.version = 2;
      record.capacity = null;
    });
    const settle = vi
      .spyOn(CapacityStore.prototype, "settleEnvironmentAfterStop")
      .mockImplementation(() => {
        throw new CapacitySnapshotChangedError();
      });
    await expect(
      lifecycle.executeLifecycleWorker(request, async () => {
        lifecycle.proveLifecycleStopped();
      }),
    ).rejects.toThrow("Capacity snapshot changed");
    expect(settle).toHaveBeenCalledTimes(3);
    expect(store.readReliabilityOperation(identity)?.state).toMatchObject({
      phase: "stopping",
      stopProof: { workloadsStopped: false, routesRemoved: false },
    });
  });

  it.each([
    { routesRemain: false, crashAfterRelease: false, unbound: false },
    { routesRemain: true, crashAfterRelease: false, unbound: false },
    { routesRemain: false, crashAfterRelease: true, unbound: false },
    { routesRemain: false, crashAfterRelease: false, unbound: true },
  ])("settles capacity after stop and reconciles released bindings ($routesRemain, $crashAfterRelease, $unbound)", async ({
    routesRemain,
    crashAfterRelease,
    unbound,
  }) => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedStopRequest();
    const { CapacityStore } = await import("../capacity-store");
    const { DEVROUTER_HOME } = await import("../router");
    const reservations = new CapacityStore(path.join(DEVROUTER_HOME, "controller"));
    const environmentId = store.readReliabilityOperation(identity)!.state.environmentId;
    const sample = {
      sampledAtMs: 100,
      pressure: "normal" as const,
      unmanagedBytes: 0,
      sharedBytes: 0,
      ownedBytes: {},
    };
    const admission = reservations.reserve(
      {
        environmentId,
        operationId: "previous",
        reservationId: "reservation",
        policyRevision: 1,
        totals: { host: 1 },
        startup: true,
        heavy: false,
      },
      { host: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 1, heavySlots: 1 } },
      { host: sample },
      100,
      15,
      undefined,
      reservations.read().revision,
    );
    expect(admission.admitted).toBe(true);
    store.updateReliabilityOperation(identity, (record) => {
      record.version = 2;
      record.capacity = {
        reservationId: "reservation",
        operationId: "previous",
        workerId: "previous-worker",
        policyRevision: 1,
        validUntilMs: 1000,
      };
    });
    if (routesRemain) fixture.listHostRouteState.mockReturnValue([{ repoPath: identity.repoPath }]);
    if (unbound)
      store.updateReliabilityOperation(identity, (record) => {
        record.capacity = null;
      });
    if (crashAfterRelease) {
      const release = CapacityStore.prototype.settleEnvironmentAfterStop;
      vi.spyOn(CapacityStore.prototype, "settleEnvironmentAfterStop").mockImplementationOnce(
        function (this: InstanceType<typeof CapacityStore>, expected, revision) {
          release.call(this, expected, revision);
          throw new Error("synthetic crash after release");
        },
      );
    }
    const stopped = lifecycle.executeLifecycleWorker(request, async () => {
      if (crashAfterRelease) {
        expect(() => lifecycle.proveLifecycleStopped()).toThrow("synthetic crash after release");
        expect(store.readReliabilityOperation(identity)?.state).toMatchObject({
          phase: "stopping",
          stopProof: { workloadsStopped: false, routesRemoved: false },
        });
        expect(reservations.read().reservations).toHaveLength(0);
        expect(() => lifecycle.prepareLifecycleOperation("ensure", request.repoPath)).toThrow();
      }
      lifecycle.proveLifecycleStopped();
    });
    if (routesRemain) await expect(stopped).rejects.toThrow("routes remain");
    else await expect(stopped).resolves.toBeUndefined();
    expect(
      reservations.read().reservations.filter((entry) => entry.environmentId === environmentId),
    ).toHaveLength(routesRemain ? 1 : 0);
    expect(store.readReliabilityOperation(identity)?.capacity?.validUntilMs).toBe(
      routesRemain ? 1000 : undefined,
    );
    if (!routesRemain) {
      expect(store.readReliabilityOperation(identity)).toMatchObject({
        version: 2,
        capacity: null,
      });
      fixture.newLifecycleIds.mockReturnValue({
        requestId: "after-stop-request",
        operationId: "after-stop-operation",
        workerId: "after-stop-worker",
      });
      const next = lifecycle.prepareLifecycleOperation("ensure", request.repoPath);
      expect(() =>
        store.assertCapacityEffect(
          store.readReliabilityOperation(identity)!,
          next.workerId,
          Date.now(),
        ),
      ).toThrow("absent or stale");
      const now = Date.now();
      expect(
        lifecycle.admitLifecycleCapacity(
          next,
          {
            environmentId,
            operationId: next.operationId,
            reservationId: "after-stop",
            policyRevision: 1,
            totals: { host: 1 },
            startup: true,
            heavy: false,
          },
          {
            host: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 1, heavySlots: 1 },
          },
          { host: { ...sample, sampledAtMs: now } },
          now,
          15_000,
        ).admitted,
      ).toBe(true);
    }
  });

  it.each([
    {
      label: "the recorded worker incarnation is still live",
      birth: "proc:worker",
      groupAbsent: true,
    },
    {
      label: "the worker process group is still live",
      birth: "proc:replacement",
      groupAbsent: false,
    },
  ])("does not reclaim a prior worker when $label", async ({ birth, groupAbsent }) => {
    const { lifecycle, request, store, identity } = await seedWorkerRequest();
    fixture.processBirthIdentity.mockReturnValue(birth);
    fixture.workerGroupAbsent.mockReturnValue(groupAbsent);

    await lifecycle.superviseLifecycle("stop", identity.repoPath);

    expect(store.readReliabilityOperation(identity)).toMatchObject({
      worker: {
        id: request.workerId,
        operationId: request.operationId,
        pid: process.pid,
        birth: "proc:worker",
      },
      state: { desired: "stopped-by-user", phase: "stopping" },
    });
  });

  it("reconciles a proven absent ensure worker while preserving its unknown result", async () => {
    const { lifecycle, store, identity } = await seedWorkerRequest();
    fixture.processBirthIdentity.mockReturnValue("proc:replacement");
    fixture.workerGroupAbsent.mockReturnValue(true);
    fixture.newLifecycleIds.mockReturnValue({
      requestId: "new-request",
      operationId: "new-operation",
      workerId: "new-worker",
    });
    await lifecycle.superviseLifecycle("ensure", identity.repoPath);
    const record = store.readReliabilityOperation(identity);
    expect(record?.worker).toBeNull();
    expect(record?.state.operationHistory[0]).toMatchObject({
      id: "operation-id",
      status: "INTERRUPTED",
      drained: true,
      exitCode: null,
    });
    expect(record?.state.operation?.id).not.toBe("operation-id");
    expect(fixture.runLifecycleWorker).toHaveBeenCalledTimes(1);
  });

  it("keeps command args, environment, and output out of the persisted record", async () => {
    const { lifecycle, store } = await loadLifecycleModules();
    const repoPath = newCheckout();
    const rawArg = "synthetic-raw-arg-7f1c";
    const rawEnv = "synthetic-raw-env-8a2d";
    const rawOutput = "synthetic-raw-output-9b3e";
    fixture.resolveRunningWorkspaceContainer.mockReturnValue({
      id: "synthetic-app",
      workspacePath: "/synthetic/workspace",
    });
    fixture.runLifecycleWorker.mockResolvedValue(rawOutput);

    await lifecycle.superviseLifecycle(
      "exec",
      repoPath,
      {
        profile: "full",
        env: { SYNTHETIC_VALUE: rawEnv },
        output: rawOutput,
      } as unknown as LifecycleWorkerRequest["options"],
      ["synthetic-command", rawArg],
    );

    const identity: ReliabilityIdentity = { repoPath, workspace: null, provider: "devsy" };
    const record = store.readReliabilityOperation(identity);
    const persisted = fs.readFileSync(store.reliabilityOperationPath(identity), "utf8");
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty("command");
    expect(record).not.toHaveProperty("env");
    expect(record).not.toHaveProperty("output");
    expect(persisted).not.toContain(rawArg);
    expect(persisted).not.toContain(rawEnv);
    expect(persisted).not.toContain(rawOutput);
  });
});
