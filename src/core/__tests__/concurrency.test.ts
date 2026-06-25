import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppAlreadyRunningError,
  HostnameConflictError,
  assertAppNotRunning,
  evictStaleHostRoutes,
  evictOrphanedWorkspaceRoutes
} from "../concurrency";
import fs from "node:fs";
import type { HostRouteState } from "../../types";

const mockListHostRouteState = vi.fn<() => HostRouteState[]>(() => []);
const mockRemoveHostRouteById = vi.fn<(id: string) => boolean>(() => true);
const mockIsPidRunning = vi.fn<(pid: number | undefined) => boolean>(() => false);
const mockIsTLSEnabled = vi.fn<() => boolean>(() => true);

vi.mock("../host-routes", () => ({
  listHostRouteState: (...args: unknown[]) => mockListHostRouteState(...(args as [])),
  removeHostRouteById: (...args: unknown[]) => mockRemoveHostRouteById(...(args as [string])),
  isPidRunning: (...args: unknown[]) => mockIsPidRunning(...(args as [number | undefined])),
  buildHostRouteId: (repoPath: string, name: string) => `${repoPath}::${name}`
}));

vi.mock("../router", () => ({
  isTLSEnabled: () => mockIsTLSEnabled()
}));

function makeProxyRoute(overrides: Partial<HostRouteState> = {}): HostRouteState {
  return makeRoute({
    id: "/worktree/repo-feat-a::app",
    name: "app",
    host: "app.feat-a.localhost",
    repoPath: "/worktree/repo-feat-a",
    mode: "proxy",
    pid: undefined,
    upstreamHost: "feat-a-app",
    workspace: "feat-a",
    ...overrides
  });
}

