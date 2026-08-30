import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevrouterConfig, HostRouteState, ManagedRuntimeStatus } from "../../types";
import {
  inspectManagedDevcontainerConfig,
  type ManagedDevcontainerPlan,
  removeManagedDevcontainerConfig,
  startExactManagedServices,
  stopExactManagedService,
  writeManagedDevcontainerConfig,
} from "../devcontainer-profile";
import {
  inspectWorkspaceContainers,
  resolveRunningWorkspaceContainer,
  type WorkspaceContainerSnapshot,
} from "../devpod-environment";
import { type DevpodWorkspace, selectDevpodWorkspace } from "../devpod-workspaces";
import { listHostRouteState, replaceHostRoutesForRepo } from "../host-routes";
import {
  resolveManagedPostStartPlan,
  runManagedPostStart,
  runManagedProcessAction,
} from "../managed-post-start";
import {
  type ManagedRuntimeState,
  markManagedRuntimeDegraded,
  readManagedRuntimeState,
  writeManagedRuntimeState,
} from "../managed-runtime-state";
import { collectManagedRuntimeStatus } from "../managed-runtime-status";
import { loadRuntimeConfig } from "../repo-config";
import { startRouterStack } from "../router";
import { ensureTraefikRoutesLoaded } from "../traefik-route-health";
import { validateWorkspaceContainers, workspaceEnsure } from "../workspace-ensure";
import { resetWorkspaceRuntimeCaches } from "../workspace-runtime";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../file-lock", () => ({
  withFileLock: vi.fn(async (_path: string, _options: unknown, operation: () => Promise<unknown>) =>
    operation(),
  ),
  withFileLockSync: vi.fn((_path: string, _options: unknown, operation: () => unknown) =>
    operation(),
  ),
  createStderrWaitReporter: vi.fn(() => () => undefined),
}));
vi.mock("../host-routes", () => ({
  listHostRouteState: vi.fn(() => []),
  parseUpstream: vi.fn((upstream: string) => {
    const [host, port] = upstream.split(":");
    return { host, port: Number(port), upstreamHost: host };
  }),
  replaceHostRoutesForRepo: vi.fn(() => []),
}));
vi.mock("../devcontainer-profile", () => ({
  inspectManagedDevcontainerConfig: vi.fn(),
  removeManagedDevcontainerConfig: vi.fn(),
  startExactManagedServices: vi.fn(),
  stopExactManagedService: vi.fn(),
  writeManagedDevcontainerConfig: vi.fn(),
}));
vi.mock("../managed-post-start", () => ({
  resolveManagedPostStartPlan: vi.fn(() => ({ kind: "unmanaged" })),
  runManagedPostStart: vi.fn(),
  runManagedProcessAction: vi.fn(() => "running"),
}));
vi.mock("../managed-runtime-state", () => ({
  readManagedRuntimeState: vi.fn(() => undefined),
  writeManagedRuntimeState: vi.fn(),
  markManagedRuntimeDegraded: vi.fn(),
}));
vi.mock("../managed-runtime-status", () => ({
  collectManagedRuntimeStatus: vi.fn(() => undefined),
}));
vi.mock("../docker", () => ({ ensureNetwork: vi.fn(async () => undefined) }));
vi.mock("../repo-config", () => ({
  loadRuntimeConfig: vi.fn(),
  resolveRepoPath: vi.fn((repo?: string) => repo ?? process.cwd()),
}));
vi.mock("../router", () => ({
  CERT_FILE: "/certs/localhost.pem",
  DEVROUTER_HOME: "/tmp/devrouter-workspace-ensure-test",
  DEVNET_NAME: "devnet",
  TCP_PROTOCOL_REGISTRY: { postgres: { port: 5432, entrypoint: "postgres" } },
  activateTcpProtocol: vi.fn(() => false),
  ensureRouterFiles: vi.fn(),
  isTLSEnabled: vi.fn(() => true),
  startRouterStack: vi.fn(),
}));
vi.mock("../traefik-route-health", () => ({
  ensureTraefikRoutesLoaded: vi.fn(async () => ({ restarted: false })),
}));
vi.mock("../tls", () => ({
  getMkcertRootCAPath: vi.fn(() => "/ca/rootCA.pem"),
  ensureTLSHostsCovered: vi.fn(async () => ({
    refreshed: false,
    uncoveredHosts: [],
    certificateHosts: ["*.localhost"],
  })),
}));

const repoPath = "/repo/trees/feature";
const workspace = "feature";

function devpod(id: string, localFolder = repoPath): DevpodWorkspace {
  return { id, source: { localFolder } };
}

function container(
  id: string,
  service: string,
  aliases: string[],
  options: { mountRepo?: boolean; running?: boolean; health?: string; overlay?: boolean } = {},
): WorkspaceContainerSnapshot {
  const overlay =
    options.overlay === false
      ? `${repoPath}/.devcontainer/docker-compose.yml`
      : `${repoPath}/.devcontainer/docker-compose.yml,${repoPath}/.devcontainer/docker-compose.devrouter.yml`;
  return {
    id,
    state: {
      Running: options.running ?? true,
      Health: options.health ? { Status: options.health } : undefined,
    },
    labels: {
      "com.docker.compose.project": "workspace-project",
      "com.docker.compose.project.working_dir": `${repoPath}/.devcontainer`,
      "com.docker.compose.project.config_files": overlay,
      "com.docker.compose.service": service,
    },
    mounts: options.mountRepo
      ? [
          { Type: "bind", Source: repoPath, Destination: "/workspaces/repo" },
          { Type: "bind", Source: "/repo/.git", Destination: "/repo/.git" },
        ]
      : [],
    networks: {
      devnet: { Aliases: aliases },
    },
  };
}

describe("selectDevpodWorkspace", () => {
  it("selects the one DevPod bound to the exact worktree path", () => {
    expect(
      selectDevpodWorkspace([devpod("other", "/repo/trees/other"), devpod("feature")], repoPath),
    ).toEqual(devpod("feature"));
  });

  it("returns undefined when the exact worktree has no DevPod", () => {
    expect(selectDevpodWorkspace([devpod("other", "/repo/trees/other")], repoPath)).toBeUndefined();
  });

  it("rejects multiple DevPods bound to the same worktree", () => {
    expect(() =>
      selectDevpodWorkspace([devpod("feature-old"), devpod("feature-new")], repoPath),
    ).toThrow("Multiple DevPod workspaces reference");
  });
});

