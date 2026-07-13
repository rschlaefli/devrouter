import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAgentsMdSection, ensureSkillFile } from "../agents-md";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-agents-md-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agents-md", () => {
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
    const sourceSkillContent = fs.readFileSync(
      path.join(process.cwd(), ".agents", "skills", "devrouter", "SKILL.md"),
      "utf-8",
    );
    expect(skillContent).toBe(sourceSkillContent);
    expect(skillContent).toContain("kind: app | dependency");
    expect(skillContent).toContain("devrouter:");
    expect(skillContent).toContain("kind=dependency");
    expect(skillContent).toContain("devrouter upgrade <version>");
    expect(skillContent).toContain("devrouter -V");
    expect(skillContent).toContain("devrouter setup --repo . --yes");
    expect(skillContent).toContain("devrouter repo inspect --repo . --json");
    expect(skillContent).toContain("devrouter repo devcontainer write --dry-run --json");
    expect(skillContent).toContain("devrouter repo devcontainer verify --json");
  });
});