function makeRoute(overrides: Partial<HostRouteState> = {}): HostRouteState {
  return {
    id: "/repo::web",
    name: "web",
    host: "web.localhost",
    protocol: "http",
    repoPath: "/repo",
    port: 3000,
    mode: "run",
    pid: 12345,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertAppNotRunning", () => {
  it("does nothing when state is empty", () => {
    mockListHostRouteState.mockReturnValue([]);
    expect(() => assertAppNotRunning("/repo", { name: "web", host: "web.localhost" })).not.toThrow();
  });

  it("throws AppAlreadyRunningError when same app/repo has live PID", () => {
    mockListHostRouteState.mockReturnValue([makeRoute()]);
    mockIsPidRunning.mockReturnValue(true);

    expect(() => assertAppNotRunning("/repo", { name: "web", host: "web.localhost" })).toThrow(
      AppAlreadyRunningError
    );
  });

  it("error message includes URL, PID, and repo path", () => {
    mockListHostRouteState.mockReturnValue([makeRoute({ pid: 9999 })]);
    mockIsPidRunning.mockReturnValue(true);

    try {
      assertAppNotRunning("/repo", { name: "web", host: "web.localhost" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppAlreadyRunningError);
      const e = error as AppAlreadyRunningError;
      expect(e.message).toContain("https://web.localhost");
      expect(e.message).toContain("9999");
      expect(e.message).toContain("/repo");
    }
  });

  it("evicts stale entry and does not throw when same app/repo has dead PID", () => {
    mockListHostRouteState.mockReturnValue([makeRoute({ pid: 99999 })]);
    mockIsPidRunning.mockReturnValue(false);

    expect(() => assertAppNotRunning("/repo", { name: "web", host: "web.localhost" })).not.toThrow();
    expect(mockRemoveHostRouteById).toHaveBeenCalledWith("/repo::web");
  });

  it("throws HostnameConflictError when different app claims same hostname with live PID", () => {
    mockListHostRouteState.mockReturnValue([
      makeRoute({ id: "/other-repo::api", name: "api", repoPath: "/other-repo" })
    ]);
    mockIsPidRunning.mockReturnValue(true);

    expect(() => assertAppNotRunning("/repo", { name: "web", host: "web.localhost" })).toThrow(
      HostnameConflictError
    );
  });

  it("hostname conflict error includes existing app details", () => {
    mockListHostRouteState.mockReturnValue([
      makeRoute({ id: "/other::api", name: "api", repoPath: "/other", pid: 5555 })
    ]);
    mockIsPidRunning.mockReturnValue(true);

    try {
      assertAppNotRunning("/repo", { name: "web", host: "web.localhost" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HostnameConflictError);
      const e = error as HostnameConflictError;
      expect(e.message).toContain("web.localhost");
      expect(e.message).toContain("api");
      expect(e.message).toContain("/other");
    }
  });

  it("evicts stale hostname conflict and does not throw", () => {
    mockListHostRouteState.mockReturnValue([
      makeRoute({ id: "/other::api", name: "api", repoPath: "/other", pid: 99999 })
    ]);
    mockIsPidRunning.mockReturnValue(false);

    expect(() => assertAppNotRunning("/repo", { name: "web", host: "web.localhost" })).not.toThrow();
    expect(mockRemoveHostRouteById).toHaveBeenCalledWith("/other::api");
  });

  it("allows different apps with different hostnames", () => {
    mockListHostRouteState.mockReturnValue([
      makeRoute({ id: "/repo::api", name: "api", host: "api.localhost" })
    ]);
    mockIsPidRunning.mockReturnValue(true);

    expect(() => assertAppNotRunning("/repo", { name: "web", host: "web.localhost" })).not.toThrow();
  });

  it("uses http scheme when TLS is disabled", () => {
    mockIsTLSEnabled.mockReturnValue(false);
    mockListHostRouteState.mockReturnValue([makeRoute()]);
    mockIsPidRunning.mockReturnValue(true);

    try {
      assertAppNotRunning("/repo", { name: "web", host: "web.localhost" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppAlreadyRunningError);
      expect((error as AppAlreadyRunningError).url).toBe("http://web.localhost");
    }
  });
});

describe("evictStaleHostRoutes", () => {
  it("returns 0 when state is empty", () => {
    mockListHostRouteState.mockReturnValue([]);
    expect(evictStaleHostRoutes()).toBe(0);
  });

  it("evicts dead-PID entries and returns count", () => {
    mockListHostRouteState.mockReturnValue([
      makeRoute({ id: "/a::web", pid: 111 }),
      makeRoute({ id: "/b::api", pid: 222 })
    ]);
    mockIsPidRunning.mockReturnValue(false);

    expect(evictStaleHostRoutes()).toBe(2);
    expect(mockRemoveHostRouteById).toHaveBeenCalledTimes(2);
  });

  it("skips live-PID entries", () => {
    mockListHostRouteState.mockReturnValue([
      makeRoute({ id: "/a::web", pid: 111 }),
      makeRoute({ id: "/b::api", pid: 222 })
    ]);
    mockIsPidRunning.mockReturnValue(true);

    expect(evictStaleHostRoutes()).toBe(0);
    expect(mockRemoveHostRouteById).not.toHaveBeenCalled();
  });

  it("handles mixed live and dead entries", () => {
    mockListHostRouteState.mockReturnValue([
      makeRoute({ id: "/a::web", pid: 111 }),
      makeRoute({ id: "/b::api", pid: 222 })
    ]);
    mockIsPidRunning.mockImplementation((pid) => pid === 111);

    expect(evictStaleHostRoutes()).toBe(1);
    expect(mockRemoveHostRouteById).toHaveBeenCalledWith("/b::api");
  });

  it("never evicts proxy-mode routes (no pid)", () => {
    mockListHostRouteState.mockReturnValue([
      makeRoute({ id: "/a::app", mode: "proxy", pid: undefined, upstreamHost: "host.docker.internal" })
    ]);
    mockIsPidRunning.mockReturnValue(false);

    expect(evictStaleHostRoutes()).toBe(0);
    expect(mockRemoveHostRouteById).not.toHaveBeenCalled();
  });

  it("treats a live proxy route on the same host as a conflict, not a stale entry", () => {
    mockListHostRouteState.mockReturnValue([
      makeRoute({ id: "/other::app", name: "app", repoPath: "/other", mode: "proxy", pid: undefined })
    ]);
    mockIsPidRunning.mockReturnValue(false);

    // A proxy route (no pid) claiming web.localhost must NOT be evicted as stale,
    // and a different app claiming the same host is a real conflict.
    expect(() => assertAppNotRunning("/repo", { name: "web", host: "web.localhost" })).toThrow(
      HostnameConflictError
    );
    expect(mockRemoveHostRouteById).not.toHaveBeenCalled();
  });
});

describe("evictOrphanedWorkspaceRoutes", () => {
  it("keeps a workspace proxy route while its worktree still exists", () => {
    mockListHostRouteState.mockReturnValue([makeProxyRoute()]);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    expect(evictOrphanedWorkspaceRoutes()).toBe(0);
    expect(mockRemoveHostRouteById).not.toHaveBeenCalled();
  });

  it("reclaims a workspace proxy route once its worktree is gone", () => {
    mockListHostRouteState.mockReturnValue([makeProxyRoute()]);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(evictOrphanedWorkspaceRoutes()).toBe(1);
    expect(mockRemoveHostRouteById).toHaveBeenCalledWith("/worktree/repo-feat-a::app");
  });

  it("reclaims every orphaned workspace route under a removed worktree", () => {
    mockListHostRouteState.mockReturnValue([
      makeProxyRoute({ id: "/worktree/repo-feat-a::app", name: "app" }),
      makeProxyRoute({ id: "/worktree/repo-feat-a::db", name: "db", upstreamHost: "feat-a-db" })
    ]);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(evictOrphanedWorkspaceRoutes()).toBe(2);
  });

  it("never reclaims primary-checkout proxy routes (no workspace token), even if absent", () => {
    mockListHostRouteState.mockReturnValue([
      makeProxyRoute({ workspace: undefined, repoPath: "/main/repo" })
    ]);
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(evictOrphanedWorkspaceRoutes()).toBe(0);
    // Stable primary routes must never be GC'd by worktree existence — a stopped
    // devpod is not an orphan. We must not even probe the filesystem for them.
    expect(existsSpy).not.toHaveBeenCalled();
    expect(mockRemoveHostRouteById).not.toHaveBeenCalled();
  });

  it("ignores host-run workspace routes (PID liveness owns those)", () => {
    mockListHostRouteState.mockReturnValue([
      makeProxyRoute({ id: "/worktree/repo-feat-a::web", mode: "run", pid: 111 })
    ]);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(evictOrphanedWorkspaceRoutes()).toBe(0);
    expect(mockRemoveHostRouteById).not.toHaveBeenCalled();
  });
});
