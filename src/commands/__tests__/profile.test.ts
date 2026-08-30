import { afterEach, describe, expect, it, vi } from "vitest";
import { printJSON } from "../../core/output";
import { type ProfileResolutionReport, resolveProfileReport } from "../../core/profile-resolution";
import { runProfileResolveCommand } from "../profile";

vi.mock("../../core/profile-resolution", () => ({
  resolveProfileReport: vi.fn(),
}));

vi.mock("../../core/output", () => ({
  printJSON: vi.fn(),
}));

const report: ProfileResolutionReport = {
  schemaVersion: 1,
  repoPath: "/repo",
  profile: "manage,pwa",
  apps: ["api", "manage", "pwa"],
  dependencies: ["db"],
  readiness: ["api", "manage", "pwa"],
  managedRuntime: {
    baseServices: ["postgres"],
    profileServices: ["redis"],
    services: ["postgres", "redis"],
    processes: ["web"],
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("runProfileResolveCommand", () => {
  it("prints stable JSON when requested", async () => {
    vi.mocked(resolveProfileReport).mockReturnValue(report);

    await runProfileResolveCommand({
      repo: "/repo",
      profile: "pwa,manage",
      json: true,
    });

    expect(resolveProfileReport).toHaveBeenCalledWith({
      repo: "/repo",
      profile: "pwa,manage",
      json: true,
    });
    expect(printJSON).toHaveBeenCalledWith(report);
  });

  it("prints a compact human summary", async () => {
    vi.mocked(resolveProfileReport).mockReturnValue(report);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await runProfileResolveCommand({ repo: "/repo" });
      const output = writeSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("Profile: manage,pwa");
      expect(output).toContain("Apps: api, manage, pwa");
      expect(output).toContain("Managed processes: web");
      expect(printJSON).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});
