import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRepoAgentsCommand } from "../repo-agents";

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
  it("keeps default behavior unchanged", async () => {
    await runRepoAgentsCommand({ repo: tmpDir });

    expect(fs.existsSync(path.join(tmpDir, ".agents", "skills", "devrouter", "SKILL.md"))).toBe(
      true,
    );

    const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- devrouter -->");
    expect(agents).not.toContain("<!-- devrouter-linear-workflow -->");
  });
});
