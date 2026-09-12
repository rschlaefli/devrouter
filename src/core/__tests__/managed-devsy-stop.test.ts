import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevrouterApp, DevrouterConfig, DevrouterProfile } from "../../types";
import {
  assertManagedContainerConfigUnchanged,
  inspectManagedDevcontainerConfig,
  inspectManagedDevcontainerGeneratedConfig,
  stopExactManagedService,
} from "../devcontainer-profile";
import {
  assertManagedStopCheckoutAbsent,
  inspectManagedStopContainers,
  inspectManagedStopDaemon,
  inspectManagedStopRunnerId,
  inspectManagedStopWorkspaceIds,
  inspectProviderRunnerContainers,
  inspectWorkspaceContainers,
  resolveManagedStopEndpoint,
  stopPinnedManagedContainer,
  supportsManagedStopBaseline,
} from "../devpod-environment";
import { devpodRegistryRoot, listDevpodWorkspacesRaw } from "../devpod-registry";
import { proveLocalDockerSelection } from "../devsy-exec-proof";
import {
  inspectDevsyRuntimeAbsence,
  inspectDevsyRuntimeStatus,
  inspectDevsyWorkspaceOwnership,
  listDevsyWorkspaces,
} from "../devsy-workspaces";
import { listHostRouteState } from "../host-routes";
import { proveManagedComposePopulation } from "../managed-compose-population";
import { stopRetainedManagedDevsyWorkspace } from "../managed-devsy-stop";
import { type ManagedRuntimeState, readManagedRuntimeState } from "../managed-runtime-state";
import { claimLifecycleEffect } from "../reliability-context";
import {
  createReliabilityState,
  type ReliabilityEvent,
  type ReliabilityFence,
  type ReliabilityState,
  reliabilityFence,
} from "../reliability-contract";
import { stepReliability } from "../reliability-model";
import {
  type ReliabilityOperationRecord,
  readReliabilityOperation,
} from "../reliability-operation-store";
import { loadRepoConfig, loadRuntimeConfig, resolveProfile } from "../repo-config";
import { assertTraefikRoutesRemoved } from "../traefik-route-health";
import { isLinkedWorktree, resolveWorktreeWorkspace } from "../workspace";
import {
  inspectWorkspaceOwnership,
  listGitWorktrees,
  readWorkspaceOwnership,
  resolveGitCommonDir,
} from "../workspace-ownership";
import { resolveWorkspaceRuntimeOrDefault } from "../workspace-runtime";

vi.mock("../devcontainer-profile", () => ({
  assertManagedContainerConfigUnchanged: vi.fn(),
  inspectManagedDevcontainerConfig: vi.fn(),
  inspectManagedDevcontainerGeneratedConfig: vi.fn(),
  stopExactManagedService: vi.fn(),
}));
vi.mock("../traefik-route-health", () => ({ assertTraefikRoutesRemoved: vi.fn() }));
vi.mock("../host-routes", () => ({ listHostRouteState: vi.fn(() => []) }));
vi.mock("../devpod-environment", () => ({
  assertManagedStopCheckoutAbsent: vi.fn(),
  inspectManagedStopDaemon: vi.fn(),
  supportsManagedStopBaseline: vi.fn(),
  inspectManagedStopContainers: vi.fn(),
  inspectManagedStopRunnerId: vi.fn(),
  inspectManagedStopWorkspaceIds: vi.fn(),
  inspectProviderRunnerContainers: vi.fn(),
  inspectWorkspaceContainers: vi.fn(),
  resolveManagedStopEndpoint: vi.fn(),
  stopPinnedManagedContainer: vi.fn(),
}));
vi.mock("../devsy-exec-proof", () => ({ proveLocalDockerSelection: vi.fn() }));
vi.mock("../reliability-context", () => ({ claimLifecycleEffect: vi.fn() }));
vi.mock("../reliability-operation-store", async (original) => ({
  ...(await original<typeof import("../reliability-operation-store")>()),
  readReliabilityOperation: vi.fn(),
}));
vi.mock("../devpod-registry", () => ({
  listDevpodWorkspacesRaw: vi.fn(),
  devpodRegistryRoot: vi.fn(() => "/legacy"),
}));
vi.mock("../devsy-workspaces", () => ({
  inspectDevsyRuntimeAbsence: vi.fn(),
  inspectDevsyRuntimeStatus: vi.fn(),
  inspectDevsyWorkspaceOwnership: vi.fn(),
  listDevsyWorkspaces: vi.fn(),
}));
vi.mock("../managed-runtime-state", () => ({ readManagedRuntimeState: vi.fn() }));
vi.mock("../repo-config", async (original) => ({
  ...(await original<typeof import("../repo-config")>()),
  loadRepoConfig: vi.fn(),
  loadRuntimeConfig: vi.fn(),
}));
vi.mock("../workspace", () => ({
  isLinkedWorktree: vi.fn(),
  resolveWorktreeWorkspace: vi.fn(),
  sameWorkspacePath: (a: string, b: string) => a === b,
}));
vi.mock("../workspace-ownership", () => ({
  inspectWorkspaceOwnership: vi.fn(),
  listGitWorktrees: vi.fn(),
  readWorkspaceOwnership: vi.fn(),
  resolveGitCommonDir: vi.fn(),
}));
vi.mock("../workspace-runtime", () => ({
  resetWorkspaceRuntimeCaches: vi.fn(),
  resolveWorkspaceRuntimeOrDefault: vi.fn(),
}));

const repoPath = "/workspace/example";
const devsyId = "example";
const hash = "a".repeat(64);
let root: string;
let context: string;
let provider: "running" | "stopped";
let containers: ReturnType<typeof container>[];
let state: ManagedRuntimeState;
let plan: Pick<
  ReturnType<typeof inspectManagedDevcontainerConfig>,
  | "primaryService"
  | "composeDirectory"
  | "composeFiles"
  | "nativeRunServices"
  | "desiredServices"
  | "desiredProfileServices"
  | "sourceConfigSha256"
  | "effectiveConfigSha256"
>;
let stopProvider: ReturnType<typeof vi.fn<() => void>>;
let inspectCount: number;
let mutateOnInspect: ((count: number) => void) | undefined;

