import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeRepoApp } from "../../core/repo-config";
import { removeRouteForApp } from "../../core/route-state";
import { runAppRmCommand } from "../app-rm";

vi.mock("../../core/route-state", () => ({
  removeRouteForApp: vi.fn(() => [{ id: "/repo::app" }]),
}));

vi.mock("../../core/repo-config", () => ({
  removeRepoApp: vi.fn(),
  resolveRepoPath: vi.fn(() => "/repo"),
}));

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  vi.clearAllMocks();
});

describe("runAppRmCommand", () => {
  it("removes the app from config and frees its route by default", async () => {
    vi.mocked(removeRepoApp).mockReturnValue({ removed: true, configPath: "/repo/.devrouter.yml" });

    await runAppRmCommand({ name: "app" });

    expect(removeRepoApp).toHaveBeenCalledWith("/repo", "app");
    expect(removeRouteForApp).toHaveBeenCalledWith("/repo", "app");
    expect(stdoutSpy).toHaveBeenCalledWith("Removed 'app' from /repo/.devrouter.yml\n");
  });

  it("throws when the app is not in the config (default mode)", async () => {
    vi.mocked(removeRepoApp).mockReturnValue({
      removed: false,
      configPath: "/repo/.devrouter.yml",
    });

    await expect(runAppRmCommand({ name: "ghost" })).rejects.toThrow(
      "App 'ghost' not found in /repo/.devrouter.yml.",
    );
    expect(removeRouteForApp).not.toHaveBeenCalled();
  });

  it("with --keep-config frees only the route and never touches the config", async () => {
    await runAppRmCommand({ name: "app", keepConfig: true });

    expect(removeRepoApp).not.toHaveBeenCalled();
    expect(removeRouteForApp).toHaveBeenCalledWith("/repo", "app");
    expect(stdoutSpy).toHaveBeenCalledWith("Freed route for 'app' (config left intact)\n");
  });

  it("with --keep-config and no active route, reports it and leaves the config intact", async () => {
    vi.mocked(removeRouteForApp).mockReturnValue([]);

    await runAppRmCommand({ name: "app", keepConfig: true });

    expect(removeRepoApp).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith("No active route for 'app' (config left intact)\n");
  });
});
