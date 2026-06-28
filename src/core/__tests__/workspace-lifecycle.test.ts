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
// Keep the real wsFromBranch; only stub the on-disk worktree probe (test paths
// are synthetic). Everything except the primary checkout is a linked worktree.
vi.mock("../workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace")>();
  return { ...actual, isLinkedWorktree: vi.fn((p: string) => p !== "/main/repo") };
});

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

function route(workspace: string | undefined, name: string, repoPath = "/repo") {
  return {
    id: `${repoPath}::${name}-${workspace}`,
    name,
    host: `${name}.${workspace ?? "x"}.localhost`,
    repoPath,
    port: 3000,
    mode: "proxy" as const,
    workspace,
    createdAt: "t",
    updatedAt: "t"
  };
}

describe("workspaceDown", () => {
  it("frees only this repo's routes for the workspace, without loading any config", () => {
    // feat-a routes live under this repo's worktree; a same-named workspace in
    // another repo (/other-feat-a) must be left untouched.
    vi.mocked(listHostRouteState).mockReturnValue([
      route("feat-a", "web", "/main/repo-feat-a"),
      route("feat-a", "api", "/main/repo-feat-a"),
      route("feat-a", "web", "/other-feat-a"),
      route("feat-b", "web", "/main/repo-feat-b"),
      route(undefined, "web", "/main/repo")
    ]);
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as never); // devpod absent, no git

    const result = workspaceDown("feat/a", { keepWorktree: true, keepDevpod: true });

    expect(result.workspace).toBe("feat-a");
    expect(result.freedRoutes).toBe(2);
    expect(removeHostRouteById).toHaveBeenCalledTimes(2);
    expect(removeHostRouteById).toHaveBeenCalledWith("/main/repo-feat-a::web-feat-a");
    expect(removeHostRouteById).toHaveBeenCalledWith("/main/repo-feat-a::api-feat-a");
    // A different repo's same-named workspace is never torn down.
    expect(removeHostRouteById).not.toHaveBeenCalledWith("/other-feat-a::web-feat-a");
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

  it("frees routes when git reports a realpath for a symlinked worktree path", () => {
    vi.mocked(listHostRouteState).mockReturnValue([
      route("feat-a", "web", "/tmp/repo-feat-a")
    ]);
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (cmd === "git" && a.includes("list")) {
        return {
          status: 0,
          stdout: `worktree /main/repo
HEAD abc
branch refs/heads/main

worktree /private/tmp/repo-feat-a
HEAD def
branch refs/heads/feat/a

`
        } as never;
      }
      return { status: 1 } as never;
    });
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation((p) => {
      const key = String(p);
      if (key === "/tmp/repo-feat-a" || key === "/private/tmp/repo-feat-a") {
        return "/private/tmp/repo-feat-a";
      }
      return key;
    });

    try {
      const result = workspaceDown("feat-a", { keepWorktree: true, keepDevpod: true });

      expect(result.freedRoutes).toBe(1);
      expect(removeHostRouteById).toHaveBeenCalledWith("/tmp/repo-feat-a::web-feat-a");
    } finally {
      realpath.mockRestore();
    }
  });
});

describe("workspaceLs", () => {
  it("joins worktrees with their workspace token and route counts by worktree path", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: PORCELAIN } as never);
    vi.mocked(listHostRouteState).mockReturnValue([
      route("feat-a", "web", "/main/repo-feat-a"),
      route("feat-a", "api", "/main/repo-feat-a"),
      // A different repo's untagged route must not inflate the primary row.
      route(undefined, "web", "/other/repo")
    ]);

    const rows = workspaceLs();

    expect(rows).toHaveLength(2);
    expect(rows[0].workspace).toBeUndefined(); // primary checkout
    expect(rows[0].branch).toBe("main");
    expect(rows[0].routeCount).toBe(0); // no route under /main/repo, ignores /other/repo
    expect(rows[1].workspace).toBe("feat-a");
    expect(rows[1].routeCount).toBe(2);
  });

  it("counts routes when worktree and route paths use /private/tmp and /tmp aliases", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: `worktree /private/tmp/repo
HEAD abc
branch refs/heads/main

worktree /private/tmp/repo-feat-a
HEAD def
branch refs/heads/feat/a

`
    } as never);
    vi.mocked(listHostRouteState).mockReturnValue([
      route("feat-a", "web", "/tmp/repo-feat-a")
    ]);
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation((p) => {
      const key = String(p);
      if (key === "/tmp/repo-feat-a" || key === "/private/tmp/repo-feat-a") {
        return "/private/tmp/repo-feat-a";
      }
      if (key === "/private/tmp/repo") {
        return "/private/tmp/repo";
      }
      return key;
    });

    try {
      const rows = workspaceLs("/private/tmp/repo");

      expect(rows[1].workspace).toBe("feat-a");
      expect(rows[1].routeCount).toBe(1);
    } finally {
      realpath.mockRestore();
    }
  });
});

describe("workspaceUp", () => {
  it("sets the devpod workspace id with the resolved token (R5) and registers routes", async () => {
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
    expect(devpodUp?.args).toEqual(["up", "/main/repo-feat-a", "--id", "feat-a", "--open-ide=false"]);
    // WORKSPACE in the env is what drives the compose ${WORKSPACE} alias substitution.
    expect(devpodUp?.env?.WORKSPACE).toBe("feat-a");
    // The resolved token is threaded explicitly so route tag == devpod id.
    expect(loadRuntimeConfig).toHaveBeenCalledWith("/main/repo-feat-a", "feat-a");
    expect(runConfiguredApp).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "app",
        repoPath: "/main/repo-feat-a",
        workspace: "feat-a",
        yes: true
      })
    );
  });

  it("opens registered HTTP routes when --open is requested", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      calls.push({ cmd: cmd as string, args: a });
      return { status: 0, stdout: "" } as never;
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
          } as never,
          {
            name: "db",
            host: "db.feat-a.localhost",
            protocol: "tcp",
            tcpProtocol: "postgres",
            runtime: "proxy",
            dependencies: [],
            upstream: "feat-a-db:5432"
          } as never
        ]
      }
    });

    await workspaceUp("feat/a", { noDevpod: true, open: true });

    const opened = calls.filter((c) => c.cmd === "open");
    expect(opened).toEqual([{ cmd: "open", args: ["https://app.feat-a.localhost"] }]);
    expect(runConfiguredApp).toHaveBeenCalledTimes(2);
  });
});