function container(service: string, running: boolean, digit: string) {
  return {
    id: digit.repeat(64),
    state: {
      Status: (running ? "running" : "exited") as "running" | "exited",
      Running: running,
      Paused: false as const,
      Restarting: false as const,
      Dead: false as const,
    },
    labels: {
      "com.docker.compose.project": "owned-project",
      "com.docker.compose.service": service,
      "com.docker.compose.project.working_dir": `${repoPath}/.devcontainer`,
      "com.docker.compose.project.config_files": `${repoPath}/.devcontainer/compose.yml`,
      "com.docker.compose.config-hash": hash,
    },
    mounts:
      service === "app" ? [{ Type: "bind", Source: repoPath, Destination: "/workspace" }] : [],
    networks: {},
  };
}
function exitContainer(entry: ReturnType<typeof container>) {
  entry.state.Running = false;
  entry.state.Status = "exited";
}
function run() {
  return stopRetainedManagedDevsyWorkspace({ repoPath, devsyId, stopProvider });
}
function featureFile(contextName = "default", workspaceId = devsyId) {
  const file = path.join(
    root,
    "contexts",
    contextName,
    "workspaces",
    workspaceId,
    "agent",
    ".docker-compose",
    "docker-compose.devcontainer.containerFeatures-1.yml",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "services: {}\n");
  return file;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadRepoConfig).mockReturnValue({
    managedRuntime: { processes: [] },
    apps: [],
  } as never);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-managed-stop-"));
  vi.stubEnv("DEVSY_HOME", root);
  context = "default";
  provider = "stopped";
  inspectCount = 0;
  mutateOnInspect = undefined;
  containers = [container("app", false, "a"), container("db", true, "b")];
  state = {
    version: 1,
    repoPath,
    devpodId: devsyId,
    composeProject: "owned-project",
    profile: "web",
    desired: { apps: ["web"], services: [], processes: ["web"] },
    sourceConfigSha256: hash,
    effectiveConfigSha256: hash,
    status: "degraded",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  plan = {
    primaryService: "app",
    composeDirectory: `${repoPath}/.devcontainer`,
    composeFiles: [`${repoPath}/.devcontainer/compose.yml`],
    nativeRunServices: ["app", "db", "blob"],
    desiredServices: ["app", "db"],
    desiredProfileServices: [],
    sourceConfigSha256: hash,
    effectiveConfigSha256: hash,
  };
  vi.mocked(isLinkedWorktree).mockReturnValue(false);
  vi.mocked(resolveWorkspaceRuntimeOrDefault).mockReturnValue("devsy");
  vi.mocked(listDevsyWorkspaces).mockReturnValue([]);
  vi.mocked(inspectWorkspaceContainers).mockReturnValue([]);
  vi.mocked(inspectDevsyWorkspaceOwnership).mockImplementation(() => ({
    status: "owned",
    workspace: { id: devsyId, context, source: { localFolder: repoPath } },
  }));
  vi.mocked(inspectDevsyRuntimeStatus).mockImplementation(() => provider);
  vi.mocked(readManagedRuntimeState).mockImplementation(() => structuredClone(state) as never);
  vi.mocked(loadRuntimeConfig).mockReturnValue({
    profile: "web",
    workspace: undefined,
    resolvedProfile: { processes: ["web"] },
    config: {
      apps: [{ name: "web", runtime: "proxy", upstream: "app:3000", host: "web.localhost" }],
      managedRuntime: { processes: ["web"] },
    },
  } as never);
  vi.mocked(inspectManagedDevcontainerConfig).mockImplementation(
    () => structuredClone(plan) as never,
  );
  vi.mocked(inspectManagedDevcontainerGeneratedConfig).mockReturnValue({ status: "valid" });
  vi.mocked(inspectManagedStopContainers).mockImplementation(() => {
    mutateOnInspect?.(++inspectCount);
    return structuredClone(containers) as never;
  });
  vi.mocked(stopExactManagedService).mockImplementation((id) => {
    exitContainer(containers.find((c) => c.id === id)!);
  });
  stopProvider = vi.fn(() => {
    provider = "stopped";
    exitContainer(containers[0]);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("retained managed Devsy stop", () => {
  it("completes a stopped primary's residual service and is idempotent", () => {
    expect(run()).toBe(true);
    expect(stopProvider).not.toHaveBeenCalled();
    expect(stopExactManagedService).toHaveBeenCalledExactlyOnceWith("b".repeat(64), "db", {
      timeoutMs: 30_000,
    });
    expect(containers.every((c) => !c.state.Running)).toBe(true);
    expect(run()).toBe(true);
    expect(stopExactManagedService).toHaveBeenCalledTimes(1);
  });
  it("stops the running provider once before residual cleanup", () => {
    provider = "running";
    containers[0] = container("app", true, "a");
    stopProvider.mockImplementation(() => {
      expect(stopExactManagedService).not.toHaveBeenCalled();
      provider = "stopped";
      exitContainer(containers[0]);
    });
    expect(run()).toBe(true);
    expect(stopProvider).toHaveBeenCalledTimes(1);
  });
  it("does not issue a residual stop when the provider stopped every service", () => {
    provider = "running";
    containers[0] = container("app", true, "a");
    stopProvider.mockImplementation(() => {
      provider = "stopped";
      containers.forEach(exitContainer);
    });
    expect(run()).toBe(true);
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });
  it("preserves a provider failure after eligible cleanup", () => {
    const error = new Error("provider failure");
    provider = "running";
    containers[0] = container("app", true, "a");
    stopProvider.mockImplementation(() => {
      provider = "stopped";
      exitContainer(containers[0]);
      throw error;
    });
    expect(run).toThrow(error);
    expect(stopProvider).toHaveBeenCalledTimes(1);
    expect(containers.every((c) => !c.state.Running)).toBe(true);
  });
  it("retains the original provider failure when cleanup is ineligible", () => {
    const original = new Error("provider failure");
    provider = "running";
    containers[0] = container("app", true, "a");
    stopProvider.mockImplementation(() => {
      throw original;
    });
    try {
      run();
      expect.fail("must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).cause).toBe(original);
    }
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });
  it("propagates exact stop failure and does not continue to another service", () => {
    containers.push(container("blob", true, "c"));
    const error = new Error("stop failed");
    vi.mocked(stopExactManagedService).mockImplementation(() => {
      throw error;
    });
    expect(run).toThrow(error);
    expect(stopExactManagedService).toHaveBeenCalledTimes(1);
  });
  it("rejects a stop that returned success but left its service running", () => {
    vi.mocked(stopExactManagedService).mockImplementation(() => undefined);
    expect(run).toThrow();
  });
  it.each([
    "running",
    "busy",
    "unknown",
    "not-found",
  ] as const)("rejects inconsistent provider status %s before mutation", (status) => {
    vi.mocked(inspectDevsyRuntimeStatus).mockReturnValue(status);
    expect(run).toThrow();
    expect(stopProvider).not.toHaveBeenCalled();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });
  it.each(["absent", "conflict"] as const)("rejects %s retained registration", (status) => {
    vi.mocked(inspectDevsyWorkspaceOwnership).mockReturnValue({
      status,
      reason: "conflict",
    } as never);
    expect(run).toThrow();
    expect(stopProvider).not.toHaveBeenCalled();
  });
  it("does not adopt a managed record under a different provider", () => {
    vi.mocked(resolveWorkspaceRuntimeOrDefault).mockReturnValue("devpod");
    expect(run).toThrow();
  });
  it.each(["", "..", "other/context"])("rejects invalid context %s", (value) => {
    context = value;
    expect(run).toThrow();
  });
  it("rejects a context change before a later mutation", () => {
    mutateOnInspect = (count) => {
      if (count === 2) context = "changed";
    };
    expect(run).toThrow();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });
  it.each(["sourceConfigSha256", "effectiveConfigSha256"] as const)("rejects %s drift", (field) => {
    plan[field] = "b".repeat(64);
    expect(run).toThrow();
  });
  it.each(["apps", "services", "processes"] as const)("rejects recorded %s drift", (field) => {
    state.desired[field] = ["unexpected"];
    expect(run).toThrow();
  });
  it("rejects generated configuration drift", () => {
    vi.mocked(inspectManagedDevcontainerGeneratedConfig).mockReturnValue({ status: "drifted" });
    expect(run).toThrow();
  });
  it("stops retained containers when an unapplied Compose edit changes service hashes", () => {
    vi.mocked(assertManagedContainerConfigUnchanged).mockImplementation(() => {
      throw new Error("drift");
    });
    expect(run()).toBe(true);
    expect(assertManagedContainerConfigUnchanged).not.toHaveBeenCalled();
    expect(stopExactManagedService).toHaveBeenCalledExactlyOnceWith("b".repeat(64), "db", {
      timeoutMs: 30_000,
    });
  });
  it.each([
    "missing",
    "duplicate",
    "unknown",
    "replacement",
  ])("rejects %s project membership", (change) => {
    if (change === "missing") containers.pop();
    if (change === "duplicate") containers.push(container("db", false, "d"));
    if (change === "unknown") containers.push(container("foreign", false, "d"));
    if (change === "replacement")
      mutateOnInspect = (count) => {
        if (count === 2) containers[1].id = "d".repeat(64);
      };
    expect(run).toThrow();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });
  it("rejects changed source mount", () => {
    containers[0].mounts[0].Source = "/other";
    expect(run).toThrow();
  });
  it("accepts reordered mounts while retaining every mount identity", () => {
    containers[0].mounts.push({
      Type: "volume",
      Source: "/volumes/dependencies",
      Destination: "/workspace/node_modules",
    });
    mutateOnInspect = () => containers[0].mounts.reverse();
    expect(run()).toBe(true);
    expect(stopExactManagedService).toHaveBeenCalledExactlyOnceWith("b".repeat(64), "db", {
      timeoutMs: 30_000,
    });
  });
  it.each([
    "Type",
    "Source",
    "Destination",
  ] as const)("rejects changed retained mount %s before stopping services", (field) => {
    mutateOnInspect = (count) => {
      if (count === 2) containers[0].mounts[0][field] = "changed";
    };
    expect(run).toThrow();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });
  it("accepts retained optional stopped services", () => {
    containers.push(container("blob", false, "c"));
    expect(run()).toBe(true);
  });
  it("accepts the exact provider feature file", () => {
    const file = featureFile();
    for (const c of containers) c.labels["com.docker.compose.project.config_files"] += `,${file}`;
    expect(run()).toBe(true);
  });
  it.each([
    "context",
    "workspace",
    "duplicate",
    "order",
    "symlink",
  ])("rejects %s Compose identity drift", (change) => {
    const file = featureFile(
      change === "context" ? "foreign" : "default",
      change === "workspace" ? "foreign" : devsyId,
    );
    const base = plan.composeFiles[0];
    if (change === "symlink") {
      fs.unlinkSync(file);
      const outside = path.join(root, "outside.yml");
      fs.writeFileSync(outside, "services: {}\n");
      fs.symlinkSync(outside, file);
    }
    containers[0].labels["com.docker.compose.project.config_files"] =
      change === "duplicate"
        ? `${base},${base}`
        : change === "order"
          ? `${file},${base}`
          : `${base},${file}`;
    expect(run).toThrow();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });
  it("proves linked owner and common Git directory", () => {
    vi.mocked(isLinkedWorktree).mockReturnValue(true);
    vi.mocked(resolveWorktreeWorkspace).mockReturnValue("feature");
    vi.mocked(resolveGitCommonDir).mockReturnValue("/repo/.git");
    vi.mocked(readWorkspaceOwnership).mockReturnValue({
      devpodId: devsyId,
      worktreePath: repoPath,
    } as never);
    state.workspace = "feature";
    const runtime = vi.mocked(loadRuntimeConfig).getMockImplementation()!();
    vi.mocked(loadRuntimeConfig).mockReturnValue({ ...runtime, workspace: "feature" });
    expect(run()).toBe(true);
    vi.mocked(readWorkspaceOwnership).mockReturnValue(undefined);
    expect(run).toThrow();
  });
});

type ModelInput = ReliabilityEvent extends infer Event
  ? Event extends ReliabilityEvent
    ? Omit<Event, keyof ReliabilityFence>
    : never
  : never;

function stepChatModel(state: ReliabilityState, event: ModelInput, nowMs = 100) {
  return stepReliability(
    state,
    { ...reliabilityFence(state), ...event } as ReliabilityEvent,
    nowMs,
  );
}

describe("interrupted initial managed Devsy start", () => {
  const chatServices = ["app", "db", "redis", "blob", "worker", "proxy", "docs"];
  const endpoint = "unix:///synthetic/docker.sock";
  /** Raw repo config whose declared profiles the real resolver validates against. */
  function profileConfig(profiles: string[]): DevrouterConfig {
    const apps: DevrouterApp[] = chatServices.map((name) => ({
      name,
      dependencies: [],
      protocol: "http",
      runtime: "docker",
      host: `${name}.localhost`,
      docker: { service: name, internalPort: 3000, composeFiles: ["compose.yml"] },
    }));
    const declared: Record<string, DevrouterProfile> = Object.fromEntries(
      profiles.map((name) => [
        name,
        { apps: ["app"], processes: [name], devcontainerServices: ["db"] },
      ]),
    );
    return {
      version: 1,
      project: { name: "chat-env" },
      apps,
      managedRuntime: {
        processes: ["chat", "manage"],
        devcontainer: { baseServices: [], profileServices: ["db", "redis"] },
      },
      profiles: declared,
    };
  }

  /** The canonical name the real resolver derives for a recorded raw selection. */
  function canonicalOf(recorded: string, profiles = ["chat", "manage"]): string {
    return resolveProfile(profileConfig(profiles), recorded).name;
  }

  const recordedSelection = "manage,chat";
  const canonicalSelection = canonicalOf(recordedSelection);
  const chatRuntime = {
    profile: canonicalSelection,
    workspace: undefined as string | undefined,
    resolvedProfile: { processes: ["chat"] },
    config: {
      apps: [{ name: "web", runtime: "proxy", upstream: "app:3000", host: "web.localhost" }],
      managedRuntime: { processes: ["chat"] },
    },
  };
  /** What an unrecorded stop falls back to: the full native service selection. */
  const defaultRuntime = {
    profile: "full",
    workspace: undefined as string | undefined,
    resolvedProfile: { processes: ["*"] },
    config: {
      apps: [{ name: "web", runtime: "proxy", upstream: "app:3000", host: "web.localhost" }],
      managedRuntime: { processes: ["*"] },
    },
  };
  const chatPlan = {
    primaryService: "app",
    composeDirectory: `${repoPath}/.devcontainer`,
    composeFiles: [`${repoPath}/.devcontainer/compose.yml`],
    nativeRunServices: [...chatServices, "docs-native"],
    desiredServices: [...chatServices],
    desiredProfileServices: [...chatServices],
    sourceConfigSha256: hash,
    effectiveConfigSha256: hash,
  };
  const defaultPlan = { ...chatPlan, desiredServices: [...chatServices, "docs-native"] };
  let record: ReliabilityOperationRecord;

  /** A launched seven-service ensure cancelled before any completion result exists. */
  function cancelledChatEnsure(selection = recordedSelection): ReliabilityOperationRecord {
    const chatConsumer = { id: "chat-agent", requiredCapabilities: ["api"], pinned: false };
    let model = createReliabilityState("chat-env", 1, "manual");
    const advance = (event: ModelInput) => {
      model = stepChatModel(model, event).state;
    };
    advance({
      type: "operation-request",
      kind: "ensure",
      key: "request",
      operationId: "op",
      profile: selection,
      consumer: chatConsumer,
      runtimeRunning: false,
    });
    advance({ type: "dispatch" });
    advance({ type: "dispatch-persisted", operationId: "op" });
    advance({ type: "launched", operationId: "op" });
    advance({ type: "stop" });
    advance({ type: "drained", operationId: "op" });
    return {
      version: 1,
      identity: { repoPath, workspace: null, provider: "devsy" },
      revision: 3,
      state: model,
      worker: null,
      effectSequence: 0,
      outcome: null,
    };
  }

  function syncHistory(current: ReliabilityOperationRecord) {
    const operation = current.state.operation;
    current.state.operationHistory = current.state.operationHistory.map((entry) =>
      entry.id === operation?.id ? { ...entry, ...operation } : entry,
    );
  }

  function primaryId() {
    return containers.find((c) => c.labels["com.docker.compose.service"] === "app")!.id;
  }

  function refuse(change: () => void) {
    change();
    expect(run).toThrow(Error);
    expect(stopPinnedManagedContainer).not.toHaveBeenCalled();
    expect(stopExactManagedService).not.toHaveBeenCalled();
    expect(claimLifecycleEffect).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    inspectCount = 0;
    mutateOnInspect = undefined;
    record = cancelledChatEnsure();
    containers = chatServices.map((service, index) => container(service, true, String(index + 1)));
    plan = chatPlan;
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(readManagedRuntimeState).mockReturnValue(undefined);
    vi.mocked(readReliabilityOperation).mockImplementation(() => structuredClone(record));
    vi.mocked(loadRepoConfig).mockReturnValue(profileConfig(["chat", "manage"]));
    vi.mocked(loadRuntimeConfig).mockImplementation(
      (_repoPath, _workspace, profile) =>
        (profile === canonicalSelection ? chatRuntime : defaultRuntime) as never,
    );
    vi.mocked(inspectManagedDevcontainerConfig).mockImplementation(
      (options) =>
        structuredClone(
          options.profile === chatRuntime.resolvedProfile ? chatPlan : defaultPlan,
        ) as never,
    );
    vi.mocked(inspectWorkspaceContainers).mockImplementation(() => structuredClone(containers));
    vi.mocked(resolveManagedStopEndpoint).mockReturnValue(endpoint);
    vi.mocked(supportsManagedStopBaseline).mockReturnValue(true);
    vi.mocked(inspectManagedStopDaemon).mockReturnValue("synthetic-daemon");
    vi.mocked(listDevpodWorkspacesRaw).mockReturnValue([]);
    vi.mocked(inspectManagedStopWorkspaceIds).mockImplementation(() => containers.map((c) => c.id));
    vi.mocked(inspectManagedStopRunnerId).mockImplementation(() => devsyId);
    vi.mocked(inspectProviderRunnerContainers).mockImplementation(() => [primaryId()]);
    vi.mocked(stopPinnedManagedContainer).mockImplementation((_endpoint, id) => {
      exitContainer(containers.find((c) => c.id === id)!);
    });
    vi.mocked(claimLifecycleEffect).mockImplementation(() => {
      record.effectSequence += 1;
      record.revision += 1;
    });
  });

  it("stops the complete seven-service population recorded by the interrupted ensure", () => {
    expect(run()).toBe(true);
    expect(readReliabilityOperation).toHaveBeenCalledWith({
      repoPath,
      workspace: null,
      provider: "devsy",
    });
    expect(loadRuntimeConfig).toHaveBeenCalledWith(repoPath, "", canonicalSelection);
    expect(
      vi.mocked(loadRuntimeConfig).mock.calls.every((call) => call[2] === canonicalSelection),
    ).toBe(true);
    expect(inspectManagedStopContainers).toHaveBeenCalledWith("owned-project", endpoint);
    expect(inspectManagedStopWorkspaceIds).toHaveBeenCalledWith(endpoint, plan.composeDirectory);
    expect(stopPinnedManagedContainer).toHaveBeenCalledTimes(7);
    expect(vi.mocked(stopPinnedManagedContainer).mock.calls.map((call) => call[1])).toEqual(
      containers.map((c) => c.id),
    );
    expect(claimLifecycleEffect).toHaveBeenCalledTimes(7);
    expect(proveLocalDockerSelection).toHaveBeenCalled();
    expect(stopExactManagedService).not.toHaveBeenCalled();
    expect(stopProvider).not.toHaveBeenCalled();
    expect(containers.every((c) => !c.state.Running)).toBe(true);
    expect(record.effectSequence).toBe(7);
    expect(record.revision).toBe(10);
    const configChecks = vi.mocked(assertManagedContainerConfigUnchanged).mock.calls;
    expect(configChecks.length).toBeGreaterThan(0);
    expect(configChecks.every(([options]) => options.containers.length === 7)).toBe(true);
  });

  it("leaves unmanaged provider stop to its existing caller", () => {
    vi.mocked(loadRepoConfig).mockReturnValue({ apps: [] } as never);
    expect(run()).toBe(false);
    expect(readReliabilityOperation).not.toHaveBeenCalled();
    expect(stopPinnedManagedContainer).not.toHaveBeenCalled();
  });

  it("refuses an initial stop without journal evidence", () => {
    vi.mocked(readReliabilityOperation).mockReturnValue(undefined);
    expect(run).toThrow("drained ensure's recorded profile");
    expect(loadRuntimeConfig).not.toHaveBeenCalled();
    expect(stopPinnedManagedContainer).not.toHaveBeenCalled();
  });

  it("refuses an unreadable journal", () => {
    vi.mocked(readReliabilityOperation).mockImplementation(() => {
      throw new Error("EACCES");
    });
    refuse(() => {});
  });

  it.each([
    [
      "a retained worker",
      (r: ReliabilityOperationRecord) => {
        r.worker = { id: "worker", operationId: "op", pid: 4_242, birth: "birth" };
      },
    ],
    [
      "an exec intent",
      (r: ReliabilityOperationRecord) => {
        r.state.operation = { ...r.state.operation!, kind: "exec" };
        syncHistory(r);
      },
    ],
    [
      "an undrained operation",
      (r: ReliabilityOperationRecord) => {
        r.state.operation = { ...r.state.operation!, drained: false };
        syncHistory(r);
      },
    ],
    [
      "a non-stopping phase",
      (r: ReliabilityOperationRecord) => {
        r.state.phase = "verifying";
      },
    ],
    [
      "a history entry that disagrees with the operation",
      (r: ReliabilityOperationRecord) => {
        r.state.operationHistory = r.state.operationHistory.map((entry) =>
          entry.id === "op" ? { ...entry, status: "RUNNING" } : entry,
        );
      },
    ],
  ] as const)("refuses %s", (_label, change) => {
    refuse(() => change(record));
  });

  it("requires the recorded managed profile instead of the default selection", () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({ ...chatRuntime, profile: "full" } as never);
    expect(run).toThrow("recorded managed profile");
    expect(loadRuntimeConfig).toHaveBeenCalledWith(repoPath, "", canonicalSelection);
    expect(stopPinnedManagedContainer).not.toHaveBeenCalled();
  });

  /** Point the config and runtime mocks at one declared profile set and selection. */
  function configureProfiles(declared: string[], raw: string, canonical: string) {
    vi.mocked(loadRepoConfig).mockReturnValue(profileConfig(declared));
    vi.mocked(loadRuntimeConfig).mockImplementation(
      (_repoPath, _workspace, profile) =>
        (profile === canonical ? { ...chatRuntime, profile: canonical } : defaultRuntime) as never,
    );
    record = cancelledChatEnsure(raw);
  }

  it.each([
    ["reversed", "manage,chat"],
    ["repeated", "manage,chat,manage"],
    ["padded", " manage , chat "],
  ])("stops the recorded population for a %s combined selection", (_label, raw) => {
    record = cancelledChatEnsure(raw);
    expect(canonicalOf(raw)).toBe(canonicalSelection);
    const journal = structuredClone(record);
    expect(run()).toBe(true);
    expect(loadRuntimeConfig).toHaveBeenCalledWith(repoPath, "", canonicalSelection);
    expect(
      vi.mocked(loadRuntimeConfig).mock.calls.every((call) => call[2] === canonicalSelection),
    ).toBe(true);
    expect(stopPinnedManagedContainer).toHaveBeenCalledTimes(chatServices.length);
    expect(record.worker).toBeNull();
    expect(record.state.operationHistory).toEqual(journal.state.operationHistory);
    // The recorded entry keeps its raw authority while the journal only advances.
    expect(record.state.operationHistory[0].profile).toBe(raw);
    expect(record.state.desired).toBe("stopped-by-user");
    expect(record.state.phase).toBe("stopping");
    expect(record.revision).toBe(journal.revision + chatServices.length);
    expect(record.effectSequence).toBe(chatServices.length);
  });

  it("stops the recorded population for a single profile selection", () => {
    configureProfiles(["chat"], "chat", "chat");
    expect(canonicalOf("chat", ["chat"])).toBe("chat");
    expect(run()).toBe(true);
    expect(loadRuntimeConfig).toHaveBeenCalledWith(repoPath, "", "chat");
    expect(stopPinnedManagedContainer).toHaveBeenCalledTimes(chatServices.length);
  });

  it("refuses a recorded selection whose profile no longer exists", () => {
    vi.mocked(loadRepoConfig).mockReturnValue(profileConfig(["chat"]));
    refuse(() => {});
    expect(loadRuntimeConfig).not.toHaveBeenCalled();
  });

  it("accepts an added profile while the stop observes", () => {
    // Both reads resolve the recorded selection to the same canonical name, so a
    // config that only gains an unrelated profile keeps its recorded identity.
    let reads = 0;
    vi.mocked(loadRepoConfig).mockImplementation(() =>
      reads++ === 0 ? profileConfig(["chat", "manage"]) : profileConfig(["chat", "manage", "docs"]),
    );
    expect(canonicalOf(recordedSelection, ["chat", "manage", "docs"])).toBe(canonicalSelection);
    expect(run()).toBe(true);
    expect(stopPinnedManagedContainer).toHaveBeenCalledTimes(chatServices.length);
  });

  it("refuses a changed selection resolution while the stop observes", () => {
    // The second read no longer resolves the recorded selection, so the stop
    // refuses after re-reading the config instead of stopping on a stale profile.
    let reads = 0;
    vi.mocked(loadRepoConfig).mockImplementation(() =>
      reads++ === 0 ? profileConfig(["chat", "manage"]) : profileConfig(["chat"]),
    );
    refuse(() => {});
  });

  it("refuses generated configuration drift", () => {
    refuse(() => {
      vi.mocked(inspectManagedDevcontainerGeneratedConfig).mockReturnValue({ status: "drifted" });
    });
  });

  it("refuses a recorded Compose configuration hash change", () => {
    refuse(() => {
      vi.mocked(assertManagedContainerConfigUnchanged).mockImplementation(() => {
        throw new Error("Compose configuration hash changed.");
      });
    });
  });

  it.each([
    [
      "a missing selected service",
      () => {
        containers.pop();
      },
    ],
    [
      "an extra unselected native service",
      () => {
        containers.push(container("docs-native", true, "8"));
      },
    ],
    [
      "an extra foreign service",
      () => {
        containers.push(container("ghost", true, "8"));
      },
    ],
  ])("refuses %s", (_label, change) => {
    refuse(change);
  });

  it("refuses Docker endpoint drift", () => {
    refuse(() => {
      vi.mocked(resolveManagedStopEndpoint)
        .mockReturnValueOnce(endpoint)
        .mockReturnValue("unix:///other.sock");
    });
  });

  it.each([
    ["a short legacy UID", "short", devsyId],
    ["an exact 16-byte UID", "1234567890123456", "1234567890123456"],
    ["an exact 40-byte UID", "a".repeat(40), "a".repeat(40)],
  ] as const)("binds the primary container to %s", (_label, uid, runnerId) => {
    vi.mocked(inspectDevsyWorkspaceOwnership).mockReturnValue({
      status: "owned",
      workspace: { id: devsyId, uid, context, source: { localFolder: repoPath } },
    } as never);
    vi.mocked(inspectManagedStopRunnerId).mockReturnValue(runnerId);
    expect(run()).toBe(true);
    expect(inspectManagedStopRunnerId).toHaveBeenCalledWith(endpoint, primaryId());
    expect(inspectProviderRunnerContainers).toHaveBeenCalledWith(endpoint, runnerId);
  });

  it("refuses a runner binding that differs from the recorded UID", () => {
    refuse(() => {
      vi.mocked(inspectDevsyWorkspaceOwnership).mockReturnValue({
        status: "owned",
        workspace: {
          id: devsyId,
          uid: "1234567890123456",
          context,
          source: { localFolder: repoPath },
        },
      } as never);
      vi.mocked(inspectManagedStopRunnerId).mockReturnValue(devsyId);
    });
  });

  it("requires the provider runner population to be the primary alone", () => {
    refuse(() => {
      vi.mocked(inspectProviderRunnerContainers).mockImplementation(() => [
        primaryId(),
        "9".repeat(64),
      ]);
    });
  });

  it("refuses an unreadable provider runner population", () => {
    refuse(() => {
      vi.mocked(inspectProviderRunnerContainers).mockImplementation(() => {
        throw new Error("docker unavailable");
      });
    });
  });

  it("refuses a container that restarts after its pinned stop", () => {
    vi.mocked(stopPinnedManagedContainer).mockImplementation((_endpoint, id) => {
      const revived = containers.find((c) => c.id === id)!;
      exitContainer(revived);
      revived.state.Running = true;
      revived.state.Status = "running";
    });
    expect(run).toThrow("cessation is not proven");
    expect(stopPinnedManagedContainer).toHaveBeenCalledTimes(1);
  });

  it("refuses a stopped service that restarts while a later service stops", () => {
    let stops = 0;
    vi.mocked(stopPinnedManagedContainer).mockImplementation((_endpoint, id) => {
      exitContainer(containers.find((c) => c.id === id)!);
      stops += 1;
      if (stops === 2) {
        containers[0].state.Running = true;
        containers[0].state.Status = "running";
      }
    });
    expect(run).toThrow("population or identity changed");
    expect(stopPinnedManagedContainer).toHaveBeenCalledTimes(2);
  });

  it("refuses a journal replaced after the first pinned stop", () => {
    vi.mocked(stopPinnedManagedContainer).mockImplementation((_endpoint, id) => {
      exitContainer(containers.find((c) => c.id === id)!);
      record.state.operation = { ...record.state.operation!, id: "op-2" };
      record.state.operationHistory = record.state.operationHistory.map((entry) => ({
        ...entry,
        id: "op-2",
      }));
    });
    expect(run).toThrow();
    expect(stopPinnedManagedContainer).toHaveBeenCalledTimes(1);
  });

  it("stops the recorded population for a linked workspace and forwards its environment", () => {
    vi.mocked(isLinkedWorktree).mockReturnValue(true);
    vi.mocked(resolveWorktreeWorkspace).mockReturnValue("chat-ws");
    vi.mocked(resolveGitCommonDir).mockReturnValue("/synthetic/common");
    vi.mocked(readWorkspaceOwnership).mockReturnValue({
      devpodId: devsyId,
      worktreePath: repoPath,
      workspace: "chat-ws",
    } as never);
    vi.mocked(inspectWorkspaceOwnership).mockReturnValue({ ownerStatus: "present" } as never);
    vi.mocked(loadRuntimeConfig).mockImplementation(
      (_repoPath, _workspace, profile) =>
        (profile === canonicalSelection
          ? { ...chatRuntime, workspace: "chat-ws" }
          : { ...defaultRuntime, workspace: "chat-ws" }) as never,
    );
    record.identity = { repoPath, workspace: "chat-ws", provider: "devsy" };
    expect(run()).toBe(true);
    expect(readReliabilityOperation).toHaveBeenCalledWith({
      repoPath,
      workspace: "chat-ws",
      provider: "devsy",
    });
    expect(loadRuntimeConfig).toHaveBeenCalledWith(repoPath, "chat-ws", canonicalSelection);
    expect(assertManagedContainerConfigUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: { token: "chat-ws", gitCommonDir: "/synthetic/common" },
      }),
    );
  });
});

