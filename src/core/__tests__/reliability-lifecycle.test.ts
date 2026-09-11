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
  proveRetainedManagedStop: vi.fn(),
  absent: false,
  assertRoutesRemoved: vi.fn(),
  withWorkspaceLifecycleLock: vi.fn(),
  readCapacityPolicy: vi.fn(),
  isLinkedWorktree: vi.fn(),
  resolveLinkedTarget: vi.fn(),
  observe: vi.fn(),
  submit: vi.fn(),
  follow: vi.fn(),
}));

vi.mock("../capacity-policy", async (original) => ({
  ...(await original<typeof import("../capacity-policy")>()),
  readCapacityPolicy: fixture.readCapacityPolicy,
}));

vi.mock("../controller-client", () => ({
  observeControllerBinding: fixture.observe,
  submitControllerOperation: fixture.submit,
  followControllerOperation: fixture.follow,
}));

vi.mock("../router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../router")>();
  const actualFs = await import("node:fs");
  const actualOs = await import("node:os");
  const actualPath = await import("node:path");
  const root = actualFs.mkdtempSync(actualPath.join(actualOs.tmpdir(), "reliability-lifecycle-"));
  actualFs.chmodSync(root, 0o700);
  fixture.roots.push(root);
  return { ...actual, DEVROUTER_HOME: root };
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

vi.mock("../traefik-route-health", () => ({
  assertTraefikRoutesRemoved: fixture.assertRoutesRemoved,
}));
vi.mock("../managed-stop-recovery", () => ({
  managedStopRouteReferences: () => [],
  proveManagedStop: (...args: unknown[]) => ({
    status: fixture.absent ? "proven-absent" : "retained",
    containers: fixture.proveRetainedManagedStop(...args),
  }),
}));

vi.mock("../reliability-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reliability-worker")>()),
  newLifecycleIds: fixture.newLifecycleIds,
  runLifecycleWorker: fixture.runLifecycleWorker,
  workerGroupAbsent: fixture.workerGroupAbsent,
}));

vi.mock("../workspace", () => ({
  comparableWorkspacePath: (repoPath: string) => repoPath,
  isLinkedWorktree: fixture.isLinkedWorktree,
  readPersistedWorkspace: () => undefined,
  resolveWorktreeWorkspace: () => undefined,
  sameWorkspacePath: (left: string, right: string) => left === right,
  withWorkspaceLifecycleLock: fixture.withWorkspaceLifecycleLock,
}));

vi.mock("../workspace-ensure", () => ({ resolveLinkedTarget: fixture.resolveLinkedTarget }));
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

async function seedCapacityWorkerRequest(
  options: {
    budgets?: Record<
      string,
      {
        capacityBytes: number;
        protectedHeadroomBytes: number;
        startupSlots: number;
        heavySlots: number;
      }
    >;
    samples?: Record<
      string,
      {
        sampledAtMs: number;
        pressure: "normal" | "unknown";
        unmanagedBytes: number;
        sharedBytes: number;
        ownedBytes: Record<string, number>;
      }
    >;
    totals?: Record<string, number>;
  } = {},
) {
  const seeded = await seedWorkerRequest();
  const { CapacityStore } = await import("../capacity-store");
  const { ControllerStore } = await import("../controller-store");
  const { DEVROUTER_HOME } = await import("../router");
  const directory = path.join(DEVROUTER_HOME, "controller");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const controller = new ControllerStore(directory).startIncarnation();
  const capacities = new CapacityStore(directory);
  const now = Date.now();
  const budgets = options.budgets ?? {
    host: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 2, heavySlots: 2 },
  };
  const samples = options.samples ?? {
    host: {
      sampledAtMs: now,
      pressure: "normal" as const,
      unmanagedBytes: 0,
      sharedBytes: 0,
      ownedBytes: {},
    },
  };
  const reservation = {
    environmentId: seeded.request.fence.environmentId,
    operationId: seeded.request.operationId,
    reservationId: "claim-reservation",
    policyRevision: 1,
    totals: options.totals ?? { host: 1 },
    startup: true,
    heavy: true,
  };
  const admission = capacities.reserve(
    reservation,
    budgets,
    samples,
    now,
    60_000,
    undefined,
    capacities.read().revision,
  );
  if (!admission.admitted) throw new Error("Synthetic admission failed.");
  const enrollment = {
    policyRevision: 1,
    gitCommonDir: "/tmp/synthetic-common",
    providerId: "synthetic-provider",
    hostDomain: "host",
    runtimeDomain: "guest",
    endpoint: "/tmp/synthetic-docker.sock",
    daemonId: "synthetic-daemon",
    estimatesDigest: "a".repeat(64),
  };
  seeded.store.updateReliabilityOperation(seeded.identity, (record) => {
    record.version = 2;
    record.enrollment = enrollment;
    record.activeProfile = "full";
    record.state.executionPolicy = "capacity-managed";
    record.state.admission = "admitted";
    record.state.chargeHeld = true;
    record.capacity = {
      reservationId: reservation.reservationId,
      operationId: seeded.request.operationId,
      workerId: seeded.request.workerId,
      policyRevision: 1,
      validUntilMs: now + 60_000,
      snapshotRevision: admission.revision,
      controller: { store: controller.store, epoch: controller.epoch },
    };
  });
  const policy = {
    revision: 1,
    admissions: "enabled",
    scheduling: { maxSampleAgeSeconds: 60 },
    domains: {
      ...budgets,
      guest: {
        ...(budgets.guest ?? {}),
        kind: "runtime",
        endpoint: enrollment.endpoint,
        daemonId: enrollment.daemonId,
      },
    },
    enrollments: [{ ...enrollment, ...seeded.identity, profiles: ["full"] }],
  } as unknown as import("../capacity-policy").CapacityPolicy;
  fixture.readCapacityPolicy.mockReturnValue(policy);
  return { ...seeded, capacities, controller, directory, reservation, policy, samples, now };
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
  fixture.absent = false;
  fixture.assertRoutesRemoved.mockReset();
  vi.resetModules();
  vi.clearAllMocks();
  fixture.isLinkedWorktree.mockReturnValue(false);
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

