import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCapacityController } from "../capacity-controller";
import { controllerCapability, environmentIdentity } from "../controller-monitor";
import type { ControllerSessionValidator } from "../controller-server";

const fixture = vi.hoisted(() => ({
  policy: vi.fn(),
  enroll: vi.fn(),
  resolve: vi.fn(),
  status: vi.fn(),
  wait: vi.fn(),
  page: vi.fn(),
  close: vi.fn(),
  tick: vi.fn(),
  journal: vi.fn(),
  prepare: vi.fn(),
  prepareRecovery: vi.fn(),
  hasOperation: vi.fn(),
  retire: vi.fn(),
  settle: vi.fn(),
  evidence: vi.fn(),
  config: vi.fn(),
  runtimeConfig: vi.fn(),
  charge: vi.fn(),
  enqueue: vi.fn(),
  list: vi.fn(),
  info: vi.fn(),
  snapshot: vi.fn(),
  merge: vi.fn(),
  incarnation: vi.fn(),
  collection: vi.fn(),
  witness: vi.fn(),
  running: vi.fn(),
  park: vi.fn(),
  resumePrepare: vi.fn(),
  reconcileStop: vi.fn(),
  restoreParked: vi.fn(),
  worker: vi.fn(),
}));
vi.mock("../capacity-startup-witness", () => ({
  publishQueuedStartupWitness: fixture.witness,
}));
vi.mock("../devpod-environment", () => ({
  resolveRunningWorkspaceContainer: fixture.running,
}));
vi.mock("../capacity-docker-probe", () => ({ readDockerCapacityInfo: fixture.info }));
vi.mock("../controller-store", () => ({
  ControllerStore: class {
    read = fixture.incarnation;
  },
}));
vi.mock("../reliability-operation-store", () => ({
  createLifecycleCapacityStore: () => ({
    read: fixture.snapshot,
    mergeObservedPools: fixture.merge,
  }),
  readReliabilityOperation: fixture.journal,
  listReliabilityOperations: fixture.list,
}));
vi.mock("../reliability-lifecycle", () => ({
  prepareManagedLifecycleOperation: fixture.prepare,
  prepareRecoveryLifecycleOperation: fixture.prepareRecovery,
  prepareParkLifecycleOperation: fixture.park,
  prepareResumeLifecycleOperation: fixture.resumePrepare,
  reconcileParkedLifecycleStop: fixture.reconcileStop,
  restoreParkedIntentAfterFailedResume: fixture.restoreParked,
  retireQueuedLifecycle: fixture.retire,
  settlePreparedLifecycleCapacity: fixture.settle,
}));
vi.mock("../reliability-worker", () => ({ runLifecycleWorker: fixture.worker }));
vi.mock("../controller-binding", async (original) => ({
  ...(await original<typeof import("../controller-binding")>()),
  readControllerEvidence: fixture.evidence,
}));
vi.mock("../repo-config", () => ({
  loadRepoConfig: fixture.config,
  loadRuntimeConfig: fixture.runtimeConfig,
}));
vi.mock("../capacity-request", () => ({ capacityRequest: fixture.charge }));
vi.mock("../capacity-policy", () => ({ readCapacityPolicy: fixture.policy }));
vi.mock("../capacity-enrollment", () => ({
  enrollCapacityLifecycle: fixture.enroll,
  resolveCapacityEnrollment: fixture.resolve,
}));
vi.mock("../lifecycle-operation-status", () => ({ readLifecycleOperationStatus: fixture.status }));
vi.mock("../capacity-queue", () => ({
  CapacityQueue: class {
    constructor(options: { collect: () => Promise<unknown> }) {
      fixture.collection.mockImplementation(options.collect);
    }
    observePage = fixture.page;
    wait = fixture.wait;
    close = fixture.close;
    tick = fixture.tick;
    enqueue = fixture.enqueue;
    hasOperation = fixture.hasOperation;
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  fixture.policy.mockReturnValue({
    revision: 1,
    admissions: "enabled",
    scheduling: { sampleIntervalSeconds: 1, maxSampleAgeSeconds: 15 },
    recovery: { enabled: false, observationSeconds: 30, resumeDwellSeconds: 300 },
    enrollments: [submissionEnrollment],
    domains: { host: { kind: "host" }, runtime: submissionRuntime },
  });
  fixture.list.mockReturnValue([]);
  fixture.runtimeConfig.mockReturnValue({ config: { apps: [] } });
  fixture.incarnation.mockReturnValue({ store: "store", epoch: 1 });
  fixture.snapshot.mockReturnValue({ revision: 7, reservations: [], pools: [] });
  fixture.merge.mockReturnValue({ changed: true, revision: 8 });
  fixture.info.mockResolvedValue({ ID: "synthetic.daemon", MemTotal: 100 });
});
afterEach(() => vi.useRealTimers());
const submissionEnrollment = { hostDomain: "host", runtimeDomain: "runtime" };
const submissionRuntime = {
  kind: "runtime",
  daemonId: "synthetic.daemon",
  hostDomain: "host",
  hostChargeCeilingBytes: 60,
};
const environment = {
  id: "env",
  repoPath: "/fixture",
  workspace: "fixture",
  provider: "devsy" as const,
  providerId: "provider",
  profile: "full",
  fingerprint: "fingerprint",
};
const binding = {
  version: 1 as const,
  id: "transport",
  session: "reader",
  store: "store",
  epoch: 1,
  generation: "generation",
};
function controller(
  collect: (
    signal: AbortSignal,
  ) => Promise<
    Record<string, import("../capacity-accounting").CapacityDomainSample>
  > = async () => ({}),
  clock = () => ({ wallMs: 100, monotonicMs: 100 }),
) {
  return createCapacityController({
    directory: "/tmp/synthetic-controller",
    controller: {
      directory: "/tmp/synthetic-controller",
      store: "store",
      epoch: 1,
      consumeStartup: () => {},
    },
    collect,
    clock,
  });
}

const submissionValidator: ControllerSessionValidator = () => ({
  id: "synthetic-consumer",
  requiredCapabilities: [],
  pinned: false,
});

function submissionFixture() {
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: {},
    enrollment: submissionEnrollment,
  });
  fixture.journal.mockReturnValue({ state: { environmentId: "env" }, activeProfile: null });
  fixture.charge.mockReturnValue({ environmentId: "env", totals: { host: 1 } });
  fixture.status.mockReturnValue({ operationId: "accepted", phase: "queued" });
  fixture.prepare.mockReturnValue({
    operationId: "accepted",
    request: {
      operationId: "accepted",
      requestId: "stable",
      fence: { environmentId: "env", intentRevision: 1, runtimeGeneration: 1, controllerEpoch: 1 },
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

/** Synthetic provider facts for the recovery path; the resolver never writes. */
const recoveryEnrollment = {
  hostDomain: "host",
  runtimeDomain: "runtime",
  gitCommonDir: "/fixture/.git",
  providerId: "provider",
  estimatesDigest: "d".repeat(64),
};
const recoveryRuntime = {
  kind: "runtime" as const,
  daemonId: "synthetic.daemon",
  hostDomain: "host",
  hostChargeCeilingBytes: 60,
  endpoint: "/tmp/synthetic-controller/d.sock",
};
const recoveryDurableEnrollment = {
  policyRevision: 1,
  gitCommonDir: recoveryEnrollment.gitCommonDir,
  providerId: recoveryEnrollment.providerId,
  hostDomain: recoveryEnrollment.hostDomain,
  runtimeDomain: recoveryEnrollment.runtimeDomain,
  endpoint: recoveryRuntime.endpoint,
  daemonId: recoveryRuntime.daemonId,
  estimatesDigest: recoveryEnrollment.estimatesDigest,
};
const recoveryEstimates = { host: { steadyBytes: 1 } };

function recoveryFixture() {
  fixture.policy.mockReturnValue({
    revision: 1,
    admissions: "enabled",
    scheduling: { sampleIntervalSeconds: 1, maxSampleAgeSeconds: 15 },
    recovery: {
      enabled: true,
      maxCorrectiveActions: 3,
      maxProcessRestarts: 2,
      maxServiceRestarts: 1,
      windowSeconds: 600,
      observationSeconds: 30,
      resumeDwellSeconds: 300,
    },
    enrollments: [recoveryEnrollment],
    domains: { host: { kind: "host" }, runtime: recoveryRuntime },
  });
  fixture.runtimeConfig.mockReturnValue({
    config: {
      apps: [
        {
          name: "admin",
          kind: "app",
          host: "admin.fixture.localhost",
          protocol: "http",
          runtime: "proxy",
          upstream: "fixture-postgres:8080",
          readiness: { path: "/health" },
        },
        {
          name: "web",
          kind: "app",
          host: "web.fixture.localhost",
          protocol: "http",
          runtime: "proxy",
          upstream: "fixture-app:3000",
          readiness: { path: "/health" },
        },
      ],
      managedRuntime: {
        devcontainer: { baseServices: ["postgres"], profileServices: [] },
        processes: ["app"],
      },
    },
  });
  fixture.resolve.mockResolvedValue({
    environment,
    enrollment: recoveryEnrollment,
    estimates: recoveryEstimates,
  });
  fixture.journal.mockReturnValue({
    state: { environmentId: "env", operation: null },
    activeProfile: null,
    enrollment: recoveryDurableEnrollment,
  });
  fixture.hasOperation.mockReturnValue(false);
  fixture.charge.mockReturnValue({ environmentId: "env", totals: { host: 1 } });
  fixture.prepareRecovery.mockReturnValue({
    operationId: "recovered",
    request: { operationId: "recovered", requestId: "recovery" },
  });
}

/** Stand-in for the monitor's producing-observation closure. */
function recoveryProof(failedCapabilities = ["app-dead"]) {
  return () => ({ journalRevision: 1, failedCapabilities });
}

const submission = {
  ...binding,
  method: "operation-submit" as const,
  kind: "ensure" as const,
  requestId: "stable",
};

function policyEnrollment(repoPath: string) {
  return { repoPath, workspace: null, provider: "devsy" as const };
}

function preparedRecord(overrides: { worker?: unknown; drained?: boolean } = {}) {
  return {
    capacity: {
      reservationId: "reservation",
      operationId: "operation",
      validUntilMs: 0,
    },
    preparation: { operationId: "operation" },
    worker: overrides.worker ?? null,
    state: {
      operation: {
        kind: "ensure",
        drained: overrides.drained ?? true,
        status: "COMPLETED",
      },
    },
  };
}

it("settles a completed drained ensure before queue tick", async () => {
  const enrollment = policyEnrollment("/fixture");
  const estimates = { host: { steadyBytes: 1 } };
  fixture.policy.mockReturnValue({
    ...fixture.policy(),
    revision: 1,
    admissions: "enabled",
    enrollments: [enrollment],
  });
  fixture.journal.mockReturnValue(preparedRecord());
  fixture.evidence.mockReturnValue(Buffer.from("synthetic"));
  fixture.config.mockReturnValue({ capacity: estimates });

  const active = controller();
  await active.tick();

  expect(fixture.settle).toHaveBeenCalledWith({
    identity: { repoPath: "/fixture", workspace: null, provider: "devsy" },
    controller: { store: "store", epoch: 1 },
    estimates,
    enrollment,
    directory: "/tmp/synthetic-controller",
  });
  expect(fixture.settle.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.tick.mock.invocationCallOrder[0],
  );
  expect(fixture.tick).toHaveBeenCalledOnce();
});

it.each([
  ["worker", { worker: { id: "worker" } }],
  ["undrained", { drained: false }],
] as const)("does not settle an ensure with %s evidence", async (_label, overrides) => {
  const enrollment = policyEnrollment("/fixture");
  fixture.policy.mockReturnValue({
    ...fixture.policy(),
    revision: 1,
    admissions: "enabled",
    enrollments: [enrollment],
  });
  fixture.journal.mockReturnValue(preparedRecord(overrides));

  const active = controller();
  await active.tick();

  expect(fixture.settle).not.toHaveBeenCalled();
  expect(fixture.tick).toHaveBeenCalledOnce();
});

it("skips preparation settlement when the operator policy changes", async () => {
  const initial = {
    ...fixture.policy(),
    revision: 1,
    admissions: "enabled",
    enrollments: [policyEnrollment("/fixture")],
  };
  fixture.policy
    .mockReturnValueOnce(initial)
    .mockReturnValue({ revision: 2, admissions: "enabled", enrollments: initial.enrollments });

  const active = controller();
  await active.tick();

  expect(fixture.journal).not.toHaveBeenCalled();
  expect(fixture.settle).not.toHaveBeenCalled();
  expect(fixture.tick).toHaveBeenCalledOnce();
});

it("continues settling independent enrollments after one enrollment fails", async () => {
  const bad = policyEnrollment("/bad");
  const good = policyEnrollment("/good");
  const estimates = { guest: { steadyBytes: 2 } };
  fixture.policy.mockReturnValue({
    ...fixture.policy(),
    revision: 1,
    admissions: "enabled",
    enrollments: [bad, good],
  });
  fixture.journal.mockImplementation((target: { repoPath: string }) => {
    if (target.repoPath === bad.repoPath) throw new Error("bad enrollment");
    return preparedRecord();
  });
  fixture.evidence.mockReturnValue(Buffer.from("synthetic"));
  fixture.config.mockReturnValue({ capacity: estimates });

  const active = controller();
  await active.tick();

  expect(fixture.settle).toHaveBeenCalledOnce();
  expect(fixture.settle).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: { repoPath: "/good", workspace: null, provider: "devsy" },
    }),
  );
  expect(fixture.tick).toHaveBeenCalledOnce();
});

it("continues queue handling when settlement cannot read the policy", async () => {
  const active = controller();
  fixture.policy.mockImplementation(() => {
    throw new Error("transient policy read failure");
  });
  fixture.tick.mockResolvedValue(undefined);
  await expect(active.tick()).resolves.toBeUndefined();
  expect(fixture.settle).not.toHaveBeenCalled();
  expect(fixture.journal).not.toHaveBeenCalled();
  expect(fixture.tick).toHaveBeenCalledOnce();
});

it("skips preparation settlement after the controller closes", async () => {
  const enrollment = policyEnrollment("/fixture");
  fixture.policy.mockReturnValue({
    ...fixture.policy(),
    revision: 1,
    admissions: "enabled",
    enrollments: [enrollment],
  });
  fixture.journal.mockReturnValue(preparedRecord());

  const active = controller();
  active.close();
  await active.tick();

  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.settle).not.toHaveBeenCalled();
});

