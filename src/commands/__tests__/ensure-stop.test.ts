import { afterEach, describe, expect, it, vi } from "vitest";
import { superviseLifecycle } from "../../core/reliability-lifecycle";
import { runEnsureCommand } from "../ensure";
import { runStopCommand } from "../stop";

vi.mock("../../core/reliability-lifecycle", () => ({ superviseLifecycle: vi.fn() }));
vi.mock("../../core/workspace-ownership", () => ({
  resolveGitTopLevel: vi.fn((repoPath: string) => repoPath),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("canonical environment commands", () => {
  it.each([
    {
      result: {
        kind: "primary" as const,
        repoPath: "/repo",
        devpodId: "repo",
        profile: "full",
        urls: ["https://web.localhost"],
        recreated: false,
        tlsRefreshed: false,
      },
    },
    {
      result: {
        kind: "linked" as const,
        repoPath: "/repo/trees/feature",
        workspace: "feature",
        devpodId: "feature",
        profile: "full",
        urls: ["https://web.feature.localhost"],
        recreated: false,
        tlsRefreshed: false,
      },
    },
  ])("ensures $result.kind checkouts through one command", async ({ result }) => {
    vi.mocked(superviseLifecycle).mockResolvedValue(result);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runEnsureCommand({ path: result.repoPath, open: true });

    expect(superviseLifecycle).toHaveBeenCalledWith("ensure", result.repoPath, {
      open: true,
      quiet: false,
      profile: undefined,
    });
    expect(write).toHaveBeenCalled();
  });

  it("prints the stable ensure result as JSON", async () => {
    const result = {
      kind: "linked" as const,
      repoPath: "/repo/trees/feature",
      workspace: "feature",
      profile: "full",
      devpodId: "feature",
      urls: ["https://web.feature.localhost"],
      recreated: true,
      tlsRefreshed: true,
    };
    vi.mocked(superviseLifecycle).mockResolvedValue(result);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runEnsureCommand({ path: result.repoPath, json: true });

    expect(superviseLifecycle).toHaveBeenCalledWith("ensure", result.repoPath, {
      open: undefined,
      quiet: true,
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual(result);
  });

  it("forwards explicit degraded-runtime repair", async () => {
    const result = {
      kind: "linked" as const,
      repoPath: "/repo/trees/feature",
      workspace: "feature",
      profile: "ai",
      devpodId: "feature",
      urls: ["https://web.feature.localhost"],
      recreated: false,
      tlsRefreshed: false,
    };
    vi.mocked(superviseLifecycle).mockResolvedValue(result);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runEnsureCommand({ path: result.repoPath, json: true, repair: true });

    expect(superviseLifecycle).toHaveBeenCalledWith("ensure", result.repoPath, {
      open: undefined,
      quiet: true,
      repair: true,
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual(result);
  });

  it("stops an exact checkout and prints JSON", async () => {
    const result = {
      kind: "primary" as const,
      repoPath: "/repo",
      devpodId: "repo",
      stopped: true,
      freedRoutes: 2,
    };
    vi.mocked(superviseLifecycle).mockResolvedValue(result);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runStopCommand({ path: "/repo", json: true });

    expect(superviseLifecycle).toHaveBeenCalledWith("stop", "/repo", { delete: undefined });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual(result);
  });

  it("reports an already stopped linked checkout as a successful no-op", async () => {
    vi.mocked(superviseLifecycle).mockResolvedValue({
      kind: "linked",
      repoPath: "/repo/trees/feature",
      workspace: "feature",
      stopped: false,
      freedRoutes: 0,
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runStopCommand({ path: "/repo/trees/feature" });

    expect(write).toHaveBeenCalled();
  });

  it("reports an explicitly deleted exact DevPod", async () => {
    vi.mocked(superviseLifecycle).mockResolvedValue({
      kind: "primary",
      repoPath: "/repo",
      devpodId: "repo",
      stopped: false,
      deleted: true,
      freedRoutes: 1,
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runStopCommand({ path: "/repo", delete: true });

    expect(superviseLifecycle).toHaveBeenCalledWith("stop", "/repo", { delete: true });
    expect(write).toHaveBeenCalled();
  });
});
