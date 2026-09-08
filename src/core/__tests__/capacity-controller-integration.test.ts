import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { CapacityEstimates } from "../../types";
import type { CapacityDomainSample } from "../capacity-accounting";
import { createCapacityController } from "../capacity-controller";
import type { CapacityPolicy, CapacityPolicyEnrollment } from "../capacity-policy";
import { CapacityStore } from "../capacity-store";
import { ControllerStore } from "../controller-store";
import { reliabilityFence } from "../reliability-contract";
import { stepReliability } from "../reliability-model";
import {
  type CapacityEnrollmentBinding,
  enrollStoppedLifecycle,
  type ReliabilityIdentity,
  readReliabilityOperation,
  updateReliabilityOperation,
} from "../reliability-operation-store";
import type { LifecycleWorkerRequest } from "../reliability-worker";
import { capacityEstimatesDigest } from "../repo-config";

const fixture = vi.hoisted(() => ({
  root: "",
  enroll: vi.fn(),
  runLifecycleWorker: vi.fn(),
  runningContainer: vi.fn(),
}));

vi.mock("../router", async (importOriginal) => {
  const actualFs = await import("node:fs");
  const actualOs = await import("node:os");
  const actualPath = await import("node:path");
  const actual = await importOriginal<typeof import("../router")>();
  fixture.root = actualFs.realpathSync(
    actualFs.mkdtempSync(
      actualPath.join(actualFs.realpathSync(actualOs.tmpdir()), "capacity-controller-"),
    ),
  );
  actualFs.chmodSync(fixture.root, 0o700);
  return { ...actual, DEVROUTER_HOME: fixture.root };
});

vi.mock("../capacity-enrollment", () => ({
  enrollCapacityLifecycle: fixture.enroll,
}));

vi.mock("../devpod-environment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../devpod-environment")>()),
  resolveRunningWorkspaceContainer: fixture.runningContainer,
}));

vi.mock("../reliability-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reliability-worker")>()),
  runLifecycleWorker: fixture.runLifecycleWorker,
}));

const estimates: CapacityEstimates = {
  version: 1,
  profiles: {
    full: {
      host: { steadyBytes: 10, startupTotalBytes: 20 },
      runtime: { steadyBytes: 10, startupTotalBytes: 20 },
      operations: { ensure: { hostIncrementBytes: 1, runtimeIncrementBytes: 1 } },
    },
  },
};
const estimatesDigest = capacityEstimatesDigest(estimates);

function environment(repoPath: string, suffix: string) {
  return {
    id: `environment-${suffix}`,
    repoPath,
    workspace: `workspace-${suffix}`,
    provider: "devsy" as const,
    providerId: `provider-${suffix}`,
    profile: "full",
    fingerprint: suffix.repeat(64),
  };
}

function policyEnrollment(current: ReturnType<typeof environment>): CapacityPolicyEnrollment {
  return {
    repoPath: current.repoPath,
    gitCommonDir: path.join(current.repoPath, ".git"),
    workspace: current.workspace,
    provider: current.provider,
    providerId: current.providerId,
    hostDomain: "host",
    runtimeDomain: "runtime",
    profiles: ["full"],
    estimatesDigest,
    defaultOperation: { hostIncrementBytes: 1, runtimeIncrementBytes: 1 },
  };
}

function durableEnrollment(current: ReturnType<typeof environment>): CapacityEnrollmentBinding {
  return {
    policyRevision: 1,
    gitCommonDir: path.join(current.repoPath, ".git"),
    providerId: current.providerId,
    hostDomain: "host",
    runtimeDomain: "runtime",
    endpoint: "/tmp/synthetic-runtime.sock",
    daemonId: "synthetic-daemon",
    estimatesDigest,
  };
}

function policy(enrollments: CapacityPolicyEnrollment[]): CapacityPolicy {
  return {
    version: 1,
    revision: 1,
    admissions: "enabled",
    scheduling: {
      maxQueuedPerDomain: 2,
      maxQueuedTotal: 2,
      queueLifetimeSeconds: 900,
      clientWaitSeconds: 1,
      maxClientWaitSeconds: 30,
      watchSeconds: 30,
      sampleIntervalSeconds: 5,
      maxSampleAgeSeconds: 15,
    },
    domains: {
      host: {
        kind: "host",
        adapter: "macos-host-v1",
        capacityBytes: 100,
        protectedHeadroomBytes: 10,
        startupSlots: 1,
        heavySlots: 1,
      },
      runtime: {
        kind: "runtime",
        adapter: "orbstack-local-v1",
        endpoint: "/tmp/synthetic-runtime.sock",
        daemonId: "synthetic-daemon",
        hostDomain: "host",
        hostChargeCeilingBytes: 90,
        capacityBytes: 100,
        protectedHeadroomBytes: 10,
        startupSlots: 1,
        heavySlots: 1,
      },
    },
    enrollments,
  };
}