it("accepts managed intent once and reconnects without returning another worker payload", async () => {
  const { lifecycle, store, contract, model } = await loadLifecycleModules();
  const identity: ReliabilityIdentity = {
    repoPath: newCheckout(),
    workspace: null,
    provider: "devsy",
  };
  store.updateReliabilityOperation(identity, (record) => {
    record.state = model.stepReliability(
      record.state,
      { ...contract.reliabilityFence(record.state), type: "stop" },
      1,
    ).state;
    record.state = model.stepReliability(
      record.state,
      {
        ...contract.reliabilityFence(record.state),
        type: "stop-proof",
        workloadsStopped: true,
        routesRemoved: true,
      },
      2,
    ).state;
  });
  const before = store.readReliabilityOperation(identity)!;
  store.enrollStoppedLifecycle(identity, before.revision, {
    policyRevision: 1,
    gitCommonDir: "/tmp/synthetic-common",
    providerId: "synthetic-provider",
    hostDomain: "host",
    runtimeDomain: "guest",
    endpoint: "/tmp/synthetic-docker.sock",
    daemonId: "synthetic-daemon",
    estimatesDigest: "a".repeat(64),
  });
  const { ControllerStore } = await import("../controller-store");
  const { DEVROUTER_HOME } = await import("../router");
  const directory = path.join(DEVROUTER_HOME, "controller");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const controllerStore = new ControllerStore(directory);
  const controller = controllerStore.startIncarnation();
  const input = {
    identity,
    controller: { store: controller.store, epoch: controller.epoch },
    policyRevision: 1,
    requestId: "durable-request",
    kind: "ensure" as const,
    profile: "full",
    consumer: { id: "agent", requiredCapabilities: [], pinned: false },
    runtimeRunning: false,
  };
  expect(() => lifecycle.prepareManagedLifecycleOperation({ ...input, policyRevision: 2 })).toThrow(
    "enrollment",
  );
  expect(() => lifecycle.prepareLifecycleOperation("ensure", identity.repoPath)).toThrow(
    "controller admission",
  );
  const accepted = lifecycle.prepareManagedLifecycleOperation(input);
  expect(accepted.request).toMatchObject({ requestId: input.requestId });
  expect(store.readReliabilityOperation(identity)?.state).toMatchObject({
    admission: "waiting",
    phase: "queued",
    operation: { id: accepted.operationId, status: "NOT_STARTED" },
  });
  fixture.newLifecycleIds.mockReturnValue({
    requestId: "unused-request",
    operationId: "unused-operation",
    workerId: "unused-worker",
  });
  expect(lifecycle.prepareManagedLifecycleOperation(input)).toEqual({
    operationId: accepted.operationId,
  });
  expect(() =>
    lifecycle.prepareManagedLifecycleOperation({ ...input, requestId: "competing-request" }),
  ).toThrow("blocked");
  expect(store.readReliabilityOperation(identity)?.state.operation).toMatchObject({
    id: accepted.operationId,
    status: "NOT_STARTED",
    drained: false,
  });
  expect(() => lifecycle.prepareManagedLifecycleOperation({ ...input, profile: "other" })).toThrow(
    "conflict",
  );
  expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
  expect(store.readReliabilityOperation(identity)?.state.operationHistory).toHaveLength(1);
  store.updateReliabilityOperation(identity, (record) => {
    const completed = { status: "COMPLETED" as const, drained: true, exitCode: 0 };
    record.state.operation = { ...record.state.operation!, ...completed };
    record.state.operationHistory = record.state.operationHistory.map((entry) => ({
      ...entry,
      ...completed,
    }));
  });
  const execInput = {
    ...input,
    kind: "exec" as const,
    requestId: "exec-request",
    runtimeRunning: true,
    command: ["synthetic-transient-payload"],
  };
  const exec = lifecycle.prepareManagedLifecycleOperation(execInput);
  expect(exec.request?.command).toEqual(execInput.command);
  const now = Date.now();
  expect(
    lifecycle.admitLifecycleCapacity(
      exec.request!,
      {
        environmentId: exec.request!.fence.environmentId,
        operationId: exec.operationId,
        reservationId: "managed-reservation",
        policyRevision: 1,
        totals: { host: 1 },
        startup: false,
        heavy: true,
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
      directory,
      { store: controller.store, epoch: controller.epoch },
    ).admitted,
  ).toBe(true);
  const admitted = store.readReliabilityOperation(identity)!;
  expect(() => store.assertCapacityEffect(admitted, exec.request!.workerId, now)).not.toThrow();
  const policy = {
    revision: 1,
    admissions: "enabled",
    scheduling: { maxSampleAgeSeconds: 15 },
    domains: {
      host: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 1, heavySlots: 1 },
      guest: {
        kind: "runtime",
        endpoint: admitted.enrollment!.endpoint,
        daemonId: admitted.enrollment!.daemonId,
      },
    },
    enrollments: [{ ...admitted.enrollment, ...identity, profiles: ["full"] }],
  } as unknown as import("../capacity-policy").CapacityPolicy;
  fixture.readCapacityPolicy.mockReturnValue(policy);
  const samples = {
    host: {
      sampledAtMs: now + 1000,
      pressure: "normal" as const,
      unmanagedBytes: 0,
      sharedBytes: 0,
      ownedBytes: {},
    },
  };
  expect(
    lifecycle.renewLifecycleCapacity(
      exec.request!,
      policy,
      samples,
      controller,
      directory,
      now + 1000,
    ),
  ).toBe(true);
  expect(store.readReliabilityOperation(identity)?.capacity?.validUntilMs).toBe(now + 16_000);
  const { CapacityStore } = await import("../capacity-store");
  const capacities = new CapacityStore(directory);
  const readCapacity = CapacityStore.prototype.read;
  vi.spyOn(CapacityStore.prototype, "read").mockImplementationOnce(function (
    this: InstanceType<typeof CapacityStore>,
  ) {
    const snapshot = readCapacity.call(this);
    capacities.settleEnvironmentAfterStop("competing-environment", snapshot.revision);
    return snapshot;
  });
  expect(
    lifecycle.renewLifecycleCapacity(
      exec.request!,
      policy,
      samples,
      controller,
      directory,
      now + 1000,
    ),
  ).toBe(false);
  // A snapshot race is observational. Revoking here would abort a running
  // operation whose authority is still inside its freshness window, and would
  // misreport the cause as absent or stale authority.
  expect(store.readReliabilityOperation(identity)?.capacity?.validUntilMs).toBe(now + 16_000);
  const reservations = capacities.read();
  expect(
    lifecycle.renewLifecycleCapacity(
      exec.request!,
      policy,
      samples,
      controller,
      directory,
      now + 20_000,
    ),
  ).toBe(false);
  expect(store.readReliabilityOperation(identity)?.capacity?.validUntilMs).toBe(now + 16_000);
  expect(new CapacityStore(directory).read()).toEqual(reservations);
  expect(
    lifecycle.renewLifecycleCapacity(
      exec.request!,
      policy,
      samples,
      controller,
      directory,
      now + 1000,
    ),
  ).toBe(true);
  expect(() =>
    store.assertCapacityEffect(
      store.readReliabilityOperation(identity)!,
      exec.request!.workerId,
      now + 1000,
    ),
  ).not.toThrow();
  // A collection gap for a reserved domain declines the extension without
  // revoking the authority the operation still holds.
  expect(
    lifecycle.renewLifecycleCapacity(exec.request!, policy, {}, controller, directory, now + 1000),
  ).toBe(false);
  expect(store.readReliabilityOperation(identity)?.capacity?.validUntilMs).toBe(now + 16_000);
  controllerStore.startIncarnation();
  expect(() => store.assertCapacityEffect(admitted, exec.request!.workerId, now)).toThrow(
    "incarnation",
  );
  expect(
    lifecycle.renewLifecycleCapacity(
      exec.request!,
      policy,
      samples,
      controller,
      directory,
      now + 1000,
    ),
  ).toBe(false);
  expect(new CapacityStore(directory).read()).toEqual(reservations);
  expect(admitted.state).toMatchObject({ admission: "admitted", chargeHeld: true });
  expect(
    model.stepReliability(
      admitted.state,
      { ...contract.reliabilityFence(admitted.state), type: "dispatch" },
      now,
    ).outcome,
  ).toBe("accepted");
  const beforeStaleAcceptance = store.readReliabilityOperation(identity);
  expect(() =>
    lifecycle.prepareManagedLifecycleOperation({
      ...execInput,
      command: ["replacement-not-executed"],
    }),
  ).toThrow("incarnation");
  expect(store.readReliabilityOperation(identity)).toEqual(beforeStaleAcceptance);
  expect(() =>
    lifecycle.admitLifecycleCapacity(
      exec.request!,
      reservations.reservations[0],
      { host: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 1, heavySlots: 1 } },
      samples,
      now,
      15_000,
      directory,
      controller,
    ),
  ).toThrow("incarnation");
  expect(store.readReliabilityOperation(identity)).toEqual(beforeStaleAcceptance);
  expect(new CapacityStore(directory).read()).toEqual(reservations);
  const saved = fs.readFileSync(store.reliabilityOperationPath(identity), "utf8");
  expect(saved).not.toContain("synthetic-transient-payload");
  expect(saved).not.toContain("replacement-not-executed");
});

