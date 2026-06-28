import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRouteState } from "../../types";
import {
  evictOrphanedWorkspaceProxyRoutes,
  evictStaleProcessRoutes,
  findOrphanedWorkspaceProxyRoutes,
  findStaleProcessRoutes,
  listRoutesForWorktreePath,
  listRoutesForWorktreePaths,
  removeRouteForApp,
  removeWorkspaceRoutesForWorktree,
  reconcileRouteRunConflict
} from "../route-state";

const mockListHostRouteState = vi.fn<() => HostRouteState[]>(() => []);
const mockIsPidRunning = vi.fn<(pid: number | undefined) => boolean>(() => false);
const mockRemoveHostRoutesWhere = vi.fn<(predicate: (route: HostRouteState) => boolean) => HostRouteState[]>(
  (predicate) => mockListHostRouteState().filter(predicate)
);

vi.mock("../host-routes", () => ({
  listHostRouteState: (...args: unknown[]) => mockListHostRouteState(...(args as [])),
  removeHostRoutesWhere: (...args: unknown[]) =>
    mockRemoveHostRoutesWhere(...(args as [(route: HostRouteState) => boolean])),
  isPidRunning: (...args: unknown[]) => mockIsPidRunning(...(args as [number | undefined])),
  buildHostRouteId: (repoPath: string, name: string) => `${repoPath}::${name}`
}));

function route(overrides: Partial<HostRouteState> = {}): HostRouteState {
  return {
    id: "/repo::web",
    name: "web",
    host: "web.localhost",
    protocol: "http",
    repoPath: "/repo",
    port: 3000,
    mode: "run",
    pid: 12345,
    createdAt: "t",
    updatedAt: "t",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("process route state", () => {
  it("finds and evicts dead process routes", () => {
    mockListHostRouteState.mockReturnValue([
      route({ id: "/repo::web", pid: 111 }),
      route({ id: "/repo::api", name: "api", host: "api.localhost", pid: 222 })
    ]);
    mockIsPidRunning.mockReturnValue(false);

    expect(findStaleProcessRoutes().map((entry) => entry.id)).toEqual(["/repo::web", "/repo::api"]);
    expect(evictStaleProcessRoutes()).toBe(2);
    expect(mockRemoveHostRoutesWhere).toHaveBeenCalledTimes(1);
  });

  it("keeps live process routes and proxy routes", () => {
    mockListHostRouteState.mockReturnValue([
      route({ id: "/repo::web", pid: 111 }),
      route({
        id: "/repo::proxy",
        name: "proxy",
        host: "proxy.localhost",
        mode: "proxy",
        pid: undefined,
        upstreamHost: "host.docker.internal"
      })
    ]);
    mockIsPidRunning.mockReturnValue(true);

    expect(findStaleProcessRoutes()).toEqual([]);
    expect(evictStaleProcessRoutes()).toBe(0);
    expect(mockRemoveHostRoutesWhere).toHaveBeenCalledTimes(1);
  });

  it("evicts stale app and hostname conflicts before reporting blockers", () => {
    mockListHostRouteState.mockReturnValue([
      route({ id: "/repo::web", pid: 111 }),
      route({ id: "/other::api", name: "api", repoPath: "/other", pid: 222 })
    ]);
    mockIsPidRunning.mockReturnValue(false);

    expect(reconcileRouteRunConflict("/repo", { name: "web", host: "web.localhost" })).toBeUndefined();
    expect(mockRemoveHostRoutesWhere).toHaveBeenCalledTimes(2);
    const removedIds = mockRemoveHostRoutesWhere.mock.results.map((result) =>
      (result.value as HostRouteState[]).map((entry) => entry.id)
    );
    expect(removedIds).toEqual([
      ["/repo::web"],
      ["/other::api"]
    ]);
  });

  it("does not evict a fresh route that replaced a stale snapshot with the same id", () => {
    const staleSnapshot = route({ id: "/repo::web", pid: 111 });
    const freshRoute = route({ id: "/repo::web", pid: 222 });
    mockListHostRouteState.mockReturnValueOnce([staleSnapshot]).mockReturnValue([freshRoute]);
    mockIsPidRunning.mockImplementation((pid) => pid === 222);

    const conflict = reconcileRouteRunConflict("/repo", { name: "web", host: "web.localhost" });

    expect(conflict?.kind).toBe("same-app");
    expect(conflict?.route.pid).toBe(222);
    expect(mockRemoveHostRoutesWhere.mock.results[0].value).toEqual([]);
  });

  it("reports live proxy hostname conflicts without PID eviction", () => {
    mockListHostRouteState.mockReturnValue([
      route({
        id: "/other::proxy",
        name: "proxy",
        repoPath: "/other",
        mode: "proxy",
        pid: undefined
      })
    ]);

    const conflict = reconcileRouteRunConflict("/repo", { name: "web", host: "web.localhost" });

    expect(conflict?.kind).toBe("hostname");
    expect(conflict?.route.name).toBe("proxy");
    expect(mockRemoveHostRoutesWhere).not.toHaveBeenCalled();
  });

  it("matches same-app conflicts through /tmp and /private/tmp aliases", () => {
    mockListHostRouteState.mockReturnValue([
      route({ id: "/tmp/repo::web", repoPath: "/tmp/repo", host: "old.localhost", pid: 111 })
    ]);
    mockIsPidRunning.mockReturnValue(true);
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => {
      const key = String(value);
      if (key === "/tmp/repo" || key === "/private/tmp/repo") {
        return "/private/tmp/repo";
      }
      return key;
    });

    try {
      const conflict = reconcileRouteRunConflict("/private/tmp/repo", {
        name: "web",
        host: "new.localhost"
      });

      expect(conflict?.kind).toBe("same-app");
      expect(conflict?.route.id).toBe("/tmp/repo::web");
    } finally {
      realpath.mockRestore();
    }
  });
});

describe("workspace route state", () => {
  it("matches worktree paths through /tmp and /private/tmp aliases", () => {
    mockListHostRouteState.mockReturnValue([
      route({ id: "/tmp/repo-feat-a::web", repoPath: "/tmp/repo-feat-a", workspace: "feat-a" })
    ]);
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => {
      const key = String(value);
      if (key === "/tmp/repo-feat-a" || key === "/private/tmp/repo-feat-a") {
        return "/private/tmp/repo-feat-a";
      }
      return key;
    });

    try {
      expect(listRoutesForWorktreePath("/private/tmp/repo-feat-a")).toHaveLength(1);
      const grouped = listRoutesForWorktreePaths(["/private/tmp/repo-feat-a"]);
      expect(grouped.get("/private/tmp/repo-feat-a")).toHaveLength(1);
    } finally {
      realpath.mockRestore();
    }
  });

  it("removes only routes for the requested workspace worktree", () => {
    mockListHostRouteState.mockReturnValue([
      route({ id: "/repo-feat-a::web", repoPath: "/repo-feat-a", workspace: "feat-a" }),
      route({ id: "/repo-feat-a::api", name: "api", repoPath: "/repo-feat-a", workspace: "feat-a" }),
      route({ id: "/other-feat-a::web", repoPath: "/other-feat-a", workspace: "feat-a" }),
      route({ id: "/repo-feat-b::web", repoPath: "/repo-feat-b", workspace: "feat-b" })
    ]);

    const removed = removeWorkspaceRoutesForWorktree("feat-a", "/repo-feat-a");

    expect(removed.map((entry) => entry.id)).toEqual(["/repo-feat-a::web", "/repo-feat-a::api"]);
    expect(mockRemoveHostRoutesWhere).toHaveBeenCalledTimes(1);
    expect(removed.map((entry) => entry.id)).not.toContain("/other-feat-a::web");
  });

  it("evicts only workspace proxy routes whose worktree no longer exists", () => {
    mockListHostRouteState.mockReturnValue([
      route({ id: "/gone::proxy", repoPath: "/gone", mode: "proxy", workspace: "gone" }),
      route({ id: "/main::proxy", repoPath: "/main", mode: "proxy", workspace: undefined }),
      route({ id: "/gone::run", repoPath: "/gone", mode: "run", workspace: "gone" })
    ]);
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((value) => String(value) !== "/gone");

    try {
      expect(findOrphanedWorkspaceProxyRoutes().map((entry) => entry.id)).toEqual(["/gone::proxy"]);
      expect(evictOrphanedWorkspaceProxyRoutes()).toBe(1);
      expect(mockRemoveHostRoutesWhere).toHaveBeenCalledTimes(1);
      const removed = mockRemoveHostRoutesWhere.mock.results[0].value as HostRouteState[];
      expect(removed.map((entry) => entry.id)).toEqual(["/gone::proxy"]);
      expect(existsSpy).not.toHaveBeenCalledWith("/main");
    } finally {
      existsSpy.mockRestore();
    }
  });
});

