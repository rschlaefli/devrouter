import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInitCommand } from "../init";

const AGENTS_PATH = "AGENTS.md";
const DEVROUTER_SKILL_PATH = path.join(".factory", "skills", "devrouter", "SKILL.md");
const LINEAR_SKILL_PATH = path.join(".factory", "skills", "linear-workflow", "SKILL.md");
const LINEAR_ISSUE_TEMPLATE_PATH = path.join(
  ".factory",
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
  });

  it("writes linear workflow skill artifacts with --with-linear --write-skill", async () => {
    await runInitCommand({ repo: tmpDir, withLinear: true, writeSkill: true });

    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(true);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(true);
    expect(fileExists(tmpDir, LINEAR_ISSUE_TEMPLATE_PATH)).toBe(true);
    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(false);
  });

  it("writes both AGENTS sections with --with-linear --write-agents", async () => {
    await runInitCommand({ repo: tmpDir, withLinear: true, writeAgents: true });

    const agentsPath = path.join(tmpDir, AGENTS_PATH);
    expect(fileExists(tmpDir, AGENTS_PATH)).toBe(true);
    expect(fileExists(tmpDir, DEVROUTER_SKILL_PATH)).toBe(false);
    expect(fileExists(tmpDir, LINEAR_SKILL_PATH)).toBe(false);
    const content = fs.readFileSync(agentsPath, "utf-8");
    expect(content).toContain("<!-- devrouter -->");
    expect(content).toContain("<!-- devrouter-linear-workflow -->");
  });

  it("rejects json mode with write flags", async () => {
    await expect(
      runInitCommand({ repo: tmpDir, json: true, writeAgents: true })
    ).rejects.toThrow("--json cannot be combined");
  });
});
