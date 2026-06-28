import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRepoDevcontainerVerifyCommand, runRepoDevcontainerWriteCommand } from "../repo-devcontainer";
import { writeDevcontainer } from "../../core/devcontainer-write";
import { verifyDevcontainer } from "../../core/devcontainer-verify";
import { printJSON } from "../../core/output";
import type { DevcontainerWritePlan } from "../../core/devcontainer-write";
import type { DevcontainerVerifyReport } from "../../core/devcontainer-verify";

vi.mock("../../core/devcontainer-write", () => ({
  writeDevcontainer: vi.fn(),
}));

vi.mock("../../core/devcontainer-verify", () => ({
  verifyDevcontainer: vi.fn(),
}));

vi.mock("../../core/output", () => ({
  printJSON: vi.fn(),
}));

function plan(error = false): DevcontainerWritePlan {
  return {
    repoPath: "/repo",
    projectName: "repo",
    profile: "node-postgres",
    dryRun: true,
    files: [{ path: ".devcontainer/Dockerfile", action: "create", reason: "missing" }],
    issues: error
      ? [{ id: "repo.devcontainer.write-conflict", level: "error", summary: "conflict" }]
      : [],
    nextSteps: ["next"],
  };
}

function verifyReport(error = false): DevcontainerVerifyReport {
  return {
    generatedAt: "2026-06-28T00:00:00.000Z",
    repoPath: "/repo",
    live: false,
    summary: { ok: error ? 0 : 1, warn: 0, error: error ? 1 : 0 },
    checks: [
      {
        id: error ? "repo.devcontainer.verify-files" : "repo.devcontainer.verify-doctor",
        level: error ? "error" : "ok",
        summary: error ? "missing" : "ok",
      },
    ],
    evidence: {
      doctorSummary: { ok: 1, warn: 0, error: 0 },
      blockingDoctorChecks: [],
      proxyApps: [],
    },
    nextSteps: [],
  };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
  stdoutSpy.mockRestore();
  process.exitCode = undefined;
});

describe("runRepoDevcontainerWriteCommand", () => {
  it("prints JSON for dry-runs", async () => {
    const report = plan(false);
    vi.mocked(writeDevcontainer).mockReturnValue(report);

    await runRepoDevcontainerWriteCommand({
      repo: "/repo",
      dryRun: true,
      json: true,
      installedVersion: "1.2.3",
    });

    expect(printJSON).toHaveBeenCalledWith(report);
    expect(writeDevcontainer).toHaveBeenCalledWith({
      repo: "/repo",
      dryRun: true,
      yes: false,
      installedVersion: "1.2.3",
    });
  });

  it("prints human output for dry-runs without --json", async () => {
    const report = plan(false);
    vi.mocked(writeDevcontainer).mockReturnValue(report);

    await runRepoDevcontainerWriteCommand({ repo: "/repo", dryRun: true });

    expect(printJSON).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("sets exitCode when write plan has errors", async () => {
    vi.mocked(writeDevcontainer).mockReturnValue(plan(true));

    await runRepoDevcontainerWriteCommand({ repo: "/repo", dryRun: true, json: true });

    expect(process.exitCode).toBe(1);
  });
});

describe("runRepoDevcontainerVerifyCommand", () => {
  it("prints JSON when --json is set", async () => {
    const report = verifyReport(false);
    vi.mocked(verifyDevcontainer).mockResolvedValue(report);

    await runRepoDevcontainerVerifyCommand({ repo: "/repo", json: true });

    expect(printJSON).toHaveBeenCalledWith(report);
  });

  it("sets exitCode when verify report has errors", async () => {
    vi.mocked(verifyDevcontainer).mockResolvedValue(verifyReport(true));

    await runRepoDevcontainerVerifyCommand({ repo: "/repo", json: true });

    expect(process.exitCode).toBe(1);
  });
});
