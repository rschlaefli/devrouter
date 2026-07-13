import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRouteState } from "../../types";
import { AppAlreadyRunningError, assertAppNotRunning, HostnameConflictError } from "../concurrency";
import { reconcileRouteRunConflict } from "../route-state";

vi.mock("../route-state", () => ({
  reconcileRouteRunConflict: vi.fn(() => undefined),
}));

const mockIsTLSEnabled = vi.fn<() => boolean>(() => true);

vi.mock("../router", () => ({
  isTLSEnabled: () => mockIsTLSEnabled(),
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsTLSEnabled.mockReturnValue(true);
});

describe("assertAppNotRunning", () => {
  it("does nothing when route state reports no conflict", () => {
    expect(() =>
      assertAppNotRunning("/repo", { name: "web", host: "web.localhost" }),
    ).not.toThrow();
    expect(reconcileRouteRunConflict).toHaveBeenCalledWith("/repo", {
      name: "web",
      host: "web.localhost",
    });
  });

  it("throws AppAlreadyRunningError for same-app conflicts", () => {
    vi.mocked(reconcileRouteRunConflict).mockReturnValue({
      kind: "same-app",
      route: route({ pid: 9999 }),
    });

    expect(() => assertAppNotRunning("/repo", { name: "web", host: "web.localhost" })).toThrow(
      AppAlreadyRunningError,
    );

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

  it("throws HostnameConflictError for hostname conflicts", () => {
    vi.mocked(reconcileRouteRunConflict).mockReturnValue({
      kind: "hostname",
      route: route({ id: "/other::api", name: "api", repoPath: "/other", pid: 5555 }),
    });

    expect(() => assertAppNotRunning("/repo", { name: "web", host: "web.localhost" })).toThrow(
      HostnameConflictError,
    );

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

  it("uses http scheme when TLS is disabled", () => {
    mockIsTLSEnabled.mockReturnValue(false);
    vi.mocked(reconcileRouteRunConflict).mockReturnValue({
      kind: "same-app",
      route: route(),
    });

    try {
      assertAppNotRunning("/repo", { name: "web", host: "web.localhost" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppAlreadyRunningError);
      expect((error as AppAlreadyRunningError).url).toBe("http://web.localhost");
    }
  });
});
