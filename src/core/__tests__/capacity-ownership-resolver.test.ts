import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { resolveCapacityOwnership } from "../capacity-ownership-resolver";
import type { CapacityPolicy } from "../capacity-policy";
import { runControllerProbe } from "../controller-probe";
import type { ManagedStopContainerSnapshot } from "../devpod-environment";
import type { ManagedRuntimeState } from "../managed-runtime-state";
import type {
  CapacityStartupWitness,
  ReliabilityOperationRecord,
} from "../reliability-operation-store";

vi.mock("../controller-probe", () => ({ runControllerProbe: vi.fn() }));

const witnessFiles = ["/synthetic/checkout/.devcontainer/compose.yml"];

function witness(overrides: Partial<CapacityStartupWitness> = {}): CapacityStartupWitness {
  return {
    operationId: "witnessed-operation",
    fence: {} as CapacityStartupWitness["fence"],
    provider: { id: "synthetic", context: "default", uid: "generation", sourceContainer: "" },
    profile: "full",
    sourceConfigSha256: "a".repeat(64),
    effectiveConfigSha256: "b".repeat(64),
    composeFiles: witnessFiles,
    primaryService: "app",
    startupServices: ["app"],
    retainedContainerIds: [],
    ...overrides,
  };
}

function fixture() {
  const repoPath = "/synthetic/checkout";
  const id = createHash("sha256").update(repoPath).digest("hex");
  const enrollment = {
    repoPath,
    gitCommonDir: "/synthetic/.git",
    workspace: "synthetic",
    provider: "devsy" as const,
    providerId: "synthetic",
    hostDomain: "host",
    runtimeDomain: "guest",
    profiles: ["full"],
    estimatesDigest: "a".repeat(64),
    defaultOperation: { hostIncrementBytes: 0, runtimeIncrementBytes: 10 },
  };
  const domain = {
    kind: "runtime" as const,
    adapter: "orbstack-declared-v1" as const,
    endpoint: "/synthetic/docker.sock",
    daemonId: "daemon",
    hostDomain: "host",
    hostChargeCeilingBytes: 1000,
    capacityBytes: 1000,
    protectedHeadroomBytes: 100,
    startupSlots: 1,
    heavySlots: 1,
    guestUnmanagedAllowanceBytes: 100,
  };
  const policy = {
    version: 1,
    revision: 1,
    admissions: "enabled",
    domains: { guest: domain },
    enrollments: [enrollment],
  } as unknown as CapacityPolicy;
  const binding = {
    enrollment,
    environment: {
      id,
      repoPath,
      workspace: "synthetic",
      provider: "devsy" as const,
      providerId: "synthetic",
      profile: "full",
      fingerprint: "fixed",
    },
    estimates: {},
  };
  const record = {
    identity: { repoPath, workspace: "synthetic", provider: "devsy" },
    revision: 1,
    enrollment: {
      policyRevision: 1,
      gitCommonDir: enrollment.gitCommonDir,
      providerId: "synthetic",
      hostDomain: "host",
      runtimeDomain: "guest",
      endpoint: domain.endpoint,
      daemonId: domain.daemonId,
      estimatesDigest: enrollment.estimatesDigest,
    },
    worker: null,
    state: {
      environmentId: id,
      executionPolicy: "capacity-managed",
      operation: null,
      stopProof: { workloadsStopped: true, routesRemoved: true },
    },
  } as unknown as ReliabilityOperationRecord;
  const state = {
    repoPath,
    workspace: "synthetic",
    devpodId: "synthetic",
    composeProject: "project",
    stopBaseline: {
      context: "default",
      uid: "generation",
      sourceContainer: "",
      provider: "devsy",
      endpoint: `unix://${domain.endpoint}`,
      daemonId: domain.daemonId,
    },
  } as ManagedRuntimeState;
  const dependencies = {
    providerGeneration: vi.fn(async () => ({
      context: "default",
      uid: "generation",
      sourceContainer: "",
    })),
    resolve: vi.fn(async () => structuredClone(binding)) as unknown as ReturnType<
      typeof vi.fn<typeof import("../capacity-enrollment").resolveCapacityEnrollment>
    >,
    journal: vi.fn(() => structuredClone(record)),
    managed: vi.fn(() => structuredClone(state)),
    population: vi.fn(async () => []),
    index: vi.fn(
      async () =>
        [] as Array<{
          id: string;
          project: string;
          workingDirectory: string;
          bindSources: string[];
        }>,
    ),
  };
  const cancellation = new AbortController();
  return {
    policy,
    record,
    state,
    dependencies,
    cancellation,
    id,
    resolve: () => resolveCapacityOwnership(policy, "guest", cancellation.signal, dependencies),
  };
}
it("proves a positively stopped absent population and revalidates provider ownership", async () => {
  const f = fixture();
  const resolver = await f.resolve();
  expect(await resolver.proveOwned(f.cancellation.signal)).toEqual([
    { environmentId: f.id, containers: [] },
  ]);
  expect(await resolver.proveOwned(f.cancellation.signal)).toEqual([
    { environmentId: f.id, containers: [] },
  ]);
  await resolver.revalidate();
  expect(f.dependencies.resolve).toHaveBeenCalledTimes(2);
});
it.each([
  "stop",
  "worker",
  "endpoint",
  "enrollment",
])("rejects absent population with uncertain %s evidence", async (difference) => {
  const f = fixture();
  if (difference === "stop") f.record.state.stopProof.workloadsStopped = false;
  if (difference === "worker")
    f.record.worker = { id: "worker", operationId: "operation", pid: 1, birth: "birth" };
  if (difference === "endpoint") f.state.stopBaseline!.endpoint = "unix:///foreign.sock";
  if (difference === "enrollment") f.record.enrollment!.daemonId = "foreign";
  const resolver = await f.resolve();
  await expect(resolver.proveOwned(f.cancellation.signal)).rejects.toThrow();
});
it.each([
  "project",
  "directory",
  "mount",
])("rejects residual enrolled container by %s", async (match) => {
  const f = fixture();
  f.dependencies.index.mockResolvedValue([
    {
      id: "b".repeat(64),
      project: match === "project" ? "project" : "other",
      workingDirectory: match === "directory" ? "/synthetic/checkout/.devcontainer" : "/other",
      bindSources: match === "mount" ? ["/synthetic/checkout"] : [],
    },
  ]);
  const resolver = await f.resolve();
  await expect(resolver.proveOwned(f.cancellation.signal)).rejects.toThrow();
});
it("does not attribute a sibling checkout by lexical prefix", async () => {
  const f = fixture();
  f.dependencies.index.mockResolvedValue([
    {
      id: "b".repeat(64),
      project: "other",
      workingDirectory: "/synthetic/checkout-other/.devcontainer",
      bindSources: ["/synthetic/checkout-other"],
    },
  ]);
  const resolver = await f.resolve();
  await expect(resolver.proveOwned(f.cancellation.signal)).resolves.toHaveLength(1);
});
it.each(["between-samples", "publication"])("rejects record drift at %s", async (when) => {
  const f = fixture();
  const resolver = await f.resolve();
  await resolver.proveOwned(f.cancellation.signal);
  f.record.revision++;
  await expect(
    when === "publication" ? resolver.revalidate() : resolver.proveOwned(f.cancellation.signal),
  ).rejects.toThrow();
});
it("rejects provider drift before publication", async () => {
  const f = fixture();
  const resolver = await f.resolve();
  await resolver.proveOwned(f.cancellation.signal);
  f.dependencies.resolve.mockImplementationOnce(async (...args) => {
    const result = await f.dependencies.resolve(...args);
    return { ...result, environment: { ...result.environment, fingerprint: "changed" } };
  });
  await expect(resolver.revalidate()).rejects.toThrow();
});
it("does not probe the daemon after cancellation", async () => {
  const f = fixture();
  const resolver = await f.resolve();
  f.cancellation.abort();
  await expect(resolver.proveOwned(f.cancellation.signal)).rejects.toThrow();
  expect(f.dependencies.index).not.toHaveBeenCalled();
});