function witnessedRecordFixture(
  record: import("../reliability-operation-store").ReliabilityOperationRecord,
  fence: import("../reliability-contract").ReliabilityFence,
) {
  return {
    operationId: record.state.operation!.id,
    fence,
    provider: {
      id: record.enrollment!.providerId,
      context: "default",
      uid: "generation",
      sourceContainer: "container",
    },
    profile: "full",
    sourceConfigSha256: "b".repeat(64),
    effectiveConfigSha256: "c".repeat(64),
    composeFiles: ["/tmp/synthetic-compose.yml"],
    primaryService: "app",
    startupServices: ["app", "db"],
    retainedContainerIds: [],
  };
}

it("renews authority with an unknown sample local to the witnessed runtime domain", async () => {
  const seeded = await seedCapacityWorkerRequest({
    totals: { host: 1, guest: 1 },
    budgets: {
      host: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 2, heavySlots: 2 },
      guest: { capacityBytes: 10, protectedHeadroomBytes: 1, startupSlots: 2, heavySlots: 2 },
    },
    samples: {
      host: {
        sampledAtMs: Date.now(),
        pressure: "normal",
        unmanagedBytes: 0,
        sharedBytes: 0,
        ownedBytes: {},
      },
      guest: {
        sampledAtMs: Date.now(),
        pressure: "normal",
        unmanagedBytes: 0,
        sharedBytes: 0,
        ownedBytes: {},
      },
    },
  });
  const guestUnknown = {
    sampledAtMs: seeded.now,
    pressure: "unknown" as const,
    unmanagedBytes: 0,
    sharedBytes: 0,
    ownedBytes: {},
  };
  const samples = {
    host: seeded.samples.host,
    guest: guestUnknown,
  };
  const granted = seeded.store.readReliabilityOperation(seeded.identity)!.capacity!.validUntilMs;
  expect(
    seeded.lifecycle.renewLifecycleCapacity(
      seeded.request,
      seeded.policy,
      samples,
      seeded.controller,
      seeded.directory,
      seeded.now,
    ),
  ).toBe(false);
  // An unobservable domain declines the extension without revoking the deadline
  // the running operation already holds.
  expect(seeded.store.readReliabilityOperation(seeded.identity)?.capacity?.validUntilMs).toBe(
    granted,
  );
  seeded.store.updateReliabilityOperation(seeded.identity, (record) => {
    record.capacity!.validUntilMs = seeded.now + 60_000;
    record.startupWitness = witnessedRecordFixture(record, seeded.request.fence);
  });
  expect(
    seeded.lifecycle.renewLifecycleCapacity(
      seeded.request,
      seeded.policy,
      samples,
      seeded.controller,
      seeded.directory,
      seeded.now,
    ),
  ).toBe(true);
  const renewed = seeded.store.readReliabilityOperation(seeded.identity)!;
  expect(renewed.capacity?.validUntilMs).toBeGreaterThan(seeded.now);
  expect(
    seeded.lifecycle.renewLifecycleCapacity(
      seeded.request,
      seeded.policy,
      {
        ...samples,
        guest: { ...samples.guest, sampledAtMs: seeded.now - 120_000, pressure: "unknown" },
      },
      seeded.controller,
      seeded.directory,
      seeded.now,
    ),
  ).toBe(false);
  expect(
    seeded.lifecycle.renewLifecycleCapacity(
      seeded.request,
      seeded.policy,
      { ...samples, guest: { ...samples.guest, pressure: "pressured" } },
      seeded.controller,
      seeded.directory,
      seeded.now,
    ),
  ).toBe(false);
  expect(
    seeded.lifecycle.renewLifecycleCapacity(
      seeded.request,
      seeded.policy,
      { host: guestUnknown, guest: seeded.samples.host },
      seeded.controller,
      seeded.directory,
      seeded.now,
    ),
  ).toBe(false);
});

