import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDevcontainerPlan } from "../devcontainer-profile";
import * as docker from "../devpod-environment";
import { listDevpodWorkspacesRaw } from "../devpod-registry";
import { stopRetainedManagedDevsyWorkspace } from "../managed-devsy-stop";
import {
  type ManagedRuntimeState,
  managedRuntimeStatePath,
  readManagedRuntimeState,
  writeManagedRuntimeState,
} from "../managed-runtime-state";
import {
  captureManagedStopBaseline,
  proveManagedStop,
  proveRetainedManagedStop,
  stopFromManagedBaseline,
} from "../managed-stop-recovery";

const fixture = vi.hoisted(() => ({
  home: "",
  owner: {
    id: "fixture",
    uid: "1234567890123456",
    context: "default",
    source: { localFolder: "/synthetic/repo" },
  },
  linked: false,
  token: "feature" as string | undefined,
  claim: vi.fn(),
  provider: "devsy",
  missing: false,
  competitors: [] as Array<{ id: string; source: { localFolder: string } }>,
  ownership: "present",
}));
vi.mock("../router", () => ({
  get DEVROUTER_HOME() {
    return fixture.home;
  },
}));
vi.mock("../devpod-environment", () => ({
  assertManagedStopContainersAbsent: vi.fn(),
  inspectProviderRunnerContainers: vi.fn(),
  inspectManagedStopContainers: vi.fn(),
  inspectManagedStopDaemon: vi.fn(),
  inspectManagedStopRunnerId: vi.fn(),
  inspectManagedStopWorkspaceIds: vi.fn(),
  resolveManagedStopEndpoint: vi.fn(),
  stopPinnedManagedContainer: vi.fn(),
}));
vi.mock("../devsy-workspaces", async (original) => ({
  ...(await original<typeof import("../devsy-workspaces")>()),
  listDevsyWorkspaces: () => (fixture.missing ? [] : [fixture.owner]),
}));
vi.mock("../devpod-registry", () => ({
  listDevpodWorkspacesRaw: vi.fn(() => fixture.competitors),
}));
vi.mock("../workspace-runtime", () => ({
  resetWorkspaceRuntimeCaches: vi.fn(),
  resolveWorkspaceRuntimeOrDefault: () => fixture.provider,
}));
vi.mock("../workspace", () => ({
  sameWorkspacePath: (a: string, b: string) => a === b,
  isLinkedWorktree: () => fixture.linked,
  resolveWorktreeWorkspace: () => (fixture.linked ? fixture.token : undefined),
}));
vi.mock("../workspace-ownership", () => ({
  resolveGitCommonDir: () => "/synthetic/common",
  listGitWorktrees: () => [],
  inspectWorkspaceOwnership: () => ({ ownerStatus: fixture.ownership }),
  readWorkspaceOwnership: () => ({
    workspace: "feature",
    devpodId: "fixture",
    worktreePath: "/synthetic/repo",
  }),
}));
vi.mock("../reliability-context", () => ({ claimLifecycleEffect: fixture.claim }));
vi.mock("../route-publication", () => ({ proxyAppsFromConfig: vi.fn() }));
vi.mock("../repo-config", () => ({
  loadRuntimeConfig: () => {
    throw new Error("Synthetic mutable configuration is unavailable");
  },
}));

