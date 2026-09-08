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
  withWorkspaceLifecycleLock: vi.fn(),
  isLinkedWorktree: vi.fn(),
  resolveLinkedTarget: vi.fn(),
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

vi.mock("../managed-stop-recovery", () => ({
  proveRetainedManagedStop: fixture.proveRetainedManagedStop,
}));

vi.mock("../reliability-worker", () => ({
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

  it("persists history rollover and its new fence before invoking the next worker", async () => {
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
      expect(persisted.revision).toBe(before.revision + 1);
      expect(persisted.state.intentRevision).toBe(before.state.intentRevision + 1);
      expect(request.fence).toEqual(contract.reliabilityFence(persisted.state));
      expect(persisted.state.operation?.id).toBe("next-operation");
      expect(persisted.state.operationHistory).toHaveLength(128);
      expect(persisted.state.operationHistory.some((entry) => entry.id === "old-0")).toBe(false);
      expect(persisted.state.operationHistory.some((entry) => entry.id === "operation-id")).toBe(
        true,
      );
    });
    await lifecycle.superviseLifecycle("ensure", identity.repoPath, {});
    expect(fixture.runLifecycleWorker).toHaveBeenCalledOnce();
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
