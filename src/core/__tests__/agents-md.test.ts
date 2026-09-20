import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAgentsMdSection, ensureSkillFile } from "../agents-md";
import { HARNESS_GATE_DEFAULT_BUDGET_MS } from "../harness-gate";

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

  it("keeps every shipped harness hook timeout above the default wait budget", () => {
    const skill = fs.readFileSync(ensureSkillFile(tmpDir).path, "utf-8");
    const wirings = skill.split('"command": "devrouter harness gate"').slice(1);
    expect(wirings.length).toBeGreaterThan(0);
    for (const wiring of wirings) {
      const timeout = wiring.slice(0, 80).match(/"timeout":\s*(\d+)/);
      expect(timeout, "a shipped harness-gate wiring declares no hook timeout").toBeTruthy();
      const timeoutMs = Number(timeout?.[1]) * 1000;
      expect(
        timeoutMs,
        "a shipped hook timeout of " +
          timeout?.[1] +
          "s leaves no headroom above the " +
          HARNESS_GATE_DEFAULT_BUDGET_MS +
          "ms wait budget it must outlast",
      ).toBeGreaterThanOrEqual(HARNESS_GATE_DEFAULT_BUDGET_MS * 2);
    }
  });
});
