import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listDevpodWorkspaces,
  mutateOwnedDevpodWorkspace,
  selectDevpodWorkspace,
} from "../devpod-workspaces";
import { environmentStop } from "../environment-stop";
import { removeHostRoutesWhere } from "../host-routes";
import {
  isLinkedWorktree,
  resolveWorktreeWorkspace,
  withWorkspaceLifecycleLock,
} from "../workspace";
import { workspaceDeleteOwnedPath, workspaceStopOwnedPath } from "../workspace-lifecycle";
import { listGitWorktrees, listWorkspaceOwnership } from "../workspace-ownership";

vi.mock("../devpod-workspaces", () => ({
  listDevpodWorkspaces: vi.fn(),
  mutateOwnedDevpodWorkspace: vi.fn(),
  selectDevpodWorkspace: vi.fn(),
}));

vi.mock("../host-routes", () => ({
  removeHostRoutesWhere: vi.fn(() => []),
}));

vi.mock("../workspace-lifecycle", () => ({
  workspaceDeleteOwnedPath: vi.fn(),
  workspaceStopOwnedPath: vi.fn(),
}));

vi.mock("../workspace-ownership", () => ({
  listGitWorktrees: vi.fn(),
  listWorkspaceOwnership: vi.fn(),
}));

vi.mock("../workspace", () => ({
  isLinkedWorktree: vi.fn(() => false),
  resolveWorktreeWorkspace: vi.fn(),
  sameWorkspacePath: (left: string, right: string) => left === right,
  withWorkspaceLifecycleLock: vi.fn(async (_path: string, operation: () => Promise<unknown>) =>
    operation(),
  ),
}));