const endpoint = "unix:///synthetic/docker.sock";
let state: ManagedRuntimeState;
let plan: ManagedDevcontainerPlan;
let containers: docker.ManagedStopContainerSnapshot[];
function persist() {
  state.stopBaseline = captureManagedStopBaseline(state, plan, containers[0].id);
  writeManagedRuntimeState(state);
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), "stop-baseline-test-"));
  fixture.owner = {
    id: "fixture",
    uid: "1234567890123456",
    context: "default",
    source: { localFolder: "/synthetic/repo" },
  };
  fixture.linked = false;
  fixture.token = "feature";
  fixture.provider = "devsy";
  fixture.missing = false;
  fixture.competitors = [];
  fixture.ownership = "present";
  vi.mocked(docker.inspectProviderRunnerContainers).mockReturnValue([]);
  vi.mocked(listDevpodWorkspacesRaw).mockImplementation(() => fixture.competitors);
  state = {
    version: 1,
    repoPath: "/synthetic/repo",
    devpodId: "fixture",
    composeProject: "fixture-project",
    profile: "default",
    desired: { apps: ["web"], services: ["db"], processes: [] },
    sourceConfigSha256: "a".repeat(64),
    effectiveConfigSha256: "b".repeat(64),
    status: "degraded",
    transitionPhase: "process-start",
    updatedAt: "2026-09-08T00:00:00Z",
  };
  plan = {
    sourcePath: "/synthetic/repo/.devcontainer/devcontainer.json",
    generatedPath: "/synthetic/repo/.devcontainer/generated.json",
    generatedRelativePath: ".devcontainer/generated.json",
    sourceConfigSha256: state.sourceConfigSha256,
    effectiveConfigSha256: state.effectiveConfigSha256,
    primaryService: "app",
    composeDirectory: "/synthetic/repo/.devcontainer",
    composeFiles: ["/synthetic/repo/.devcontainer/compose.yml"],
    composeServices: ["app", "db"],
    nativeRunServices: ["app", "db"],
    baseServices: ["app"],
    profileServices: ["db"],
    desiredProfileServices: ["db"],
    desiredServices: ["app", "db"],
    contents: "",
  };
  containers = ["app", "db"].map((service, i) => ({
    id: (i ? "d" : "c").repeat(64),
    state: { Running: true, Status: "running", Paused: false, Restarting: false, Dead: false },
    labels: {
      "com.docker.compose.project": state.composeProject,
      "com.docker.compose.service": service,
      "com.docker.compose.project.working_dir": plan.composeDirectory,
      "com.docker.compose.project.config_files": plan.composeFiles.join(","),
      "com.docker.compose.config-hash": "synthetic",
    },
    mounts: i ? [] : [{ Type: "bind", Source: state.repoPath, Destination: "/workspace" }],
    networks: {},
  }));
  vi.mocked(docker.resolveManagedStopEndpoint).mockReturnValue(endpoint);
  vi.mocked(docker.inspectManagedStopDaemon).mockReturnValue("synthetic-daemon");
  vi.mocked(docker.inspectManagedStopRunnerId).mockImplementation(() => fixture.owner.uid);
  vi.mocked(docker.inspectManagedStopContainers).mockImplementation(() =>
    structuredClone(containers),
  );
  vi.mocked(docker.inspectManagedStopWorkspaceIds).mockImplementation(() =>
    containers.map((c) => c.id),
  );
  vi.mocked(docker.stopPinnedManagedContainer).mockImplementation((_endpoint, id) => {
    const container = containers.find((c) => c.id === id);
    if (!container) throw new Error("Unexpected test container");
    container.state.Running = false;
    container.state.Status = "exited";
  });
});
afterEach(() => {
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

describe("retained stop ownership", () => {
  it.each([
    false,
    true,
  ])("round-trips and stops without mutable configuration (linked=%s)", (linked) => {
    fixture.linked = linked;
    if (linked) state.workspace = "feature";
    persist();
    expect(readManagedRuntimeState(state.repoPath, state.workspace)).toEqual(state);
    const providerStop = vi.fn();
    expect(
      stopRetainedManagedDevsyWorkspace({
        repoPath: state.repoPath,
        devsyId: state.devpodId,
        stopProvider: providerStop,
      }),
    ).toBe(true);
    expect(providerStop).not.toHaveBeenCalled();
    expect(docker.stopPinnedManagedContainer).toHaveBeenCalledTimes(2);
    expect(fixture.claim).toHaveBeenCalledTimes(2);
    expect(docker.stopPinnedManagedContainer).toHaveBeenNthCalledWith(1, endpoint, "c".repeat(64));
    expect(containers.every((c) => !c.state.Running)).toBe(true);
    stopFromManagedBaseline(state);
    expect(docker.stopPinnedManagedContainer).toHaveBeenCalledTimes(2);
    expect(readManagedRuntimeState(state.repoPath, state.workspace)).toEqual(state);
  });

  it("retains source-less tmpfs mounts through capture and exact stop", () => {
    containers[0].mounts.push({ Type: "tmpfs", Source: "", Destination: "/run/synthetic" });
    persist();
    expect(readManagedRuntimeState(state.repoPath)).toEqual(state);
    stopFromManagedBaseline(state);
    expect(containers.every((container) => !container.state.Running)).toBe(true);
    expect(docker.stopPinnedManagedContainer).toHaveBeenCalledTimes(2);
  });

  it.each(["bind", "volume"])("rejects a source-less %s mount before capture", (Type) => {
    containers[0].mounts.push({ Type, Source: "", Destination: "/run/synthetic" });
    expect(() => persist()).toThrow(Error);
    expect(docker.stopPinnedManagedContainer).not.toHaveBeenCalled();
    expect(readManagedRuntimeState(state.repoPath)).toBeUndefined();
  });

  it("accepts unchanged mount identities in a different persisted order", () => {
    containers[0].mounts.push({ Type: "tmpfs", Source: "", Destination: "/run/synthetic" });
    persist();
    state.stopBaseline!.containers[0].mounts.reverse();
    writeManagedRuntimeState(state);
    stopFromManagedBaseline(state);
    expect(containers.every((container) => !container.state.Running)).toBe(true);
  });

  it("rejects endpoint drift between capability selection and locked capture", () => {
    expect(() =>
      captureManagedStopBaseline(state, plan, containers[0].id, "unix:///different.sock"),
    ).toThrow(Error);
    expect(docker.inspectManagedStopContainers).not.toHaveBeenCalled();
    expect(readManagedRuntimeState(state.repoPath)).toBeUndefined();
  });

  it("keeps stopped siblings in the independently required population", () => {
    containers[1].state.Running = false;
    containers[1].state.Status = "exited";
    persist();
    stopFromManagedBaseline(state);
    expect(docker.stopPinnedManagedContainer).toHaveBeenCalledTimes(1);
    expect(state.stopBaseline?.containers).toHaveLength(2);
  });

  it.each([
    "missing",
    "duplicate",
    "foreign",
    "mount",
    "runner",
  ])("rejects %s ownership before capture", (failure) => {
    if (failure === "missing") containers.pop();
    if (failure === "duplicate") containers.push(structuredClone(containers[1]));
    if (failure === "foreign") containers[1].labels["com.docker.compose.service"] = "foreign";
    if (failure === "mount") containers[0].mounts[0].Source = "/synthetic/foreign";
    if (failure === "runner")
      vi.mocked(docker.inspectManagedStopRunnerId).mockReturnValue("foreign");
    expect(persist).toThrow(Error);
    expect(readManagedRuntimeState(state.repoPath)).toBeUndefined();
    expect(docker.stopPinnedManagedContainer).not.toHaveBeenCalled();
  });

  it.each([
    "daemon",
    "uid",
    "context",
    "provider",
    "id",
    "missing",
    "extra-project",
  ])("rejects %s drift before effects", (failure) => {
    persist();
    if (failure === "daemon") vi.mocked(docker.inspectManagedStopDaemon).mockReturnValue("other");
    if (failure === "uid") fixture.owner.uid = "abcdefghijklmnop";
    if (failure === "context") fixture.owner.context = "other";
    if (failure === "provider") fixture.provider = "devpod";
    if (failure === "id") containers[0].id = "e".repeat(64);
    if (failure === "missing") containers.pop();
    if (failure === "extra-project")
      vi.mocked(docker.inspectManagedStopWorkspaceIds).mockReturnValue([
        ...containers.map((c) => c.id),
        "e".repeat(64),
      ]);
    expect(() => stopFromManagedBaseline(state)).toThrow(Error);
    expect(docker.stopPinnedManagedContainer).not.toHaveBeenCalled();
  });

  it("fails on changed membership after partial cessation and never adopts replacements", () => {
    persist();
    vi.mocked(docker.stopPinnedManagedContainer).mockImplementationOnce(() => {
      containers[0].state.Running = false;
      containers[0].state.Status = "exited";
      containers[1].id = "e".repeat(64);
    });
    expect(() => stopFromManagedBaseline(state)).toThrow(Error);
    expect(docker.stopPinnedManagedContainer).toHaveBeenCalledTimes(1);
    expect(() => proveRetainedManagedStop(state)).toThrow(Error);
  });

  it("retains uncertainty when stop returns without cessation or its fence is superseded", () => {
    persist();
    vi.mocked(docker.stopPinnedManagedContainer).mockImplementation(() => {});
    expect(() => stopFromManagedBaseline(state)).toThrow(Error);
    expect(docker.stopPinnedManagedContainer).toHaveBeenCalledTimes(1);
    vi.mocked(docker.stopPinnedManagedContainer).mockClear();
    fixture.claim.mockImplementation(() => {
      throw new Error("Synthetic superseded intent");
    });
    expect(() => stopFromManagedBaseline(state)).toThrow(Error);
    expect(docker.stopPinnedManagedContainer).not.toHaveBeenCalled();
  });

  it("rejects a lost linked identity instead of claiming one", () => {
    fixture.linked = true;
    state.workspace = "feature";
    persist();
    fixture.token = undefined;
    expect(() => stopFromManagedBaseline(state)).toThrow(Error);
    expect(docker.stopPinnedManagedContainer).not.toHaveBeenCalled();
  });

  it.each([
    "null",
    "version",
    "extra",
    "generation",
    "duplicate",
    "required",
    "mount",
    "endpoint",
    "oversized",
  ])("rejects a present %s baseline on read, preserving its bytes", (failure) => {
    persist();
    const value = JSON.parse(JSON.stringify(state));
    if (failure === "null") value.stopBaseline = null;
    if (failure === "version") value.stopBaseline.version = 2;
    if (failure === "extra") value.stopBaseline.command = ["untrusted"];
    if (failure === "generation") value.stopBaseline.effectiveConfigSha256 = "e".repeat(64);
    if (failure === "duplicate")
      value.stopBaseline.containers.push(value.stopBaseline.containers[0]);
    if (failure === "required") value.stopBaseline.requiredServices.push("missing");
    if (failure === "mount") value.stopBaseline.containers[0].mounts[0].Source = "/foreign";
    if (failure === "endpoint") value.stopBaseline.endpoint = "tcp://unbound:2375";
    if (failure === "oversized") value.stopBaseline.daemonId = "x".repeat(4097);
    const file = managedRuntimeStatePath(state.repoPath);
    const bytes = JSON.stringify(value);
    fs.writeFileSync(file, bytes);
    expect(() =>
      stopRetainedManagedDevsyWorkspace({
        repoPath: state.repoPath,
        devsyId: state.devpodId,
        stopProvider: vi.fn(),
      }),
    ).toThrow(Error);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(docker.stopPinnedManagedContainer).not.toHaveBeenCalled();
  });
});

describe("baseline-backed missing registration", () => {
  function absent() {
    fixture.linked = true;
    state.workspace = "feature";
    persist();
    fixture.missing = true;
    containers = [];
    vi.mocked(docker.inspectManagedStopWorkspaceIds).mockReturnValue([]);
  }
  it("proves absence without provider or container effects and retains the baseline", () => {
    absent();
    expect(proveManagedStop(state)).toEqual({ status: "proven-absent", containers: [] });
    expect(stopFromManagedBaseline(state)).toBe("proven-absent");
    expect(listDevpodWorkspacesRaw).toHaveBeenCalledWith({ allowMissingExecutable: true });
    expect(docker.assertManagedStopContainersAbsent).toHaveBeenCalledWith(
      endpoint,
      state.stopBaseline!.containers.map((c) => c.id),
    );
    expect(docker.stopPinnedManagedContainer).not.toHaveBeenCalled();
    expect(readManagedRuntimeState(state.repoPath, state.workspace)).toEqual(state);
  });
  it.each([
    "owner",
    "token",
    "competitor-id",
    "competitor-path",
    "runner",
    "directory",
    "daemon",
    "saved-id",
  ])("rejects %s uncertainty", (failure) => {
    absent();
    if (failure === "owner") fixture.ownership = "locked";
    if (failure === "token") fixture.token = "other";
    if (failure === "competitor-id")
      fixture.competitors = [{ id: state.devpodId, source: { localFolder: "/other" } }];
    if (failure === "competitor-path")
      fixture.competitors = [{ id: "other", source: { localFolder: state.repoPath } }];
    if (failure === "runner")
      vi.mocked(docker.inspectProviderRunnerContainers).mockReturnValue(["e".repeat(64)]);
    if (failure === "directory")
      vi.mocked(docker.inspectManagedStopWorkspaceIds).mockReturnValue(["e".repeat(64)]);
    if (failure === "daemon") vi.mocked(docker.inspectManagedStopDaemon).mockReturnValue("other");
    if (failure === "saved-id")
      vi.mocked(docker.assertManagedStopContainersAbsent).mockImplementation(() => {
        throw new Error("exists");
      });
    expect(() => proveManagedStop(state)).toThrow();
    expect(docker.stopPinnedManagedContainer).not.toHaveBeenCalled();
  });
  it.each([
    "short",
    "x".repeat(16),
    "x".repeat(40),
    "é".repeat(8),
  ])("uses saved UID bytes for runner identity (%s)", (uid) => {
    fixture.owner.uid = uid;
    vi.mocked(docker.inspectManagedStopRunnerId).mockReturnValue(
      Buffer.byteLength(uid) === 16 || Buffer.byteLength(uid) === 40 ? uid : "fixture",
    );
    absent();
    proveManagedStop(state);
    expect(docker.inspectProviderRunnerContainers).toHaveBeenCalledWith(
      endpoint,
      Buffer.byteLength(uid) === 16 || Buffer.byteLength(uid) === 40 ? uid : "fixture",
    );
  });
  it("rejects primary checkout recovery", () => {
    persist();
    fixture.missing = true;
    expect(() => proveManagedStop(state)).toThrow();
  });
  it("rejects a retained generation changed during collection", () => {
    absent();
    vi.mocked(docker.assertManagedStopContainersAbsent).mockImplementation(() => {
      writeManagedRuntimeState({ ...state, updatedAt: "2026-09-09T00:00:00Z" });
    });
    expect(() => proveManagedStop(state)).toThrow();
  });
  it("rejects a daemon changed during collection", () => {
    absent();
    vi.mocked(docker.assertManagedStopContainersAbsent).mockImplementation(() => {
      vi.mocked(docker.inspectManagedStopDaemon).mockReturnValue("changed");
    });
    expect(() => proveManagedStop(state)).toThrow();
  });
  it("rejects a registration appearing during inspection", () => {
    absent();
    vi.mocked(docker.assertManagedStopContainersAbsent).mockImplementation(() => {
      fixture.missing = false;
    });
    expect(() => proveManagedStop(state)).toThrow();
  });
});
