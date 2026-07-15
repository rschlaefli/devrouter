import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRouteState } from "../../types";
import { loadRuntimeConfig } from "../repo-config";
import { listRoutesForWorktreePaths, removeWorkspaceRoutesForWorktree } from "../route-state";
import { resolveWorktreeWorkspace, withWorkspaceLifecycleLock, wsFromBranch } from "../workspace";
import { listDevpodWorkspaces, workspaceEnsure } from "../workspace-ensure";
import { workspaceDown, workspaceLs, workspaceStop, workspaceUp } from "../workspace-lifecycle";
import {
  inspectWorkspaceOwnership,
  listWorkspaceOwnership,
  removeWorkspaceOwnership,
} from "../workspace-ownership";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../route-state", () => ({
  listRoutesForWorktreePaths: vi.fn(() => new Map()),
  removeWorkspaceRoutesForWorktree: vi.fn(() => []),
}));
vi.mock("../workspace-ensure", () => ({
  listDevpodWorkspaces: vi.fn(() => []),
  workspaceEnsure: vi.fn(async (repoPath: string) => ({
    repoPath,
    workspace: "feat-a",
    devpodId: "feat-a",
    urls: ["https://app.feat-a.localhost"],
  })),
}));
vi.mock("../workspace-ownership", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace-ownership")>();
  return {
    ...actual,
    inspectWorkspaceOwnership: vi.fn(() => ({
      ownerStatus: "present",
      devpodStatus: "owned",
      worktree: undefined,
    })),
    listWorkspaceOwnership: vi.fn(() => []),
    removeWorkspaceOwnership: vi.fn(() => true),
  };
});
vi.mock("../repo-config", () => ({
  loadRuntimeConfig: vi.fn(() => ({ config: { version: 1, apps: [] }, workspace: undefined })),
  resolveRepoPath: vi.fn((p?: string) => p ?? "/main/repo"),
}));
// Keep the real wsFromBranch; only stub the on-disk worktree probe (test paths
// are synthetic). Everything except the primary checkout is a linked worktree.
vi.mock("../workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace")>();
  return {
    ...actual,
    isLinkedWorktree: vi.fn((p: string) => p !== "/main/repo"),
    resolveWorktreeWorkspace: vi.fn(actual.resolveWorktreeWorkspace),
    withWorkspaceLifecycleLock: vi.fn(
      async (_repoPath: string, operation: () => Promise<unknown>) => operation(),
    ),
  };
});

const PORCELAIN = `worktree /main/repo
HEAD abc
branch refs/heads/main

worktree /main/repo-feat-a
HEAD def
branch refs/heads/feat/a

`;

const DETACHED_PORCELAIN = `worktree /main/repo
HEAD abc
branch refs/heads/main

worktree /custom/detached
HEAD def
detached

`;

const COLLIDING_PORCELAIN = `worktree /main/repo
HEAD abc
branch refs/heads/main

worktree /main/repo-feat-slash
HEAD def
branch refs/heads/feat/a

worktree /main/repo-feat-dash
HEAD ghi
branch refs/heads/feat-a

`;

const LOCKED_PORCELAIN = `worktree /main/repo
HEAD abc
branch refs/heads/main

worktree /main/repo-feat-a
HEAD def
branch refs/heads/feat/a
locked maintenance

`;

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.mocked(resolveWorktreeWorkspace).mockImplementation((_repoPath, branch) =>
    wsFromBranch(branch ?? ""),
  );
  vi.mocked(listWorkspaceOwnership).mockReturnValue([]);
  vi.mocked(listDevpodWorkspaces).mockReturnValue([]);
  vi.mocked(inspectWorkspaceOwnership).mockReturnValue({
    ownerStatus: "present",
    devpodStatus: "owned",
    worktree: undefined,
  });
  vi.mocked(removeWorkspaceOwnership).mockReturnValue(true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  vi.clearAllMocks();
});

