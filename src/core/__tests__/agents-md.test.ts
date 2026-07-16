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
    expect(content).toContain("<!-- /devrouter -->");
    expect(content).not.toContain("<!-- devrouter-linear-workflow -->");
    expect(content).toContain(
      "Primary or linked devcontainer checkout: `devrouter ensure . --json`",
    );
    expect(content).toContain("Host/docker runtime app only:");

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
    expect(skillContent).toContain("devrouter ensure [path] [--open] [--json]");
    expect(skillContent).toContain("devrouter exec [path] -- <command...>");
    expect(skillContent).toContain("devrouter repo inspect --repo . --json");
    expect(skillContent).toContain("devrouter repo devcontainer write --dry-run --json");
    expect(skillContent).toContain("devrouter repo devcontainer verify --json");
    expect(skillContent).toContain("DEVCONTAINER_COMPOSE_OVERLAY");
    expect(skillContent).toContain("DEVROUTER_GIT_COMMON_DIR");
    expect(skillContent).toContain("custom repositories may keep another default overlay");
    expect(skillContent).toContain("For host/docker runtime apps only:");
    expect(skillContent).toContain("devrouter workspace stop <workspace|branch>");
    expect(skillContent).toContain("devrouter workspace gc [--json] [--yes]");
    expect(skillContent).toContain("`present`, `missing`, `locked`, or `conflict`");
    expect(skillContent).toContain("workspace commands require Git");
    expect(skillContent).toContain("Git has no worktree-removal hook");
    expect(skillContent).not.toContain("--keep-devpod");

    expect(ensureAgentsMdSection(tmpDir).written).toBe(false);
  });

  it("refreshes a legacy generated section without replacing later user content", () => {
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      [
        "# AGENTS.md",
        "",
        "<!-- devrouter -->",
        "## devrouter",
        "",
        "Quick validation sequence:",
        "- `devrouter app run <host-app> --repo . --yes`",
        "- `devrouter ls`",
        "",
        "## User notes",
        "",
        "Keep this content.",
        "",
      ].join("\n"),
    );

    expect(ensureAgentsMdSection(tmpDir).written).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toContain(
      "Primary or linked devcontainer checkout: `devrouter ensure . --json`",
    );
    expect(content).toContain("<!-- /devrouter -->");
    expect(content).toContain("## User notes\n\nKeep this content.");
  });
});
