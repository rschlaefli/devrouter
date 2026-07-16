import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listDevpodWorkspaces,
  runDevpodWorkspaceAction,
  selectDevpodWorkspace,
} from "../devpod-workspaces";
import { environmentStop } from "../environment-stop";
import { removeHostRoutesWhere } from "../host-routes";
import {
  isLinkedWorktree,
  resolveWorktreeWorkspace,
  withWorkspaceLifecycleLock,
} from "../workspace";
import { workspaceStop } from "../workspace-lifecycle";
import { listGitWorktrees, listWorkspaceOwnership } from "../workspace-ownership";

vi.mock("../devpod-workspaces", () => ({
  listDevpodWorkspaces: vi.fn(),
  runDevpodWorkspaceAction: vi.fn(),
  selectDevpodWorkspace: vi.fn(),
}));

vi.mock("../host-routes", () => ({
  removeHostRoutesWhere: vi.fn(() => []),
}));

vi.mock("../workspace-lifecycle", () => ({ workspaceStop: vi.fn() }));

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
  vi.mocked(listWorkspaceOwnership).mockReturnValue([]);
  vi.mocked(listGitWorktrees).mockReturnValue([]);
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
    vi.mocked(runDevpodWorkspaceAction).mockImplementation(() => events.push("stop"));

    await expect(environmentStop("/repo")).resolves.toEqual({
      kind: "primary",
      repoPath: "/repo",
      devpodId: "repo",
      stopped: true,
      freedRoutes: 1,
    });

    expect(withWorkspaceLifecycleLock).toHaveBeenCalledWith("/repo", expect.any(Function));
    expect(runDevpodWorkspaceAction).toHaveBeenCalledWith("stop", "repo");
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

    expect(runDevpodWorkspaceAction).not.toHaveBeenCalled();
    expect(removeHostRoutesWhere).toHaveBeenCalledOnce();
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
    vi.mocked(workspaceStop).mockResolvedValue({
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

    expect(workspaceStop).toHaveBeenCalledWith("feature", { quiet: true, repoPath: "/repo" });
    expect(runDevpodWorkspaceAction).not.toHaveBeenCalled();
    expect(removeHostRoutesWhere).not.toHaveBeenCalled();
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
    vi.mocked(workspaceStop).mockRejectedValue(
      new Error("ownership conflicts with live Git or DevPod evidence"),
    );

    await expect(environmentStop("/repo/trees/feature")).rejects.toThrow("ownership conflicts");

    expect(runDevpodWorkspaceAction).not.toHaveBeenCalled();
    expect(removeHostRoutesWhere).not.toHaveBeenCalled();
  });

  it("preserves routes when provider stop fails", async () => {
    const devpod = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([devpod]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(devpod);
    vi.mocked(runDevpodWorkspaceAction).mockImplementation(() => {
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

    expect(runDevpodWorkspaceAction).not.toHaveBeenCalled();
    expect(removeHostRoutesWhere).not.toHaveBeenCalled();
  });
});