describe("read-only managed Compose population proof", () => {
  function prove() {
    return proveManagedComposePopulation({
      plan,
      repoPath,
      composeProject: state.composeProject,
      providerRoot: root,
      featureDirectory: path.join(
        root,
        "contexts",
        context,
        "workspaces",
        devsyId,
        "agent",
        ".docker-compose",
      ),
      containers,
    });
  }

  it("retains stopped optional siblings without mutating or probing the provider", () => {
    containers.push(container("blob", false, "c"));
    const before = structuredClone(containers);
    expect(prove()).toBe(containers[0]);
    expect(containers).toEqual(before);
    expect(inspectManagedStopContainers).not.toHaveBeenCalled();
    expect(listDevsyWorkspaces).not.toHaveBeenCalled();
    expect(stopProvider).not.toHaveBeenCalled();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });

  it.each([
    "foreign",
    "duplicate",
    "missing",
    "project",
    "workdir",
    "mount",
  ])("rejects %s ownership evidence", (mode) => {
    if (mode === "foreign") containers.push(container("foreign", false, "c"));
    if (mode === "duplicate") containers.push(container("db", false, "c"));
    if (mode === "missing") containers.pop();
    if (mode === "project") containers[0].labels["com.docker.compose.project"] = "foreign";
    if (mode === "workdir")
      containers[0].labels["com.docker.compose.project.working_dir"] = "/foreign";
    if (mode === "mount") containers[0].mounts.push({ ...containers[0].mounts[0] });
    expect(prove).toThrow(Error);
    expect(stopProvider).not.toHaveBeenCalled();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });

  it("requires provider feature files to resolve under the explicit provider root", () => {
    const file = featureFile();
    containers[0].labels["com.docker.compose.project.config_files"] += `,${file}`;
    expect(prove()).toBe(containers[0]);
    fs.unlinkSync(file);
    const outside = path.join(root, "outside.yml");
    fs.writeFileSync(outside, "services: {}\n");
    fs.symlinkSync(outside, file);
    expect(prove).toThrow(Error);
  });
});

