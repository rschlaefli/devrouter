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
    const before = fs.readFileSync(agents.path, "utf-8");
    expect(ensureAgentsMdSection(tmpDir).written).toBe(false);
    expect(fs.readFileSync(agents.path, "utf-8")).toBe(before);
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
    expect(content).toContain("<!-- /devrouter -->");
    expect(content).toContain("## User notes\n\nKeep this content.");
  });
});
