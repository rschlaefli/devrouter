import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceHostRoutesForRepo } from "../host-routes";
import { loadRuntimeConfig } from "../repo-config";
import { startRouterStack } from "../router";
import {
  type DevpodWorkspace,
  inspectWorkspaceContainers,
  selectDevpodWorkspace,
  validateWorkspaceContainers,
  type WorkspaceContainerSnapshot,
  workspaceEnsure,
} from "../workspace-ensure";

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
});

describe("validateWorkspaceContainers", () => {
  it("returns the one running app container after exact overlay and alias proof", () => {
    const app = container("app-id", "app", ["feature-app"], { mountRepo: true });
    const db = container("db-id", "postgres", ["feature-db"], { health: "healthy" });

    expect(
      validateWorkspaceContainers([app, db], {
        repoPath,
        gitCommonDir: "/repo/.git",
        workspace,
        upstreamHosts: ["feature-app", "feature-db", "external.example"],
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
        gitCommonDir: "/repo/.git",
        workspace,
        upstreamHosts: ["feature-app"],
      }),
    ).toThrow("docker-compose.devrouter.yml");
  });

  it("rejects a missing or ambiguous workspace alias", () => {
    const app = container("app-id", "app", ["old-app"], { mountRepo: true });

    expect(() =>
      validateWorkspaceContainers([app], {
        repoPath,
        gitCommonDir: "/repo/.git",
        workspace,
        upstreamHosts: ["feature-app"],
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
        gitCommonDir: "/repo/.git",
        workspace,
        upstreamHosts: ["feature-app"],
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
        gitCommonDir: "/repo/.git",
        workspace,
        upstreamHosts: ["feature-db"],
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
      curlStatus?: number;
      curlCode?: string;
    } = {},
  ): void {
    let devpodUpCall = 0;
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
        return {
          status: 0,
          stdout: `${inspectLine(app)}\n${inspectLine(db)}\n`,
          stderr: "",
        } as never;
      }
      if (command === "docker" && argv[0] === "exec") {
        return {
          status: 0,
          stdout: argv.includes("--is-inside-work-tree") ? "true\n" : "feature\n",
          stderr: "",
        } as never;
      }
      if (command === "curl") {
        return {
          status: options.curlStatus ?? 0,
          stdout: options.curlCode ?? "404",
          stderr: options.curlStatus ? "not ready" : "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });
  }

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

  it("removes the whole route batch when HTTP readiness times out", async () => {
    mockLifecycle({ curlStatus: 22, curlCode: "502" });

    await expect(
      workspaceEnsure(tmpDir, { containerTimeoutMs: 0, httpTimeoutMs: 0 }),
    ).rejects.toThrow("HTTP route readiness timed out");

    expect(replaceHostRoutesForRepo).toHaveBeenCalledTimes(2);
    expect(replaceHostRoutesForRepo).toHaveBeenLastCalledWith(tmpDir, []);
  });
});