describe("inspectWorkspaceContainers", () => {
  it("safely inspects containers without healthchecks", () => {
    const snapshot = container("app-id", "app", ["feature-app"], {
      mountRepo: true,
    });
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: "app-id\n", stderr: "" } as never)
      .mockReturnValueOnce({
        status: 0,
        stdout: `${JSON.stringify(snapshot)}\n`,
        stderr: "",
      } as never);

    expect(inspectWorkspaceContainers()).toEqual([snapshot]);
    expect(spawnSync).toHaveBeenNthCalledWith(1, "docker", ["ps", "-a", "--format", "{{.ID}}"], {
      encoding: "utf-8",
    });
    expect(spawnSync).toHaveBeenLastCalledWith(
      "docker",
      expect.arrayContaining([
        "inspect",
        "--format",
        expect.stringContaining('index .State "Health"'),
        "app-id",
      ]),
      { encoding: "utf-8" },
    );
  });

  it("resolves the running compose-owned app container instead of any matching bind mount", () => {
    const app = container("app-id", "app", ["feature-app"], { mountRepo: true });
    const unrelated = container("other-id", "tool", [], { mountRepo: true });
    unrelated.labels["com.docker.compose.project.working_dir"] = "/other/.devcontainer";
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: "app-id\nother-id\n", stderr: "" } as never)
      .mockReturnValueOnce({
        status: 0,
        stdout: `${JSON.stringify(app)}\n${JSON.stringify(unrelated)}\n`,
        stderr: "",
      } as never);

    expect(resolveRunningWorkspaceContainer(repoPath)).toEqual({
      id: "app-id",
      workspacePath: "/workspaces/repo",
    });
  });
});

describe("validateWorkspaceContainers", () => {
  it("returns the one running app container after exact overlay and alias proof", () => {
    const app = container("app-id", "app", ["feature-app"], { mountRepo: true });
    const db = container("db-id", "postgres", ["feature-db"], { health: "healthy" });

    expect(
      validateWorkspaceContainers([app, db], {
        repoPath,
        upstreamHosts: ["feature-app", "feature-db"],
        target: {
          kind: "linked",
          workspace,
          devpodId: workspace,
          hadExactDevpod: true,
          gitCommonDir: "/repo/.git",
        },
      }),
    ).toEqual({ id: "app-id", workspacePath: "/workspaces/repo" });
  });

  it("rejects a container not started with the devrouter overlay", () => {
    const app = container("app-id", "app", ["feature-app"], {
      mountRepo: true,
      overlay: false,
    });

    expect(() =>
      validateWorkspaceContainers([app], {
        repoPath,
        upstreamHosts: ["feature-app"],
        target: {
          kind: "linked",
          workspace,
          devpodId: workspace,
          hadExactDevpod: true,
          gitCommonDir: "/repo/.git",
        },
      }),
    ).toThrow("docker-compose.devrouter.yml");
  });

  it("rejects a missing or ambiguous workspace alias", () => {
    const app = container("app-id", "app", ["old-app"], { mountRepo: true });

    expect(() =>
      validateWorkspaceContainers([app], {
        repoPath,
        upstreamHosts: ["feature-app"],
        target: {
          kind: "linked",
          workspace,
          devpodId: workspace,
          hadExactDevpod: true,
          gitCommonDir: "/repo/.git",
        },
      }),
    ).toThrow("exactly one running container");
  });

  it("rejects a running foreign container that claims the same workspace alias", () => {
    const app = container("app-id", "app", ["feature-app"], { mountRepo: true });
    const foreign = container("foreign-id", "app", ["feature-app"]);
    foreign.labels["com.docker.compose.project.working_dir"] = "/repo/trees/other/.devcontainer";
    foreign.labels["com.docker.compose.project.config_files"] =
      "/repo/trees/other/.devcontainer/docker-compose.yml,/repo/trees/other/.devcontainer/docker-compose.devrouter.yml";

    expect(() =>
      validateWorkspaceContainers([app, foreign], {
        repoPath,
        upstreamHosts: ["feature-app"],
        target: {
          kind: "linked",
          workspace,
          devpodId: workspace,
          hadExactDevpod: true,
          gitCommonDir: "/repo/.git",
        },
      }),
    ).toThrow("found 2");
  });

  it("rejects an unhealthy workspace upstream", () => {
    const app = container("app-id", "app", ["feature-app"], { mountRepo: true });
    const db = container("db-id", "postgres", ["feature-db"], {
      health: "unhealthy",
    });

    expect(() =>
      validateWorkspaceContainers([app, db], {
        repoPath,
        upstreamHosts: ["feature-db"],
        target: {
          kind: "linked",
          workspace,
          devpodId: workspace,
          hadExactDevpod: true,
          gitCommonDir: "/repo/.git",
        },
      }),
    ).toThrow("not healthy");
  });
});

