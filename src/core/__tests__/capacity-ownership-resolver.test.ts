import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { resolveCapacityOwnership } from "../capacity-ownership-resolver";
import type { CapacityPolicy } from "../capacity-policy";
import type { ManagedStopContainerSnapshot } from "../devpod-environment";
import type { ManagedRuntimeState } from "../managed-runtime-state";
import type { ReliabilityOperationRecord } from "../reliability-operation-store";

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
      provider: "devsy",
      endpoint: `unix://${domain.endpoint}`,
      daemonId: domain.daemonId,
    },
  } as ManagedRuntimeState;
  const dependencies = {
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