describe("app route removal", () => {
  it("removes only the target app route in the target repo", () => {
    mockListHostRouteState.mockReturnValue([
      route({ id: "/repo::web", name: "web", repoPath: "/repo" }),
      route({ id: "/repo::api", name: "api", repoPath: "/repo" }),
      route({ id: "/other::web", name: "web", repoPath: "/other" })
    ]);

    const removed = removeRouteForApp("/repo", "web");

    expect(removed.map((entry) => entry.id)).toEqual(["/repo::web"]);
    expect(mockRemoveHostRoutesWhere).toHaveBeenCalledTimes(1);
    expect(removed.map((entry) => entry.id)).not.toContain("/repo::api");
    expect(removed.map((entry) => entry.id)).not.toContain("/other::web");
  });

  it("removes target app routes through /tmp and /private/tmp aliases", () => {
    mockListHostRouteState.mockReturnValue([
      route({ id: "/tmp/repo::web", name: "web", repoPath: "/tmp/repo" }),
      route({ id: "/other::web", name: "web", repoPath: "/other" })
    ]);
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => {
      const key = String(value);
      if (key === "/tmp/repo" || key === "/private/tmp/repo") {
        return "/private/tmp/repo";
      }
      return key;
    });

    try {
      const removed = removeRouteForApp("/private/tmp/repo", "web");

      expect(removed.map((entry) => entry.id)).toEqual(["/tmp/repo::web"]);
      expect(mockRemoveHostRoutesWhere).toHaveBeenCalledTimes(1);
      expect(removed.map((entry) => entry.id)).not.toContain("/other::web");
    } finally {
      realpath.mockRestore();
    }
  });
});
