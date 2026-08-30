import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomically } from "../../core/atomic-file";
import { printJSON } from "../../core/output";
import { type ProfilePlanReport, resolveProfilePlan } from "../../core/profile-plan";
import { type ProfileResolutionReport, resolveProfileReport } from "../../core/profile-resolution";
import { runProfilePlanCommand, runProfileResolveCommand } from "../profile";

vi.mock("../../core/profile-resolution", () => ({
  resolveProfileReport: vi.fn(),
}));

vi.mock("../../core/profile-plan", () => ({ resolveProfilePlan: vi.fn() }));
vi.mock("../../core/atomic-file", () => ({ writeFileAtomically: vi.fn() }));

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

const plan: ProfilePlanReport = {
  ...report,
  contractPath: "ci/profile-plan.yml",
  bindings: { filters: ["--filter=api", "--filter=web"] },
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

describe("runProfilePlanCommand", () => {
  it("prints and atomically writes the same stable JSON plan", async () => {
    vi.mocked(resolveProfilePlan).mockReturnValue(plan);

    await runProfilePlanCommand({
      repo: "/repo",
      profile: "manage,pwa",
      contract: "ci/profile-plan.yml",
      output: "/tmp/profile-plan.json",
      json: true,
    });

    expect(resolveProfilePlan).toHaveBeenCalledWith({
      repo: "/repo",
      profile: "manage,pwa",
      contract: "ci/profile-plan.yml",
      output: "/tmp/profile-plan.json",
      json: true,
    });
    expect(writeFileAtomically).toHaveBeenCalledWith(
      "/tmp/profile-plan.json",
      `${JSON.stringify(plan, null, 2)}\n`,
    );
    expect(printJSON).toHaveBeenCalledWith(plan);
  });
});
