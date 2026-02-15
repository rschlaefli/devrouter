import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureAgentsMdSection,
  ensureLinearWorkflowAgentsSection,
  ensureLinearWorkflowSkillFiles,
  ensureSkillFile
} from "../agents-md";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-agents-md-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agents-md linear workflow support", () => {
  it("writes linear workflow AGENTS section idempotently", () => {
    const first = ensureLinearWorkflowAgentsSection(tmpDir);
    expect(first.written).toBe(true);

    const second = ensureLinearWorkflowAgentsSection(tmpDir);
    expect(second.written).toBe(false);

    const content = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("<!-- devrouter-linear-workflow -->");
  });

  it("writes all linear workflow skill artifacts", () => {
    const result = ensureLinearWorkflowSkillFiles(tmpDir);
    expect(result.written).toBe(true);
    expect(result.paths.length).toBe(4);

    const skillPath = path.join(tmpDir, ".factory", "skills", "linear-workflow", "SKILL.md");
    const issueTemplatePath = path.join(
      tmpDir,
      ".factory",
      "skills",
      "linear-workflow",
      "references",
      "LINEAR_ISSUE_TEMPLATE.md"
    );
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(issueTemplatePath)).toBe(true);

    const skillContent = fs.readFileSync(skillPath, "utf-8");
    expect(skillContent).toContain("# linear-workflow");
    expect(skillContent).toContain("Large milestones must be planned and tracked in Linear");
    expect(skillContent).toContain("https://github.com/rolandhordos/devrouter/blob/main/CHANGELOG.md");
    expect(skillContent).toContain(
      "does not require creating a `CHANGELOG.md` in the target repository unless that repository already has its own policy"
    );
  });

  it("keeps existing devrouter section and skill behavior unchanged", () => {
    const agents = ensureAgentsMdSection(tmpDir);
    const skill = ensureSkillFile(tmpDir);

    expect(agents.written).toBe(true);
    expect(fs.existsSync(agents.path)).toBe(true);
    expect(fs.existsSync(skill.path)).toBe(true);

    const content = fs.readFileSync(agents.path, "utf-8");
    expect(content).toContain("<!-- devrouter -->");
    expect(content).not.toContain("<!-- devrouter-linear-workflow -->");

    const skillContent = fs.readFileSync(skill.path, "utf-8");
    expect(skillContent).toContain("https://github.com/rolandhordos/devrouter/blob/main/CHANGELOG.md");
    expect(skillContent).toContain(
      "does not require creating a `CHANGELOG.md` in the target repository unless that repository already has its own policy"
    );
  });
});
