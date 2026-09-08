import { beforeEach, expect, it, vi } from "vitest";
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
  retire: vi.fn(),
  charge: vi.fn(),
  enqueue: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../reliability-operation-store", () => ({
  readReliabilityOperation: fixture.journal,
  listReliabilityOperations: fixture.list,
}));
vi.mock("../reliability-lifecycle", () => ({
  prepareManagedLifecycleOperation: fixture.prepare,
  retireQueuedLifecycle: fixture.retire,
}));
vi.mock("../capacity-request", () => ({ capacityRequest: fixture.charge }));
vi.mock("../capacity-policy", () => ({ readCapacityPolicy: fixture.policy }));
vi.mock("../capacity-enrollment", () => ({ enrollCapacityLifecycle: fixture.enroll }));
vi.mock("../lifecycle-operation-status", () => ({ readLifecycleOperationStatus: fixture.status }));
vi.mock("../capacity-queue", () => ({
  CapacityQueue: class {
    observePage = fixture.page;
    wait = fixture.wait;
    close = fixture.close;
    tick = fixture.tick;
    enqueue = fixture.enqueue;
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  fixture.policy.mockReturnValue({ revision: 1, admissions: "enabled" });
  fixture.list.mockReturnValue([]);
});
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
function controller() {
  return createCapacityController({
    directory: "/tmp/synthetic-controller",
    controller: {
      directory: "/tmp/synthetic-controller",
      store: "store",
      epoch: 1,
      consumeStartup: () => {},
    },
    collect: async () => ({}),
  });
}
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
    return { environment, estimates: {}, enrollment: {} };
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
    return { environment, estimates: {}, enrollment: {} };
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
  fixture.enroll.mockResolvedValue({ environment, estimates: {}, enrollment: {} });
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
  );
});

it("does not enqueue a second payload when durable preparation joins", async () => {
  fixture.enroll.mockResolvedValue({ environment, estimates: {}, enrollment: {} });
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
  fixture.enroll.mockResolvedValue({ environment, estimates: {}, enrollment: {} });
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
