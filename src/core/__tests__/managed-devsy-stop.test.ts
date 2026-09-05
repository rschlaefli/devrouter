import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertManagedContainerConfigUnchanged,
  inspectManagedDevcontainerConfig,
  inspectManagedDevcontainerGeneratedConfig,
  stopExactManagedService,
} from "../devcontainer-profile";
import { inspectManagedStopContainers } from "../devpod-environment";
import {
  inspectDevsyRuntimeStatus,
  inspectDevsyWorkspaceOwnership,
  listDevsyWorkspaces,
} from "../devsy-workspaces";
import { stopRetainedManagedDevsyWorkspace } from "../managed-devsy-stop";
import { type ManagedRuntimeState, readManagedRuntimeState } from "../managed-runtime-state";
import { loadRuntimeConfig } from "../repo-config";
import { isLinkedWorktree, resolveWorktreeWorkspace } from "../workspace";
import { readWorkspaceOwnership, resolveGitCommonDir } from "../workspace-ownership";
import { resolveWorkspaceRuntimeOrDefault } from "../workspace-runtime";

vi.mock("../devcontainer-profile", () => ({
  assertManagedContainerConfigUnchanged: vi.fn(),
  inspectManagedDevcontainerConfig: vi.fn(),
  inspectManagedDevcontainerGeneratedConfig: vi.fn(),
  stopExactManagedService: vi.fn(),
}));
vi.mock("../devpod-environment", () => ({ inspectManagedStopContainers: vi.fn() }));
vi.mock("../devsy-workspaces", () => ({
  inspectDevsyRuntimeStatus: vi.fn(),
  inspectDevsyWorkspaceOwnership: vi.fn(),
  listDevsyWorkspaces: vi.fn(),
}));
vi.mock("../managed-runtime-state", () => ({ readManagedRuntimeState: vi.fn() }));
vi.mock("../repo-config", () => ({ loadRuntimeConfig: vi.fn() }));
vi.mock("../workspace", () => ({
  isLinkedWorktree: vi.fn(),
  resolveWorktreeWorkspace: vi.fn(),
  sameWorkspacePath: (a: string, b: string) => a === b,
}));
vi.mock("../workspace-ownership", () => ({
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
      Status: running ? "running" : "exited",
      Running: running,
      Paused: false,
      Restarting: false,
      Dead: false,
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
  it("requires unchanged service configuration hashes before mutation", () => {
    vi.mocked(assertManagedContainerConfigUnchanged).mockImplementation(() => {
      throw new Error("drift");
    });
    expect(run).toThrow();
    expect(stopExactManagedService).not.toHaveBeenCalled();
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
  it("leaves legacy stop behavior to its existing caller", () => {
    vi.mocked(readManagedRuntimeState).mockReturnValue(undefined);
    expect(run()).toBe(false);
    expect(inspectManagedStopContainers).not.toHaveBeenCalled();
  });
});