it("samples a retained running population without treating a profile change as foreign ownership", async () => {
  const f = fixture();
  const repoPath = f.policy.enrollments[0].repoPath;
  const id = "c".repeat(64);
  const files = [`${repoPath}/.devcontainer/compose.yml`];
  const mounts = [{ Type: "bind", Source: repoPath, Destination: "/workspace" }];
  f.state.profile = "old-profile";
  Object.assign(f.state.stopBaseline!, {
    sourcePath: repoPath,
    project: "project",
    composeDirectory: `${repoPath}/.devcontainer`,
    primaryService: "app",
    containers: [{ id, service: "app", configFiles: files, mounts }],
  });
  f.record.state.stopProof.workloadsStopped = false;
  const container: ManagedStopContainerSnapshot = {
    id,
    mounts,
    labels: {
      "com.docker.compose.project": "project",
      "com.docker.compose.project.working_dir": `${repoPath}/.devcontainer`,
      "com.docker.compose.service": "app",
      "com.docker.compose.project.config_files": files.join(","),
    },
    networks: {},
    state: { Status: "running", Running: true, Paused: false, Restarting: false, Dead: false },
  };
  const resolver = await resolveCapacityOwnership(f.policy, "guest", f.cancellation.signal, {
    ...f.dependencies,
    population: async () => [container],
    index: async () => [
      {
        id,
        project: "project",
        workingDirectory: `${repoPath}/.devcontainer`,
        bindSources: [repoPath],
      },
    ],
  });
  expect(await resolver.proveOwned(f.cancellation.signal)).toEqual([
    { environmentId: f.id, containers: [container] },
  ]);
  await resolver.revalidate();
});

