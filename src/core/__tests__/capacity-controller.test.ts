import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCapacityController } from "../capacity-controller";

const fixture = vi.hoisted(() => ({
  policy: vi.fn(),
  enroll: vi.fn(),
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
}));
vi.mock("../capacity-startup-witness", () => ({
  publishQueuedStartupWitness: fixture.witness,
}));
vi.mock("../devpod-environment", () => ({
  resolveRunningWorkspaceContainer: fixture.running,
}));
vi.mock("../capacity-docker-probe", () => ({ readDockerCapacityInfo: fixture.info }));
vi.mock("../capacity-store", () => ({
  CapacityStore: class {
    read = fixture.snapshot;
    mergeObservedPools = fixture.merge;
  },
}));
vi.mock("../controller-store", () => ({
  ControllerStore: class {
    read = fixture.incarnation;
  },
}));
vi.mock("../reliability-operation-store", () => ({
  readReliabilityOperation: fixture.journal,
  listReliabilityOperations: fixture.list,
}));
vi.mock("../reliability-lifecycle", () => ({
  prepareManagedLifecycleOperation: fixture.prepare,
  prepareRecoveryLifecycleOperation: fixture.prepareRecovery,
  retireQueuedLifecycle: fixture.retire,
  settlePreparedLifecycleCapacity: fixture.settle,
}));
vi.mock("../controller-binding", () => ({ readControllerEvidence: fixture.evidence }));
vi.mock("../repo-config", () => ({ loadRepoConfig: fixture.config }));
vi.mock("../capacity-request", () => ({ capacityRequest: fixture.charge }));
vi.mock("../capacity-policy", () => ({ readCapacityPolicy: fixture.policy }));
vi.mock("../capacity-enrollment", () => ({ enrollCapacityLifecycle: fixture.enroll }));
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
    enrollments: [submissionEnrollment],
    domains: { host: { kind: "host" }, runtime: submissionRuntime },
  });
  fixture.list.mockReturnValue([]);
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
  });
}

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
  fixture.policy.mockReturnValue({ revision: 1, admissions: "enabled", enrollments: [enrollment] });
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
  fixture.policy.mockReturnValue({ revision: 1, admissions: "enabled", enrollments: [enrollment] });
  fixture.journal.mockReturnValue(preparedRecord(overrides));

  const active = controller();
  await active.tick();

  expect(fixture.settle).not.toHaveBeenCalled();
  expect(fixture.tick).toHaveBeenCalledOnce();
});

it("skips preparation settlement when the operator policy changes", async () => {
  const initial = {
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
  fixture.policy.mockReturnValue({ revision: 1, admissions: "enabled", enrollments: [bad, good] });
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
  fixture.policy.mockReturnValue({ revision: 1, admissions: "enabled", enrollments: [enrollment] });
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
  await active.submit(request, environment, new AbortController().signal);
  await expect(
    active.submit({ ...request, operation: "large" }, environment, new AbortController().signal),
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
  const policy = { revision: 1, admissions: "enabled", enrollments: [], domains };
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

it("drains a cooperative sample collector on close before tick rejects", async () => {
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
  expect(events).toEqual(["aborted"]);
  finishDrain();
  await completion;
  expect(events).toEqual(["aborted", "drained", "tick-rejected"]);
  expect(fixture.merge).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it("opens a bounded recovery for a failed capability when policy enables it", async () => {
  fixture.policy.mockReturnValue({
    revision: 1,
    admissions: "enabled",
    recovery: { enabled: true, maxCorrectiveActions: 3 },
    enrollments: [submissionEnrollment],
    domains: { host: { kind: "host" }, runtime: submissionRuntime },
  });
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: { host: { steadyBytes: 1 } },
    enrollment: submissionEnrollment,
  });
  fixture.journal.mockReturnValue({ state: { environmentId: "env", operation: null } });
  fixture.hasOperation.mockReturnValue(false);
  fixture.charge.mockReturnValue({
    environmentId: "env",
    totals: { host: 1 },
    startup: false,
    heavy: false,
  });
  fixture.prepareRecovery.mockReturnValue({
    operationId: "recovered",
    request: { operationId: "recovered", requestId: "recovery" },
  });

  await controller().recover(environment, ["app-dead"], new AbortController().signal);

  expect(fixture.prepareRecovery).toHaveBeenCalledWith(
    expect.objectContaining({
      policyRevision: 1,
      actionLimit: 3,
      failedCapabilities: ["app-dead"],
      profile: "full",
    }),
  );
  expect(fixture.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: "recovered" }),
    expect.objectContaining({ operationId: "recovered", policyRevision: 1, totals: { host: 1 } }),
    {
      estimates: { host: { steadyBytes: 1 } },
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

it("is inert when policy leaves automatic recovery disabled", async () => {
  fixture.policy.mockReturnValue({
    revision: 1,
    admissions: "enabled",
    recovery: { enabled: false },
    enrollments: [submissionEnrollment],
    domains: { host: { kind: "host" }, runtime: submissionRuntime },
  });
  await controller().recover(environment, ["app-dead"], new AbortController().signal);
  expect(fixture.enroll).not.toHaveBeenCalled();
  expect(fixture.prepareRecovery).not.toHaveBeenCalled();
});

it("leaves an operation the queue still owns alone", async () => {
  fixture.policy.mockReturnValue({
    revision: 1,
    admissions: "enabled",
    recovery: { enabled: true, maxCorrectiveActions: 3 },
    enrollments: [submissionEnrollment],
    domains: { host: { kind: "host" }, runtime: submissionRuntime },
  });
  fixture.enroll.mockResolvedValue({
    environment,
    estimates: {},
    enrollment: submissionEnrollment,
  });
  fixture.journal.mockReturnValue({
    state: { environmentId: "env", operation: { id: "inflight" } },
  });
  fixture.hasOperation.mockReturnValue(true);

  await controller().recover(environment, ["app-dead"], new AbortController().signal);

  expect(fixture.hasOperation).toHaveBeenCalledWith("inflight");
  expect(fixture.prepareRecovery).not.toHaveBeenCalled();
  expect(fixture.enqueue).not.toHaveBeenCalled();
});