it("clears a superseded startup witness when a new managed operation is accepted", async () => {
  const { lifecycle, store, contract, model } = await loadLifecycleModules();
  const identity: ReliabilityIdentity = {
    repoPath: newCheckout(),
    workspace: null,
    provider: "devsy",
  };
  store.updateReliabilityOperation(identity, (record) => {
    record.state = model.stepReliability(
      record.state,
      { ...contract.reliabilityFence(record.state), type: "stop" },
      1,
    ).state;
    record.state = model.stepReliability(
      record.state,
      {
        ...contract.reliabilityFence(record.state),
        type: "stop-proof",
        workloadsStopped: true,
        routesRemoved: true,
      },
      2,
    ).state;
  });
  const before = store.readReliabilityOperation(identity)!;
  store.enrollStoppedLifecycle(identity, before.revision, {
    policyRevision: 1,
    gitCommonDir: "/tmp/synthetic-common",
    providerId: "synthetic-provider",
    hostDomain: "host",
    runtimeDomain: "guest",
    endpoint: "/tmp/synthetic-docker.sock",
    daemonId: "synthetic-daemon",
    estimatesDigest: "a".repeat(64),
  });
  const { ControllerStore } = await import("../controller-store");
  const { DEVROUTER_HOME } = await import("../router");
  const directory = path.join(DEVROUTER_HOME, "controller");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const controller = new ControllerStore(directory).startIncarnation();
  const input = {
    identity,
    controller: { store: controller.store, epoch: controller.epoch },
    policyRevision: 1,
    requestId: "first-request",
    kind: "ensure" as const,
    profile: "full",
    consumer: { id: "agent", requiredCapabilities: [], pinned: false },
    runtimeRunning: false,
  };
  const accepted = lifecycle.prepareManagedLifecycleOperation(input);
  store.updateReliabilityOperation(identity, (record) => {
    record.startupWitness = witnessedRecordFixture(record, accepted.request!.fence);
  });
  expect(store.readReliabilityOperation(identity)?.startupWitness).not.toBeNull();
  store.updateReliabilityOperation(identity, (record) => {
    const completed = { status: "COMPLETED" as const, drained: true, exitCode: 0 };
    record.state.operation = { ...record.state.operation!, ...completed };
    record.state.operationHistory = record.state.operationHistory.map((entry) => ({
      ...entry,
      ...completed,
    }));
  });
  fixture.newLifecycleIds.mockReturnValue({
    requestId: "second-request",
    operationId: "second-operation",
    workerId: "second-worker",
  });
  const second = lifecycle.prepareManagedLifecycleOperation({
    ...input,
    requestId: "second-request",
  });
  expect(second.request).toMatchObject({ operationId: "second-operation" });
  expect(store.readReliabilityOperation(identity)?.startupWitness ?? null).toBeNull();
});