it.each([
  "context",
  "uid",
  "sourceContainer",
] as const)("rejects retained provider %s drift", async (field) => {
  const f = fixture();
  f.state.stopBaseline![field] = "foreign";
  const resolver = await f.resolve();
  await expect(resolver.proveOwned(f.cancellation.signal)).rejects.toThrow();
});
it("revalidates provider generation before publishing memory evidence", async () => {
  const f = fixture();
  const resolver = await f.resolve();
  await resolver.proveOwned(f.cancellation.signal);
  f.dependencies.providerGeneration.mockResolvedValue({
    context: "default",
    uid: "replacement",
    sourceContainer: "",
  });
  await expect(resolver.revalidate()).rejects.toThrow();
});

it.each([
  "undispatched",
  "worker",
  "dispatched",
])("proves empty queued population only before dispatch (%s)", async (phase) => {
  const f = fixture();
  f.record.state.phase = "queued";
  f.record.state.stopProof = { workloadsStopped: false, routesRemoved: false };
  f.record.state.operation = {
    id: "queued",
    status: "NOT_STARTED",
    drained: false,
  } as typeof f.record.state.operation;
  if (phase === "worker")
    f.record.worker = { id: "worker", operationId: "queued", pid: 1, birth: "birth" };
  if (phase === "dispatched") f.record.state.operation!.status = "RUNNING";
  const before = structuredClone(f.record);
  const resolver = await f.resolve();
  if (phase !== "undispatched") {
    await expect(resolver.proveOwned(f.cancellation.signal)).rejects.toThrow();
    expect(f.record).toEqual(before);
    return;
  }
  expect(await resolver.proveOwned(f.cancellation.signal)).toEqual([
    { environmentId: f.id, containers: [] },
  ]);
  await resolver.revalidate();
  expect(f.record).toEqual(before);
});

