import { afterEach, describe, expect, it, vi } from "vitest";
import { printJSON } from "../../core/output";
import type { RepoInspection } from "../../core/repo-inspect";
import { inspectRepo } from "../../core/repo-inspect";
import { runRepoInspectCommand } from "../repo-inspect";

vi.mock("../../core/repo-inspect", () => ({
  inspectRepo: vi.fn(),
}));

vi.mock("../../core/output", () => ({
  printJSON: vi.fn(),
}));

const report: RepoInspection = {
  repoPath: "/repo",
  scripts: [],
  apps: [],
  services: [],
  env: { files: [], authLikeNames: [], databaseLikeNames: [] },
  devcontainer: { exists: false, files: [] },
  devrouter: {
    exists: false,
    configPath: "/repo/.devrouter.yml",
    valid: false,
    appCount: 0,
    tcpAppCount: 0,
    apps: [],
  },
  agentGuidance: [],
  issues: [
    {
      id: "repo.devrouter.missing",
      level: "warn",
      summary: "No .devrouter.yml found.",
    },
  ],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("runRepoInspectCommand", () => {
  it("prints JSON when --json is set", async () => {
    vi.mocked(inspectRepo).mockReturnValue(report);

    await runRepoInspectCommand({ repo: "/repo", json: true });

    expect(printJSON).toHaveBeenCalledWith(report);
  });

  it("prints a compact human summary when --json is omitted", async () => {
    vi.mocked(inspectRepo).mockReturnValue(report);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await runRepoInspectCommand({ repo: "/repo" });
      const output = writeSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("Repo: /repo");
      expect(output).toContain("Devrouter config: missing");
      expect(output).toContain("repo.devrouter.missing");
      expect(printJSON).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});
