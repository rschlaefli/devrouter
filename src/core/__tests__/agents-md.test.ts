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
import type { LinearWorkflowMetadata } from "../linear-onboarding";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-agents-md-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agents-md linear workflow support", () => {
  it("writes and replaces managed linear workflow config block without duplicates", () => {
    const initial: LinearWorkflowMetadata = {
      workspace: { name: "Workspace A" },
      team: { name: "Platform", key: "PLAT" },
      project: { name: "Devrouter", id: "proj-1" },
      updatedAt: "2026-02-16T00:00:00.000Z",
      captureMode: "interactive"
    };
    const updated: LinearWorkflowMetadata = {
      workspace: { name: "Workspace B" },
      team: { name: "Core" },
      project: { name: "Router V2" },
      updatedAt: "2026-02-16T01:00:00.000Z",
      captureMode: "placeholder"
    };

    const first = ensureLinearWorkflowAgentsSection(tmpDir, initial);
    expect(first.written).toBe(true);

    const second = ensureLinearWorkflowAgentsSection(tmpDir, updated);
    expect(second.written).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("<!-- devrouter-linear-workflow -->");
    expect(content).toContain("<!-- devrouter-linear-workflow-config:start -->");
    expect(content).toContain("Required Linear execution hygiene:");
    expect(content).toContain("Set issue status at session start and update it at each phase transition.");
    expect(content).toContain("Workspace B");
    expect(content).not.toContain("Workspace A");
    expect(content.match(/devrouter-linear-workflow-config:start/g)?.length ?? 0).toBe(1);
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
    expect(skillContent).toContain("workspace/team/project");
    expect(skillContent).toContain("Do not hardcode workspace/team/project assumptions.");
    expect(skillContent).toContain("Required execution hygiene");
    expect(skillContent).toContain("Post progress comments at meaningful checkpoints during implementation.");
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
