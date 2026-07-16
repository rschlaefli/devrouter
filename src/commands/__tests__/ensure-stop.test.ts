import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentStop } from "../../core/environment-stop";
import { workspaceEnsure } from "../../core/workspace-ensure";
import { runEnsureCommand } from "../ensure";
import { runStopCommand } from "../stop";

vi.mock("../../core/workspace-ensure", () => ({ workspaceEnsure: vi.fn() }));
vi.mock("../../core/environment-stop", () => ({ environmentStop: vi.fn() }));
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
        urls: ["https://web.localhost"],
      },
      expected: "Primary checkout is ready (repo).\n  https://web.localhost\n",
    },
    {
      result: {
        kind: "linked" as const,
        repoPath: "/repo/trees/feature",
        workspace: "feature",
        devpodId: "feature",
        urls: ["https://web.feature.localhost"],
      },
      expected: "Workspace 'feature' is ready (feature).\n  https://web.feature.localhost\n",
    },
  ])("ensures $result.kind checkouts through one command", async ({ result, expected }) => {
    vi.mocked(workspaceEnsure).mockResolvedValue(result);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runEnsureCommand({ path: result.repoPath, open: true });

    expect(workspaceEnsure).toHaveBeenCalledWith(result.repoPath, { open: true });
    expect(write).toHaveBeenCalledWith(expected);
  });

  it("prints the stable ensure result as JSON", async () => {
    const result = {
      kind: "linked" as const,
      repoPath: "/repo/trees/feature",
      workspace: "feature",
      devpodId: "feature",
      urls: ["https://web.feature.localhost"],
    };
    vi.mocked(workspaceEnsure).mockResolvedValue(result);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runEnsureCommand({ path: result.repoPath, json: true });

    expect(write).toHaveBeenCalledWith(`${JSON.stringify(result, null, 2)}\n`);
  });

  it("stops an exact checkout and prints JSON", async () => {
    const result = {
      kind: "primary" as const,
      repoPath: "/repo",
      devpodId: "repo",
      stopped: true,
      freedRoutes: 2,
    };
    vi.mocked(environmentStop).mockResolvedValue(result);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runStopCommand({ path: "/repo", json: true });

    expect(environmentStop).toHaveBeenCalledWith("/repo");
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(result, null, 2)}\n`);
  });

  it("reports an already stopped linked checkout as a successful no-op", async () => {
    vi.mocked(environmentStop).mockResolvedValue({
      kind: "linked",
      repoPath: "/repo/trees/feature",
      workspace: "feature",
      stopped: false,
      freedRoutes: 0,
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runStopCommand({ path: "/repo/trees/feature" });

    expect(write).toHaveBeenCalledWith(
      "Workspace 'feature' is already stopped; no routes needed removal.\n",
    );
  });
});
