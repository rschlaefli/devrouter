import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { workspaceDown, workspaceLs, workspaceUp } from "../workspace-lifecycle";
import { listHostRouteState, removeHostRouteById } from "../host-routes";
import { loadRuntimeConfig } from "../repo-config";
import { runConfiguredApp } from "../app-run";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../host-routes", () => ({
  listHostRouteState: vi.fn(() => []),
  removeHostRouteById: vi.fn()
}));
vi.mock("../app-run", () => ({ runConfiguredApp: vi.fn(async () => ({})) }));
vi.mock("../repo-config", () => ({
  loadRuntimeConfig: vi.fn(() => ({ config: { version: 1, apps: [] }, workspace: undefined })),
  resolveRepoPath: vi.fn((p?: string) => p ?? "/main/repo")
}));

const PORCELAIN = `worktree /main/repo
HEAD abc
branch refs/heads/main

worktree /main/repo-feat-a
HEAD def
branch refs/heads/feat/a

`;

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  vi.clearAllMocks();
});

function route(workspace: string | undefined, name: string) {
  return {
    id: `/repo::${name}-${workspace}`,
    name,
    host: `${name}.${workspace ?? "x"}.localhost`,
    repoPath: "/repo",
    port: 3000,
    mode: "proxy" as const,
    workspace,
    createdAt: "t",
    updatedAt: "t"
  };
}

describe("workspaceDown", () => {
  it("frees only routes tagged with the workspace, without loading any config", () => {
    vi.mocked(listHostRouteState).mockReturnValue([
      route("feat-a", "web"),
      route("feat-a", "api"),
      route("feat-b", "web"),
      route(undefined, "web")
    ]);
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as never); // devpod absent, no git

    const result = workspaceDown("feat/a", { keepWorktree: true, keepDevpod: true });

    expect(result.workspace).toBe("feat-a");
    expect(result.freedRoutes).toBe(2);
    expect(removeHostRouteById).toHaveBeenCalledTimes(2);
    expect(removeHostRouteById).toHaveBeenCalledWith("/repo::web-feat-a");
    expect(removeHostRouteById).toHaveBeenCalledWith("/repo::api-feat-a");
    // Teardown must not depend on the (possibly-deleted) worktree config.
    expect(loadRuntimeConfig).not.toHaveBeenCalled();
  });

  it("removes the worktree by matching branch->workspace when not kept", () => {
    vi.mocked(listHostRouteState).mockReturnValue([]);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      calls.push({ cmd: cmd as string, args: a });
      if (cmd === "devpod") return { status: 1 } as never; // devpod absent
      if (a.includes("list")) return { status: 0, stdout: PORCELAIN } as never;
      return { status: 0, stdout: "" } as never;
    });
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    workspaceDown("feat-a", {});

    const remove = calls.find((c) => c.cmd === "git" && c.args.includes("remove"));
    expect(remove?.args).toContain("/main/repo-feat-a");
  });
});

describe("workspaceLs", () => {
  it("joins worktrees with their workspace token and route counts", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: PORCELAIN } as never);
    vi.mocked(listHostRouteState).mockReturnValue([route("feat-a", "web"), route("feat-a", "api")]);

    const rows = workspaceLs();

    expect(rows).toHaveLength(2);
    expect(rows[0].workspace).toBeUndefined(); // primary checkout
    expect(rows[0].branch).toBe("main");
    expect(rows[1].workspace).toBe("feat-a");
    expect(rows[1].routeCount).toBe(2);
  });
});

describe("workspaceUp", () => {
  it("names the devpod workspace with the resolved token (R5) and registers routes", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    vi.mocked(spawnSync).mockImplementation((cmd, args, opts) => {
      const a = (args as string[]) ?? [];
      calls.push({ cmd: cmd as string, args: a, env: (opts as { env?: NodeJS.ProcessEnv })?.env });
      return { status: 0, stdout: "" } as never; // git add ok, devpod version+up ok
    });
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      workspace: "feat-a",
      config: {
        version: 1,
        apps: [
          {
            name: "app",
            host: "app.feat-a.localhost",
            protocol: "http",
            runtime: "proxy",
            dependencies: [],
            upstream: "feat-a-app:3000"
          } as never
        ]
      }
    });

    await workspaceUp("feat/a", {});

    const devpodUp = calls.find((c) => c.cmd === "devpod" && c.args[0] === "up");
    expect(devpodUp?.args).toEqual(["up", "/main/repo-feat-a", "--name", "feat-a"]);
    // WORKSPACE in the env is what drives the compose ${WORKSPACE} alias substitution.
    expect(devpodUp?.env?.WORKSPACE).toBe("feat-a");
    expect(runConfiguredApp).toHaveBeenCalledWith(
      expect.objectContaining({ name: "app", repoPath: "/main/repo-feat-a", yes: true })
    );
  });
});
