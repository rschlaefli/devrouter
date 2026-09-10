import { beforeEach, expect, it, vi } from "vitest";
import { publishQueuedStartupWitness } from "../capacity-startup-witness";

const fixture = vi.hoisted(() => ({
  generation: vi.fn(),
  runtime: vi.fn(),
  plan: vi.fn(),
  state: vi.fn(),
  linked: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("../capacity-ownership-resolver", () => ({
  readProviderGeneration: fixture.generation,
}));
vi.mock("../repo-config", () => ({ loadRuntimeConfig: fixture.runtime }));
vi.mock("../devcontainer-profile", () => ({
  inspectManagedDevcontainerConfig: fixture.plan,
}));
vi.mock("../managed-runtime-state", () => ({ readManagedRuntimeState: fixture.state }));
vi.mock("../workspace", () => ({ isLinkedWorktree: fixture.linked }));
vi.mock("../reliability-operation-store", () => ({
  publishStartupWitness: fixture.publish,
}));

const identity = {
  repoPath: "/synthetic/checkout",
  workspace: "feature",
  provider: "devsy" as const,
};
const fence = {
  environmentId: "a".repeat(64),
  intentRevision: 3,
  runtimeGeneration: 1,
  controllerEpoch: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.generation.mockResolvedValue({
    context: "default",
    uid: "generation",
    sourceContainer: "container",
  });
  fixture.runtime.mockReturnValue({
    config: { managedRuntime: {} },
    profile: "full",
    resolvedProfile: { name: "full" },
  });
  fixture.plan.mockReturnValue({
    sourceConfigSha256: "b".repeat(64),
    effectiveConfigSha256: "c".repeat(64),
    primaryService: "app",
    composeFiles: ["/synthetic/checkout/.devcontainer/compose.yml"],
    desiredServices: ["db", "app"],
  });
  fixture.state.mockReturnValue(undefined);
  fixture.linked.mockReturnValue(true);
});

it("binds the queued witness to generation, request profile, plan, and retained IDs", async () => {
  fixture.state.mockReturnValue({
    stopBaseline: {
      containers: [{ id: "d".repeat(64) }, { id: "e".repeat(64) }],
    },
  });
  await expect(
    publishQueuedStartupWitness({
      identity,
      provider: "devsy",
      providerId: "synthetic-provider",
      operationId: "operation-1",
      fence,
      profile: "full",
      signal: new AbortController().signal,
    }),
  ).resolves.toBeUndefined();
  expect(fixture.publish).toHaveBeenCalledOnce();
  const [publishedIdentity, witness] = fixture.publish.mock.calls[0];
  expect(publishedIdentity).toEqual(identity);
  expect(witness).toEqual({
    operationId: "operation-1",
    fence,
    provider: {
      id: "synthetic-provider",
      context: "default",
      uid: "generation",
      sourceContainer: "container",
    },
    profile: "full",
    sourceConfigSha256: "b".repeat(64),
    effectiveConfigSha256: "c".repeat(64),
    composeFiles: ["/synthetic/checkout/.devcontainer/compose.yml"],
    primaryService: "app",
    startupServices: ["app", "db"],
    retainedContainerIds: ["d".repeat(64), "e".repeat(64)],
  });
  expect(fixture.runtime).toHaveBeenCalledWith("/synthetic/checkout", "feature", "full");
  expect(fixture.plan).toHaveBeenCalledWith(
    expect.objectContaining({ repoPath: "/synthetic/checkout", linked: true }),
  );
});

it("publishes an empty retained list for a cold environment", async () => {
  await publishQueuedStartupWitness({
    identity,
    provider: "devsy",
    providerId: "synthetic-provider",
    operationId: "operation-2",
    fence,
    profile: "full",
    signal: new AbortController().signal,
  });
  expect(fixture.publish.mock.calls[0]?.[1]).toMatchObject({ retainedContainerIds: [] });
});

it("publishes Devpod witnesses without reading retained Devsy generation", async () => {
  await publishQueuedStartupWitness({
    identity,
    provider: "devpod",
    providerId: "synthetic-provider",
    operationId: "operation-3",
    fence,
    profile: "full",
    signal: new AbortController().signal,
  });
  expect(fixture.generation).not.toHaveBeenCalled();
  expect(fixture.publish.mock.calls[0]?.[1]).toMatchObject({
    provider: { id: "synthetic-provider", context: "", uid: "", sourceContainer: "" },
  });
});
