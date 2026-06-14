import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInitCommand } from "../init";
import type { LinearWorkflowMetadata } from "../../core/linear-onboarding";

const AGENTS_PATH = "AGENTS.md";
const DEVROUTER_SKILL_PATH = path.join(".agents", "skills", "devrouter", "SKILL.md");
const LINEAR_SKILL_PATH = path.join(".agents", "skills", "linear-workflow", "SKILL.md");
const LINEAR_ISSUE_TEMPLATE_PATH = path.join(
  ".agents",
  "skills",
  "linear-workflow",
  "references",
  "LINEAR_ISSUE_TEMPLATE.md"
);

let tmpDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function fileExists(base: string, rel: string): boolean {
  return fs.existsSync(path.join(base, rel));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-init-test-"));
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runInitCommand", () => {
  it("does not write repo files by default", async () => {
    await runInitCommand({ repo: tmpDir });

    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(false);
    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(false);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(false);
  });

  it("does not write repo files in json mode", async () => {
    await runInitCommand({ repo: tmpDir, json: true });

    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(false);
    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(false);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(false);
  });

  it("writes only the skill file when requested", async () => {
    await runInitCommand({ repo: tmpDir, writeSkill: true });

    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(true);
    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(false);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(false);
  });

  it("writes only AGENTS.md section when requested", async () => {
    await runInitCommand({ repo: tmpDir, writeAgents: true });

    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(true);
    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(false);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(false);
  });

  it("writes both artifacts when both write flags are set", async () => {
    await runInitCommand({ repo: tmpDir, writeAgents: true, writeSkill: true });

    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(true);
    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(true);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(false);
  });

  it("does not write linear artifacts with --with-linear unless write flags are set", async () => {
    await runInitCommand({ repo: tmpDir, withLinear: true });

    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(false);
    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(false);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(false);

    const output = (stdoutSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join("");
    expect(output).toContain("Which Linear workspace does this repository belong to?");
  });

  it("writes linear workflow skill artifacts with --with-linear --write-skill", async () => {
    await runInitCommand({ repo: tmpDir, withLinear: true, writeSkill: true });

    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(true);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(true);
    expect(fileExists(tmpDir, LINEAR_ISSUE_TEMPLATE_PATH)).toBe(true);
    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(false);
  });

  it("writes placeholders for linear mapping in non-interactive mode", async () => {
    await runInitCommand({ repo: tmpDir, withLinear: true, writeAgents: true });

    const agentsPath = path.join(tmpDir, AGENTS_PATH);
    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(true);
    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(false);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(false);
    const content = fs.readFileSync(agentsPath, "utf-8");
    expect(content).toContain("<!-- devrouter -->");
    expect(content).toContain("<!-- devrouter-linear-workflow -->");
    expect(content).toContain("<!-- devrouter-linear-workflow-config:start -->");
    expect(content).toContain("<REQUIRED: workspace.name>");
    expect(content).toContain("capture_mode: \"placeholder\"");

    const output = (stdoutSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join("");
    expect(output).toContain("non-interactive mode detected");
  });

  it("writes interactive linear mapping values when collector is provided", async () => {
    const metadata: LinearWorkflowMetadata = {
      workspace: { name: "Acme Workspace" },
      team: { name: "Platform", key: "PLAT" },
      project: { name: "Devrouter", id: "0b1c6ef6-9e97-4a75-ac79-18fea4b21af8" },
      updatedAt: "2026-02-16T12:00:00.000Z",
      captureMode: "interactive"
    };

    await runInitCommand(
      { repo: tmpDir, withLinear: true, writeAgents: true },
      { collectLinearMetadata: async () => metadata }
    );

    const content = fs.readFileSync(path.join(tmpDir, AGENTS_PATH), "utf-8");
    expect(content).toContain("Acme Workspace");
    expect(content).toContain("PLAT");
    expect(content).toContain("capture_mode: \"interactive\"");
  });

  it("rejects json mode with write flags", async () => {
    await expect(
      runInitCommand({ repo: tmpDir, json: true, writeAgents: true })
    ).rejects.toThrow("--json cannot be combined");
  });
});