it("rejects consumed startup authority before inspecting journals or policy", () => {
  const consumeStartup = vi.fn(() => {
    throw new Error("Startup already consumed");
  });
  expect(() =>
    createCapacityController({
      directory: "/tmp/synthetic-controller",
      controller: {
        directory: "/tmp/synthetic-controller",
        store: "store",
        epoch: 1,
        consumeStartup,
      },
      collect: async () => ({}),
    }),
  ).toThrow("Startup already consumed");
  expect(fixture.list).not.toHaveBeenCalled();
  expect(fixture.policy).not.toHaveBeenCalled();
});

it("reads terminal journal results after transient queue output is absent", async () => {
  const operation = {
    operationId: "retained",
    phase: "terminal",
    outcome: "COMPLETED",
    exitCode: 7,
  };
  fixture.status.mockReturnValue(operation);
  fixture.page.mockReturnValue(undefined);
  expect(
    await controller().watch(
      { ...binding, method: "operation-watch", operationId: "retained", timeout: 30 },
      environment,
      new AbortController().signal,
    ),
  ).toEqual({ operation, output: null });
  expect(fixture.wait).not.toHaveBeenCalled();
});
it("rejects a foreign operation before reading transient output", async () => {
  fixture.status.mockReturnValue(undefined);
  await expect(
    controller().watch(
      { ...binding, method: "operation-watch", operationId: "foreign", timeout: 30 },
      environment,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(fixture.page).not.toHaveBeenCalled();
});
it("does not begin enrollment after operator policy is paused", async () => {
  const active = controller();
  fixture.policy.mockReturnValue({ revision: 1, admissions: "paused" });
  await expect(
    active.submit(
      { ...binding, method: "operation-submit", requestId: "request", kind: "ensure" },
      environment,
      new AbortController().signal,
      submissionValidator,
    ),
  ).rejects.toThrow();
  expect(fixture.enroll).not.toHaveBeenCalled();
});

it("cancels in-flight enrollment when its owning controller closes", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enrollmentSignal: AbortSignal | undefined;
  fixture.enroll.mockImplementation(async (_policy, _request, signal) => {
    enrollmentSignal = signal;
    await held;
    return { environment, estimates: {}, enrollment: submissionEnrollment };
  });
  const active = controller();
  const pending = active.submit(
    { ...binding, method: "operation-submit", kind: "ensure", requestId: "stable" },
    environment,
    new AbortController().signal,
    submissionValidator,
  );
  expect(enrollmentSignal?.aborted).toBe(false);
  active.close();
  expect(enrollmentSignal?.aborted).toBe(true);
  release();
  await expect(pending).rejects.toThrow();
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("does not prepare work if policy changes while enrollment resolves", async () => {
  fixture.enroll.mockImplementation(async () => {
    fixture.policy.mockReturnValue({ revision: 1, admissions: "paused" });
    return { environment, estimates: {}, enrollment: submissionEnrollment };
  });
  await expect(
    controller().submit(
      { ...binding, method: "operation-submit", kind: "ensure", requestId: "stable" },
      environment,
      new AbortController().signal,
      submissionValidator,
    ),
  ).rejects.toThrow("policy changed");
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it.each([
  false,
  true,
])("owns a newly prepared request or retires a rejected enqueue (%s)", async (reject) => {
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: {},
    enrollment: submissionEnrollment,
  });
  fixture.journal.mockReturnValue({ state: { environmentId: "env" }, activeProfile: null });
  fixture.charge.mockReturnValue({
    environmentId: "env",
    totals: { host: 1 },
    startup: true,
    heavy: false,
  });
  const prepared = { operationId: "accepted", requestId: "stable" };
  fixture.prepare.mockReturnValue({ operationId: "accepted", request: prepared });
  fixture.status.mockReturnValue({ operationId: "accepted", phase: "queued" });
  if (reject)
    fixture.enqueue.mockImplementation(() => {
      throw new Error("queue full");
    });
  const result = controller().submit(
    { ...binding, method: "operation-submit", kind: "ensure", requestId: "stable" },
    environment,
    new AbortController().signal,
    submissionValidator,
  );
  if (reject) {
    await expect(result).rejects.toThrow("queue full");
    expect(fixture.retire).toHaveBeenCalledWith(prepared);
  } else {
    await expect(result).resolves.toMatchObject({
      operation: { operationId: "accepted", phase: "queued" },
    });
    expect(fixture.retire).not.toHaveBeenCalled();
  }
  expect(fixture.enqueue).toHaveBeenCalledWith(
    prepared,
    expect.objectContaining({ operationId: "accepted", policyRevision: 1, totals: { host: 1 } }),
    {
      estimates: {},
      enrollment: submissionEnrollment,
      pool: {
        daemonId: "synthetic.daemon",
        hostDomain: "host",
        runtimeDomain: "runtime",
        hostChargeCeilingBytes: 60,
      },
    },
  );
});

it("publishes the queued startup witness before enqueueing an ensure", async () => {
  const policyEnrollmentWithProvider = {
    ...submissionEnrollment,
    provider: "devsy" as const,
    providerId: "provider",
  };
  fixture.policy.mockReturnValue({
    ...fixture.policy(),
    revision: 1,
    admissions: "enabled",
    enrollments: [policyEnrollmentWithProvider],
    domains: { host: { kind: "host" }, runtime: submissionRuntime },
  });
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: {},
    enrollment: policyEnrollmentWithProvider,
  });
  fixture.journal.mockReturnValue({ state: { environmentId: "env" }, activeProfile: null });
  fixture.charge.mockReturnValue({
    environmentId: "env",
    totals: { host: 1 },
    startup: true,
    heavy: false,
  });
  fixture.prepare.mockReturnValue({
    operationId: "accepted",
    request: {
      operationId: "accepted",
      requestId: "stable",
      fence: { environmentId: "env", intentRevision: 1, runtimeGeneration: 1, controllerEpoch: 1 },
    },
  });
  fixture.status.mockReturnValue({ operationId: "accepted", phase: "queued" });
  await expect(
    controller().submit(
      { ...binding, method: "operation-submit", kind: "ensure", requestId: "stable" },
      environment,
      new AbortController().signal,
      submissionValidator,
    ),
  ).resolves.toBeDefined();
  expect(fixture.witness).toHaveBeenCalledOnce();
  expect(fixture.witness).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: { repoPath: "/fixture", workspace: "fixture", provider: "devsy" },
      provider: "devsy",
      providerId: "provider",
      operationId: "accepted",
      profile: "full",
      fence: { environmentId: "env", intentRevision: 1, runtimeGeneration: 1, controllerEpoch: 1 },
    }),
  );
  expect(fixture.enqueue).toHaveBeenCalledOnce();
});

