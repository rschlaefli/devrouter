import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevrouterConfig } from "../../types";
import type { ManagedDevcontainerPlan } from "../devcontainer-profile";
import type { WorkspaceContainerSnapshot } from "../devpod-environment";
import { collectManagedRuntimeStatus } from "../managed-runtime-status";

vi.mock("../devcontainer-profile", () => ({
  inspectManagedDevcontainerConfig: vi.fn(),
}));
vi.mock("../devpod-environment", () => ({
  inspectWorkspaceContainers: vi.fn(),
  workspaceAppContainers: vi.fn(),
}));
vi.mock("../host-routes", () => ({
  listHostRouteState: vi.fn(),
}));
vi.mock("../managed-post-start", () => ({
  runManagedProcessAction: vi.fn(),
}));
vi.mock("../managed-runtime-state", () => ({
  readManagedRuntimeState: vi.fn(),
}));
vi.mock("../workspace", () => ({
  sameWorkspacePath: vi.fn((left: string, right: string) => left === right),
}));

import { inspectManagedDevcontainerConfig } from "../devcontainer-profile";
import { inspectWorkspaceContainers, workspaceAppContainers } from "../devpod-environment";
import { listHostRouteState } from "../host-routes";
import { runManagedProcessAction } from "../managed-post-start";
import { type ManagedRuntimeState, readManagedRuntimeState } from "../managed-runtime-state";

const repoPath = "/repo/trees/feature";
const workspace = "feature";
const composeFiles = [
  `${repoPath}/.devcontainer/docker-compose.yml`,
  `${repoPath}/.devcontainer/docker-compose.devrouter.yml`,
];

function managedConfig(): DevrouterConfig {
  return {
    version: 1,
    managedRuntime: {
      devcontainer: {
        baseServices: ["postgres"],
        profileServices: ["litellm", "mcp-doc-query"],
      },
      processes: ["chat", "local-mcp"],
    },
    apps: [
      {
        name: "chat",
        host: "chat.feature.localhost",
        protocol: "http",
        runtime: "proxy",
        dependencies: [],
        upstream: "feature-app:3000",
      },
    ],
  };
}

function managedPlan(): ManagedDevcontainerPlan {
  return {
    sourcePath: `${repoPath}/.devcontainer/devcontainer.json`,
    generatedPath: `${repoPath}/.devcontainer/devcontainer.devrouter.json`,
    generatedRelativePath: ".devcontainer/devcontainer.devrouter.json",
    sourceConfigSha256: "a".repeat(64),
    effectiveConfigSha256: "b".repeat(64),
    primaryService: "app",
    composeDirectory: `${repoPath}/.devcontainer`,
    composeFiles,
    composeServices: ["app", "litellm", "mcp-doc-query", "postgres"],
    nativeRunServices: ["app", "litellm", "mcp-doc-query", "postgres"],
    baseServices: ["postgres"],
    profileServices: ["litellm", "mcp-doc-query"],
    desiredProfileServices: ["litellm", "mcp-doc-query"],
    desiredServices: ["app", "litellm", "mcp-doc-query", "postgres"],
    contents: "// devrouter:managed devcontainer profile\n{}\n",
  };
}

function container(
  service: string,
  options: {
    project?: string;
    running?: boolean;
    health?: string;
    mountRepo?: boolean;
  } = {},
): WorkspaceContainerSnapshot {
  return {
    id: `${service}-id`,
    state: {
      Running: options.running ?? true,
      ...(options.health ? { Health: { Status: options.health } } : {}),
    },
    labels: {
      "com.docker.compose.project": options.project ?? "feature-project",
      "com.docker.compose.service": service,
      "com.docker.compose.project.working_dir": `${repoPath}/.devcontainer`,
      "com.docker.compose.project.config_files": composeFiles.join(","),
    },
    mounts: options.mountRepo
      ? [{ Type: "bind", Source: repoPath, Destination: "/workspaces/repo" }]
      : [],
    networks: {},
  };
}

function state(overrides: Partial<ManagedRuntimeState> = {}): ManagedRuntimeState {
  return {
    version: 1,
    repoPath,
    workspace,
    devpodId: "devpod-feature",
    composeProject: "feature-project",
    profile: "ai",
    desired: {
      apps: ["chat"],
      services: ["litellm"],
      processes: ["chat"],
    },
    sourceConfigSha256: "a".repeat(64),
    effectiveConfigSha256: "b".repeat(64),
    status: "ready",
    updatedAt: "2026-08-26T08:00:00.000Z",
    ...overrides,
  };
}

