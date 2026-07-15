import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listHostRouteState } from "../host-routes";
import { removeWorkspaceRoutesForWorktree } from "../route-state";
import { listDevpodWorkspaces } from "../workspace-ensure";
import { workspaceGc } from "../workspace-gc";
import {
  inspectWorkspaceOwnership,
  listGitWorktrees,
  listWorkspaceOwnership,
  removeWorkspaceOwnershipIfMatches,
} from "../workspace-ownership";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../repo-config", () => ({ resolveRepoPath: vi.fn((repo?: string) => repo ?? "/repo") }));
vi.mock("../workspace-ensure", () => ({ listDevpodWorkspaces: vi.fn(() => []) }));
vi.mock("../host-routes", () => ({ listHostRouteState: vi.fn(() => []) }));
vi.mock("../route-state", () => ({ removeWorkspaceRoutesForWorktree: vi.fn(() => []) }));
vi.mock("../workspace-ownership", () => ({
  inspectWorkspaceOwnership: vi.fn(),
  listGitWorktrees: vi.fn(() => []),
  listWorkspaceOwnership: vi.fn(() => []),
  removeWorkspaceOwnershipIfMatches: vi.fn(() => "removed"),
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

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.mocked(removeWorkspaceOwnershipIfMatches).mockReturnValue("removed");
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
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
    expect(spawnSync).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(removeWorkspaceOwnershipIfMatches).not.toHaveBeenCalled();
  });

  it("deletes exact eligible resources in DevPod, routes, record order with --yes", () => {
    const events: string[] = [];
    vi.mocked(spawnSync).mockImplementation(() => {
      events.push("devpod");
      return { status: 0, stdout: "", stderr: "" } as never;
    });
    vi.mocked(removeWorkspaceRoutesForWorktree).mockImplementation(() => {
      events.push("routes");
      return [route];
    });
    vi.mocked(removeWorkspaceOwnershipIfMatches).mockImplementation(() => {
      events.push("record");
      return "removed";
    });

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(events).toEqual(["devpod", "routes", "record"]);
    expect(spawnSync).toHaveBeenCalledWith(
      "devpod",
      ["delete", "gone", "--ignore-not-found"],
      expect.anything(),
    );
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

    expect(spawnSync).toHaveBeenCalledWith(
      "devpod",
      ["delete", "provider-id", "--ignore-not-found"],
      expect.anything(),
    );
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
    expect(spawnSync).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(removeWorkspaceOwnershipIfMatches).not.toHaveBeenCalled();
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
    expect(spawnSync).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
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
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      "devpod",
      ["delete", "also-gone", "--ignore-not-found"],
      expect.anything(),
    );
  });

  it("rechecks the machine-global DevPod source immediately before delete", () => {
    const exact = [{ id: "gone", source: { localFolder: record.worktreePath } }];
    vi.mocked(listDevpodWorkspaces)
      .mockReturnValueOnce(exact)
      .mockReturnValueOnce(exact)
      .mockReturnValueOnce([{ id: "gone", source: { localFolder: "/other/repo/trees/gone" } }]);

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.summary.errors).toBe(1);
    expect(report.candidates[0].actions[0]).toMatchObject({
      resource: "devpod",
      status: "failed",
      error: expect.stringContaining("changed owner"),
    });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(removeWorkspaceOwnershipIfMatches).not.toHaveBeenCalled();
  });

  it("retains routes and record when DevPod deletion fails", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "provider failed",
    } as never);

    const report = workspaceGc({ repoPath: "/repo", yes: true });

    expect(report.summary.errors).toBe(1);
    expect(report.candidates[0].actions[0]).toMatchObject({
      resource: "devpod",
      status: "failed",
      error: expect.stringContaining("provider failed"),
    });
    expect(removeWorkspaceRoutesForWorktree).not.toHaveBeenCalled();
    expect(removeWorkspaceOwnershipIfMatches).not.toHaveBeenCalled();
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
    expect(removeWorkspaceOwnershipIfMatches).not.toHaveBeenCalled();
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
    expect(spawnSync).not.toHaveBeenCalled();
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
});