it("retires the queued intent when startup witness publication fails", async () => {
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: {},
    enrollment: submissionEnrollment,
  });
  fixture.journal.mockReturnValue({ state: { environmentId: "env" }, activeProfile: null });
  fixture.charge.mockReturnValue({
    environmentId: "env",
    totals: { host: 1 },
    startup: true,
    heavy: false,
  });
  const prepared = { operationId: "accepted", requestId: "stable" };
  fixture.prepare.mockReturnValue({ operationId: "accepted", request: prepared });
  fixture.witness.mockImplementation(() => {
    throw new Error("witness fence changed");
  });
  await expect(
    controller().submit(
      { ...binding, method: "operation-submit", kind: "ensure", requestId: "stable" },
      environment,
      new AbortController().signal,
      submissionValidator,
    ),
  ).rejects.toThrow("witness fence changed");
  expect(fixture.retire).toHaveBeenCalledWith(prepared);
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("publishes no startup witness for exec submissions", async () => {
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: {},
    enrollment: submissionEnrollment,
  });
  fixture.journal.mockReturnValue({ state: { environmentId: "env" }, activeProfile: null });
  fixture.charge.mockReturnValue({ environmentId: "env", totals: { host: 1 } });
  fixture.prepare.mockReturnValue({
    operationId: "accepted",
    request: { operationId: "accepted", requestId: "stable" },
  });
  fixture.status.mockReturnValue({ operationId: "accepted", phase: "queued" });
  await controller().submit(
    {
      ...binding,
      method: "operation-submit",
      kind: "exec",
      requestId: "stable",
      command: ["synthetic"],
    },
    environment,
    new AbortController().signal,
    submissionValidator,
  );
  expect(fixture.witness).not.toHaveBeenCalled();
  expect(fixture.enqueue).toHaveBeenCalledOnce();
});