beforeEach(() => {
  vi.mocked(isLinkedWorktree).mockReturnValue(false);
  vi.mocked(resolveWorktreeWorkspace).mockReturnValue(undefined);
  vi.mocked(listWorkspaceOwnership).mockReturnValue([]);
  vi.mocked(listGitWorktrees).mockReturnValue([]);
  vi.mocked(removeHostRoutesWhere).mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("environmentStop", () => {
  it("stops the exact primary DevPod before atomically removing its routes", async () => {
    const events: string[] = [];
    const devpod = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([devpod]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(devpod);
    vi.mocked(removeHostRoutesWhere).mockImplementation((predicate) => {
      const routes = [
        { id: "route", name: "web", host: "web.localhost", repoPath: "/repo" } as never,
        { id: "other", name: "other", host: "other.localhost", repoPath: "/other" } as never,
      ];
      const removed = routes.filter(predicate);
      events.push("routes");
      return removed;
    });
    vi.mocked(mutateOwnedDevpodWorkspace).mockImplementation(() => {
      events.push("stop");
      return { status: "changed" };
    });

    await expect(environmentStop("/repo")).resolves.toEqual({
      kind: "primary",
      repoPath: "/repo",
      devpodId: "repo",
      stopped: true,
      freedRoutes: 1,
    });

    expect(withWorkspaceLifecycleLock).toHaveBeenCalledWith("/repo", expect.any(Function));
    expect(mutateOwnedDevpodWorkspace).toHaveBeenCalledWith("stop", "repo", "/repo");
    expect(removeHostRoutesWhere).toHaveBeenCalledOnce();
    expect(events).toEqual(["stop", "routes"]);
  });

  it("returns linked identity and never deletes a DevPod", async () => {
    vi.mocked(isLinkedWorktree).mockReturnValue(true);
    vi.mocked(resolveWorktreeWorkspace).mockReturnValue("feature");
    vi.mocked(listDevpodWorkspaces).mockReturnValue([]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(undefined);

    await expect(environmentStop("/repo/trees/feature")).resolves.toEqual({
      kind: "linked",
      repoPath: "/repo/trees/feature",
      workspace: "feature",
      stopped: false,
      freedRoutes: 0,
    });

    expect(mutateOwnedDevpodWorkspace).not.toHaveBeenCalled();
    expect(removeHostRoutesWhere).toHaveBeenCalledOnce();
  });

  it("does not report a stale pre-lock DevPod as stopped", async () => {
    const devpod = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([devpod]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(devpod);
    vi.mocked(mutateOwnedDevpodWorkspace).mockReturnValue({ status: "absent" });

    await expect(environmentStop("/repo")).resolves.toEqual({
      kind: "primary",
      repoPath: "/repo",
      stopped: false,
      freedRoutes: 0,
    });
  });

  it("deletes only the exact primary DevPod when explicitly requested", async () => {
    const devpod = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([devpod]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(devpod);
    vi.mocked(mutateOwnedDevpodWorkspace).mockReturnValue({ status: "changed" });

    await expect(environmentStop("/repo", { delete: true })).resolves.toEqual({
      kind: "primary",
      repoPath: "/repo",
      devpodId: "repo",
      stopped: false,
      deleted: true,
      freedRoutes: 0,
    });

    expect(mutateOwnedDevpodWorkspace).toHaveBeenCalledWith("delete", "repo", "/repo");
  });

  it("delegates ledger-owned linked checkouts to the fail-closed workspace lifecycle", async () => {
    vi.mocked(isLinkedWorktree).mockReturnValue(true);
    vi.mocked(resolveWorktreeWorkspace).mockReturnValue("feature");
    vi.mocked(listWorkspaceOwnership).mockReturnValue([
      {
        version: 1,
        workspace: "feature",
        worktreePath: "/repo/trees/feature",
        branch: "feat/feature",
        devpodId: "feature",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
    ]);
    vi.mocked(listGitWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", locked: false, prunable: false },
      {
        path: "/repo/trees/feature",
        branch: "feat/feature",
        locked: false,
        prunable: false,
      },
    ]);
    vi.mocked(workspaceStopOwnedPath).mockResolvedValue({
      devpodId: "feature",
      freedRoutes: 1,
      providerChanged: true,
      workspace: "feature",
    });

    await expect(environmentStop("/repo/trees/feature")).resolves.toEqual({
      kind: "linked",
      repoPath: "/repo/trees/feature",
      workspace: "feature",
      devpodId: "feature",
      stopped: true,
      freedRoutes: 1,
    });

    expect(workspaceStopOwnedPath).toHaveBeenCalledWith("/repo/trees/feature", {
      quiet: true,
      repoPath: "/repo",
    });
    expect(mutateOwnedDevpodWorkspace).not.toHaveBeenCalled();
    expect(removeHostRoutesWhere).not.toHaveBeenCalled();
  });

  it("delegates explicit linked deletion without removing its worktree", async () => {
    vi.mocked(isLinkedWorktree).mockReturnValue(true);
    vi.mocked(resolveWorktreeWorkspace).mockReturnValue("feature");
    vi.mocked(listWorkspaceOwnership).mockReturnValue([
      {
        version: 1,
        workspace: "feature",
        worktreePath: "/repo/trees/feature",
        branch: "feat/feature",
        devpodId: "feature",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
    ]);
    vi.mocked(listGitWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", locked: false, prunable: false },
    ]);
    vi.mocked(workspaceDeleteOwnedPath).mockResolvedValue({
      devpodId: "feature",
      freedRoutes: 1,
      providerChanged: true,
      workspace: "feature",
    });

    await expect(environmentStop("/repo/trees/feature", { delete: true })).resolves.toEqual({
      kind: "linked",
      repoPath: "/repo/trees/feature",
      workspace: "feature",
      devpodId: "feature",
      stopped: false,
      deleted: true,
      freedRoutes: 1,
    });

    expect(workspaceDeleteOwnedPath).toHaveBeenCalledWith("/repo/trees/feature", {
      quiet: true,
      repoPath: "/repo",
    });
    expect(workspaceStopOwnedPath).not.toHaveBeenCalled();
  });

  it("preserves resources when ledger-backed ownership validation fails", async () => {
    vi.mocked(isLinkedWorktree).mockReturnValue(true);
    vi.mocked(resolveWorktreeWorkspace).mockReturnValue("feature");
    vi.mocked(listWorkspaceOwnership).mockReturnValue([
      {
        version: 1,
        workspace: "feature",
        worktreePath: "/repo/trees/feature",
        branch: "feat/feature",
        devpodId: "recorded-id",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
    ]);
    vi.mocked(listGitWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", locked: false, prunable: false },
    ]);
    vi.mocked(workspaceStopOwnedPath).mockRejectedValue(
      new Error("ownership conflicts with live Git or DevPod evidence"),
    );

    await expect(environmentStop("/repo/trees/feature")).rejects.toThrow("ownership conflicts");

    expect(mutateOwnedDevpodWorkspace).not.toHaveBeenCalled();
    expect(removeHostRoutesWhere).not.toHaveBeenCalled();
  });

  it("preserves routes when provider stop fails", async () => {
    const devpod = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([devpod]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(devpod);
    vi.mocked(mutateOwnedDevpodWorkspace).mockImplementation(() => {
      throw new Error("provider failed");
    });

    await expect(environmentStop("/repo")).rejects.toThrow("provider failed");

    expect(removeHostRoutesWhere).not.toHaveBeenCalled();
  });

  it("fails closed when multiple DevPods claim the exact path", async () => {
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "one", source: { localFolder: "/repo" } },
      { id: "two", source: { localFolder: "/repo" } },
    ]);
    vi.mocked(selectDevpodWorkspace).mockImplementation(() => {
      throw new Error("Multiple DevPod workspaces reference '/repo'");
    });

    await expect(environmentStop("/repo")).rejects.toThrow("Multiple DevPod workspaces");

    expect(mutateOwnedDevpodWorkspace).not.toHaveBeenCalled();
    expect(removeHostRoutesWhere).not.toHaveBeenCalled();
  });
});
