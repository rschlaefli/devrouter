import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectWorkspaceContainers,
  resolveRunningWorkspaceContainer,
  type WorkspaceContainerSnapshot,
} from "../devpod-environment";
import { type DevpodWorkspace, selectDevpodWorkspace } from "../devpod-workspaces";
import { replaceHostRoutesForRepo } from "../host-routes";
import { loadRuntimeConfig } from "../repo-config";
import { startRouterStack } from "../router";
import { validateWorkspaceContainers, workspaceEnsure } from "../workspace-ensure";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../host-routes", () => ({
  parseUpstream: vi.fn((upstream: string) => {
    const [host, port] = upstream.split(":");
    return { host, port: Number(port), upstreamHost: host };
  }),
  replaceHostRoutesForRepo: vi.fn(() => []),
}));
vi.mock("../docker", () => ({ ensureNetwork: vi.fn(async () => undefined) }));
vi.mock("../repo-config", () => ({
  loadRuntimeConfig: vi.fn(),
  resolveRepoPath: vi.fn((repo?: string) => repo ?? process.cwd()),
}));
vi.mock("../router", () => ({
  DEVNET_NAME: "devnet",
  TCP_PROTOCOL_REGISTRY: { postgres: { port: 5432, entrypoint: "postgres" } },
  activateTcpProtocol: vi.fn(() => false),
  ensureRouterFiles: vi.fn(),
  isTLSEnabled: vi.fn(() => true),
  startRouterStack: vi.fn(),
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
      if (command === "devpod" && argv[0] === "list") {
        const fallback = [{ id: "sample", source: { localFolder: tmpDir } }];
        const listed = options.devpodLists?.[devpodListCall] ?? fallback;
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

  it("reuses an exact primary DevPod without linked ownership metadata", async () => {
    makePrimaryRepo();
    mockPrimaryLifecycle();

    const result = await workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 });

    expect(result).toMatchObject({ kind: "primary", devpodId: "sample", repoPath: tmpDir });
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
      devpodLists: [[], [{ id: "devpod-selected", source: { localFolder: tmpDir } }]],
    });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).resolves.toMatchObject({ kind: "primary", devpodId: "devpod-selected" });

    expect(devpodUpCalls()[0][1]).not.toContain("--id");
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

    expect(loadRuntimeConfig).toHaveBeenCalledWith(tmpDir, "");
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
      devpodLists: [[], [{ id: "new-primary", source: { localFolder: tmpDir } }]],
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
    ).resolves.toMatchObject({ workspace: "feature" });

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
    ).rejects.toThrow("already belongs to '/repo/trees/other'");

    expect(spawnSync).not.toHaveBeenCalledWith(
      "devpod",
      expect.arrayContaining(["up"]),
      expect.anything(),
    );
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
  });

  it("rejects a TCP upstream whose workspace ownership cannot be proved", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
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
    mockLifecycle({ curlCodes: ["500", "404"] });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).resolves.toMatchObject({ workspace: "feature" });

    const devpodUps = devpodUpCalls();
    expect(devpodUps).toHaveLength(2);
    expect(devpodUps[1][1]).toContain("--recreate");
    expect(replaceHostRoutesForRepo).toHaveBeenCalledTimes(3);
    expect(replaceHostRoutesForRepo).toHaveBeenNthCalledWith(2, tmpDir, []);
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