it.each([
  "context",
  "uid",
  "sourceContainer",
])("rejects present null provider %s metadata", async (field) => {
  const f = fixture();
  const entry = {
    id: "synthetic",
    context: "default",
    uid: "generation",
    source: { localFolder: "/synthetic/checkout", container: "" },
  };
  if (field === "sourceContainer") Object.assign(entry.source, { container: null });
  else Object.assign(entry, { [field]: null });
  vi.mocked(runControllerProbe).mockResolvedValue(JSON.stringify([entry]));
  await expect(
    resolveCapacityOwnership(f.policy, "guest", f.cancellation.signal, {
      ...f.dependencies,
      providerGeneration: undefined,
    }),
  ).rejects.toThrow();
});

it("proves an empty population from a cold startup witness without stop evidence", async () => {
  const f = fixture();
  f.record.startupWitness = witness();
  f.record.state.stopProof.workloadsStopped = false;
  f.record.state.stopProof.routesRemoved = false;
  const resolver = await f.resolve();
  expect(await resolver.proveOwned(f.cancellation.signal)).toEqual([
    { environmentId: f.id, containers: [] },
  ]);
  await resolver.revalidate();
});

it("samples a witnessed startup population as owned", async () => {
  const f = fixture();
  const id = "c".repeat(64);
  const mounts = [{ Type: "bind", Source: "/synthetic/checkout", Destination: "/workspace" }];
  f.record.startupWitness = witness();
  const container: ManagedStopContainerSnapshot = {
    id,
    mounts,
    labels: {
      "com.docker.compose.project": "project",
      "com.docker.compose.project.working_dir": "/synthetic/checkout/.devcontainer",
      "com.docker.compose.service": "app",
      "com.docker.compose.project.config_files": witnessFiles.join(","),
    },
    networks: {},
    state: { Status: "running", Running: true, Paused: false, Restarting: false, Dead: false },
  };
  const resolver = await resolveCapacityOwnership(f.policy, "guest", f.cancellation.signal, {
    ...f.dependencies,
    population: async () => [container],
    index: async () => [
      {
        id,
        project: "project",
        workingDirectory: "/synthetic/checkout/.devcontainer",
        bindSources: ["/synthetic/checkout"],
      },
    ],
  });
  expect(await resolver.proveOwned(f.cancellation.signal)).toEqual([
    { environmentId: f.id, containers: [container] },
  ]);
  await resolver.revalidate();
});

it("rejects a witness bound to a replaced provider generation", async () => {
  const f = fixture();
  f.record.startupWitness = witness({
    provider: { id: "synthetic", context: "default", uid: "replacement", sourceContainer: "" },
  });
  const resolver = await f.resolve();
  await expect(resolver.proveOwned(f.cancellation.signal)).rejects.toThrow(
    "Capacity witnessed startup generation changed.",
  );
});

it("rejects a witnessed population without its primary container", async () => {
  const f = fixture();
  const id = "d".repeat(64);
  f.record.startupWitness = witness({ startupServices: ["app", "db"] });
  const secondary: ManagedStopContainerSnapshot = {
    id,
    mounts: [{ Type: "volume", Source: "/synthetic/volume", Destination: "/data" }],
    labels: {
      "com.docker.compose.project": "project",
      "com.docker.compose.project.working_dir": "/synthetic/checkout/.devcontainer",
      "com.docker.compose.service": "db",
      "com.docker.compose.project.config_files": witnessFiles.join(","),
    },
    networks: {},
    state: { Status: "running", Running: true, Paused: false, Restarting: false, Dead: false },
  };
  const resolver = await resolveCapacityOwnership(f.policy, "guest", f.cancellation.signal, {
    ...f.dependencies,
    population: async () => [secondary],
    index: async () => [],
  });
  await expect(resolver.proveOwned(f.cancellation.signal)).rejects.toThrow(
    "Capacity witnessed population is missing the primary container.",
  );
});