it("does not enqueue a second payload when durable preparation joins", async () => {
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: {},
    enrollment: submissionEnrollment,
  });
  fixture.journal.mockReturnValue({ state: { environmentId: "env" }, activeProfile: null });
  fixture.charge.mockReturnValue({
    environmentId: "env",
    totals: { host: 1 },
    startup: true,
    heavy: false,
  });
  fixture.prepare.mockReturnValue({ operationId: "accepted" });
  fixture.status.mockReturnValue({ operationId: "accepted", phase: "running" });
  await expect(
    controller().submit(
      { ...binding, method: "operation-submit", kind: "ensure", requestId: "stable" },
      environment,
      new AbortController().signal,
      submissionValidator,
    ),
  ).resolves.toMatchObject({ operation: { operationId: "accepted" } });
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("rejects conflicting repeated operation metadata while the accepted payload is retained", async () => {
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: {},
    enrollment: submissionEnrollment,
  });
  fixture.journal.mockReturnValue({ state: { environmentId: "env" }, activeProfile: null });
  fixture.charge.mockReturnValue({ environmentId: "env", totals: { host: 1 } });
  fixture.prepare
    .mockReturnValueOnce({ operationId: "accepted", request: { operationId: "accepted" } })
    .mockReturnValue({ operationId: "accepted" });
  fixture.page.mockReturnValue({ phase: "queued" });
  const active = controller();
  const request = {
    ...binding,
    method: "operation-submit" as const,
    kind: "ensure" as const,
    requestId: "stable",
    operation: "small",
  };
  await active.submit(request, environment, new AbortController().signal, submissionValidator);
  await expect(
    active.submit(
      { ...request, operation: "large" },
      environment,
      new AbortController().signal,
      submissionValidator,
    ),
  ).rejects.toThrow("conflicts");
  expect(fixture.enqueue).toHaveBeenCalledOnce();
});

it.each([
  "host",
  "runtime",
  "enrollment",
])("refuses mismatched policy pool binding %s before preparation", async (mismatch) => {
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: {},
    enrollment: {
      ...submissionEnrollment,
      ...(mismatch === "enrollment" ? { hostDomain: "other" } : {}),
    },
  });
  fixture.policy.mockReturnValue({
    ...fixture.policy(),
    revision: 1,
    admissions: "enabled",
    enrollments: [submissionEnrollment],
    domains: {
      host: { kind: "host" },
      runtime: {
        ...submissionRuntime,
        ...(mismatch === "host" ? { hostDomain: "other" } : {}),
        ...(mismatch === "runtime" ? { kind: "host" } : {}),
      },
    },
  });
  await expect(
    controller().submit(
      { ...binding, method: "operation-submit", kind: "ensure", requestId: "stable" },
      environment,
      new AbortController().signal,
      submissionValidator,
    ),
  ).rejects.toThrow(Error);
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