describe("absent-registration managed stop", () => {
  beforeEach(() => {
    vi.mocked(inspectWorkspaceContainers).mockReturnValue([]);
    vi.mocked(inspectProviderRunnerContainers).mockReturnValue([]);
    vi.mocked(resolveManagedStopEndpoint).mockReturnValue("unix:///var/run/docker.sock");
    vi.mocked(devpodRegistryRoot).mockReturnValue("/legacy");
    vi.mocked(listDevpodWorkspacesRaw).mockReturnValue([]);
    vi.mocked(listGitWorktrees).mockReturnValue([]);
  });

  function arrangeAbsentRegistration() {
    vi.mocked(inspectDevsyWorkspaceOwnership).mockReturnValue({ status: "absent" });
    vi.mocked(inspectDevsyRuntimeStatus).mockReturnValue("not-found");
    vi.mocked(inspectDevsyRuntimeAbsence).mockReturnValue(true);
    vi.mocked(inspectManagedStopContainers).mockReturnValue([]);
    containers = [];
  }

  function arrangeInitialAbsence() {
    arrangeAbsentRegistration();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(readManagedRuntimeState).mockReturnValue(undefined);
    vi.mocked(isLinkedWorktree).mockReturnValue(true);
    vi.mocked(resolveWorktreeWorkspace).mockReturnValue("feature");
    vi.mocked(resolveGitCommonDir).mockReturnValue("/repo/.git");
    vi.mocked(readWorkspaceOwnership).mockReturnValue({
      devpodId: devsyId,
      worktreePath: repoPath,
      workspace: "feature",
    } as never);
    vi.mocked(inspectWorkspaceOwnership).mockReturnValue({ ownerStatus: "present" } as never);
    vi.mocked(inspectManagedStopDaemon).mockReturnValue("daemon");
    vi.mocked(supportsManagedStopBaseline).mockReturnValue(true);
    vi.mocked(listHostRouteState).mockReturnValue([]);
  }

  it("proves a pre-registration stop after a failed managed startup", () => {
    arrangeInitialAbsence();
    expect(run()).toBe("proven-absent");
    expect(stopProvider).not.toHaveBeenCalled();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });

  it("allows unrelated nonlocal legacy sources without resolving their empty path", () => {
    arrangeInitialAbsence();
    vi.mocked(listDevpodWorkspacesRaw).mockReturnValue([
      { id: "other", source: { localFolder: "" } },
    ]);
    expect(run()).toBe("proven-absent");
    expect(listDevpodWorkspacesRaw).toHaveBeenCalledWith({ readLocalWhenMissing: true });
  });

  it.each([
    [
      "changed legacy home",
      () => vi.mocked(devpodRegistryRoot).mockReturnValueOnce("/first").mockReturnValue("/second"),
    ],
    [
      "changed unrelated legacy projection",
      () =>
        vi
          .mocked(listDevpodWorkspacesRaw)
          .mockReturnValueOnce([])
          .mockReturnValue([{ id: "other", source: { localFolder: "/elsewhere" } }]),
    ],
    [
      "nonlocal legacy ID conflict",
      () =>
        vi
          .mocked(listDevpodWorkspacesRaw)
          .mockReturnValue([{ id: devsyId, source: { localFolder: "" } }]),
    ],
    [
      "unknown Docker",
      () =>
        vi.mocked(assertManagedStopCheckoutAbsent).mockImplementation(() => {
          throw new Error("unknown Docker");
        }),
    ],
    [
      "remaining checkout",
      () =>
        vi.mocked(assertManagedStopCheckoutAbsent).mockImplementation(() => {
          throw new Error("remaining checkout");
        }),
    ],
    [
      "remaining runner",
      () => vi.mocked(inspectProviderRunnerContainers).mockReturnValue(["a".repeat(64)]),
    ],
    [
      "remaining routes",
      () => vi.mocked(listHostRouteState).mockReturnValue([{ repoPath }] as never),
    ],
    [
      "live route remains",
      () =>
        vi.mocked(assertTraefikRoutesRemoved).mockImplementation(() => {
          throw new Error("live route remains");
        }),
    ],
    ["unknown Devsy", () => vi.mocked(inspectDevsyRuntimeAbsence).mockReturnValue(false)],
    [
      "unreadable legacy evidence",
      () =>
        vi.mocked(listDevpodWorkspacesRaw).mockImplementation(() => {
          throw new Error("ENOENT");
        }),
    ],
    [
      "DevPod id conflict",
      () =>
        vi
          .mocked(listDevpodWorkspacesRaw)
          .mockReturnValue([{ id: devsyId, source: { localFolder: "/elsewhere" } }]),
    ],
    [
      "DevPod path conflict",
      () =>
        vi
          .mocked(listDevpodWorkspacesRaw)
          .mockReturnValue([{ id: "other", source: { localFolder: repoPath } }]),
    ],
    [
      "locked owner",
      () =>
        vi.mocked(inspectWorkspaceOwnership).mockReturnValue({ ownerStatus: "locked" } as never),
    ],
    ["wrong provider", () => vi.mocked(resolveWorkspaceRuntimeOrDefault).mockReturnValue("devpod")],
    ["remote Docker", () => vi.mocked(supportsManagedStopBaseline).mockReturnValue(false)],
    [
      "changed daemon",
      () =>
        vi.mocked(inspectManagedStopDaemon).mockReturnValueOnce("first").mockReturnValue("second"),
    ],
    [
      "changed owner",
      () =>
        vi
          .mocked(readWorkspaceOwnership)
          .mockReturnValueOnce({
            devpodId: devsyId,
            worktreePath: repoPath,
            workspace: "feature",
          } as never)
          .mockReturnValue(undefined),
    ],
    [
      "new retained state",
      () =>
        vi
          .mocked(readManagedRuntimeState)
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce(undefined)
          .mockReturnValue(state),
    ],
    [
      "registration appears",
      () =>
        vi
          .mocked(inspectDevsyWorkspaceOwnership)
          .mockReturnValueOnce({ status: "absent" })
          .mockReturnValue({
            status: "owned",
            workspace: { id: devsyId, source: { localFolder: repoPath } },
          }),
    ],
  ] as const)("refuses pre-registration recovery with %s", (_reason, change) => {
    arrangeInitialAbsence();
    change();
    expect(run).toThrow();
    expect(stopProvider).not.toHaveBeenCalled();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });

  it("fails closed when Devsy cannot positively report runtime absence", () => {
    arrangeAbsentRegistration();
    vi.mocked(inspectDevsyRuntimeAbsence).mockReturnValue(false);
    expect(() => run()).toThrow("not-found");
  });

  it("proves absence without a registration when every workload is gone", () => {
    arrangeAbsentRegistration();
    expect(run()).toBe("proven-absent");
    expect(stopProvider).not.toHaveBeenCalled();
    expect(stopExactManagedService).not.toHaveBeenCalled();
  });

  it("is stable across two observations", () => {
    arrangeAbsentRegistration();
    let observations = 0;
    vi.mocked(inspectDevsyWorkspaceOwnership).mockImplementation(() => {
      observations += 1;
      return observations >= 3
        ? {
            status: "owned",
            workspace: { id: devsyId, context, source: { localFolder: repoPath } },
          }
        : { status: "absent" };
    });
    expect(() => run()).toThrow("remain absent");
  });

  it("fails closed when a compose population remains", () => {
    arrangeAbsentRegistration();
    vi.mocked(inspectManagedStopContainers).mockReturnValue([
      container("app", false, "c"),
    ] as never);
    expect(() => run()).toThrow("compose population");
  });

  it("fails closed when a competing provider registration remains", () => {
    arrangeAbsentRegistration();
    vi.mocked(listDevpodWorkspacesRaw).mockReturnValue([
      { id: devsyId, source: { localFolder: `${repoPath}-other` } },
    ] as never);
    expect(() => run()).toThrow("provider registrations");
  });

  it("preserves ownership conflicts instead of proving absence", () => {
    arrangeAbsentRegistration();
    vi.mocked(inspectDevsyWorkspaceOwnership).mockReturnValue({
      status: "conflict",
      reason: "two exact owners",
    });
    expect(() => run()).toThrow("two exact owners");
  });

  it("fails closed when linked workspace ownership is not present", () => {
    arrangeAbsentRegistration();
    vi.mocked(isLinkedWorktree).mockReturnValue(true);
    vi.mocked(resolveWorktreeWorkspace).mockReturnValue("feature");
    vi.mocked(resolveGitCommonDir).mockReturnValue("/repo/.git");
    vi.mocked(readWorkspaceOwnership).mockReturnValue({
      devpodId: devsyId,
      worktreePath: repoPath,
      workspace: "feature",
    } as never);
    vi.mocked(inspectWorkspaceOwnership).mockReturnValue({
      ownerStatus: "missing",
      devpodStatus: "absent",
    } as never);
    expect(() => run()).toThrow("ownership changed during absence proof");
  });
});
