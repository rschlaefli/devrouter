import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteOwnedDevpodWorkspace } from "../devpod-mutation";
import { listDevpodWorkspaces } from "../devpod-workspaces";
import { listHostRouteState } from "../host-routes";
import { removeWorkspaceRoutesForWorktree } from "../route-state";
import { applyWorkspaceGc, inspectWorkspaceGc } from "../workspace-gc";
import {
  inspectWorkspaceOwnership,
  listGitWorktrees,
  listWorkspaceOwnership,
  type WorkspaceOwnershipRecord,
  type WorkspaceOwnershipTransaction,
  withWorkspaceOwnershipTransaction,
} from "../workspace-ownership";

const ownershipMocks = vi.hoisted(() => ({
  removeIfMatches: vi.fn<(expected: unknown) => "removed" | "absent" | "changed">(() => "removed"),
}));

vi.mock("../repo-config", () => ({ resolveRepoPath: vi.fn((repo?: string) => repo ?? "/repo") }));
vi.mock("../devpod-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../devpod-workspaces")>()),
  listDevpodWorkspaces: vi.fn(() => []),
}));
vi.mock("../devpod-mutation", () => ({
  deleteOwnedDevpodWorkspace: vi.fn(() => ({ status: "absent" })),
}));
vi.mock("../host-routes", () => ({ listHostRouteState: vi.fn(() => []) }));
vi.mock("../route-state", () => ({ removeWorkspaceRoutesForWorktree: vi.fn(() => []) }));
vi.mock("../workspace-ownership", () => ({
  inspectWorkspaceOwnership: vi.fn(),
  listGitWorktrees: vi.fn(() => []),
  listWorkspaceOwnership: vi.fn(() => []),
  withWorkspaceOwnershipTransaction: vi.fn(
    (repoPath: string, operation: (transaction: WorkspaceOwnershipTransaction) => unknown) =>
      operation({
        list: () => listWorkspaceOwnership(repoPath),
        write: () => {
          throw new Error("unexpected write");
        },
        remove: () => {
          throw new Error("unexpected remove");
        },
        removeIfMatches: (expected: WorkspaceOwnershipRecord) =>
          ownershipMocks.removeIfMatches(expected),
      }),
  ),
}));

const record = {
  version: 1 as const,
  workspace: "gone",
  worktreePath: "/repo/trees/gone",
  branch: "feat/gone",
  devpodId: "gone",
  createdAt: "2026-07-15T10:00:00.000Z",
  updatedAt: "2026-07-15T10:00:00.000Z",
};

const route = {
  id: "route-gone",
  name: "web",
  host: "web.gone.localhost",
  repoPath: record.worktreePath,
  port: 3000,
  mode: "proxy" as const,
  workspace: "gone",
  createdAt: "t",
  updatedAt: "t",
};

const secondRecord = {
  ...record,
  workspace: "also-gone",
  worktreePath: "/repo/trees/also-gone",
  branch: "feat/also-gone",
  devpodId: "also-gone",
};

function workspaceGc(options: { repoPath: string; yes?: boolean }) {
  const plan = inspectWorkspaceGc(options.repoPath);
  return options.yes ? applyWorkspaceGc(plan) : plan;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withWorkspaceOwnershipTransaction).mockImplementation((repoPath, operation) =>
    operation({
      list: () => listWorkspaceOwnership(repoPath),
      write: () => {
        throw new Error("unexpected write");
      },
      remove: () => {
        throw new Error("unexpected remove");
      },
      removeIfMatches: (expected) => ownershipMocks.removeIfMatches(expected),
    }),
  );
  vi.mocked(listGitWorktrees).mockReturnValue([]);
  vi.mocked(listWorkspaceOwnership).mockReturnValue([record]);
  vi.mocked(listDevpodWorkspaces).mockReturnValue([
    { id: "gone", source: { localFolder: record.worktreePath } },
  ]);
  vi.mocked(listHostRouteState).mockReturnValue([route]);
  vi.mocked(inspectWorkspaceOwnership).mockReturnValue({
    ownerStatus: "missing",
    devpodStatus: "owned",
    worktree: undefined,
  });
  vi.mocked(removeWorkspaceRoutesForWorktree).mockReturnValue([route]);
  ownershipMocks.removeIfMatches.mockReturnValue("removed");
  vi.mocked(deleteOwnedDevpodWorkspace).mockImplementation((devpodId, worktreePath) => {
    const workspace = vi
      .mocked(listDevpodWorkspaces)()
      .find(
        (candidate) => candidate.id === devpodId && candidate.source.localFolder === worktreePath,
      );
    return workspace ? { status: "changed" } : { status: "absent" };
  });
});