const collectedSample = {
  sampledAtMs: 100,
  pressure: "normal" as const,
  unmanagedBytes: 4,
  sharedBytes: 3,
  ownedBytes: {},
};
function collectionPolicy(count = 1) {
  const domains: Record<string, unknown> = {
    host: { kind: "host" },
    independent: { kind: "host" },
  };
  for (let i = 0; i < count; i++)
    domains[`runtime-${i}`] = {
      ...submissionRuntime,
      endpoint: `/synthetic-${i}.sock`,
      daemonId: `daemon-${i}`,
      hostDomain: i === 0 ? "host" : "independent",
    };
  const policy = {
    revision: 1,
    admissions: "enabled",
    enrollments: [],
    domains,
    scheduling: { sampleIntervalSeconds: 1, maxSampleAgeSeconds: 15 },
    recovery: { enabled: false, observationSeconds: 30, resumeDwellSeconds: 300 },
  };
  fixture.policy.mockReturnValue(policy);
  return policy;
}

it("retains successful pool observations while isolating unknown host and runtime evidence", async () => {
  collectionPolicy(2);
  fixture.info.mockImplementation(async (endpoint) => ({
    ID: endpoint === "/synthetic-0.sock" ? "foreign" : "daemon-1",
    MemTotal: 100,
  }));
  const samples = {
    host: collectedSample,
    independent: collectedSample,
    "runtime-0": collectedSample,
    "runtime-1": collectedSample,
  };
  controller(async () => samples);
  const result = await fixture.collection();
  expect(result.host).toEqual({ ...collectedSample, pressure: "unknown" });
  expect(result["runtime-0"].pressure).toBe("unknown");
  expect(result.independent).toEqual(collectedSample);
  expect(result["runtime-1"]).toEqual(collectedSample);
  expect(samples.host.pressure).toBe("normal");
  expect(fixture.merge).toHaveBeenCalledWith(
    [
      {
        daemonId: "daemon-1",
        runtimeDomain: "runtime-1",
        hostDomain: "independent",
        hostChargeCeilingBytes: 60,
      },
    ],
    7,
  );
});

it.each([
  "policy",
  "epoch",
  "store",
])("rejects %s drift during collection before persistence", async (field) => {
  const initial = collectionPolicy();
  fixture.info.mockImplementation(async () => {
    if (field === "policy") fixture.policy.mockReturnValue({ ...initial, revision: 2 });
    else
      fixture.incarnation.mockReturnValue({
        store: field === "store" ? "other" : "store",
        epoch: field === "epoch" ? 2 : 1,
      });
    return { ID: "daemon-0", MemTotal: 100 };
  });
  controller();
  await expect(fixture.collection()).rejects.toThrow(Error);
  expect(fixture.merge).not.toHaveBeenCalled();
});

it("rechecks authority after the supplied sample collector awaits", async () => {
  collectionPolicy();
  fixture.info.mockResolvedValue({ ID: "daemon-0", MemTotal: 100 });
  controller(async () => {
    fixture.incarnation.mockReturnValue({ store: "store", epoch: 2 });
    return {};
  });
  await expect(fixture.collection()).rejects.toThrow(Error);
  expect(fixture.merge).not.toHaveBeenCalled();
});

it.each(["close", "timeout"])("bounds four in-flight probes and drains on %s", async (mode) => {
  vi.useFakeTimers();
  collectionPolicy(8);
  const signals: AbortSignal[] = [];
  let activeProbes = 0;
  let drained = 0;
  fixture.info.mockImplementation(
    (_endpoint, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signals.push(signal);
        activeProbes++;
        signal.addEventListener(
          "abort",
          () => {
            activeProbes--;
            drained++;
            reject(new Error("synthetic abort"));
          },
          { once: true },
        );
      }),
  );
  const samples = vi.fn(async () => ({ host: collectedSample, independent: collectedSample }));
  const active = controller(samples);
  const pending = fixture.collection();
  const completion =
    mode === "close"
      ? expect(pending).rejects.toThrow(Error)
      : expect(pending).resolves.toMatchObject({
          host: { pressure: "unknown" },
          independent: { pressure: "unknown" },
        });
  expect(activeProbes).toBe(4);
  if (mode === "close") active.close();
  else await vi.advanceTimersByTimeAsync(3000);
  await completion;
  expect(signals).toHaveLength(4);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(drained).toBe(4);
  expect(activeProbes).toBe(0);
  if (mode === "close") {
    expect(samples).not.toHaveBeenCalled();
    expect(fixture.merge).not.toHaveBeenCalled();
  } else expect(fixture.merge).toHaveBeenCalledWith([], 7);
});

it("retains a closing collector slot until its underlying work drains", async () => {
  collectionPolicy();
  fixture.info.mockResolvedValue({ ID: "daemon-0", MemTotal: 100 });
  let started!: (signal: AbortSignal) => void;
  const collecting = new Promise<AbortSignal>((resolve) => {
    started = resolve;
  });
  let finishDrain!: () => void;
  const drain = new Promise<void>((resolve) => {
    finishDrain = resolve;
  });
  const events: string[] = [];
  const launch = vi.fn();
  fixture.tick.mockImplementation(async () => {
    await fixture.collection();
    launch();
  });
  const active = controller(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            events.push("aborted");
            void drain.then(() => {
              events.push("drained");
              reject(new Error("synthetic collector cancelled"));
            });
          },
          { once: true },
        );
        started(signal);
      }),
  );
  const pending = active.tick().catch((error: unknown) => {
    events.push("tick-rejected");
    throw error;
  });
  const completion = expect(pending).rejects.toThrow(Error);
  const signal = await collecting;
  expect(signal.aborted).toBe(false);
  active.close();
  expect(signal.aborted).toBe(true);
  await completion;
  expect(events).toEqual(["aborted", "tick-rejected"]);
  finishDrain();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(events).toEqual(["aborted", "tick-rejected", "drained"]);
  expect(fixture.merge).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it("opens a bounded recovery for a failed capability when policy enables it", async () => {
  recoveryFixture();

  await controller().recover(
    environment,
    ["app-dead"],
    new AbortController().signal,
    recoveryProof(),
  );

  expect(fixture.enroll).not.toHaveBeenCalled();
  expect(fixture.prepareRecovery).toHaveBeenCalledWith(
    expect.objectContaining({
      policyRevision: 1,
      journalRevision: 1,
      actionLimit: 3,
      failedCapabilities: ["app-dead"],
      profile: "full",
      recoveryLimits: { maxProcessRestarts: 2, maxServiceRestarts: 1, windowSeconds: 600 },
      recoverySelectors: { process: ["app:web"], service: ["app:admin"] },
    }),
  );
  expect(fixture.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: "recovered" }),
    expect.objectContaining({ operationId: "recovered", policyRevision: 1, totals: { host: 1 } }),
    {
      estimates: recoveryEstimates,
      enrollment: recoveryEnrollment,
      pool: {
        daemonId: "synthetic.daemon",
        hostDomain: "host",
        runtimeDomain: "runtime",
        hostChargeCeilingBytes: 60,
      },
    },
  );
});