function route(workspace: string | undefined, name: string, repoPath = "/repo"): HostRouteState {
  return {
    id: `${repoPath}::${name}-${workspace}`,
    name,
    host: `${name}.${workspace ?? "x"}.localhost`,
    repoPath,
    port: 3000,
    mode: "proxy",
    workspace,
    createdAt: "t",
    updatedAt: "t",
  };
}

function owner(workspace = "feat-a", worktreePath = "/main/repo-feat-a") {
  return {
    version: 1 as const,
    workspace,
    worktreePath,
    branch: "feat/a",
    devpodId: workspace,
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:00:00.000Z",
  };
}

describe("workspaceDown", () => {
  it("frees this repo's routes for the workspace, without loading any config", async () => {
    vi.mocked(removeWorkspaceRoutesForWorktree).mockReturnValue([
      route("feat-a", "web", "/main/repo-feat-a"),
      route("feat-a", "api", "/main/repo-feat-a"),
    ]);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      return { status: 1 } as never; // DevPod absent
    });

    const result = await workspaceDown("feat-a", { keepWorktree: true });

    expect(result.workspace).toBe("feat-a");
    expect(result.freedRoutes).toBe(2);
    expect(removeWorkspaceRoutesForWorktree).toHaveBeenCalledWith(
      "feat-a",
      "/main/repo/trees/feat-a",
    );
    // Teardown must not depend on the (possibly-deleted) worktree config.
    expect(loadRuntimeConfig).not.toHaveBeenCalled();
  });

  it("uses the persisted identity when the target is the worktree branch", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const a = (args as string[]) ?? [];
      if (a.includes("list")) return { status: 0, stdout: PORCELAIN } as never;
      return { status: 0, stdout: "" } as never;
    });
    vi.mocked(resolveWorktreeWorkspace).mockImplementation((repoPath, branch) =>
      repoPath === "/main/repo-feat-a" ? "existing-devpod" : branch,
    );

    const result = await workspaceDown("feat-a", { keepWorktree: true });

    expect(result.workspace).toBe("existing-devpod");
    expect(removeWorkspaceRoutesForWorktree).toHaveBeenCalledWith(
      "existing-devpod",
      "/main/repo-feat-a",
    );
    expect(withWorkspaceLifecycleLock).toHaveBeenCalledWith(
      "/main/repo-feat-a",
      expect.any(Function),
    );
  });

  it("cleans routes from the legacy sibling path after that worktree was removed", async () => {
    const legacyPath = "/main/repo-feat-a";
    vi.mocked(listRoutesForWorktreePaths).mockReturnValue(
      new Map([
        ["/main/repo/trees/feat-a", []],
        [legacyPath, [route("feat-a", "web", legacyPath)]],
      ]),
    );
    vi.mocked(removeWorkspaceRoutesForWorktree).mockReturnValue([
      route("feat-a", "web", legacyPath),
    ]);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      return { status: 1 } as never;
    });

    const result = await workspaceDown("feat-a", {
      keepWorktree: true,
    });

    expect(result.freedRoutes).toBe(1);
    expect(removeWorkspaceRoutesForWorktree).toHaveBeenCalledWith("feat-a", legacyPath);
  });

  it("tears down a detached custom-path worktree by persisted identity", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const a = (args as string[]) ?? [];
      if (a.includes("list")) return { status: 0, stdout: DETACHED_PORCELAIN } as never;
      return { status: 0, stdout: "" } as never;
    });
    vi.mocked(resolveWorktreeWorkspace).mockImplementation((repoPath) =>
      repoPath === "/custom/detached" ? "detached-id" : undefined,
    );

    const result = await workspaceDown("detached-id", {
      keepWorktree: true,
    });

    expect(result.workspace).toBe("detached-id");
    expect(removeWorkspaceRoutesForWorktree).toHaveBeenCalledWith(
      "detached-id",
      "/custom/detached",
    );
  });

  it("prefers an exact branch over a colliding sanitized branch", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const a = (args as string[]) ?? [];
      if (a.includes("list")) return { status: 0, stdout: COLLIDING_PORCELAIN } as never;
      return { status: 0, stdout: "" } as never;
    });

    await workspaceDown("feat-a", { keepWorktree: true });

    expect(removeWorkspaceRoutesForWorktree).toHaveBeenCalledWith("feat-a", "/main/repo-feat-dash");
  });

  it("prefers an exact live legacy branch over a colliding record token", async () => {
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner("feat-a", "/main/repo-feat-slash")]);
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const argv = (args as string[]) ?? [];
      if (argv.includes("list")) {
        return { status: 0, stdout: COLLIDING_PORCELAIN } as never;
      }
      return { status: 0, stdout: "" } as never;
    });

    await workspaceDown("feat-a", { keepWorktree: true });

    expect(removeWorkspaceRoutesForWorktree).toHaveBeenCalledWith("feat-a", "/main/repo-feat-dash");
  });

  it("rejects ambiguous derived branch identities", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const a = (args as string[]) ?? [];
      if (a.includes("list")) {
        return {
          status: 0,
          stdout: COLLIDING_PORCELAIN.replace("refs/heads/feat-a", "refs/heads/feat_a"),
        } as never;
      }
      return { status: 0, stdout: "" } as never;
    });

    await expect(workspaceDown("feat-a", { keepWorktree: true })).rejects.toThrow(
      "Workspace target 'feat-a' is ambiguous",
    );
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
  });

  it("removes the worktree by matching branch->workspace when not kept", async () => {
    vi.mocked(removeWorkspaceRoutesForWorktree).mockReturnValue([]);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      calls.push({ cmd: cmd as string, args: a });
      if (a.includes("list")) return { status: 0, stdout: PORCELAIN } as never;
      return { status: 0, stdout: "" } as never;
    });
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    await workspaceDown("feat-a", {});

    const remove = calls.find((c) => c.cmd === "git" && c.args.includes("remove"));
    expect(remove?.args).toContain("/main/repo-feat-a");
  });

  it("rejects a dirty full down before DevPod, routes, or record mutation", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner()]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "feat-a", source: { localFolder: "/main/repo-feat-a" } },
    ]);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: PORCELAIN, stderr: "" } as never;
      }
      if (command === "git" && argv.includes("status")) {
        return { status: 0, stdout: "?? scratch.txt\n", stderr: "" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(workspaceDown("feat-a")).rejects.toThrow("uncommitted changes");

    expect(spawnSync).not.toHaveBeenCalledWith(
      "devpod",
      expect.arrayContaining(["delete"]),
      expect.anything(),
    );
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(removeWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("rejects a locked full down before DevPod, routes, or record mutation", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner()]);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: LOCKED_PORCELAIN, stderr: "" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(workspaceDown("feat-a")).rejects.toThrow("is locked");
    expect(listDevpodWorkspaces).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(removeWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("deletes runtime then routes then worktree then ownership record", async () => {
    const events: string[] = [];
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner()]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "feat-a", source: { localFolder: "/main/repo-feat-a" } },
    ]);
    vi.mocked(removeWorkspaceRoutesForWorktree).mockImplementation(() => {
      events.push("routes");
      return [];
    });
    vi.mocked(removeWorkspaceOwnership).mockImplementation(() => {
      events.push("record");
      return true;
    });
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: PORCELAIN, stderr: "" } as never;
      }
      if (command === "git" && argv.includes("status")) {
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "delete") events.push("delete");
      if (command === "git" && argv.includes("remove")) events.push("worktree");
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await workspaceDown("feat-a");

    expect(events).toEqual(["delete", "routes", "worktree", "record"]);
    expect(spawnSync).toHaveBeenCalledWith(
      "devpod",
      ["delete", "feat-a", "--ignore-not-found"],
      expect.anything(),
    );
  });

  it("retains routes, worktree, and ownership when DevPod deletion fails", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner()]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "feat-a", source: { localFolder: "/main/repo-feat-a" } },
    ]);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: PORCELAIN, stderr: "" } as never;
      }
      if (command === "git" && argv.includes("status")) {
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "delete") {
        return { status: 1, stdout: "", stderr: "provider failed" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(workspaceDown("feat-a")).rejects.toThrow("devpod delete failed");

    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(removeWorkspaceOwnership).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything(),
    );
  });

  it("allows dirty resource reclaim with --keep-worktree and retains its record", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner()]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "feat-a", source: { localFolder: "/main/repo-feat-a" } },
    ]);
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);

    await workspaceDown("feat-a", { keepWorktree: true });

    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["status"]),
      expect.anything(),
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything(),
    );
    expect(removeWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("retains ownership when Git worktree removal fails", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner()]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([]);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: PORCELAIN, stderr: "" } as never;
      }
      if (command === "git" && argv.includes("status")) {
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      if (command === "git" && argv.includes("remove")) {
        return { status: 1, stdout: "", stderr: "remove failed" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(workspaceDown("feat-a")).rejects.toThrow("git worktree remove failed");
    expect(removeWorkspaceOwnership).not.toHaveBeenCalled();
  });
});

