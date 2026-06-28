import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctorCommand } from "../doctor";
import { buildDoctorReport } from "../../core/doctor";
import { printDoctorReport, printJSON } from "../../core/output";
import type { DoctorReport } from "../../types";

vi.mock("../../core/doctor", () => ({
  buildDoctorReport: vi.fn(),
}));

vi.mock("../../core/output", () => ({
  printDoctorReport: vi.fn(),
  printJSON: vi.fn(),
}));

function report(errorCount: number): DoctorReport {
  return {
    generatedAt: "2026-06-28T00:00:00.000Z",
    repoPath: "/repo",
    summary: { ok: 1, warn: 0, error: errorCount },
    checks: [
      {
        id: errorCount > 0 ? "global.status" : "global.devnet",
        level: errorCount > 0 ? "error" : "ok",
        summary: errorCount > 0 ? "Docker unavailable" : "devnet exists",
      },
    ],
    nextSteps: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe("runDoctorCommand", () => {
  it("sets exitCode 1 after printing JSON when diagnostics contain errors", async () => {
    vi.mocked(buildDoctorReport).mockResolvedValue(report(1));

    await runDoctorCommand({ repo: "/repo", json: true });

    expect(printJSON).toHaveBeenCalledWith(report(1));
    expect(process.exitCode).toBe(1);
  });

  it("does not set exitCode when diagnostics have no errors", async () => {
    vi.mocked(buildDoctorReport).mockResolvedValue(report(0));

    await runDoctorCommand({ repo: "/repo", json: false });

    expect(printDoctorReport).toHaveBeenCalledWith(report(0));
    expect(process.exitCode).toBeUndefined();
  });
});