function setupManagedRuntime(options: {
  containers: WorkspaceContainerSnapshot[];
  routes?: Array<{ name: string; repoPath: string; workspace?: string }>;
  runtimeState?: ManagedRuntimeState;
  processStatuses?: Record<string, "running" | "stopped" | "foreign" | "drifted">;
}): void {
  const plan = managedPlan();
  vi.mocked(inspectManagedDevcontainerConfig).mockReturnValue(plan);
  vi.mocked(inspectWorkspaceContainers).mockReturnValue(options.containers);
  vi.mocked(workspaceAppContainers).mockImplementation((containers) =>
    containers.filter((candidate) => candidate.labels["com.docker.compose.service"] === "app"),
  );
  vi.mocked(listHostRouteState).mockReturnValue(
    (options.routes ?? []).map((route) => ({
      id: `${route.repoPath}::${route.name}`,
      name: route.name,
      host: `${route.name}.localhost`,
      protocol: "http",
      repoPath: route.repoPath,
      port: 3000,
      mode: "proxy",
      workspace: route.workspace,
      createdAt: "2026-08-26T08:00:00.000Z",
      updatedAt: "2026-08-26T08:00:00.000Z",
    })),
  );
  vi.mocked(readManagedRuntimeState).mockReturnValue(options.runtimeState);
  vi.mocked(runManagedProcessAction).mockImplementation(({ name }) => {
    return options.processStatuses?.[name] ?? "stopped";
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectManagedRuntimeStatus", () => {
  it("returns legacy status without inspecting runtime resources", () => {
    const result = collectManagedRuntimeStatus({
      repoPath,
      workspace,
      config: { version: 1, apps: [] },
      profile: "full",
    });

    expect(result).toEqual({
      mode: "legacy",
      status: "legacy",
      profile: "full",
      desired: { apps: [], services: [], processes: [] },
      active: { apps: [], services: [], processes: [] },
      serviceStatuses: {},
      processStatuses: {},
      drift: [],
    });
    expect(readManagedRuntimeState).not.toHaveBeenCalled();
    expect(inspectManagedDevcontainerConfig).not.toHaveBeenCalled();
    expect(inspectWorkspaceContainers).not.toHaveBeenCalled();
    expect(listHostRouteState).not.toHaveBeenCalled();
    expect(runManagedProcessAction).not.toHaveBeenCalled();
  });

  it("reports a healthy app and selected capability service as ready", () => {
    setupManagedRuntime({
      containers: [
        container("app", { mountRepo: true }),
        container("postgres"),
        container("litellm"),
      ],
      routes: [{ name: "chat", repoPath, workspace }],
      runtimeState: state(),
      processStatuses: { chat: "running", "local-mcp": "stopped" },
    });

    const result = collectManagedRuntimeStatus({
      repoPath,
      workspace,
      config: managedConfig(),
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["chat"],
      },
    });

    expect(result).toMatchObject({
      mode: "managed",
      status: "ready",
      profile: "ai",
      activeProfile: "ai",
      devpodId: "devpod-feature",
      composeProject: "feature-project",
      desired: { apps: ["chat"], services: ["litellm"], processes: ["chat"] },
      active: { apps: ["chat"], services: ["litellm"], processes: ["chat"] },
      serviceStatuses: { litellm: "healthy", "mcp-doc-query": "missing" },
      processStatuses: { chat: "running", "local-mcp": "stopped" },
      drift: [],
    });
    expect(inspectManagedDevcontainerConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        linked: true,
        profile: expect.objectContaining({ devcontainerServices: ["litellm"] }),
      }),
    );
  });

  it("reports an exact stopped workspace without turning it into drift", () => {
    setupManagedRuntime({
      containers: [
        container("app", { mountRepo: true, running: false }),
        container("postgres", { running: false }),
        container("litellm", { running: false }),
      ],
      routes: [],
      runtimeState: state(),
    });

    const result = collectManagedRuntimeStatus({
      repoPath,
      workspace,
      config: managedConfig(),
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["chat"],
      },
    });

    expect(result).toMatchObject({
      status: "stopped",
      active: { apps: [], services: [], processes: [] },
      serviceStatuses: { litellm: "stopped", "mcp-doc-query": "missing" },
      processStatuses: { chat: "stopped", "local-mcp": "stopped" },
      drift: [],
    });
  });

  it("does not activate omitted optional dimensions for an app-only profile", () => {
    setupManagedRuntime({
      containers: [container("app", { mountRepo: true }), container("postgres")],
      routes: [{ name: "chat", repoPath, workspace }],
      runtimeState: state({
        profile: "chat",
        desired: { apps: ["chat"], services: [], processes: [] },
      }),
    });

    const result = collectManagedRuntimeStatus({
      repoPath,
      workspace,
      config: managedConfig(),
      profile: "chat",
      resolvedProfile: { apps: ["chat"] },
    });

    expect(result.status).toBe("ready");
    expect(result.desired).toEqual({ apps: ["chat"], services: [], processes: [] });
    expect(result.active).toEqual({ apps: ["chat"], services: [], processes: [] });
    expect(result.drift).toEqual([]);
  });

  it("allows a route-free service-only capability profile", () => {
    setupManagedRuntime({
      containers: [
        container("app", { mountRepo: true }),
        container("postgres"),
        container("mcp-doc-query"),
      ],
      routes: [],
      runtimeState: state({
        profile: "mcp",
        desired: { apps: [], services: ["mcp-doc-query"], processes: [] },
      }),
      processStatuses: { chat: "stopped", "local-mcp": "stopped" },
    });

    const result = collectManagedRuntimeStatus({
      repoPath,
      workspace,
      config: managedConfig(),
      profile: "mcp",
      resolvedProfile: { apps: [], devcontainerServices: ["mcp-doc-query"], processes: [] },
    });

    expect(result.status).toBe("ready");
    expect(result.desired).toEqual({ apps: [], services: ["mcp-doc-query"], processes: [] });
    expect(result.active).toMatchObject({ apps: [], services: ["mcp-doc-query"], processes: [] });
    expect(result.drift).toEqual([]);
  });

  it("reports foreign services and process ownership as drift", () => {
    setupManagedRuntime({
      containers: [
        container("app", { mountRepo: true }),
        container("postgres"),
        container("litellm", { project: "other-project" }),
      ],
      routes: [{ name: "chat", repoPath, workspace }],
      runtimeState: state(),
      processStatuses: { chat: "foreign", "local-mcp": "stopped" },
    });

    const result = collectManagedRuntimeStatus({
      repoPath,
      workspace,
      config: managedConfig(),
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["chat"],
      },
    });

    expect(result.status).toBe("drifted");
    expect(result.serviceStatuses.litellm).toBe("foreign");
    expect(result.processStatuses.chat).toBe("foreign");
    expect(result.drift.join(" ")).not.toContain("other-project");
    expect(result.drift.join(" ")).not.toContain("secret");
  });

  it("reports a degraded state as failed-transition and corrupt state as drifted", () => {
    setupManagedRuntime({
      containers: [],
      routes: [],
      runtimeState: state({ status: "degraded", transitionPhase: "rollback" }),
    });

    const degraded = collectManagedRuntimeStatus({
      repoPath,
      workspace,
      config: managedConfig(),
      profile: "ai",
      resolvedProfile: { apps: ["chat"], devcontainerServices: ["litellm"], processes: ["chat"] },
    });
    expect(degraded.status).toBe("failed-transition");
    expect(degraded.transitionPhase).toBe("rollback");

    vi.mocked(readManagedRuntimeState).mockImplementation(() => {
      throw new Error("sensitive state parse detail");
    });
    const corrupt = collectManagedRuntimeStatus({
      repoPath,
      workspace,
      config: managedConfig(),
      profile: "ai",
      resolvedProfile: { apps: ["chat"], devcontainerServices: ["litellm"], processes: ["chat"] },
    });
    expect(corrupt.status).toBe("drifted");
    expect(corrupt.drift.join(" ")).not.toContain("sensitive state parse detail");
  });

  it("keeps a health transition observable without marking it as drift", () => {
    setupManagedRuntime({
      containers: [
        container("app", { mountRepo: true }),
        container("postgres"),
        container("litellm", { health: "starting" }),
      ],
      routes: [{ name: "chat", repoPath, workspace }],
      runtimeState: state(),
      processStatuses: { chat: "running", "local-mcp": "stopped" },
    });

    const result = collectManagedRuntimeStatus({
      repoPath,
      workspace,
      config: managedConfig(),
      profile: "ai",
      resolvedProfile: { apps: ["chat"], devcontainerServices: ["litellm"], processes: ["chat"] },
    });

    expect(result.status).toBe("starting");
    expect(result.serviceStatuses.litellm).toBe("starting");
    expect(result.active.services).toContain("litellm");
    expect(result.drift).toEqual([]);
  });
});