describe("workspaceStop", () => {
  it("stops the exact DevPod before freeing routes and preserves ownership", async () => {
    const events: string[] = [];
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner()]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "feat-a", source: { localFolder: "/main/repo-feat-a" } },
    ]);
    vi.mocked(removeWorkspaceRoutesForWorktree).mockImplementation(() => {
      events.push("routes");
      return [];
    });
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: PORCELAIN, stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "stop") events.push("stop");
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await workspaceStop("feat-a");

    expect(events).toEqual(["stop", "routes"]);
    expect(removeWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("retains routes when DevPod stop fails", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner()]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "feat-a", source: { localFolder: "/main/repo-feat-a" } },
    ]);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: PORCELAIN, stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "stop") {
        return { status: 1, stdout: "", stderr: "stop failed" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(workspaceStop("feat-a")).rejects.toThrow("devpod stop failed");
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
  });

  it("blocks a machine-global DevPod id that points at another worktree", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(listWorkspaceOwnership).mockReturnValue([owner()]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "feat-a", source: { localFolder: "/another/repo/trees/feat-a" } },
    ]);
    vi.mocked(inspectWorkspaceOwnership).mockReturnValue({
      ownerStatus: "conflict",
      devpodStatus: "conflict",
      worktree: undefined,
    });
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "git" && argv.includes("list")) {
        return { status: 0, stdout: PORCELAIN, stderr: "" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(workspaceStop("feat-a")).rejects.toThrow("ownership conflicts");
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
  });
});