it("keeps the aggregate ceiling when the repository configuration is unreadable", async () => {
  recoveryFixture();
  fixture.runtimeConfig.mockImplementation(() => {
    throw new Error("synthetic unreadable configuration");
  });

  await controller().recover(
    environment,
    ["app-dead"],
    new AbortController().signal,
    recoveryProof(),
  );

  expect(fixture.prepareRecovery).toHaveBeenCalledWith(
    expect.objectContaining({ recoverySelectors: { process: [], service: [] } }),
  );
});

it("is inert when policy leaves automatic recovery disabled", async () => {
  fixture.policy.mockReturnValue({
    revision: 1,
    admissions: "enabled",
    scheduling: { sampleIntervalSeconds: 1, maxSampleAgeSeconds: 15 },
    recovery: { enabled: false, observationSeconds: 30, resumeDwellSeconds: 300 },
    enrollments: [recoveryEnrollment],
    domains: { host: { kind: "host" }, runtime: recoveryRuntime },
  });
  await controller().recover(
    environment,
    ["app-dead"],
    new AbortController().signal,
    recoveryProof(),
  );
  expect(fixture.resolve).not.toHaveBeenCalled();
  expect(fixture.prepareRecovery).not.toHaveBeenCalled();
});

it("leaves an operation the queue still owns alone", async () => {
  recoveryFixture();
  fixture.journal.mockReturnValue({
    state: { environmentId: "env", operation: { id: "inflight" } },
    activeProfile: null,
    enrollment: recoveryDurableEnrollment,
  });
  fixture.hasOperation.mockReturnValue(true);

  await controller().recover(
    environment,
    ["app-dead"],
    new AbortController().signal,
    recoveryProof(),
  );

  expect(fixture.hasOperation).toHaveBeenCalledWith("inflight");
  expect(fixture.prepareRecovery).not.toHaveBeenCalled();
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("prepares and enqueues nothing when the held session proof fails", async () => {
  recoveryFixture();
  let valid = true;
  const proof = () => {
    if (!valid) throw new Error("observation invalidated");
    return { journalRevision: 1, failedCapabilities: ["app-dead"] };
  };
  const started = deferred<void>();
  const held = deferred<void>();
  fixture.resolve.mockImplementation(async () => {
    started.resolve();
    await held.promise;
    return {
      environment,
      enrollment: recoveryEnrollment,
      estimates: recoveryEstimates,
    };
  });

  const pending = controller().recover(
    environment,
    ["app-dead"],
    new AbortController().signal,
    proof,
  );
  await started.promise;
  valid = false;
  held.resolve();
  await pending;

  expect(fixture.prepareRecovery).not.toHaveBeenCalled();
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("recovers only the failures a surviving consumer still requires", async () => {
  recoveryFixture();
  let calls = 0;
  const proof = () => {
    calls += 1;
    return {
      journalRevision: 1,
      failedCapabilities: calls === 1 ? ["app-dead", "app-released"] : ["app-dead"],
    };
  };

  await controller().recover(
    environment,
    ["app-dead", "app-released"],
    new AbortController().signal,
    proof,
  );

  expect(fixture.prepareRecovery).toHaveBeenCalledWith(
    expect.objectContaining({ failedCapabilities: ["app-dead"], journalRevision: 1 }),
  );
  expect(fixture.enqueue).toHaveBeenCalledOnce();
});

it("never broadens the producing failure set from a later observation", async () => {
  recoveryFixture();
  let calls = 0;
  const proof = () => {
    calls += 1;
    return {
      journalRevision: 1,
      failedCapabilities: calls === 1 ? ["app-dead"] : ["app-other"],
    };
  };

  await controller().recover(environment, ["app-dead"], new AbortController().signal, proof);

  expect(fixture.prepareRecovery).not.toHaveBeenCalled();
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("does not prepare or enqueue an ensure whose session is released during enrollment", async () => {
  submissionFixture();
  const validator = vi.fn(submissionValidator);
  validator.mockReturnValueOnce({
    id: "synthetic-consumer",
    requiredCapabilities: [],
    pinned: false,
  });
  validator.mockImplementationOnce(() => {
    throw new Error("session released during enrollment");
  });
  await expect(
    controller().submit(submission, environment, new AbortController().signal, validator),
  ).rejects.toThrow("session released during enrollment");
  expect(validator.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.enqueue).not.toHaveBeenCalled();
  expect(fixture.retire).not.toHaveBeenCalled();
});

it("retires the exact undispatched request when the generation changes during witness", async () => {
  submissionFixture();
  const witnessHeld = deferred<void>();
  const witnessEntered = deferred<void>();
  let validateCalls = 0;
  const validator = vi.fn<ControllerSessionValidator>(() => {
    validateCalls += 1;
    if (validateCalls >= 3) throw new Error("session generation changed");
    return { id: "synthetic-consumer", requiredCapabilities: [], pinned: false };
  });
  fixture.witness.mockImplementation(async () => {
    witnessEntered.resolve();
    await witnessHeld.promise;
  });
  const pending = controller().submit(
    submission,
    environment,
    new AbortController().signal,
    validator,
  );
  await witnessEntered.promise;
  witnessHeld.resolve();
  await expect(pending).rejects.toThrow("session generation changed");
  expect(validateCalls).toBe(3);
  expect(fixture.retire).toHaveBeenCalledWith(fixture.prepare.mock.results[0].value.request);
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("maps current session requirements onto the submitted consumer", async () => {
  submissionFixture();
  const consumer = {
    id: "hashed-binding",
    requiredCapabilities: [controllerCapability("app:web"), "runtime"],
    pinned: false,
  };
  const validator = vi.fn(() => consumer);
  await expect(
    controller().submit(submission, environment, new AbortController().signal, validator),
  ).resolves.toMatchObject({ operation: { operationId: "accepted", phase: "queued" } });
  expect(validator).toHaveBeenCalledTimes(3);
  expect(validator).toHaveBeenCalledWith();
  expect(fixture.prepare).toHaveBeenCalledWith(expect.objectContaining({ consumer }));
});

it("refuses a submission whose enrollment resolves a different environment", async () => {
  submissionFixture();
  fixture.enroll.mockResolvedValue({
    environment: { ...environment, repoPath: "/elsewhere" },
    estimates: {},
    enrollment: submissionEnrollment,
  });
  const validator = vi.fn(submissionValidator);
  await expect(
    controller().submit(submission, environment, new AbortController().signal, validator),
  ).rejects.toThrow("Capacity submission binding changed.");
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

function pressureFixture() {
  const policy = collectionPolicy();
  policy.recovery.enabled = true;
  policy.recovery.observationSeconds = 2;
  policy.recovery.resumeDwellSeconds = 3;
  let now = { wallMs: 10_000, monotonicMs: 10_000 };
  fixture.info.mockResolvedValue({ ID: "daemon-0", MemTotal: 100 });
  const sample = (pressure: "normal" | "pressured" | "unknown" = "normal") => ({
    ...collectedSample,
    sampledAtMs: now.wallMs,
    pressure,
  });
  const collect = vi.fn(async () => ({ host: sample(), "runtime-0": sample() }));
  const active = controller(collect, () => ({ ...now }));
  return {
    policy,
    active,
    collect,
    sample,
    advance: (ms: number) => {
      now = { wallMs: now.wallMs + ms, monotonicMs: now.monotonicMs + ms };
    },
    jumpWall: (ms: number) => {
      now.wallMs += ms;
    },
    evidence: () => active.pressureEvidence({ hostDomain: "host", runtimeDomain: "runtime-0" }),
  };
}

it("shares collection and cached cadence without extending observed dwell", async () => {
  const context = pressureFixture();
  const first = fixture.collection();
  const second = fixture.collection();
  expect(first).toBe(second);
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  context.advance(999);
  await fixture.collection();
  expect(context.collect).toHaveBeenCalledTimes(1);
  expect(context.evidence().domains.host.observedDurationMs).toBe(0);
  context.advance(1);
  await fixture.collection();
  expect(context.collect).toHaveBeenCalledTimes(2);
  expect(context.evidence().domains.host.observedDurationMs).toBe(1000);
  context.active.close();
});

it("requires complete continuous evidence for normal dwell and sustained pressure", async () => {
  const context = pressureFixture();
  for (let tick = 0; tick <= 3; tick++) {
    await fixture.collection();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(context.evidence().normalDwellSatisfied).toBe(tick === 3);
    if (tick < 3) context.advance(1000);
  }
  context.collect.mockImplementation(async () => ({
    host: context.sample("pressured"),
    "runtime-0": context.sample(),
  }));
  for (let tick = 0; tick <= 2; tick++) {
    context.advance(1000);
    await fixture.collection();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(context.evidence().sustainedPressure).toBe(tick === 2);
    expect(context.evidence().normalDwellSatisfied).toBe(false);
  }
  context.collect.mockImplementation(async () => ({
    host: context.sample("pressured"),
    "runtime-0": context.sample("unknown"),
  }));
  context.advance(1000);
  await fixture.collection();
  expect(context.evidence().sustainedPressure).toBe(false);
  context.active.close();
});

it("expires completed dwell on reads and refuses changed live authority", async () => {
  const context = pressureFixture();
  for (let tick = 0; tick <= 3; tick++) {
    await fixture.collection();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (tick < 3) context.advance(1000);
  }
  expect(context.evidence().normalDwellSatisfied).toBe(true);
  context.advance(15_000);
  expect(context.evidence().normalDwellSatisfied).toBe(true);
  context.advance(1);
  expect(context.evidence().normalDwellSatisfied).toBe(false);
  context.policy.recovery.resumeDwellSeconds = 1;
  expect(context.evidence).toThrow();
  context.policy.recovery.resumeDwellSeconds = 3;
  expect(context.evidence).toThrow();
  context.active.close();
});

it.each([
  "timeout",
  "clock-read",
  "close",
])("retains an unresponsive collector slot after %s", async (cause) => {
  vi.useFakeTimers();
  const context = pressureFixture();
  let finish!: (value: Awaited<ReturnType<typeof context.collect>>) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signal!: AbortSignal;
  context.collect.mockImplementation(
    (input?: AbortSignal) =>
      new Promise((resolve) => {
        signal = input!;
        finish = resolve;
        started();
      }),
  );
  const pending = fixture.collection();
  const rejected = expect(pending).rejects.toThrow();
  await entered;
  if (cause === "timeout") {
    context.advance(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
  } else if (cause === "clock-read") {
    context.jumpWall(2001);
    expect(context.evidence().normalDwellSatisfied).toBe(false);
  } else context.active.close();
  await rejected;
  expect(signal.aborted).toBe(true);
  await expect(fixture.collection()).rejects.toThrow();
  expect(context.collect).toHaveBeenCalledTimes(1);
  expect(fixture.merge).not.toHaveBeenCalled();
  finish({ host: context.sample(), "runtime-0": context.sample() });
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.merge).not.toHaveBeenCalled();
  if (cause !== "close") expect(context.evidence().normalDwellSatisfied).toBe(false);
  context.active.close();
});

it("handles late collector rejection and starts fresh only after drain and cadence", async () => {
  vi.useFakeTimers();
  const context = pressureFixture();
  let fail!: (error: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  context.collect.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
        entered();
      }),
  );
  const pending = fixture.collection();
  const rejected = expect(pending).rejects.toThrow();
  await started;
  context.advance(15_000);
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  await expect(fixture.collection()).rejects.toThrow();
  fail(new Error("late synthetic failure"));
  await vi.advanceTimersByTimeAsync(0);
  await fixture.collection();
  expect(context.collect).toHaveBeenCalledTimes(2);
  expect(context.evidence().domains.host.observedDurationMs).toBe(0);
  context.active.close();
});

it.each([
  false,
  true,
])("samples idle environments only when recovery is enabled=%s", async (enabled) => {
  const context = pressureFixture();
  context.active.close();
  context.policy.recovery.enabled = enabled;
  const active = controller();
  await active.tick();
  expect(fixture.tick).toHaveBeenCalledWith({ observeIdle: enabled });
  active.close();
});

/**
 * A controller incarnation whose cloned policy already enrolls the capacity
 * target. The enrolment has to exist before startup: the target resolver
 * re-reads the live policy and refuses a decision when it differs from the
 * clone, so adding an enrolment afterwards is a policy change rather than a
 * fixture shortcut. None of the refused paths below reach worker dispatch,
 * which is why the lifecycle preparation mocks stay untouched.
 */
const capacityEnrollment = {
  hostDomain: "host",
  runtimeDomain: "runtime-0",
  gitCommonDir: "/fixture/.git",
  providerId: "provider",
  estimatesDigest: "c".repeat(64),
};

function capacityPolicyFixture(
  options: {
    recoveryEnabled?: boolean;
    enroll?: boolean;
    collect?: (
      signal: AbortSignal,
    ) => Promise<Record<string, import("../capacity-accounting").CapacityDomainSample>>;
    clock?: () => { wallMs: number; monotonicMs: number };
  } = {},
) {
  const base = collectionPolicy();
  const policy = {
    ...base,
    recovery: {
      ...base.recovery,
      enabled: options.recoveryEnabled ?? true,
      observationSeconds: 2,
      resumeDwellSeconds: 3,
    },
    enrollments: (options.enroll ?? true) ? [capacityEnrollment] : [],
  };
  fixture.policy.mockReturnValue(policy);
  fixture.resolve.mockResolvedValue({
    environment,
    enrollment: capacityEnrollment,
    estimates: { host: { steadyBytes: 1 } },
  });
  const active = controller(options.collect, options.clock);
  if (!active.capacity) throw new Error("Capacity directive is unavailable.");
  return { policy, active, capacity: active.capacity };
}

const capacitySignal = () => new AbortController().signal;

it("refuses to park while automatic recovery is disabled", async () => {
  const context = capacityPolicyFixture({ recoveryEnabled: false });
  await expect(
    context.capacity.park(environment, 1, () => "unusable-consumers-proven", capacitySignal()),
  ).resolves.toBe(false);
  expect(fixture.resolve).not.toHaveBeenCalled();
  context.active.close();
});

it("refuses to park an environment the policy does not enroll", async () => {
  const context = capacityPolicyFixture({ enroll: false });
  await expect(
    context.capacity.park(environment, 1, () => "unusable-consumers-proven", capacitySignal()),
  ).resolves.toBe(false);
  expect(fixture.resolve).toHaveBeenCalledTimes(1);
  context.active.close();
});

it("refuses to park without sustained pressure evidence", async () => {
  const context = capacityPolicyFixture();
  await expect(
    context.capacity.park(environment, 1, () => "unusable-consumers-proven", capacitySignal()),
  ).resolves.toBe(false);
  // The enrolled target resolved, so the refusal came from the pressure gate.
  expect(fixture.resolve).toHaveBeenCalledTimes(1);
  context.active.close();
});

it("refuses to resume while headroom has not dwelled normal", async () => {
  const context = capacityPolicyFixture();
  await expect(context.capacity.resume(environment, 1, () => [], capacitySignal())).resolves.toBe(
    false,
  );
  expect(fixture.resolve).toHaveBeenCalledTimes(1);
  context.active.close();
});

it("refuses a parked stop once the operator policy changed", async () => {
  const context = capacityPolicyFixture();
  fixture.policy.mockReturnValue({ ...context.policy, revision: 2 });
  await expect(
    context.capacity.parkedStop(environmentIdentity(environment), capacitySignal()),
  ).resolves.toBe(false);
  context.active.close();
});

/**
 * The success paths below are the only ones that reach worker dispatch. The
 * refused paths above return before it, so these mocks are consulted here only.
 * Each decision must rest on pressure the tracker itself accumulated across
 * distinct observations, never on a caller-supplied shortcut. The drain between
 * collections matches the real cadence path: the collector slot clears on its
 * own microtask, so an unawaited second read would reuse the first result.
 */
const pressuredSample = (wallMs: number) => ({
  sampledAtMs: wallMs,
  pressure: "pressured" as const,
  unmanagedBytes: 4,
  sharedBytes: 3,
  ownedBytes: {},
});
const normalSample = (wallMs: number) => ({
  sampledAtMs: wallMs,
  pressure: "normal" as const,
  unmanagedBytes: 4,
  sharedBytes: 3,
  ownedBytes: {},
});
const drainCollection = () => new Promise<void>((resolve) => setImmediate(resolve));

it("parks an enrolled pressured environment by committing intent and driving one stop", async () => {
  const clock = { wallMs: 10_000, monotonicMs: 10_000 };
  fixture.info.mockResolvedValue({ ID: "daemon-0", MemTotal: 100 });
  fixture.park.mockReturnValue({ request: { intent: "park" } });
  const context = capacityPolicyFixture({
    collect: async () => ({
      host: pressuredSample(clock.wallMs),
      "runtime-0": pressuredSample(clock.wallMs),
    }),
    clock: () => ({ ...clock }),
  });
  // Observations 1s apart reach the 2s sustained-pressure window on the third.
  await fixture.collection();
  await drainCollection();
  for (let tick = 0; tick < 2; tick++) {
    clock.wallMs += 1000;
    clock.monotonicMs += 1000;
    await fixture.collection();
    await drainCollection();
  }

  const observation = () => "unusable-consumers-proven" as const;
  await expect(context.capacity.park(environment, 1, observation, capacitySignal())).resolves.toBe(
    true,
  );
  expect(fixture.park).toHaveBeenCalledTimes(1);
  const options = fixture.park.mock.calls[0][0];
  expect(options.identity).toEqual(environmentIdentity(environment));
  expect(options.policyRevision).toBe(1);
  expect(options.journalRevision).toBe(1);
  // The failed-capability proof is the controller's own journal gate.
  expect(options.observationSatisfied({})).toBe(true);
  expect(fixture.worker).toHaveBeenCalledWith({ intent: "park" });
  context.active.close();
});

it("resumes a parked environment by enqueuing one automatic resume", async () => {
  const clock = { wallMs: 10_000, monotonicMs: 10_000 };
  fixture.info.mockResolvedValue({ ID: "daemon-0", MemTotal: 100 });
  fixture.journal.mockReturnValue({ state: { environmentId: "env" }, activeProfile: null });
  fixture.charge.mockReturnValue({ environmentId: "env", totals: { host: 1 } });
  fixture.resumePrepare.mockReturnValue({
    operationId: "resume-op",
    request: { intent: "resume" },
  });
  const context = capacityPolicyFixture({
    collect: async () => ({
      host: normalSample(clock.wallMs),
      "runtime-0": normalSample(clock.wallMs),
    }),
    clock: () => ({ ...clock }),
  });
  // Observations 1s apart reach the 3s normal-dwell window on the fourth.
  await fixture.collection();
  await drainCollection();
  for (let tick = 0; tick < 3; tick++) {
    clock.wallMs += 1000;
    clock.monotonicMs += 1000;
    await fixture.collection();
    await drainCollection();
  }

  await expect(context.capacity.resume(environment, 1, () => [], capacitySignal())).resolves.toBe(
    true,
  );
  expect(fixture.enqueue).toHaveBeenCalledTimes(1);
  const [request, charge, , autoResume] = fixture.enqueue.mock.calls[0];
  expect(request).toEqual({ intent: "resume" });
  expect(charge.operationId).toBe("resume-op");
  // The automatic-resume flag is what lets an expired queue entry return to parked intent.
  expect(autoResume).toBe(true);
  context.active.close();
});
