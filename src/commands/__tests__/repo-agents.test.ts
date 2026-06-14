import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRepoAgentsCommand } from "../repo-agents";
import type { LinearWorkflowMetadata } from "../../core/linear-onboarding";

let tmpDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-repo-agents-test-"));
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runRepoAgentsCommand", () => {
  it("keeps default behavior unchanged without --with-linear", async () => {
    await runRepoAgentsCommand({ repo: tmpDir });

    expect(fs.existsSync(path.join(tmpDir, ".agents", "skills", "devrouter", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".agents", "skills", "linear-workflow", "SKILL.md"))).toBe(false);

    const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- devrouter -->");
    expect(agents).not.toContain("<!-- devrouter-linear-workflow -->");
  });

  it("writes linear workflow artifacts and AGENTS section with --with-linear", async () => {
    await runRepoAgentsCommand({ repo: tmpDir, withLinear: true });

    expect(fs.existsSync(path.join(tmpDir, ".agents", "skills", "devrouter", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".agents", "skills", "linear-workflow", "SKILL.md"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          ".agents",
          "skills",
          "linear-workflow",
          "references",
          "MILESTONE_PLAN_TEMPLATE.md"
        )
      )
    ).toBe(true);

    const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- devrouter -->");
    expect(agents).toContain("<!-- devrouter-linear-workflow -->");
    expect(agents).toContain("<!-- devrouter-linear-workflow-config:start -->");
    expect(agents).toContain("<REQUIRED: workspace.name>");
    expect(agents).toContain("capture_mode: \"placeholder\"");

    const output = (stdoutSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join("");
    expect(output).toContain("non-interactive mode detected");
  });

  it("writes interactive mapping values when collector is provided", async () => {
    const metadata: LinearWorkflowMetadata = {
      workspace: { name: "Acme Workspace" },
      team: { name: "Platform", key: "PLAT" },
      project: { name: "Devrouter" },
      updatedAt: "2026-02-16T12:00:00.000Z",
      captureMode: "interactive"
    };

    await runRepoAgentsCommand(
      { repo: tmpDir, withLinear: true },
      { collectLinearMetadata: async () => metadata }
    );

    const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("Acme Workspace");
    expect(agents).toContain("PLAT");
    expect(agents).toContain("capture_mode: \"interactive\"");
  });
});