describe("workspaceLs", () => {
  it("joins worktrees with their workspace token and route counts by worktree path", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: PORCELAIN } as never);
    vi.mocked(listRoutesForWorktreePaths).mockReturnValue(
      new Map([
        ["/main/repo", []],
        [
          "/main/repo-feat-a",
          [
            route("feat-a", "web", "/main/repo-feat-a"),
            route("feat-a", "api", "/main/repo-feat-a"),
          ],
        ],
      ]),
    );

    const rows = workspaceLs();

    expect(listRoutesForWorktreePaths).toHaveBeenCalledWith(["/main/repo", "/main/repo-feat-a"]);
    expect(rows).toHaveLength(2);
    expect(rows[0].workspace).toBeUndefined(); // primary checkout
    expect(rows[0].branch).toBe("main");
    expect(rows[0].routeCount).toBe(0);
    expect(rows[1].workspace).toBe("feat-a");
    expect(rows[1].routeCount).toBe(2);
  });

  it("reports a persisted identity instead of re-deriving it from the branch", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: PORCELAIN } as never);
    vi.mocked(resolveWorktreeWorkspace).mockImplementation((repoPath, branch) =>
      repoPath === "/main/repo-feat-a" ? "existing-devpod" : branch,
    );

    const rows = workspaceLs();

    expect(rows[1].workspace).toBe("existing-devpod");
    expect(resolveWorktreeWorkspace).toHaveBeenCalledWith("/main/repo-feat-a", "feat/a");
  });

  it("reports a detached worktree's persisted identity", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: DETACHED_PORCELAIN } as never);
    vi.mocked(resolveWorktreeWorkspace).mockImplementation((repoPath) =>
      repoPath === "/custom/detached" ? "detached-id" : undefined,
    );

    const rows = workspaceLs();

    expect(rows[1]).toMatchObject({
      workspace: "detached-id",
      branch: undefined,
      worktreePath: "/custom/detached",
    });
  });

  it("includes a durable owner immediately after its worktree goes missing", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: PORCELAIN } as never);
    vi.mocked(inspectWorkspaceOwnership).mockReturnValue({
      ownerStatus: "missing",
      devpodStatus: "absent",
      worktree: undefined,
    });
    vi.mocked(listWorkspaceOwnership).mockReturnValue([
      {
        version: 1,
        workspace: "gone",
        worktreePath: "/main/repo/trees/gone",
        branch: "feat/gone",
        devpodId: "gone",
        createdAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:00:00.000Z",
      },
    ]);

    expect(workspaceLs()).toContainEqual(
      expect.objectContaining({
        workspace: "gone",
        worktreePath: "/main/repo/trees/gone",
        ownerStatus: "missing",
      }),
    );
  });
});