describe("workspaceEnsure", () => {
  let tmpDir: string;
  let gitDir: string;

  beforeEach(() => {
    vi.stubEnv("DEVROUTER_WORKSPACE_RUNTIME", "devpod");
    resetWorkspaceRuntimeCaches();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-ensure-"));
    tmpDir = fs.realpathSync.native(tmpDir);
    gitDir = path.join(tmpDir, "git", "worktrees", "feature");
    fs.mkdirSync(path.join(tmpDir, ".devcontainer"), { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git"), `gitdir: ${gitDir}\n`, "utf-8");
    fs.writeFileSync(
      path.join(tmpDir, ".devcontainer", "docker-compose.devrouter.yml"),
      "services: {}\n",
      "utf-8",
    );
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      profile: "full",
      workspace: "feature",
      config: {
        version: 1,
        apps: [
          {
            name: "app",
            host: "app.feature.localhost",
            protocol: "http",
            runtime: "proxy",
            dependencies: [],
            upstream: "feature-app:3000",
          },
          {
            name: "db",
            host: "db.feature.localhost",
            protocol: "tcp",
            tcpProtocol: "postgres",
            runtime: "proxy",
            dependencies: [],
            upstream: "feature-db:5432",
          },
        ],
      },
    });
    vi.mocked(replaceHostRoutesForRepo).mockReturnValue([]);
    vi.mocked(resolveManagedPostStartPlan).mockReturnValue({ kind: "unmanaged" });
    vi.mocked(runManagedPostStart).mockImplementation(() => undefined);
    mockDevsyUp();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  function inspectLine(snapshot: WorkspaceContainerSnapshot): string {
    return JSON.stringify(snapshot);
  }

  function devpodUpCalls() {
    return vi
      .mocked(spawnSync)
      .mock.calls.filter(
        ([command, args]) => command === "devpod" && (args as string[])[0] === "up",
      );
  }

  function mockDevsyUp(
    options: { status?: number; stderr?: string; onStart?: () => void } = {},
  ): void {
    vi.mocked(spawn).mockImplementation(() => {
      options.onStart?.();
      const child = new EventEmitter() as ChildProcess;
      const stderr = new PassThrough();
      Object.assign(child, { stderr });
      queueMicrotask(() => {
        if (options.stderr) stderr.write(Buffer.from(options.stderr));
        stderr.end();
        child.emit("close", options.status ?? 0, null);
      });
      return child;
    });
  }

  function mockLifecycle(
    options: {
      devpodUpStatus?: number;
      devpodUpStatuses?: number[];
      devpods?: DevpodWorkspace[];
      appAliases?: string[];
      appAliasSets?: string[][];
      curlStatus?: number;
      curlCode?: string;
      curlCodes?: string[];
      events?: string[];
      onDevpodUp?: () => void;
    } = {},
  ): void {
    let devpodUpCall = 0;
    let dockerInspectCall = 0;
    let curlCall = 0;
    const listedDevpod = JSON.stringify(
      options.devpods ?? [{ id: "feature", source: { localFolder: tmpDir } }],
    );
    const app = container("app-id", "app", options.appAliases ?? ["feature-app"], {
      mountRepo: true,
    });
    app.labels["com.docker.compose.project.working_dir"] = `${tmpDir}/.devcontainer`;
    app.labels["com.docker.compose.project.config_files"] =
      `${tmpDir}/.devcontainer/docker-compose.yml,${tmpDir}/.devcontainer/docker-compose.devrouter.yml`;
    app.mounts[0].Source = tmpDir;
    app.mounts[1] = { Type: "bind", Source: gitDir, Destination: gitDir };
    const db = container("db-id", "postgres", ["feature-db"], { health: "healthy" });
    db.labels["com.docker.compose.project.working_dir"] = `${tmpDir}/.devcontainer`;
    db.labels["com.docker.compose.project.config_files"] =
      `${tmpDir}/.devcontainer/docker-compose.yml,${tmpDir}/.devcontainer/docker-compose.devrouter.yml`;

    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "list") {
        return { status: 0, stdout: listedDevpod, stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "up") {
        options.events?.push("devpod-up");
        options.onDevpodUp?.();
        const status = options.devpodUpStatuses?.[devpodUpCall] ?? options.devpodUpStatus ?? 0;
        devpodUpCall += 1;
        return { status } as never;
      }
      if (command === "git" && argv.includes("--git-common-dir")) {
        return { status: 0, stdout: `${gitDir}\n`, stderr: "" } as never;
      }
      if (command === "docker" && argv[0] === "ps") {
        return { status: 0, stdout: "app-id\ndb-id\n", stderr: "" } as never;
      }
      if (command === "docker" && argv[0] === "inspect") {
        options.events?.push("preflight");
        const aliases = options.appAliasSets?.[dockerInspectCall];
        dockerInspectCall += 1;
        const inspectedApp = aliases ? { ...app, networks: { devnet: { Aliases: aliases } } } : app;
        return {
          status: 0,
          stdout: `${inspectLine(inspectedApp)}\n${inspectLine(db)}\n`,
          stderr: "",
        } as never;
      }
      if (command === "docker" && argv[0] === "exec") {
        return {
          status: 0,
          stdout: argv.includes("--show-toplevel") ? "/workspaces/repo\n" : "feature\n",
          stderr: "",
        } as never;
      }
      if (command === "curl") {
        options.events?.push("http-ready");
        const code = options.curlCodes?.[curlCall] ?? options.curlCode ?? "404";
        curlCall += 1;
        return {
          status: options.curlStatus ?? 0,
          stdout: code,
          stderr: options.curlStatus ? "not ready" : "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });
  }

  function makePrimaryRepo(): void {
    fs.rmSync(path.join(tmpDir, ".git"), { force: true });
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.rmSync(path.join(tmpDir, ".devcontainer", "docker-compose.devrouter.yml"), {
      force: true,
    });
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      profile: "full",
      workspace: undefined,
      config: {
        version: 1,
        project: { name: "sample" },
        apps: [
          {
            name: "app",
            host: "app.localhost",
            protocol: "http",
            runtime: "proxy",
            dependencies: [],
            upstream: "sample-app:3000",
          },
          {
            name: "db",
            host: "db.localhost",
            protocol: "tcp",
            tcpProtocol: "postgres",
            runtime: "proxy",
            dependencies: [],
            upstream: "sample-db:5432",
          },
        ],
      },
    });
  }

  function mockPrimaryLifecycle(
    options: { devpodLists?: DevpodWorkspace[][]; appAliases?: string[] } = {},
  ): void {
    // This provider-specific suite pins DevPod, so every list response belongs
    // to the lifecycle under test rather than runtime auto-detection.
    const devpodLists = options.devpodLists ?? [];
    let devpodListCall = 0;
    const app = container("app-id", "app", options.appAliases ?? ["sample-app"], {
      mountRepo: true,
      overlay: false,
    });
    app.labels["com.docker.compose.project.working_dir"] = `${tmpDir}/.devcontainer`;
    app.labels["com.docker.compose.project.config_files"] =
      `${tmpDir}/.devcontainer/docker-compose.yml,${tmpDir}/.devcontainer/docker-compose.default.yml`;
    app.mounts = [{ Type: "bind", Source: tmpDir, Destination: "/workspaces/sample" }];
    const db = container("db-id", "postgres", ["sample-db"], {
      health: "healthy",
      overlay: false,
    });
    db.labels["com.docker.compose.project.working_dir"] = `${tmpDir}/.devcontainer`;
    db.labels["com.docker.compose.project.config_files"] =
      `${tmpDir}/.devcontainer/docker-compose.yml,${tmpDir}/.devcontainer/docker-compose.default.yml`;

    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy") {
        return { status: 1, stdout: "", stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "list") {
        const fallback = [{ id: "sample", source: { localFolder: tmpDir } }];
        const listed = devpodLists[devpodListCall] ?? fallback;
        devpodListCall += 1;
        return { status: 0, stdout: JSON.stringify(listed), stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "up") {
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      if (command === "docker" && argv[0] === "ps") {
        return { status: 0, stdout: "app-id\ndb-id\n", stderr: "" } as never;
      }
      if (command === "docker" && argv[0] === "inspect") {
        return {
          status: 0,
          stdout: `${inspectLine(app)}\n${inspectLine(db)}\n`,
          stderr: "",
        } as never;
      }
      if (command === "docker" && argv[0] === "exec") {
        return { status: 0, stdout: "/workspaces/sample\n", stderr: "" } as never;
      }
      if (command === "curl") {
        return { status: 0, stdout: "404", stderr: "" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });
  }

  function managedPlanFor(desiredProfileServices: string[]): ManagedDevcontainerPlan {
    const composeDirectory = path.join(tmpDir, ".devcontainer");
    const composeFiles = [
      path.join(composeDirectory, "docker-compose.yml"),
      path.join(composeDirectory, "docker-compose.devrouter.yml"),
    ];
    const desiredServices = ["app", "postgres", ...desiredProfileServices];
    return {
      sourcePath: path.join(composeDirectory, "devcontainer.json"),
      generatedPath: path.join(composeDirectory, "devcontainer.devrouter.json"),
      generatedRelativePath: ".devcontainer/devcontainer.devrouter.json",
      sourceConfigSha256: "a".repeat(64),
      effectiveConfigSha256:
        desiredProfileServices.length === 1 && desiredProfileServices[0] === "redis"
          ? "d".repeat(64)
          : "b".repeat(64),
      primaryService: "app",
      composeDirectory,
      composeFiles,
      composeServices: ["app", "litellm", "postgres", "redis"],
      nativeRunServices: ["app", "postgres", "redis", "litellm"],
      baseServices: ["postgres"],
      profileServices: ["redis", "litellm"],
      desiredProfileServices,
      desiredServices,
      contents: "// devrouter:managed devcontainer profile\n{}\n",
    };
  }

  function managedRuntimeConfig(): DevrouterConfig {
    return {
      version: 1,
      managedRuntime: {
        devcontainer: {
          baseServices: ["postgres"],
          profileServices: ["redis", "litellm"],
        },
        processes: ["app", "local-mcp"],
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

  function managedPreviousState(): ManagedRuntimeState {
    return {
      version: 1,
      repoPath: tmpDir,
      workspace: "feature",
      devpodId: "feature",
      composeProject: "workspace-project",
      profile: "old",
      desired: {
        apps: ["chat"],
        services: ["redis"],
        processes: ["app", "local-mcp"],
      },
      sourceConfigSha256: "a".repeat(64),
      effectiveConfigSha256: "d".repeat(64),
      status: "ready",
      updatedAt: "2026-08-26T08:00:00.000Z",
    };
  }

  function managedPreviousRoute(): HostRouteState {
    return {
      id: "route-old",
      name: "chat",
      host: "chat.feature.localhost",
      protocol: "http",
      repoPath: tmpDir,
      port: 3000,
      mode: "proxy",
      upstreamHost: "feature-app",
      workspace: "feature",
      createdAt: "2026-08-26T08:00:00.000Z",
      updatedAt: "2026-08-26T08:00:00.000Z",
    };
  }

  function mockManagedLifecycle(
    options: { events?: string[]; curlStatus?: number; dockerPsFailureForProject?: string } = {},
  ): {
    runningServices: Set<string>;
    runningProcesses: Set<string>;
  } {
    const events = options.events ?? [];
    const runningServices = new Set(["app", "postgres", "redis"]);
    const runningProcesses = new Set(["app", "local-mcp"]);
    const serviceIds: Record<string, string> = {
      app: "app-id",
      postgres: "postgres-id",
      redis: "redis-id",
      litellm: "litellm-id",
    };
    const snapshots = Object.entries(serviceIds).map(([service, id]) => {
      const snapshot = container(id, service, [`feature-${service}`], {
        health: service === "app" ? undefined : "healthy",
        mountRepo: service === "app",
        running: runningServices.has(service),
      });
      snapshot.labels["com.docker.compose.project"] = "workspace-project";
      snapshot.labels["com.docker.compose.project.working_dir"] = `${tmpDir}/.devcontainer`;
      snapshot.labels["com.docker.compose.project.config_files"] =
        `${tmpDir}/.devcontainer/docker-compose.yml,${tmpDir}/.devcontainer/docker-compose.devrouter.yml`;
      if (service === "app") {
        snapshot.mounts = [
          { Type: "bind", Source: tmpDir, Destination: "/workspaces/repo" },
          { Type: "bind", Source: gitDir, Destination: gitDir },
        ];
      }
      return snapshot;
    });
    const listedDevpod = JSON.stringify([{ id: "feature", source: { localFolder: tmpDir } }]);

    vi.mocked(inspectManagedDevcontainerConfig).mockImplementation(({ profile }) =>
      managedPlanFor(profile?.devcontainerServices ?? ["litellm"]),
    );
    vi.mocked(writeManagedDevcontainerConfig).mockImplementation(() => {
      events.push("config-write");
    });
    vi.mocked(removeManagedDevcontainerConfig).mockImplementation(() => {
      events.push("config-remove");
    });
    vi.mocked(readManagedRuntimeState).mockReturnValue(managedPreviousState());
    vi.mocked(listHostRouteState).mockReturnValue([managedPreviousRoute()]);
    vi.mocked(resolveManagedPostStartPlan).mockReturnValue({
      kind: "runtime",
      adapterPath: ".devcontainer/post-start.sh",
      adapterSha256: "e".repeat(64),
      adapterContents: Buffer.from("adapter"),
    });
    vi.mocked(startExactManagedServices).mockImplementation(({ services }) => {
      for (const service of services) runningServices.add(service);
      events.push(`services-start:${services.join(",")}`);
    });
    vi.mocked(stopExactManagedService).mockImplementation((_id, service) => {
      runningServices.delete(service);
      events.push(`service-stop:${service}`);
    });
    vi.mocked(runManagedPostStart).mockImplementation((options) => {
      runningProcesses.clear();
      for (const process of options.processes ?? []) runningProcesses.add(process);
      events.push(`process-start:${options.processes?.join(",") ?? "legacy"}`);
    });
    vi.mocked(runManagedProcessAction).mockImplementation((options) => {
      if (options.action === "stop") {
        runningProcesses.delete(options.name);
        events.push(`process-stop:${options.name}`);
        return "stopped";
      }
      return runningProcesses.has(options.name) ? "running" : "stopped";
    });
    vi.mocked(writeManagedRuntimeState).mockImplementation(() => {
      events.push("state-write");
    });
    vi.mocked(replaceHostRoutesForRepo).mockImplementation((_repoPath, routes) => {
      events.push(`routes:${routes.length}`);
      return [];
    });

    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "list") {
        return { status: 0, stdout: listedDevpod, stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "up") {
        events.push("devpod-up");
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      if (command === "git" && argv.includes("--git-common-dir")) {
        return { status: 0, stdout: `${gitDir}\n`, stderr: "" } as never;
      }
      if (command === "docker" && argv[0] === "ps") {
        const filterIndex = argv.indexOf("--filter");
        const composeProject =
          filterIndex >= 0
            ? argv[filterIndex + 1]?.replace("label=com.docker.compose.project=", "")
            : undefined;
        if (
          options.dockerPsFailureForProject &&
          composeProject === options.dockerPsFailureForProject
        ) {
          return { status: 1, stdout: "", stderr: "docker unavailable" } as never;
        }
        const ids = snapshots
          .filter(
            (snapshot) =>
              !composeProject || snapshot.labels["com.docker.compose.project"] === composeProject,
          )
          .map((snapshot) => snapshot.id);
        return {
          status: 0,
          stdout: ids.length > 0 ? `${ids.join("\n")}\n` : "",
          stderr: "",
        } as never;
      }
      if (command === "docker" && argv[0] === "inspect") {
        return {
          status: 0,
          stdout: `${snapshots
            .map((snapshot) => {
              const service = snapshot.labels["com.docker.compose.service"];
              return JSON.stringify({
                ...snapshot,
                state: {
                  ...snapshot.state,
                  Running: runningServices.has(service ?? ""),
                },
              });
            })
            .join("\n")}\n`,
          stderr: "",
        } as never;
      }
      if (command === "docker" && argv[0] === "stop") {
        const service = Object.entries(serviceIds).find(([, id]) => id === argv[1])?.[0];
        if (service) runningServices.delete(service);
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      if (command === "docker" && argv[0] === "exec") {
        return {
          status: 0,
          stdout: argv.includes("--show-toplevel") ? "/workspaces/repo\n" : "feature\n",
          stderr: "",
        } as never;
      }
      if (command === "curl") {
        events.push("http-ready");
        return {
          status: options.curlStatus ?? 0,
          stdout: options.curlStatus ? "502" : "404",
          stderr: options.curlStatus ? "not ready" : "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    return { runningServices, runningProcesses };
  }

  function mockColdManagedDevsyFailure(attachAfterFailure: boolean): void {
    vi.stubEnv("DEVROUTER_WORKSPACE_RUNTIME", "devsy");
    resetWorkspaceRuntimeCaches();
    fs.writeFileSync(path.join(gitDir, "devrouter-workspace"), "feature\n", "utf-8");
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    mockManagedLifecycle();
    vi.mocked(readManagedRuntimeState).mockReturnValue(undefined);
    const delegate = vi.mocked(spawnSync).getMockImplementation();
    let startAttempted = false;
    mockDevsyUp({
      status: 1,
      stderr: "agent injection failed",
      onStart: () => {
        startAttempted = true;
      },
    });
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return {
          status: 0,
          stdout: JSON.stringify(
            startAttempted && attachAfterFailure
              ? [{ id: "feature", source: { localFolder: tmpDir } }]
              : [],
          ),
          stderr: "",
        } as never;
      }
      return delegate?.(command, args, options) as never;
    });
  }

  it("reconciles selected services and processes without recreating the primary container", async () => {
    const events: string[] = [];
    const runtimeConfig = managedRuntimeConfig();
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: runtimeConfig,
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    const managedRuntimeStatus: ManagedRuntimeStatus = {
      mode: "managed",
      status: "ready",
      profile: "ai",
      desired: { apps: ["chat"], services: ["litellm"], processes: ["app"] },
      active: { apps: ["chat"], services: ["litellm"], processes: ["app"] },
      serviceStatuses: { litellm: "healthy" },
      baseServiceStatuses: { postgres: "healthy" },
      processStatuses: { app: "running" },
      drift: [],
    };
    vi.mocked(collectManagedRuntimeStatus).mockReturnValue(managedRuntimeStatus);
    const runtime = mockManagedLifecycle({ events });

    const result = await workspaceEnsure(tmpDir, {
      containerTimeoutMs: 0,
      httpTimeoutMs: 0,
    });

    expect(result).toMatchObject({
      kind: "linked",
      workspace: "feature",
      profile: "ai",
      devpodId: "feature",
      recreated: false,
      managedRuntime: managedRuntimeStatus,
    });
    expect(runtime.runningServices).toEqual(new Set(["app", "postgres", "litellm"]));
    expect(runtime.runningProcesses).toEqual(new Set(["app"]));
    expect(startExactManagedServices).toHaveBeenCalledWith(
      expect.objectContaining({ composeProject: "workspace-project", services: ["litellm"] }),
    );
    expect(stopExactManagedService).toHaveBeenCalledWith("redis-id", "redis");
    expect(runManagedPostStart).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "ai", processes: ["app"] }),
    );
    expect(runManagedProcessAction).toHaveBeenCalledWith(
      expect.objectContaining({ name: "local-mcp", action: "stop" }),
    );
    expect(writeManagedDevcontainerConfig).toHaveBeenCalledOnce();
    expect(writeManagedRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "ai",
        desired: {
          apps: ["chat"],
          services: ["litellm"],
          processes: ["app"],
        },
      }),
    );
    const devpodUp = devpodUpCalls()[0];
    expect(devpodUp[1]).toContain("--devcontainer-path");
    expect(devpodUp[1]).toContain(".devcontainer/devcontainer.devrouter.json");
    expect(devpodUp[1]).not.toContain("--recreate");
    expect(events.indexOf("config-write")).toBeLessThan(events.indexOf("devpod-up"));
    expect(events.indexOf("process-stop:local-mcp")).toBeLessThan(events.indexOf("routes:1"));
    expect(events.indexOf("service-stop:redis")).toBeLessThan(events.indexOf("routes:1"));
  });

  it("proves Traefik file routers before marking a managed runtime ready", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    mockManagedLifecycle();

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).resolves.toMatchObject({ profile: "ai" });

    expect(ensureTraefikRoutesLoaded).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "chat", repoPath: tmpDir })],
      { initialTimeoutMs: 0, recoveryTimeoutMs: 0 },
    );
    expect(writeManagedRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready" }),
    );
  });

  it("rolls back managed routes when Traefik still lacks them after recovery", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    vi.mocked(ensureTraefikRoutesLoaded).mockRejectedValueOnce(
      new Error("Traefik did not load file-provider routes after one restart"),
    );
    mockManagedLifecycle();

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Candidate runtime was rolled back");

    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, [
      expect.objectContaining({ name: "chat", upstreamHost: "feature-app" }),
    ]);
    expect(ensureTraefikRoutesLoaded).toHaveBeenCalledTimes(2);
    expect(writeManagedRuntimeState).not.toHaveBeenCalled();
  });

  it("rolls back candidate services, processes, and routes after route readiness failure", async () => {
    const events: string[] = [];
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    const runtime = mockManagedLifecycle({ events, curlStatus: 22 });

    await expect(
      workspaceEnsure(tmpDir, {
        containerTimeoutMs: 0,
        httpTimeoutMs: 0,
      }),
    ).rejects.toThrow("Candidate runtime was rolled back");

    expect(runtime.runningServices).toEqual(new Set(["app", "postgres", "redis"]));
    expect(runtime.runningProcesses).toEqual(new Set(["app", "local-mcp"]));
    expect(writeManagedDevcontainerConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ desiredProfileServices: ["redis"] }),
    );
    expect(startExactManagedServices).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ services: ["litellm"] }),
    );
    expect(startExactManagedServices).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ services: ["app", "postgres", "redis"] }),
    );
    expect(stopExactManagedService).toHaveBeenNthCalledWith(1, "redis-id", "redis");
    expect(stopExactManagedService).toHaveBeenNthCalledWith(2, "litellm-id", "litellm");
    expect(runManagedPostStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ profile: "old", processes: ["app", "local-mcp"] }),
    );
    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, [
      expect.objectContaining({
        name: "chat",
        workspace: "feature",
        upstreamHost: "feature-app",
      }),
    ]);
    expect(writeManagedRuntimeState).not.toHaveBeenCalled();
    expect(events.filter((event) => event === "routes:1")).toHaveLength(2);
  });

  it("refuses a new transition when the last managed state is degraded", async () => {
    const events: string[] = [];
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    mockManagedLifecycle({ events });
    vi.mocked(readManagedRuntimeState).mockReturnValue({
      ...managedPreviousState(),
      status: "degraded",
      transitionPhase: "rollback",
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Managed runtime state is degraded");

    expect(devpodUpCalls()).toHaveLength(0);
    expect(inspectManagedDevcontainerConfig).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rebaselines degraded state after its exact Compose project disappeared", async () => {
    const events: string[] = [];
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    const runtime = mockManagedLifecycle({ events });
    vi.mocked(readManagedRuntimeState).mockReturnValue({
      ...managedPreviousState(),
      composeProject: "disappeared-project",
      status: "degraded",
      transitionPhase: "service-start",
    });
    vi.mocked(collectManagedRuntimeStatus).mockReturnValue({
      mode: "managed",
      status: "ready",
      profile: "ai",
      desired: { apps: ["chat"], services: ["litellm"], processes: ["app"] },
      active: { apps: ["chat"], services: ["litellm"], processes: ["app"] },
      serviceStatuses: { litellm: "healthy" },
      baseServiceStatuses: { postgres: "healthy" },
      processStatuses: { app: "running" },
      drift: [],
    });

    const result = await workspaceEnsure(tmpDir, {
      containerTimeoutMs: 0,
      httpTimeoutMs: 0,
    });

    expect(result.managedRuntime?.status).toBe("ready");
    expect(runtime.runningServices).toEqual(new Set(["app", "postgres", "litellm"]));
    expect(runtime.runningProcesses).toEqual(new Set(["app"]));
    expect(writeManagedRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({
        composeProject: "workspace-project",
        profile: "ai",
        status: "ready",
      }),
    );
    expect(markManagedRuntimeDegraded).not.toHaveBeenCalled();
  });

  it("keeps degraded state fail-closed when exact project inspection fails", async () => {
    const events: string[] = [];
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    mockManagedLifecycle({
      events,
      dockerPsFailureForProject: "unreadable-project",
    });
    vi.mocked(readManagedRuntimeState).mockReturnValue({
      ...managedPreviousState(),
      composeProject: "unreadable-project",
      status: "degraded",
      transitionPhase: "rollback",
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Managed runtime state is degraded");

    expect(devpodUpCalls()).toHaveLength(0);
    expect(inspectManagedDevcontainerConfig).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rejects a warm ensure when the managed source configuration changed", async () => {
    const events: string[] = [];
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    mockManagedLifecycle({ events });
    vi.mocked(readManagedRuntimeState).mockReturnValue({
      ...managedPreviousState(),
      sourceConfigSha256: "z".repeat(64),
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Managed Dev Container source configuration changed");

    expect(writeManagedDevcontainerConfig).not.toHaveBeenCalled();
    expect(devpodUpCalls()).toHaveLength(0);
  });

  it("marks rollback drift when the previous config fingerprint cannot be restored", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    mockManagedLifecycle({ curlStatus: 22 });
    vi.mocked(inspectManagedDevcontainerConfig).mockImplementation(({ profile }) => {
      const services = profile?.devcontainerServices ?? ["litellm"];
      const plan = managedPlanFor(services);
      return services.includes("redis") ? { ...plan, effectiveConfigSha256: "x".repeat(64) } : plan;
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Rollback left degraded drift: configuration:");

    expect(writeManagedDevcontainerConfig).toHaveBeenCalledOnce();
    expect(markManagedRuntimeDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready" }),
      "route-publication",
    );
  });

  it("restores the generated config to the observed first-transition baseline", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    const runtime = mockManagedLifecycle({ curlStatus: 22 });
    vi.mocked(readManagedRuntimeState).mockReturnValue(undefined);

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Candidate runtime was rolled back");

    expect(removeManagedDevcontainerConfig).not.toHaveBeenCalled();
    expect(writeManagedDevcontainerConfig).toHaveBeenCalledTimes(2);
    expect(inspectManagedDevcontainerConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ devcontainerServices: ["redis"] }),
      }),
    );
    expect(runtime.runningServices).toEqual(new Set(["app", "postgres", "redis"]));
    expect(runtime.runningProcesses).toEqual(new Set(["app", "local-mcp"]));
    expect(startExactManagedServices).toHaveBeenLastCalledWith(
      expect.objectContaining({ services: ["app", "postgres", "redis"] }),
    );
    expect(runManagedPostStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ processes: ["app", "local-mcp"] }),
    );
  });

  it("keeps a cold failed DevPod stoppable with the empty baseline config", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    const runtime = mockManagedLifecycle({ curlStatus: 22 });
    vi.mocked(readManagedRuntimeState).mockReturnValue(undefined);
    runtime.runningServices.clear();
    runtime.runningProcesses.clear();
    const delegate = vi.mocked(spawnSync).getMockImplementation();
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "up") {
        runtime.runningServices.add("app");
        runtime.runningServices.add("postgres");
        runtime.runningServices.add("litellm");
        runtime.runningProcesses.add("app");
      }
      return delegate?.(command, args, options) as never;
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Candidate runtime was rolled back");

    expect(removeManagedDevcontainerConfig).not.toHaveBeenCalled();
    expect(writeManagedDevcontainerConfig).toHaveBeenCalledTimes(2);
    expect(inspectManagedDevcontainerConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ devcontainerServices: [] }),
      }),
    );
    expect(runtime.runningServices).toEqual(new Set(["app", "postgres"]));
    expect(runtime.runningProcesses).toEqual(new Set());
  });

  it("rolls back cold selected services when the bootstrap marker rejects post-start", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    const runtime = mockManagedLifecycle();
    vi.mocked(readManagedRuntimeState).mockReturnValue(undefined);
    runtime.runningServices.clear();
    runtime.runningProcesses.clear();
    const delegate = vi.mocked(spawnSync).getMockImplementation();
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "up") {
        runtime.runningServices.add("app");
        runtime.runningServices.add("postgres");
        runtime.runningServices.add("litellm");
      }
      return delegate?.(command, args, options) as never;
    });
    vi.mocked(runManagedPostStart).mockImplementation(() => {
      throw new Error("Bootstrap completion marker is missing");
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Bootstrap completion marker is missing");

    expect(runtime.runningServices).toEqual(new Set(["app", "postgres"]));
    expect(runtime.runningProcesses).toEqual(new Set());
    expect(stopExactManagedService).toHaveBeenCalledWith("litellm-id", "litellm");
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
    expect(writeManagedRuntimeState).not.toHaveBeenCalled();
  });

  it("retains the candidate config when startup fails before the rollback boundary", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: managedRuntimeConfig(),
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: ["chat"],
        devcontainerServices: ["litellm"],
        processes: ["app"],
      },
    });
    mockManagedLifecycle();
    vi.mocked(readManagedRuntimeState).mockReturnValue(undefined);
    const delegate = vi.mocked(spawnSync).getMockImplementation();
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      const argv = (args as string[]) ?? [];
      if (command === "docker" && argv[0] === "inspect") {
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      return delegate?.(command, args, options) as never;
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Managed runtime transition did not reach a rollback boundary");

    expect(writeManagedDevcontainerConfig).toHaveBeenCalledOnce();
    expect(removeManagedDevcontainerConfig).not.toHaveBeenCalled();
    expect(startExactManagedServices).not.toHaveBeenCalled();
  });

  it("keeps a failed cold Devsy workspace stoppable when exact ownership appears", async () => {
    mockColdManagedDevsyFailure(true);

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Managed runtime transition did not reach a rollback boundary");

    expect(writeManagedDevcontainerConfig).toHaveBeenCalledOnce();
    expect(removeManagedDevcontainerConfig).not.toHaveBeenCalled();
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
  });

  it("removes a cold Devsy candidate config when exact absence is proved", async () => {
    mockColdManagedDevsyFailure(false);

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Managed runtime transition did not reach a rollback boundary");

    expect(writeManagedDevcontainerConfig).toHaveBeenCalledOnce();
    expect(removeManagedDevcontainerConfig).toHaveBeenCalledOnce();
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
  });

  it("reuses an exact primary DevPod without linked ownership metadata", async () => {
    makePrimaryRepo();
    mockPrimaryLifecycle();

    const result = await workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 });

    expect(result).toMatchObject({
      kind: "primary",
      devpodId: "sample",
      repoPath: tmpDir,
      recreated: false,
      tlsRefreshed: false,
    });
    expect(result.workspace).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, ".git", "devrouter-workspace"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".git", "devrouter", "workspaces"))).toBe(false);
    const up = devpodUpCalls()[0];
    expect(up[1]).toContain("sample");
    expect(up[1]).not.toContain("--workspace-env");
    expect(up[2]).not.toEqual(
      expect.objectContaining({
        env: expect.objectContaining({ DEVCONTAINER_COMPOSE_OVERLAY: expect.anything() }),
      }),
    );
  });

  it("rediscovers the exact DevPod id after a new primary startup", async () => {
    makePrimaryRepo();
    mockPrimaryLifecycle({
      devpodLists: [[], [], [{ id: "devpod-selected", source: { localFolder: tmpDir } }]],
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).resolves.toMatchObject({ kind: "primary", devpodId: "devpod-selected" });

    expect(devpodUpCalls()[0][1]).not.toContain("--id");
  });

  it("rejects a duplicated DevPod id during post-start ownership proof", async () => {
    makePrimaryRepo();
    mockPrimaryLifecycle({
      devpodLists: [
        [],
        [],
        [
          { id: "duplicated", source: { localFolder: tmpDir } },
          { id: "duplicated", source: { localFolder: "/other/repo" } },
        ],
      ],
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("do not have one exact owner");

    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, []);
  });

  it("keeps DevPod progress off stdout in quiet mode", async () => {
    makePrimaryRepo();
    mockPrimaryLifecycle();

    await workspaceEnsure(tmpDir, {
      quiet: true,
      containerTimeoutMs: 0,
      httpTimeoutMs: 0,
    });

    expect(devpodUpCalls()[0][2]).toEqual(
      expect.objectContaining({
        stdio: ["inherit", 2, "inherit"],
      }),
    );
  });

  it("forces primary runtime config to ignore an inherited workspace override", async () => {
    makePrimaryRepo();
    vi.stubEnv("DEVROUTER_WORKSPACE", "foreign");
    mockPrimaryLifecycle();

    await workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 });

    expect(loadRuntimeConfig).toHaveBeenCalledWith(tmpDir, "", undefined);
  });

  it("rejects duplicate primary path owners before startup or route mutation", async () => {
    makePrimaryRepo();
    mockPrimaryLifecycle({
      devpodLists: [
        [
          { id: "first", source: { localFolder: tmpDir } },
          { id: "second", source: { localFolder: tmpDir } },
        ],
      ],
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Multiple DevPod workspaces reference");
    expect(devpodUpCalls()).toHaveLength(0);
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
  });

  it("fails closed for a primary checkout without writing ownership or stopping DevPod", async () => {
    makePrimaryRepo();
    mockPrimaryLifecycle({ appAliases: ["stale-app"] });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("exactly one running container");

    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, []);
    expect(fs.existsSync(path.join(tmpDir, ".git", "devrouter", "workspaces"))).toBe(false);
    expect(spawnSync).not.toHaveBeenCalledWith(
      "devpod",
      expect.arrayContaining(["stop"]),
      expect.anything(),
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "devpod",
      expect.arrayContaining(["delete"]),
      expect.anything(),
    );
  });

  it("does not recreate a newly attached primary DevPod after failed preflight", async () => {
    makePrimaryRepo();
    mockPrimaryLifecycle({
      appAliases: ["stale-app"],
      devpodLists: [[], [], [{ id: "new-primary", source: { localFolder: tmpDir } }]],
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("exactly one running container");

    expect(devpodUpCalls()).toHaveLength(1);
    expect(devpodUpCalls()[0][1]).not.toContain("--recreate");
    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, []);
  });

  it("starts, proves, atomically publishes, and accepts non-5xx HTTP", async () => {
    mockLifecycle();

    const result = await workspaceEnsure(tmpDir, {
      containerTimeoutMs: 0,
      httpTimeoutMs: 0,
    });

    expect(result.workspace).toBe("feature");
    expect(startRouterStack).toHaveBeenCalledOnce();
    expect(replaceHostRoutesForRepo).toHaveBeenCalledOnce();
    expect(vi.mocked(replaceHostRoutesForRepo).mock.calls[0][1]).toHaveLength(2);
    expect(spawnSync).toHaveBeenCalledWith(
      "devpod",
      expect.arrayContaining([
        "--workspace-env",
        "WORKSPACE=feature",
        "DEVROUTER_WORKSPACE=feature",
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          DEVROUTER_GIT_COMMON_DIR: gitDir,
          DEVROUTER_WORKSPACE: "feature",
          WORKSPACE: "feature",
        }),
      }),
    );
  });

  it("passes the exact preflight container to managed post-start before route readiness", async () => {
    const events: string[] = [];
    const plan = {
      kind: "runtime" as const,
      adapterPath: ".devcontainer/post-start.sh",
      adapterSha256: "a".repeat(64),
      adapterContents: Buffer.from("adapter"),
    };
    vi.mocked(resolveManagedPostStartPlan).mockReturnValue(plan);
    vi.mocked(runManagedPostStart).mockImplementation(() => {
      events.push("managed-start");
    });
    mockLifecycle({ events });

    await workspaceEnsure(tmpDir, {
      containerTimeoutMs: 0,
      httpTimeoutMs: 0,
    });

    expect(events.indexOf("managed-start")).toBeGreaterThan(events.indexOf("preflight"));
    expect(events.indexOf("http-ready")).toBeGreaterThan(events.indexOf("managed-start"));
    expect(runManagedPostStart).toHaveBeenCalledWith({
      plan,
      container: { id: "app-id", workspacePath: "/workspaces/repo" },
      quiet: undefined,
      profile: "full",
    });
  });

  it("rejects unsafe managed bootstrap ordering before provider mutation", async () => {
    vi.mocked(resolveManagedPostStartPlan).mockImplementation(() => {
      throw new Error("Set waitFor to 'postCreateCommand' or 'postStartCommand'");
    });
    mockLifecycle();

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("Set waitFor to 'postCreateCommand' or 'postStartCommand'");

    expect(devpodUpCalls()).toHaveLength(0);
    expect(startRouterStack).not.toHaveBeenCalled();
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
  });

  it("does not recreate when managed post-start fails", async () => {
    const events: string[] = [];
    vi.mocked(resolveManagedPostStartPlan).mockReturnValue({
      kind: "runtime",
      adapterPath: ".devcontainer/post-start.sh",
      adapterSha256: "a".repeat(64),
      adapterContents: Buffer.from("adapter"),
    });
    vi.mocked(runManagedPostStart).mockImplementation(() => {
      throw new Error("Managed post-start failed");
    });
    mockLifecycle({ events });

    await expect(
      workspaceEnsure(tmpDir, {
        containerTimeoutMs: 0,
        httpTimeoutMs: 0,
      }),
    ).rejects.toThrow("Managed post-start failed");

    expect(events).not.toContain("http-ready");
    expect(devpodUpCalls()).toHaveLength(1);
    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, []);
  });

  it("persists common ownership before the first DevPod startup side effect", async () => {
    let recordAtStartup: string | undefined;
    mockLifecycle({
      onDevpodUp: () => {
        const recordPath = path.join(gitDir, "devrouter", "workspaces", "feature.json");
        recordAtStartup = fs.existsSync(recordPath)
          ? fs.readFileSync(recordPath, "utf-8")
          : undefined;
      },
    });

    await workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 });

    expect(JSON.parse(recordAtStartup ?? "null")).toMatchObject({
      version: 1,
      workspace: "feature",
      worktreePath: tmpDir,
      devpodId: "feature",
    });
  });

  it("does not change routes when DevPod startup fails", async () => {
    mockLifecycle({ devpodUpStatus: 1 });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("devpod up failed");

    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
    const devpodUps = devpodUpCalls();
    expect(devpodUps).toHaveLength(2);
    expect(devpodUps[1][1]).toContain("--recreate");
  });

  it("recreates an existing exact-path DevPod once when initial startup fails", async () => {
    mockLifecycle({ devpodUpStatuses: [1, 0] });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).resolves.toMatchObject({ workspace: "feature", recreated: true });

    const devpodUps = devpodUpCalls();
    expect(devpodUps).toHaveLength(2);
    expect(devpodUps[1][1]).toContain("--recreate");
  });

  it("does not recreate a brand-new DevPod when startup fails", async () => {
    fs.writeFileSync(path.join(gitDir, "devrouter-workspace"), "feature\n", "utf-8");
    mockLifecycle({ devpodUpStatus: 1, devpods: [] });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("devpod up failed");

    const devpodUps = devpodUpCalls();
    expect(devpodUps).toHaveLength(1);
  });

  it("clears stale routes when startup succeeds but attachment proof fails", async () => {
    fs.writeFileSync(path.join(gitDir, "devrouter-workspace"), "feature\n", "utf-8");
    mockLifecycle({ devpods: [] });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("did not attach");

    expect(replaceHostRoutesForRepo).toHaveBeenCalledOnce();
    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, []);
    expect(devpodUpCalls()).toHaveLength(1);
  });

  it("rejects an identity already owned by another worktree", async () => {
    fs.writeFileSync(path.join(gitDir, "devrouter-workspace"), "feature\n", "utf-8");
    mockLifecycle({
      devpods: [{ id: "feature", source: { localFolder: "/repo/trees/other" } }],
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("workspace runtime identity 'feature' already belongs to");

    expect(spawnSync).not.toHaveBeenCalledWith(
      "devpod",
      expect.arrayContaining(["up"]),
      expect.anything(),
    );
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
  });

  it("rejects a TCP upstream whose workspace ownership cannot be proved", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      profile: "full",
      workspace: "feature",
      config: {
        version: 1,
        apps: [
          {
            name: "db",
            host: "db.feature.localhost",
            protocol: "tcp",
            tcpProtocol: "postgres",
            runtime: "proxy",
            dependencies: [],
            upstream: "shared-db:5432",
          },
        ],
      },
    });
    mockLifecycle();

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("must use a workspace-owned upstream");

    expect(spawnSync).not.toHaveBeenCalledWith(
      "devpod",
      expect.arrayContaining(["up"]),
      expect.anything(),
    );
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
  });

  it("rejects an HTTP upstream outside the exact workspace namespace", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      profile: "full",
      workspace: "feature",
      config: {
        version: 1,
        apps: [
          {
            name: "web",
            host: "web.feature.localhost",
            protocol: "http",
            runtime: "proxy",
            dependencies: [],
            upstream: "shared-app:3000",
          },
        ],
      },
    });
    mockLifecycle();

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("must use a workspace-owned upstream");

    expect(spawnSync).not.toHaveBeenCalledWith(
      "devpod",
      expect.arrayContaining(["up"]),
      expect.anything(),
    );
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
  });

  it("clears stale routes when the workspace alias is wrong", async () => {
    mockLifecycle({ appAliases: ["old-app"] });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("exactly one running container");

    expect(replaceHostRoutesForRepo).toHaveBeenCalledOnce();
    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, []);
    const devpodUps = devpodUpCalls();
    expect(devpodUps).toHaveLength(2);
    expect(devpodUps[1][1]).toContain("--recreate");
  });

  it("removes the whole route batch when HTTP readiness still fails after recovery", async () => {
    mockLifecycle({ curlStatus: 22, curlCode: "502" });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("HTTP route readiness timed out");

    expect(devpodUpCalls()).toHaveLength(2);
    expect(replaceHostRoutesForRepo).toHaveBeenCalledTimes(4);
    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, []);
  });

  it("recreates an existing workspace once when HTTP readiness fails", async () => {
    const events: string[] = [];
    vi.mocked(resolveManagedPostStartPlan).mockReturnValue({
      kind: "runtime",
      adapterPath: ".devcontainer/post-start.sh",
      adapterSha256: "a".repeat(64),
      adapterContents: Buffer.from("adapter"),
    });
    vi.mocked(runManagedPostStart).mockImplementation(() => {
      events.push("managed-start");
    });
    mockLifecycle({ curlCodes: ["500", "404"], events });

    await expect(
      workspaceEnsure(tmpDir, {
        containerTimeoutMs: 0,
        httpTimeoutMs: 0,
      }),
    ).resolves.toMatchObject({ workspace: "feature", recreated: true });

    const devpodUps = devpodUpCalls();
    expect(devpodUps).toHaveLength(2);
    expect(devpodUps[1][1]).toContain("--recreate");
    expect(replaceHostRoutesForRepo).toHaveBeenCalledTimes(3);
    expect(replaceHostRoutesForRepo).toHaveBeenNthCalledWith(2, tmpDir, []);
    expect(events.filter((event) => event === "managed-start")).toHaveLength(2);
  });

  it("does not recreate again after preflight recovery when HTTP readiness fails", async () => {
    mockLifecycle({
      appAliasSets: [["old-app"], ["feature-app"]],
      curlStatus: 22,
      curlCode: "502",
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("HTTP route readiness timed out");

    expect(devpodUpCalls()).toHaveLength(2);
  });
});