it("clears the active operation's startup witness inside the lifecycle worker", async () => {
  const seeded = await seedCapacityWorkerRequest();
  seeded.store.updateReliabilityOperation(seeded.identity, (record) => {
    record.startupWitness = witnessedRecordFixture(record, seeded.request.fence);
  });
  await expect(
    seeded.lifecycle.executeLifecycleWorker(seeded.request, async () => {
      seeded.lifecycle.clearActiveLifecycleStartupWitness();
      expect(
        seeded.store.readReliabilityOperation(seeded.identity)?.startupWitness ?? null,
      ).toBeNull();
      return "ok";
    }),
  ).resolves.toBe("ok");
  expect(seeded.store.readReliabilityOperation(seeded.identity)?.startupWitness ?? null).toBeNull();
  seeded.lifecycle.clearActiveLifecycleStartupWitness();
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
  if (!admission.admitted) throw new Error("Synthetic admission failed.");
  if (stopped) lifecycle.prepareLifecycleOperation("stop", request.repoPath);
  const bind = () =>
    lifecycle.bindLifecycleCapacity(request, {
      reservationId: "reserved",
      policyRevision: 1,
      snapshotRevision: admission.revision,
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
  expect(capacities.read().reservations).toHaveLength(1);
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
      snapshotRevision: 1,
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
  vi.useRealTimers();
  restoreProcessConnected();
  vi.restoreAllMocks();
  vi.resetModules();
});

afterAll(() => {
  for (const root of fixture.roots) fs.rmSync(root, { recursive: true, force: true });
  for (const checkout of fixture.checkouts) fs.rmSync(checkout, { recursive: true, force: true });
});

describe("reliability lifecycle supervision", () => {
  it("rejects stop before allocating identity or dispatching for an unclaimed linked checkout", async () => {
    fixture.isLinkedWorktree.mockReturnValue(true);
    const lifecycle = await import("../reliability-lifecycle");
    await expect(
      lifecycle.superviseLifecycle("stop", "/synthetic/unclaimed-checkout"),
    ).rejects.toThrow();
    expect(fixture.resolveLinkedTarget).not.toHaveBeenCalled();
    expect(fixture.newLifecycleIds).not.toHaveBeenCalled();
    expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
    expect(fixture.inspectWorkspaceContainers).not.toHaveBeenCalled();
  });

  it("passes the original fence and journal snapshot to atomic worker admission", async () => {
    const { identity, lifecycle, store } = await seedWorkerRequest();
    const { contract, model } = await loadLifecycleModules();
    store.updateReliabilityOperation(identity, (record) => {
      for (const event of [
        { type: "completion", operationId: "operation-id", exitCode: 0 },
        { type: "drained", operationId: "operation-id" },
      ] as const) {
        record.state = model.stepReliability(
          record.state,
          { ...contract.reliabilityFence(record.state), ...event },
          100,
        ).state;
      }
      const current = record.state.operationHistory[0];
      record.state.operationHistory = [
        ...Array.from({ length: 127 }, (_, index) => ({
          ...current,
          id: `old-${index}`,
          key: `key-${index}`,
        })),
        current,
      ];
      record.worker = null;
    });
    const before = store.readReliabilityOperation(identity)!;
    fixture.newLifecycleIds.mockReturnValue({
      requestId: "next-key",
      operationId: "next-operation",
      workerId: "next-worker",
    });
    fixture.runLifecycleWorker.mockImplementation(async (request: LifecycleWorkerRequest) => {
      const persisted = store.readReliabilityOperation(identity)!;
      expect(persisted).toEqual(before);
      expect(request.fence).toEqual(contract.reliabilityFence(before.state));
      expect(request.admission?.expectedRevision).toBe(before.revision);
      expect(request.operationId).toBe("next-operation");
    });
    await lifecycle.superviseLifecycle("ensure", identity.repoPath, {});
    expect(fixture.runLifecycleWorker).toHaveBeenCalledOnce();
  });
  it.each(
    (["ensure", "exec"] as const).flatMap((kind) =>
      (["ensure", "exec"] as const).map((activeKind) => ({ kind, activeKind })),
    ),
  )("$kind waits behind $activeKind without writes and preserves copied inputs", async ({
    kind,
    activeKind,
  }) => {
    const { lifecycle, store, identity, contract, model } = await seedWorkerRequest(activeKind);
    vi.useFakeTimers();
    const progress = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    fixture.processBirthIdentity.mockReturnValue("proc:worker");
    fixture.newLifecycleIds.mockReturnValue({
      requestId: "next",
      operationId: "next",
      workerId: "next",
    });
    const before = store.readReliabilityOperation(identity);
    const argv = ["synthetic", "literal ; $(ignored)"];
    const options = { profile: "full" };
    const pending = lifecycle.superviseLifecycle(
      kind,
      identity.repoPath,
      options,
      kind === "exec" ? argv : undefined,
    );
    options.profile = "tooling";
    argv.push("later mutation");
    await vi.advanceTimersByTimeAsync(500);
    expect(store.readReliabilityOperation(identity)).toEqual(before);
    expect(fixture.resolveRunningWorkspaceContainer).not.toHaveBeenCalled();
    expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9500);
    expect(progress).toHaveBeenCalledTimes(2);
    const emitted = progress.mock.calls.map(([value]) => String(value)).join("");
    expect(emitted).toContain("next");
    for (const arg of argv) expect(emitted).not.toContain(arg);
    store.updateReliabilityOperation(identity, (record) => {
      for (const event of [
        { type: "completion", operationId: "operation-id", exitCode: 7 },
        { type: "drained", operationId: "operation-id" },
      ] as const)
        record.state = model.stepReliability(
          record.state,
          { ...contract.reliabilityFence(record.state), ...event },
          100,
        ).state;
      record.worker = null;
    });
    fixture.resolveRunningWorkspaceContainer.mockReturnValue({ id: "fresh" });
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(fixture.runLifecycleWorker).toHaveBeenCalledOnce();
    expect(fixture.runLifecycleWorker.mock.calls[0][0]).toMatchObject({
      kind,
      options: { profile: "full" },
      ...(kind === "exec" ? { command: ["synthetic", "literal ; $(ignored)"] } : {}),
      admission: { runtimeRunning: kind === "exec" },
    });
    expect(fixture.newLifecycleIds).toHaveBeenCalledOnce();
  });

  it.each(
    (["ensure", "exec"] as const).flatMap((kind) =>
      (["SIGINT", "SIGTERM", "timeout", "stop"] as const).map((ending) => ({ kind, ending })),
    ),
  )("never admits a waiting $kind after $ending", async ({ kind, ending }) => {
    const { lifecycle, store, identity, contract, model } = await seedWorkerRequest("exec");
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    fixture.processBirthIdentity.mockReturnValue("proc:worker");
    fixture.newLifecycleIds.mockReturnValue({
      requestId: "next",
      operationId: "next",
      workerId: "next",
    });
    const before = store.readReliabilityOperation(identity);
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const pending = lifecycle.superviseLifecycle(
      kind,
      identity.repoPath,
      {},
      kind === "exec" ? ["synthetic"] : undefined,
    );
    const rejection = expect(pending).rejects.toThrow();
    if (ending === "stop")
      store.updateReliabilityOperation(identity, (record) => {
        record.state = model.stepReliability(
          record.state,
          { ...contract.reliabilityFence(record.state), type: "stop" },
          100,
        ).state;
      });
    else if (ending === "timeout") vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    else process.emit(ending);
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
    expect(fixture.resolveRunningWorkspaceContainer).not.toHaveBeenCalled();
    expect(store.readReliabilityOperation(identity)?.worker).toEqual(before?.worker);
    if (ending !== "stop") expect(store.readReliabilityOperation(identity)).toEqual(before);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
  });

  it.each([
    "ensure",
    "exec",
  ] as const)("%s retries only admission contention with the same IDs", async (kind) => {
    const { lifecycle } = await loadLifecycleModules();
    const { LifecycleWorkerAdmissionBusyError } = await import("../reliability-worker");
    vi.useFakeTimers();
    fixture.resolveRunningWorkspaceContainer.mockReturnValue({ id: "fresh" });
    fixture.runLifecycleWorker
      .mockRejectedValueOnce(new LifecycleWorkerAdmissionBusyError())
      .mockResolvedValueOnce(7);
    const pending = lifecycle.superviseLifecycle(
      kind,
      newCheckout(),
      {},
      kind === "exec" ? ["synthetic"] : undefined,
    );
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe(7);
    expect(fixture.newLifecycleIds).toHaveBeenCalledOnce();
    expect(fixture.resolveRunningWorkspaceContainer).toHaveBeenCalledTimes(kind === "exec" ? 2 : 0);
    expect(fixture.runLifecycleWorker.mock.calls[0][0]).toEqual(
      fixture.runLifecycleWorker.mock.calls[1][0],
    );
  });

  it.each([
    undefined,
    "proc:replacement",
  ])("preserves a surviving group with uncertain birth %s", async (birth) => {
    const { lifecycle, store, identity } = await seedWorkerRequest("exec");
    fixture.processBirthIdentity.mockReturnValue(birth);
    fixture.workerGroupAbsent.mockReturnValue(false);
    fixture.newLifecycleIds.mockReturnValue({
      requestId: "next",
      operationId: "next",
      workerId: "next",
    });
    const before = store.readReliabilityOperation(identity);
    await expect(
      lifecycle.superviseLifecycle("exec", identity.repoPath, {}, ["synthetic"]),
    ).rejects.toThrow();
    expect(store.readReliabilityOperation(identity)).toEqual(before);
    expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
  });

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

  it.each([
    true,
    false,
  ])("retains charged claims across durable revocation (claim first: %s)", async (claimFirst) => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity, capacities } = await seedCapacityWorkerRequest();
    const charged = capacities.read();
    let effects = 0;
    await lifecycle.executeLifecycleWorker(request, async () => {
      const initialSequence = store.readReliabilityOperation(identity)!.effectSequence;
      if (claimFirst) lifecycle.claimLifecycleEffect();
      store.updateReliabilityOperation(identity, (record) => {
        record.capacity!.validUntilMs = 0;
      });
      expect(store.readReliabilityOperation(identity)?.capacity?.validUntilMs).toBe(0);
      if (claimFirst) effects++;
      expect(() => {
        lifecycle.claimLifecycleEffect();
        effects++;
      }).toThrow("absent or stale");
      expect(store.readReliabilityOperation(identity)?.effectSequence).toBe(
        initialSequence + (claimFirst ? 1 : 0),
      );
      expect(effects).toBe(claimFirst ? 1 : 0);
      expect(capacities.read()).toEqual(charged);
    });
    expect(capacities.read()).toEqual(charged);
  });

  it.each([
    false,
    true,
  ])("does not acknowledge or release charges on interrupted fencing (published: %s)", async (published) => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity, capacities } = await seedCapacityWorkerRequest();
    const charged = capacities.read();
    await lifecycle.executeLifecycleWorker(request, async () => {
      const rename = fs.renameSync;
      const sync = fs.fsyncSync;
      let renamed = false;
      let acknowledged = false;
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === store.reliabilityOperationPath(identity) && !published)
          throw new Error("synthetic fencing interruption");
        rename(from, to);
        if (String(to) === store.reliabilityOperationPath(identity)) renamed = true;
      });
      const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
        if (renamed) throw new Error("synthetic fencing interruption");
        sync(descriptor);
      });
      try {
        expect(() => {
          store.updateReliabilityOperation(identity, (record) => {
            record.capacity!.validUntilMs = 0;
          });
          acknowledged = true;
        }).toThrow("synthetic fencing interruption");
      } finally {
        renameSpy.mockRestore();
        syncSpy.mockRestore();
      }
      expect(acknowledged).toBe(false);
      const sequence = store.readReliabilityOperation(identity)!.effectSequence;
      if (published) {
        expect(store.readReliabilityOperation(identity)?.capacity?.validUntilMs).toBe(0);
        expect(() => lifecycle.claimLifecycleEffect()).toThrow("absent or stale");
        expect(store.readReliabilityOperation(identity)?.effectSequence).toBe(sequence);
      } else {
        expect(() => lifecycle.claimLifecycleEffect()).not.toThrow();
        expect(store.readReliabilityOperation(identity)?.effectSequence).toBe(sequence + 1);
      }
      expect(capacities.read()).toEqual(charged);
      store.updateReliabilityOperation(identity, (record) => {
        record.capacity!.validUntilMs = 0;
      });
      expect(() => lifecycle.claimLifecycleEffect()).toThrow("absent or stale");
    });
    expect(capacities.read()).toEqual(charged);
  });

  it("requires fresh renewal after a competing snapshot revision before another effect claim", async () => {
    setProcessConnected(true);
    const {
      lifecycle,
      request,
      store,
      identity,
      capacities,
      controller,
      directory,
      reservation,
      policy,
      samples,
      now,
    } = await seedCapacityWorkerRequest();
    await lifecycle.executeLifecycleWorker(request, async () => {
      const old = store.readReliabilityOperation(identity)!;
      const sequence = old.effectSequence;
      const competing = capacities.reserve(
        {
          ...reservation,
          environmentId: "competing-environment",
          operationId: "competing-operation",
          reservationId: "competing-reservation",
        },
        policy.domains,
        samples,
        now,
        60_000,
        undefined,
        capacities.read().revision,
      );
      expect(competing.admitted).toBe(true);
      let effects = 0;
      expect(() => {
        lifecycle.claimLifecycleEffect();
        effects++;
      }).toThrow("snapshot authority");
      expect(effects).toBe(0);
      expect(store.readReliabilityOperation(identity)?.effectSequence).toBe(sequence);
      expect(capacities.read().reservations).toHaveLength(2);
      expect(
        lifecycle.renewLifecycleCapacity(request, policy, samples, controller, directory, now),
      ).toBe(true);
      expect(store.readReliabilityOperation(identity)?.capacity?.snapshotRevision).toBe(
        capacities.read().revision,
      );
      lifecycle.claimLifecycleEffect();
      effects++;
      expect(effects).toBe(1);
      expect(store.readReliabilityOperation(identity)?.effectSequence).toBe(sequence + 1);
      expect(() => store.assertCapacityEffect(old, request.workerId, now, directory)).toThrow(
        "snapshot authority",
      );
      expect(() => store.assertCapacityEffect(old, "replacement-worker", now, directory)).toThrow(
        "absent or stale",
      );
      expect(capacities.read().reservations).toHaveLength(2);
    });
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

  it.each([
    0, 1,
  ])("retains a prepared profile independently of application exit %s", async (exitCode) => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedWorkerRequest();
    const { capacityEstimatesDigest } = await import("../repo-config");
    const estimates = {
      version: 1 as const,
      profiles: {
        full: {
          host: { steadyBytes: 10, startupTotalBytes: 30 },
          runtime: { steadyBytes: 20, startupTotalBytes: 60 },
          operations: {},
        },
      },
    };
    await lifecycle.executeLifecycleWorker(request, async () => {
      // Isolate completion bookkeeping after the worker's existing launch claim.
      store.updateReliabilityOperation(identity, (record) => {
        record.version = 2;
        record.state.executionPolicy = "capacity-managed";
        record.state.admission = "admitted";
        record.state.chargeHeld = true;
        record.capacity = null;
        record.activeProfile = null;
        record.enrollment = {
          policyRevision: 1,
          gitCommonDir: "/tmp/synthetic-common",
          providerId: "synthetic-provider",
          hostDomain: "host",
          runtimeDomain: "guest",
          endpoint: "/tmp/synthetic-docker.sock",
          daemonId: "synthetic-daemon",
          estimatesDigest: capacityEstimatesDigest(estimates),
        };
      });
      expect(() => lifecycle.recordLifecycleCompletion(exitCode, "other")).toThrow();
      expect(store.readReliabilityOperation(identity)?.activeProfile).toBeNull();
      lifecycle.recordLifecycleCompletion(exitCode, "full");
    });
    expect(store.readReliabilityOperation(identity)).toMatchObject({
      activeProfile: "full",
      preparation: {
        operationId: request.operationId,
        profile: "full",
        fence: request.fence,
      },
      state: { operation: { status: "COMPLETED", exitCode } },
    });
    const { ControllerStore } = await import("../controller-store");
    const { CapacityStore, CapacitySnapshotChangedError } = await import("../capacity-store");
    const { DEVROUTER_HOME } = await import("../router");
    const directory = path.join(DEVROUTER_HOME, "controller");
    const controller = new ControllerStore(directory).startIncarnation();
    fs.chmodSync(directory, 0o700);
    const enrollment = {
      repoPath: identity.repoPath,
      gitCommonDir: "/tmp/synthetic-common",
      workspace: "",
      provider: identity.provider,
      providerId: "synthetic-provider",
      hostDomain: "host",
      runtimeDomain: "guest",
      profiles: ["full"],
      estimatesDigest: capacityEstimatesDigest(estimates),
      defaultOperation: { hostIncrementBytes: 1, runtimeIncrementBytes: 1 },
    };
    store.updateReliabilityOperation(identity, (record) => {
      record.capacity = {
        reservationId: "prepared-reservation",
        operationId: request.operationId,
        workerId: request.workerId,
        policyRevision: 1,
        validUntilMs: Date.now() + 1000,
        controller: { store: controller.store, epoch: controller.epoch },
      };
    });
    const reservation = {
      environmentId: request.fence.environmentId,
      operationId: request.operationId,
      reservationId: "prepared-reservation",
      policyRevision: 1,
      totals: { host: 30, guest: 60 },
      startup: true,
      heavy: false,
    };
    fs.writeFileSync(
      path.join(directory, "capacity-reservations.json"),
      JSON.stringify({ version: 1, revision: 1, reservations: [reservation] }),
      { mode: 0o600 },
    );
    const settlement = { identity, controller, estimates, enrollment, directory };
    expect(lifecycle.settlePreparedLifecycleCapacity(settlement)).toBe(false);
    expect(new CapacityStore(directory).read().reservations).toEqual([reservation]);
    store.updateReliabilityOperation(identity, (record) => {
      record.worker = null;
      record.state.operation!.drained = true;
      record.state.operationHistory.forEach((operation) => {
        operation.drained = true;
      });
    });
    const preparation = store.readReliabilityOperation(identity)!.preparation!;
    store.updateReliabilityOperation(identity, (record) => {
      record.preparation = null;
    });
    expect(lifecycle.settlePreparedLifecycleCapacity(settlement)).toBe(false);
    expect(new CapacityStore(directory).read().reservations).toEqual([reservation]);
    store.updateReliabilityOperation(identity, (record) => {
      record.preparation = preparation;
    });
    const reduce = CapacityStore.prototype.reduceAfterPhase;
    const crash = vi
      .spyOn(CapacityStore.prototype, "reduceAfterPhase")
      .mockImplementationOnce(function (
        this: InstanceType<typeof CapacityStore>,
        target,
        revision,
      ) {
        reduce.call(this, target, revision);
        throw new Error("synthetic crash after reduction");
      });
    expect(() => lifecycle.settlePreparedLifecycleCapacity(settlement)).toThrow("synthetic crash");
    expect(store.readReliabilityOperation(identity)?.phaseSettlement).not.toBeNull();
    expect(() =>
      lifecycle.prepareManagedLifecycleOperation({
        identity,
        controller,
        policyRevision: 1,
        requestId: "replacement-operation",
        kind: "ensure",
        profile: "full",
        consumer: { id: "synthetic", requiredCapabilities: [], pinned: false },
        runtimeRunning: true,
      }),
    ).toThrow("settlement is pending");
    crash.mockRestore();
    const replacement = new ControllerStore(directory).startIncarnation();
    expect(() => lifecycle.settlePreparedLifecycleCapacity(settlement)).toThrow(
      "incarnation changed",
    );
    settlement.controller = replacement;
    const conflict = vi
      .spyOn(CapacityStore.prototype, "reduceAfterPhase")
      .mockImplementationOnce(() => {
        throw new CapacitySnapshotChangedError();
      });
    expect(lifecycle.settlePreparedLifecycleCapacity(settlement)).toBe(true);
    expect(conflict).toHaveBeenCalledTimes(2);
    conflict.mockRestore();
    expect(new CapacityStore(directory).read().reservations).toEqual([
      { ...reservation, totals: { host: 10, guest: 20 }, startup: false },
    ]);
    expect(store.readReliabilityOperation(identity)).toMatchObject({
      phaseSettlement: null,
      capacity: { validUntilMs: 0 },
    });
    expect(lifecycle.settlePreparedLifecycleCapacity(settlement)).toBe(false);
    const capacity = new CapacityStore(directory);
    fs.writeFileSync(
      path.join(directory, "capacity-reservations.json"),
      JSON.stringify({
        version: 1,
        revision: capacity.read().revision + 1,
        reservations: [reservation],
      }),
      { mode: 0o600 },
    );
    const stopRace = vi
      .spyOn(CapacityStore.prototype, "reduceAfterPhase")
      .mockImplementationOnce(function (
        this: InstanceType<typeof CapacityStore>,
        target,
        revision,
      ) {
        lifecycle.prepareLifecycleOperation("stop", identity.repoPath);
        this.settleEnvironmentAfterStop(target.environmentId, this.read().revision);
        reduce.call(this, target, revision);
      });
    expect(lifecycle.settlePreparedLifecycleCapacity(settlement)).toBe(false);
    expect(capacity.read().reservations).toEqual([]);
    expect(store.readReliabilityOperation(identity)?.state.desired).toBe("stopped-by-user");
    stopRace.mockRestore();
  });

  it.each([
    false,
    true,
  ])("clears the active profile only after complete stop proof (%s)", async (routesRemain) => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedStopRequest();
    store.updateReliabilityOperation(identity, (record) => {
      record.version = 2;
      record.state.executionPolicy = "capacity-managed";
      record.state.admission = "unknown";
      record.capacity = null;
      record.activeProfile = "full";
      record.enrollment = {
        policyRevision: 1,
        gitCommonDir: "/tmp/synthetic-common",
        providerId: "synthetic-provider",
        hostDomain: "host",
        runtimeDomain: "guest",
        endpoint: "/tmp/synthetic-docker.sock",
        daemonId: "synthetic-daemon",
        estimatesDigest: "a".repeat(64),
      };
    });
    if (routesRemain) fixture.listHostRouteState.mockReturnValue([{ repoPath: identity.repoPath }]);
    const stopped = lifecycle.executeLifecycleWorker(request, async () =>
      lifecycle.proveLifecycleStopped(),
    );
    if (routesRemain) await expect(stopped).rejects.toThrow("routes remain");
    else await expect(stopped).resolves.toBeUndefined();
    expect(store.readReliabilityOperation(identity)?.activeProfile).toBe(
      routesRemain ? "full" : null,
    );
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

  it("fences a repeated completed stop before its capacity settlement window", async () => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedStopRequest();
    const { contract, model } = await loadLifecycleModules();
    const { CapacityStore } = await import("../capacity-store");
    store.updateReliabilityOperation(identity, (record) => {
      record.version = 2;
      record.capacity = null;
      record.state = model.stepReliability(
        record.state,
        {
          ...contract.reliabilityFence(record.state),
          type: "stop-proof",
          workloadsStopped: true,
          routesRemoved: true,
        },
        2,
      ).state;
    });
    const repeated = lifecycle.prepareLifecycleOperation("stop", identity.repoPath);
    expect(repeated.fence.intentRevision).toBeGreaterThan(request.fence.intentRevision);
    const settle = CapacityStore.prototype.settleEnvironmentAfterStop;
    const intercepted = vi
      .spyOn(CapacityStore.prototype, "settleEnvironmentAfterStop")
      .mockImplementationOnce(function (this: InstanceType<typeof CapacityStore>, id, revision) {
        expect(store.readReliabilityOperation(identity)?.state.phase).toBe("stopping");
        expect(() => lifecycle.prepareLifecycleOperation("ensure", identity.repoPath)).toThrow(
          "Lifecycle transition is blocked",
        );
        return settle.call(this, id, revision);
      });
    await lifecycle.executeLifecycleWorker(repeated, async () => {
      lifecycle.proveLifecycleStopped();
    });
    expect(intercepted).toHaveBeenCalledOnce();
    expect(store.readReliabilityOperation(identity)?.state).toMatchObject({
      phase: "idle",
      stopProof: { workloadsStopped: true, routesRemoved: true },
    });
    expect(() => lifecycle.prepareLifecycleOperation("ensure", identity.repoPath)).not.toThrow();
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

  it.each(
    [
      { routesRemain: false, crashAfterRelease: false, unbound: false },
      { routesRemain: true, crashAfterRelease: false, unbound: false },
      { routesRemain: false, crashAfterRelease: true, unbound: false },
      { routesRemain: false, crashAfterRelease: false, unbound: true },
    ].flatMap((scenario) => [
      { ...scenario, retainedBaseline: false },
      { ...scenario, retainedBaseline: true },
    ]),
  )("settles capacity after stop and reconciles released bindings ($routesRemain, $crashAfterRelease, $unbound, $retainedBaseline)", async ({
    routesRemain,
    crashAfterRelease,
    unbound,
    retainedBaseline,
  }) => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedStopRequest();
    const { CapacityStore } = await import("../capacity-store");
    const { DEVROUTER_HOME } = await import("../router");
    const reservations = new CapacityStore(path.join(DEVROUTER_HOME, "controller"));
    const environmentId = store.readReliabilityOperation(identity)!.state.environmentId;
    if (retainedBaseline) {
      fixture.readManagedRuntimeState.mockReturnValue({
        repoPath: identity.repoPath,
        stopBaseline: { version: 1 },
      });
      fixture.proveRetainedManagedStop.mockReturnValue([defaultContainer(identity.repoPath)]);
    }
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
    "complete",
    "changed",
    "running",
    "routes",
  ])("requires retained proof through canonical %s settlement", async (outcome) => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedStopRequest();
    const retained = { repoPath: identity.repoPath, stopBaseline: { version: 1 } };
    fixture.readManagedRuntimeState.mockReturnValue(retained);
    fixture.proveRetainedManagedStop.mockReturnValue([defaultContainer(identity.repoPath)]);
    const operation = lifecycle.executeLifecycleWorker(request, async () => {
      if (outcome === "changed")
        fixture.proveRetainedManagedStop.mockImplementation(() => {
          throw new Error("Synthetic population drift");
        });
      if (outcome === "running")
        fixture.proveRetainedManagedStop.mockReturnValue([
          { ...defaultContainer(identity.repoPath), state: { Running: true } },
        ]);
      if (outcome === "routes")
        fixture.listHostRouteState.mockReturnValue([{ repoPath: identity.repoPath }]);
      lifecycle.proveLifecycleStopped();
    });
    if (outcome === "complete") await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toThrow(Error);
    expect(fixture.proveRetainedManagedStop).toHaveBeenCalledTimes(2);
    expect(fixture.inspectWorkspaceContainers).not.toHaveBeenCalled();
    expect(fixture.inspectManagedStopContainers).not.toHaveBeenCalled();
    expect(store.readReliabilityOperation(identity)?.state.stopProof).toEqual({
      workloadsStopped: outcome === "complete",
      routesRemoved: outcome === "complete",
    });
  });

  it.each([
    false,
    true,
  ])("settles proven absence only after live route proof (failure=%s)", async (failure) => {
    setProcessConnected(true);
    const { lifecycle, request, store, identity } = await seedStopRequest();
    fixture.absent = true;
    fixture.readManagedRuntimeState.mockReturnValue({
      repoPath: identity.repoPath,
      stopBaseline: { version: 1 },
    });
    fixture.proveRetainedManagedStop.mockReturnValue([]);
    if (failure)
      fixture.assertRoutesRemoved.mockImplementation(() => {
        throw new Error("live routes remain");
      });
    const result = lifecycle.executeLifecycleWorker(request, async () =>
      lifecycle.proveLifecycleStopped(),
    );
    if (failure) await expect(result).rejects.toThrow("live routes remain");
    else await expect(result).resolves.toBeUndefined();
    if (!failure) {
      const settled = store.readReliabilityOperation(identity)!.state;
      expect(settled.phase).toBe("idle");
      const { stepReliability } = await import("../reliability-model");
      const { reliabilityFence } = await import("../reliability-contract");
      const next = stepReliability(
        settled,
        {
          ...reliabilityFence(settled),
          type: "operation-request",
          kind: "ensure",
          key: "retry-ensure",
          operationId: "retry-ensure",
          profile: "web",
          consumer: { id: "manual-cli", requiredCapabilities: [], pinned: false },
          runtimeRunning: false,
        },
        2,
      );
      expect(next.outcome).toBe("accepted");
    }
    expect(fixture.proveRetainedManagedStop).toHaveBeenCalledTimes(2);
    expect(store.readReliabilityOperation(identity)?.state.stopProof).toEqual({
      workloadsStopped: !failure,
      routesRemoved: !failure,
    });
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
    expect(fixture.runLifecycleWorker.mock.calls[0][0]).toMatchObject({
      operationId: "new-operation",
      admission: { expectedRevision: record?.revision },
    });
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

describe("capacity admission CLI routing", () => {
  const terminalResult = {
    status: "terminal" as const,
    operationId: "operation-id",
    operation: null,
    output: null,
    outputCursor: { sequence: 0, offset: 0 },
    outputGap: false,
  };
  const binding = { session: "session", store: "store", epoch: 1, generation: "generation" };

  it("routes an enrolled checkout through the controller and returns the journalled result", async () => {
    const { lifecycle, store, identity } = await seedWorkerRequest();
    fixture.readCapacityPolicy.mockReturnValue({
      revision: 1,
      admissions: "enabled",
      enrollments: [{ repoPath: identity.repoPath, profiles: ["full"] }],
    });
    fixture.observe.mockResolvedValue(binding);
    fixture.submit.mockImplementation(async () => {
      store.updateReliabilityOperation(identity, (record) => {
        record.result = { ok: true, value: { synthetic: "ensure-result" } };
      });
      return terminalResult;
    });
    await expect(lifecycle.superviseLifecycle("ensure", identity.repoPath, {})).resolves.toEqual({
      synthetic: "ensure-result",
    });
    expect(fixture.observe).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ path: identity.repoPath, profile: "full", require: ["runtime"] }),
    );
    expect(fixture.submit).toHaveBeenCalledOnce();
    expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
  });

  it("surfaces a journalled worker failure for an enrolled exec", async () => {
    const { lifecycle, store, identity } = await seedWorkerRequest("exec");
    fixture.readCapacityPolicy.mockReturnValue({
      revision: 1,
      admissions: "enabled",
      enrollments: [{ repoPath: identity.repoPath, profiles: ["full"] }],
    });
    store.updateReliabilityOperation(identity, (record) => {
      record.result = { ok: false, message: "synthetic worker failure" };
    });
    fixture.observe.mockResolvedValue(binding);
    fixture.submit.mockResolvedValue(terminalResult);
    await expect(
      lifecycle.superviseLifecycle("exec", identity.repoPath, {}, ["synthetic-command"]),
    ).rejects.toThrow("synthetic worker failure");
    expect(fixture.submit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "exec", command: ["synthetic-command"] }),
      expect.objectContaining({ waitSeconds: 900 }),
    );
  });

  it("survives a controller transport failure while following a queued admission", async () => {
    const { lifecycle, store, identity } = await seedWorkerRequest();
    fixture.readCapacityPolicy.mockReturnValue({
      revision: 1,
      admissions: "enabled",
      enrollments: [{ repoPath: identity.repoPath, profiles: ["full"] }],
    });
    fixture.observe.mockResolvedValue(binding);
    fixture.submit.mockResolvedValue({ ...terminalResult, status: "pending" as const });
    fixture.follow
      .mockRejectedValueOnce(new Error("synthetic controller restart"))
      .mockImplementation(async () => {
        store.updateReliabilityOperation(identity, (record) => {
          record.result = { ok: true, value: { synthetic: "reconnected-result" } };
        });
        return terminalResult;
      });
    await expect(lifecycle.superviseLifecycle("ensure", identity.repoPath, {})).resolves.toEqual({
      synthetic: "reconnected-result",
    });
    expect(fixture.observe).toHaveBeenCalledTimes(3);
    expect(fixture.follow).toHaveBeenCalledTimes(2);
    expect(fixture.runLifecycleWorker).not.toHaveBeenCalled();
  });
});