describe("workspaceUp", () => {
  it("creates the worktree and delegates blocking startup to workspace ensure", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      calls.push({ cmd: cmd as string, args: a });
      return { status: 0, stdout: "" } as never;
    });

    await workspaceUp("feat/a", {});

    expect(calls.some((call) => call.cmd === "git" && call.args.includes("add"))).toBe(true);
    expect(workspaceEnsure).toHaveBeenCalledWith("/main/repo/trees/feat-a", { open: undefined });
  });

  it("refuses the default repository-local path when trees is not ignored", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const argv = (args as string[]) ?? [];
      if (cmd === "git" && argv.includes("check-ignore")) {
        return { status: 1, stdout: "" } as never;
      }
      return { status: 0, stdout: "" } as never;
    });

    await expect(workspaceUp("feat/a", {})).rejects.toThrow(
      "Add 'trees/' to '/main/repo/.gitignore' or use --path",
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "add"]),
      expect.anything(),
    );
    expect(workspaceEnsure).not.toHaveBeenCalled();
  });

  it("rejects an existing path that is not the requested registered worktree", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const argv = (args as string[]) ?? [];
      if (cmd === "git" && argv.includes("list")) {
        return { status: 0, stdout: PORCELAIN } as never;
      }
      return { status: 0, stdout: "" } as never;
    });

    await expect(workspaceUp("feat/a", { path: "/main/unrelated-worktree" })).rejects.toThrow(
      "is not a linked worktree of '/main/repo'",
    );
    expect(workspaceEnsure).not.toHaveBeenCalled();
  });

  it("rejects an existing worktree on a different branch", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const argv = (args as string[]) ?? [];
      if (cmd === "git" && argv.includes("list")) {
        return { status: 0, stdout: PORCELAIN } as never;
      }
      return { status: 0, stdout: "" } as never;
    });

    await expect(workspaceUp("other", { path: "/main/repo-feat-a" })).rejects.toThrow(
      "uses branch 'feat/a', not 'other'",
    );
    expect(workspaceEnsure).not.toHaveBeenCalled();
  });

  it("makes --no-devpod create-only and never registers routes", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.mocked(spawnSync).mockImplementation(() => {
      return { status: 0, stdout: "" } as never;
    });

    await workspaceUp("feat/a", { noDevpod: true });

    expect(workspaceEnsure).not.toHaveBeenCalled();
  });
});