describe("workspaceGc", () => {
  it("is report-only by default and returns a stable candidate/action summary", () => {
    const report = workspaceGc({ repoPath: "/repo" });

    expect(report).toMatchObject({
      repoPath: "/repo",
      mode: "dry-run",
      summary: { total: 1, eligible: 1, cleaned: 0, blocked: 0, errors: 0 },
      candidates: [
        {
          kind: "owned",
          workspace: "gone",
          worktreePath: "/repo/trees/gone",
          ownerStatus: "missing",
          eligible: true,
          actions: [
            { resource: "devpod", status: "would-delete" },
            { resource: "routes", status: "would-delete", count: 1 },
            { resource: "record", status: "would-delete" },
          ],
        },
      ],
    });
    expect(deleteOwnedDevpodWorkspace).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(ownershipMocks.removeIfMatches).not.toHaveBeenCalled();
  });

  it("holds one ownership transaction across exact DevPod, route, and record deletion", () => {
    const events: string[] = [];
    vi.mocked(withWorkspaceOwnershipTransaction).mockImplementation((repoPath, operation) => {
      events.push("lock-start");
      const result = operation({
        list: () => listWorkspaceOwnership(repoPath),
        write: () => {
          throw new Error("unexpected write");
        },
        remove: () => {
          throw new Error("unexpected remove");
        },
        removeIfMatches: (expected) => {
          events.push("record");
          return ownershipMocks.removeIfMatches(expected);
        },
      });
      events.push("lock-end");
      return result;
    });
    vi.mocked(deleteOwnedDevpodWorkspace).mockImplementation((_id, _worktreePath) => {
      events.push("devpod");
      return { status: "changed" };
    });
    vi.mocked(removeWorkspaceRoutesForWorktree).mockImplementation(() => {
      events.push("routes");
      return [route];
    });

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(events).toEqual(["lock-start", "devpod", "routes", "record", "lock-end"]);
    expect(deleteOwnedDevpodWorkspace).toHaveBeenCalledWith("gone", record.worktreePath);
    expect(report.summary).toMatchObject({ cleaned: 1, errors: 0 });
    expect(report.candidates[0].actions).toEqual([
      { resource: "devpod", status: "deleted" },
      { resource: "routes", status: "deleted", count: 1 },
      { resource: "record", status: "deleted" },
    ]);
  });

  it("deletes by the persisted DevPod id rather than assuming the workspace token", () => {
    vi.mocked(listWorkspaceOwnership).mockReturnValue([{ ...record, devpodId: "provider-id" }]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "provider-id", source: { localFolder: record.worktreePath } },
    ]);

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(deleteOwnedDevpodWorkspace).toHaveBeenCalledWith("provider-id", record.worktreePath);
    expect(report.candidates).toHaveLength(1);
  });

  it.each(["present", "locked", "conflict"] as const)("never mutates a %s owner", (ownerStatus) => {
    vi.mocked(inspectWorkspaceOwnership).mockReturnValue({
      ownerStatus,
      devpodStatus: ownerStatus === "conflict" ? "conflict" : "owned",
      worktree: undefined,
    });

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.candidates[0]).toMatchObject({ eligible: false, ownerStatus });
    expect(deleteOwnedDevpodWorkspace).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(ownershipMocks.removeIfMatches).not.toHaveBeenCalled();
  });

  it("revalidates Git ownership immediately before apply and blocks a newly locked owner", () => {
    vi.mocked(inspectWorkspaceOwnership)
      .mockReturnValueOnce({
        ownerStatus: "missing",
        devpodStatus: "owned",
        worktree: undefined,
      })
      .mockReturnValueOnce({
        ownerStatus: "locked",
        devpodStatus: "owned",
        worktree: undefined,
      });

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.summary).toMatchObject({ eligible: 0, blocked: 1, cleaned: 0 });
    expect(report.candidates[0]).toMatchObject({
      eligible: false,
      ownerStatus: "locked",
      reason: expect.stringContaining("changed before cleanup"),
    });
    expect(deleteOwnedDevpodWorkspace).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
  });

  it("does not mutate a workspace revived after the dry-run snapshot", () => {
    const refreshed = { ...record, updatedAt: "2026-07-15T11:00:00.000Z" };
    vi.mocked(listWorkspaceOwnership).mockReturnValueOnce([record]).mockReturnValue([refreshed]);
    vi.mocked(inspectWorkspaceOwnership)
      .mockReturnValueOnce({
        ownerStatus: "missing",
        devpodStatus: "owned",
        worktree: undefined,
      })
      .mockReturnValueOnce({
        ownerStatus: "present",
        devpodStatus: "owned",
        worktree: undefined,
      });

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.summary).toMatchObject({ eligible: 0, blocked: 1, cleaned: 0, errors: 0 });
    expect(report.candidates[0]).toMatchObject({
      eligible: false,
      ownerStatus: "present",
      reason: expect.stringContaining("changed before cleanup"),
    });
    expect(deleteOwnedDevpodWorkspace).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(ownershipMocks.removeIfMatches).not.toHaveBeenCalled();
  });

  it("reports a candidate-local revalidation failure and continues cleaning later candidates", () => {
    vi.mocked(listWorkspaceOwnership).mockReturnValue([record, secondRecord]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "gone", source: { localFolder: record.worktreePath } },
      { id: "also-gone", source: { localFolder: secondRecord.worktreePath } },
    ]);
    vi.mocked(listGitWorktrees)
      .mockReturnValueOnce([])
      .mockImplementationOnce(() => {
        throw new Error("git worktree state unavailable");
      })
      .mockReturnValue([]);

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.summary).toMatchObject({ cleaned: 1, errors: 1 });
    expect(report.candidates[0].actions).toEqual([
      {
        resource: "record",
        status: "failed",
        error: "Ownership revalidation failed: git worktree state unavailable",
      },
    ]);
    expect(deleteOwnedDevpodWorkspace).toHaveBeenCalledTimes(1);
    expect(deleteOwnedDevpodWorkspace).toHaveBeenCalledWith("also-gone", secondRecord.worktreePath);
  });

  it("reports transaction acquisition failure locally and continues later candidates", () => {
    vi.mocked(listWorkspaceOwnership).mockReturnValue([record, secondRecord]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "gone", source: { localFolder: record.worktreePath } },
      { id: "also-gone", source: { localFolder: secondRecord.worktreePath } },
    ]);
    vi.mocked(withWorkspaceOwnershipTransaction)
      .mockImplementationOnce(() => {
        throw new Error("ledger lock busy");
      })
      .mockImplementation((repoPath, operation) =>
        operation({
          list: () => listWorkspaceOwnership(repoPath),
          write: () => {
            throw new Error("unexpected write");
          },
          remove: () => {
            throw new Error("unexpected remove");
          },
          removeIfMatches: (expected) => ownershipMocks.removeIfMatches(expected),
        }),
      );

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.summary).toMatchObject({ cleaned: 1, errors: 1 });
    expect(report.candidates[0].actions).toEqual([
      {
        resource: "record",
        status: "failed",
        error: "Ownership transaction failed: ledger lock busy",
      },
    ]);
    expect(deleteOwnedDevpodWorkspace).toHaveBeenCalledTimes(1);
    expect(deleteOwnedDevpodWorkspace).toHaveBeenCalledWith("also-gone", secondRecord.worktreePath);
  });

  it("rechecks the machine-global DevPod source immediately before delete", () => {
    vi.mocked(deleteOwnedDevpodWorkspace).mockImplementation(() => {
      throw new Error(
        `DevPod 'gone' and worktree '${record.worktreePath}' do not have one exact owner.`,
      );
    });

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.summary.errors).toBe(1);
    expect(report.candidates[0].actions[0]).toMatchObject({
      resource: "devpod",
      status: "failed",
      error: expect.stringContaining("do not have one exact owner"),
    });
    expect(deleteOwnedDevpodWorkspace).toHaveBeenCalledWith("gone", record.worktreePath);
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(ownershipMocks.removeIfMatches).not.toHaveBeenCalled();
  });

  it("retains routes and record when DevPod deletion fails", () => {
    vi.mocked(deleteOwnedDevpodWorkspace).mockImplementation(() => {
      throw new Error("devpod delete failed for 'gone': provider failed");
    });

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.summary.errors).toBe(1);
    expect(report.candidates[0].actions[0]).toMatchObject({
      resource: "devpod",
      status: "failed",
      error: expect.stringContaining("provider failed"),
    });
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(ownershipMocks.removeIfMatches).not.toHaveBeenCalled();
  });

  it("retains the ownership record when exact route deletion fails", () => {
    vi.mocked(removeWorkspaceRoutesForWorktree).mockImplementation(() => {
      throw new Error("route state unavailable");
    });

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.summary.errors).toBe(1);
    expect(report.candidates[0].actions).toEqual([
      { resource: "devpod", status: "deleted" },
      {
        resource: "routes",
        status: "failed",
        error: "route state unavailable",
      },
    ]);
    expect(ownershipMocks.removeIfMatches).not.toHaveBeenCalled();
  });

  it("reports legacy route/DevPod evidence but never mutates it", () => {
    vi.mocked(listWorkspaceOwnership).mockReturnValue([]);

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        kind: "legacy",
        workspace: "gone",
        eligible: false,
        reason: expect.stringContaining("no ownership record"),
      }),
    );
    expect(deleteOwnedDevpodWorkspace).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
  });

  it("ignores legacy evidence owned by another repository", () => {
    vi.mocked(listWorkspaceOwnership).mockReturnValue([]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "foreign", source: { localFolder: "/other/repo/trees/foreign" } },
    ]);
    vi.mocked(listHostRouteState).mockReturnValue([
      { ...route, workspace: "foreign", repoPath: "/other/repo/trees/foreign" },
    ]);

    expect(workspaceGc({ repoPath: "/repo", yes: true }).candidates).toEqual([]);
  });

  it("never treats the primary checkout DevPod as a legacy GC candidate", () => {
    vi.mocked(listWorkspaceOwnership).mockReturnValue([]);
    vi.mocked(listGitWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", prunable: false, locked: false },
    ]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "repo", source: { localFolder: "/repo" } },
    ]);
    vi.mocked(listHostRouteState).mockReturnValue([]);

    expect(workspaceGc({ repoPath: "/repo" }).candidates).toEqual([]);
  });

  it("excludes the real primary path when GC is invoked from a linked checkout", () => {
    const linkedPath = "/repo/trees/feature";
    vi.mocked(listWorkspaceOwnership).mockReturnValue([]);
    vi.mocked(listGitWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", prunable: false, locked: false },
      { path: linkedPath, branch: "feature", prunable: false, locked: false },
    ]);
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "repo", source: { localFolder: "/repo" } },
      { id: "feature", source: { localFolder: linkedPath } },
    ]);
    vi.mocked(listHostRouteState).mockReturnValue([]);

    expect(workspaceGc({ repoPath: linkedPath }).candidates).toEqual([
      expect.objectContaining({
        kind: "legacy",
        workspace: "feature",
        worktreePath: linkedPath,
        eligible: false,
      }),
    ]);
  });
});