function sample(sampledAtMs: number): CapacityDomainSample {
  return {
    sampledAtMs,
    pressure: "normal",
    unmanagedBytes: 0,
    sharedBytes: 0,
    ownedBytes: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

function seedStopped(identity: ReliabilityIdentity, enrollment: CapacityEnrollmentBinding): void {
  updateReliabilityOperation(identity, (record) => {
    let transition = stepReliability(
      record.state,
      { ...reliabilityFence(record.state), type: "stop" },
      Date.now(),
    );
    expect(transition.outcome).toBe("accepted");
    transition = stepReliability(
      transition.state,
      {
        ...reliabilityFence(transition.state),
        type: "stop-proof",
        workloadsStopped: true,
        routesRemoved: true,
      },
      Date.now(),
    );
    expect(transition.outcome).toBe("accepted");
    record.state = transition.state;
  });
  const stopped = readReliabilityOperation(identity);
  if (!stopped) throw new Error("Synthetic stopped journal was not persisted.");
  enrollStoppedLifecycle(identity, stopped.revision, enrollment);
}

function watchRequest(
  controller: { store: string; epoch: number },
  operationId: string,
  timeout: number,
) {
  return {
    version: 1 as const,
    id: `watch-${operationId}`,
    method: "operation-watch" as const,
    session: "synthetic-session",
    store: controller.store,
    epoch: controller.epoch,
    generation: "synthetic-generation",
    operationId,
    timeout,
  };
}

beforeEach(() => {
  fixture.runningContainer.mockReset();
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.mkdirSync(fixture.root, { mode: 0o700 });
});

it.each([
  "exit0",
  "exit1",
  "exit2",
  "signal",
  "transport-error",
  "missing-outcome",
  "undrained",
  "startup",
  "heavy",
  "excess",
])("reconciles exec charges only with settled predecessor and definite drained completion (%s)", async (mode) => {
  const directory = path.join(fixture.root, "controller");
  fs.mkdirSync(directory, { mode: 0o700 });
  const current = environment(fs.mkdtempSync(path.join(fixture.root, "exec-")), "c");
  const enrollment = policyEnrollment(current);
  const identity: ReliabilityIdentity = {
    repoPath: current.repoPath,
    workspace: current.workspace,
    provider: current.provider,
  };
  seedStopped(identity, durableEnrollment(current));
  const operatorPolicy = policy([enrollment]);
  fs.writeFileSync(path.join(directory, "capacity-policy.json"), JSON.stringify(operatorPolicy), {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(current.repoPath, ".devrouter.yml"),
    JSON.stringify({ version: 1, apps: [], capacity: estimates }),
  );
  const incarnation = new ControllerStore(directory).startIncarnation();
  const controller = { store: incarnation.store, epoch: incarnation.epoch };
  fixture.enroll.mockResolvedValue({ environment: current, enrollment, estimates });
  fixture.runningContainer.mockReturnValue({ id: "synthetic-running-container" });
  const launches: LifecycleWorkerRequest[] = [];
  fixture.runLifecycleWorker.mockImplementation(async (request: LifecycleWorkerRequest) => {
    launches.push(request);
    return { status: "completed" };
  });
  const active = createCapacityController({
    directory,
    controller: { ...controller, directory, consumeStartup: () => {} },
    collect: async () => ({ host: sample(Date.now()), runtime: sample(Date.now()) }),
  });
  const binding = {
    version: 1 as const,
    id: "synthetic-submit",
    method: "operation-submit" as const,
    session: "synthetic-session",
    ...controller,
    generation: "synthetic-generation",
  };
  const store = new CapacityStore(directory);
  try {
    await active.submit(
      { ...binding, requestId: "prepare", kind: "ensure" },
      current,
      new AbortController().signal,
    );
    await active.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(1);
    // Synthetic worker proof; the launch mock itself never establishes completion.
    updateReliabilityOperation(identity, (record) => {
      const operation = {
        ...record.state.operation!,
        status: "COMPLETED" as const,
        exitCode: 0,
        drained: true,
      };
      record.state.operation = operation;
      record.state.operationHistory = record.state.operationHistory.map((entry) =>
        entry.id === operation.id ? { ...entry, ...operation } : entry,
      );
      record.activeProfile = "full";
      record.preparation = {
        operationId: operation.id,
        profile: "full",
        fence: reliabilityFence(record.state),
      };
    });
    await active.tick();
    expect(store.read().reservations[0]).toMatchObject({
      totals: { host: 10, runtime: 10 },
      startup: false,
      heavy: false,
    });

    const retainedPredecessor = ["startup", "heavy", "excess"].includes(mode);
    if (retainedPredecessor) {
      const snapshot = store.read();
      const prior = snapshot.reservations[0];
      const now = Date.now();
      expect(
        store.reserve(
          {
            ...prior,
            startup: mode === "startup",
            heavy: mode === "heavy",
            totals: { host: mode === "excess" ? 12 : 10, runtime: 10 },
          },
          operatorPolicy.domains,
          { host: sample(now), runtime: sample(now) },
          now,
          15000,
          {
            revision: snapshot.revision,
            operationId: prior.operationId,
            reservationId: prior.reservationId,
          },
          snapshot.revision,
        ).admitted,
      ).toBe(true);
      updateReliabilityOperation(identity, (record) => {
        record.preparation = null;
      });
    }
    await active.submit(
      { ...binding, requestId: "exec", kind: "exec", command: ["synthetic-command"] },
      current,
      new AbortController().signal,
    );
    await active.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(2);
    expect(launches[1].kind).toBe("exec");
    const admitted = readReliabilityOperation(identity)!;
    const reservation = store.read().reservations[0];
    expect(reservation).toMatchObject({
      operationId: launches[1].operationId,
      heavy: true,
      totals: { host: mode === "excess" ? 12 : 11, runtime: 11 },
    });
    if (retainedPredecessor) expect(admitted.capacity?.execSteady).toBeUndefined();
    else
      expect(admitted.capacity?.execSteady).toEqual({
        profile: "full",
        estimatesDigest,
        fence: launches[1].fence,
        totals: { host: 10, runtime: 10 },
      });

    updateReliabilityOperation(identity, (record) => {
      const exitCode = mode === "exit2" ? 2 : mode === "exit1" ? 1 : 0;
      const operation = {
        ...record.state.operation!,
        status: "COMPLETED" as const,
        exitCode,
        drained: mode !== "undrained",
      };
      record.state.operation = operation;
      record.state.operationHistory = record.state.operationHistory.map((entry) =>
        entry.id === operation.id ? { ...entry, ...operation } : entry,
      );
      if (mode !== "missing-outcome")
        record.outcome = {
          operationId: operation.id,
          status: "completed",
          exitCode,
          transport: {
            exitCode: mode === "signal" ? null : mode === "transport-error" ? 1 : 0,
            signal: mode === "signal" ? "SIGTERM" : null,
          },
        };
    });
    await active.tick();
    if (mode === "exit0" || mode === "exit1") {
      expect(store.read().reservations[0]).toMatchObject({
        totals: { host: 10, runtime: 10 },
        startup: false,
        heavy: false,
      });
      expect(readReliabilityOperation(identity)?.capacity?.validUntilMs).toBe(0);
    } else expect(store.read().reservations[0]).toEqual(reservation);
    expect(launches).toHaveLength(2);
  } finally {
    active.close();
  }
});

afterAll(() => {
  if (fixture.root) fs.rmSync(fixture.root, { recursive: true, force: true });
});

it.each([
  "uncertain",
  "prepared",
  "restart",
])("keeps queued work isolated and settles preparation (%s)", async (mode) => {
  const controllerDirectory = path.join(fixture.root, "controller");
  fs.mkdirSync(controllerDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(controllerDirectory, 0o700);

  const firstPath = fs.mkdtempSync(path.join(fixture.root, "checkout-one-"));
  const secondPath = fs.mkdtempSync(path.join(fixture.root, "checkout-two-"));
  const first = environment(firstPath, "a");
  const second = environment(secondPath, "b");
  const firstEnrollment = policyEnrollment(first);
  const secondEnrollment = policyEnrollment(second);
  const firstIdentity: ReliabilityIdentity = {
    repoPath: first.repoPath,
    workspace: first.workspace,
    provider: first.provider,
  };
  const secondIdentity: ReliabilityIdentity = {
    repoPath: second.repoPath,
    workspace: second.workspace,
    provider: second.provider,
  };
  seedStopped(firstIdentity, durableEnrollment(first));
  seedStopped(secondIdentity, durableEnrollment(second));

  fs.writeFileSync(
    path.join(controllerDirectory, "capacity-policy.json"),
    `${JSON.stringify(policy([firstEnrollment, secondEnrollment]))}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(path.join(controllerDirectory, "capacity-policy.json"), 0o600);
  const incarnation = new ControllerStore(controllerDirectory).startIncarnation();
  const controllerIdentity = { store: incarnation.store, epoch: incarnation.epoch };
  const now = Date.now();
  const workerDone = deferred<void>();
  const launches: Array<{ request: LifecycleWorkerRequest; signal: AbortSignal }> = [];
  fixture.enroll.mockImplementation(
    async (_currentPolicy: CapacityPolicy, request: { path: string }) => {
      const current = request.path === first.repoPath ? first : second;
      return {
        environment: current,
        enrollment: policyEnrollment(current),
        estimates,
      };
    },
  );
  fixture.runLifecycleWorker.mockImplementation(
    async (request: LifecycleWorkerRequest, supervision: { signal: AbortSignal }) => {
      launches.push({ request, signal: supervision.signal });
      await workerDone.promise;
      return { status: "completed" };
    },
  );

  const active = createCapacityController({
    directory: controllerDirectory,
    controller: { ...controllerIdentity, directory: controllerDirectory, consumeStartup: () => {} },
    collect: async () => ({ host: sample(now), runtime: sample(now) }),
  });
  const firstSubmitted = (await active.submit(
    {
      version: 1,
      id: "submit-one",
      method: "operation-submit",
      session: "synthetic-session",
      store: controllerIdentity.store,
      epoch: controllerIdentity.epoch,
      generation: "synthetic-generation",
      requestId: "request-one",
      kind: "ensure",
    },
    first,
    new AbortController().signal,
  )) as { operation: { operationId: string; phase: string } };
  const secondSubmitted = (await active.submit(
    {
      version: 1,
      id: "submit-two",
      method: "operation-submit",
      session: "synthetic-session",
      store: controllerIdentity.store,
      epoch: controllerIdentity.epoch,
      generation: "synthetic-generation",
      requestId: "request-two",
      kind: "ensure",
    },
    second,
    new AbortController().signal,
  )) as { operation: { operationId: string; phase: string } };
  const firstOperation = firstSubmitted.operation;
  const secondOperation = secondSubmitted.operation;
  expect(firstOperation.phase).toBe("queued");
  expect(secondOperation.phase).toBe("queued");

  await active.tick();
  expect(launches).toHaveLength(1);
  expect(launches[0]?.request.operationId).toBe(firstOperation.operationId);
  expect(launches[0]?.signal.aborted).toBe(false);

  const reservations = new CapacityStore(controllerDirectory).read().reservations;
  expect(reservations).toEqual([
    expect.objectContaining({
      operationId: firstOperation.operationId,
      totals: { host: 20, runtime: 20 },
      startup: true,
    }),
  ]);
  await active.tick();
  expect(launches).toHaveLength(1);

  const pending = (await active.watch(
    watchRequest(controllerIdentity, secondOperation.operationId, 0),
    second,
    new AbortController().signal,
  )) as { operation: { operationId: string; phase: string } };
  expect(pending.operation).toMatchObject({
    operationId: secondOperation.operationId,
    phase: "queued",
  });

  const cancelled = new AbortController();
  const cancelledWait = active.watch(
    watchRequest(controllerIdentity, secondOperation.operationId, 30),
    second,
    cancelled.signal,
  );
  cancelled.abort();
  await expect(cancelledWait).rejects.toThrow("Capacity wait was cancelled.");
  expect(launches).toHaveLength(1);
  expect(launches[0]?.signal.aborted).toBe(false);

  const stillQueued = (await active.watch(
    watchRequest(controllerIdentity, secondOperation.operationId, 0),
    second,
    new AbortController().signal,
  )) as { operation: { operationId: string; phase: string } };
  expect(stillQueued.operation).toMatchObject({
    operationId: secondOperation.operationId,
    phase: "queued",
  });

  workerDone.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const retained = (await active.watch(
    watchRequest(controllerIdentity, firstOperation.operationId, 0),
    first,
    new AbortController().signal,
  )) as { operation: { operationId: string; phase: string } };
  expect(retained.operation).toMatchObject({
    operationId: firstOperation.operationId,
    phase: "queued",
  });
  expect(new CapacityStore(controllerDirectory).read().reservations).toEqual(reservations);
  if (mode !== "uncertain") {
    fs.writeFileSync(
      path.join(first.repoPath, ".devrouter.yml"),
      JSON.stringify({ version: 1, apps: [], capacity: estimates }),
    );
    updateReliabilityOperation(firstIdentity, (record) => {
      const completion = {
        ...record.state.operation!,
        status: "COMPLETED" as const,
        drained: true,
        exitCode: 1,
      };
      record.state.operation = completion;
      record.state.operationHistory = record.state.operationHistory.map((entry) =>
        entry.id === completion.id ? { ...entry, ...completion } : entry,
      );
      record.activeProfile = "full";
      record.preparation = {
        operationId: completion.id,
        profile: "full",
        fence: reliabilityFence(record.state),
      };
    });
    if (mode === "restart") {
      active.close();
      const replacement = new ControllerStore(controllerDirectory).startIncarnation();
      const restarted = createCapacityController({
        directory: controllerDirectory,
        controller: {
          directory: controllerDirectory,
          store: replacement.store,
          epoch: replacement.epoch,
          consumeStartup: () => {},
        },
        collect: async () => ({ host: sample(Date.now()), runtime: sample(Date.now()) }),
      });
      await restarted.tick();
      expect(new CapacityStore(controllerDirectory).read().reservations).toEqual([
        expect.objectContaining({
          operationId: firstOperation.operationId,
          totals: { host: 10, runtime: 10 },
          startup: false,
        }),
      ]);
      expect(launches).toHaveLength(1);
      restarted.close();
      return;
    }
    await active.tick();
    expect(launches).toHaveLength(2);
    expect(launches[1]?.request.operationId).toBe(secondOperation.operationId);
    expect(new CapacityStore(controllerDirectory).read().reservations).toEqual([
      expect.objectContaining({
        operationId: firstOperation.operationId,
        totals: { host: 10, runtime: 10 },
        startup: false,
      }),
      expect.objectContaining({ operationId: secondOperation.operationId, startup: true }),
    ]);
    active.close();
    return;
  }
  active.close();
  updateReliabilityOperation(secondIdentity, (record) => {
    // Model a persisted dispatch whose delivery result was lost with the controller.
    const operation = {
      ...record.state.operation!,
      status: "DISPATCH_RECORDED" as const,
      drained: false,
    };
    record.state.operation = operation;
    record.state.operationHistory = record.state.operationHistory.map((entry) =>
      entry.id === operation.id ? { ...entry, ...operation } : entry,
    );
    record.worker = {
      id: "uncertain-worker",
      operationId: operation.id,
      pid: 123456,
      birth: "proc:synthetic",
    };
  });
  const uncertain = readReliabilityOperation(secondIdentity)!;
  const replacement = new ControllerStore(controllerDirectory).startIncarnation();
  const restarted = createCapacityController({
    directory: controllerDirectory,
    controller: {
      directory: controllerDirectory,
      store: replacement.store,
      epoch: replacement.epoch,
      consumeStartup: () => {},
    },
    collect: async () => ({ host: sample(Date.now()), runtime: sample(Date.now()) }),
  });
  const reconciled = readReliabilityOperation(firstIdentity);
  expect(reconciled?.state.operation).toMatchObject({
    id: firstOperation.operationId,
    status: "NOT_STARTED",
    drained: true,
  });
  expect(reconciled?.capacity?.validUntilMs).toBe(0);
  const retainedUncertainty = readReliabilityOperation(secondIdentity)!;
  expect(retainedUncertainty.worker).toEqual(uncertain.worker);
  expect(retainedUncertainty.state).toEqual(uncertain.state);
  expect(new CapacityStore(controllerDirectory).read().reservations).toEqual(reservations);
  const reconnected = await restarted.submit(
    {
      version: 1,
      id: "reconnect-one",
      method: "operation-submit",
      session: "replacement-session",
      store: replacement.store,
      epoch: replacement.epoch,
      generation: "replacement-generation",
      requestId: "request-one",
      kind: "ensure",
    },
    first,
    new AbortController().signal,
  );
  expect(reconnected).toMatchObject({
    operation: {
      operationId: firstOperation.operationId,
      phase: "terminal",
      outcome: "NOT_STARTED",
    },
  });
  await restarted.tick();
  expect(launches).toHaveLength(1);
  restarted.close();
});
