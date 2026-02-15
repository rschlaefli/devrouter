import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpgradeCommand } from "../upgrade";
import { runVersionCommand } from "../version";

const CHANGELOG_FIXTURE = `
## [0.0.12] - 2026-02-15

### Agent Adaptation Prompt

\`\`\`text
Prompt for 0.0.12
\`\`\`

## [0.0.11] - 2026-02-15

### Agent Adaptation Prompt

\`\`\`text
Prompt for 0.0.11
\`\`\`

## [0.0.10] - 2026-02-15

### Agent Adaptation Prompt

\`\`\`text
Prompt for 0.0.10
\`\`\`
`;

let tmpDir: string;
let changelogPath: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-upgrade-command-test-"));
  changelogPath = path.join(tmpDir, "CHANGELOG.md");
  fs.writeFileSync(changelogPath, CHANGELOG_FIXTURE, "utf-8");
  fs.writeFileSync(path.join(tmpDir, "devrouter.yaml"), "version: 0.0.10\n", "utf-8");
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function stdout(): string {
  return (stdoutSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join("");
}

describe("runUpgradeCommand", () => {
  it("lists available upgrade targets and highlights the next one", async () => {
    await runUpgradeCommand({ repo: tmpDir }, { changelogPath });

    const output = stdout();
    expect(output).toContain("Current version: 0.0.10");
    expect(output).toContain("- 0.0.11  <- next");
    expect(output).toContain("- 0.0.12");
  });

  it("prints target adaptation prompt and further version", async () => {
    await runUpgradeCommand({ repo: tmpDir, targetVersion: "0.0.11" }, { changelogPath });

    const output = stdout();
    expect(output).toContain("Target version: 0.0.11");
    expect(output).toContain("Prompt for 0.0.11");
    expect(output).toContain("Further version available: 0.0.12");
  });

  it("rejects target versions that are not newer", async () => {
    await expect(
      runUpgradeCommand({ repo: tmpDir, targetVersion: "0.0.10" }, { changelogPath })
    ).rejects.toThrow("is not newer than current version");
  });
});

describe("runVersionCommand", () => {
  it("shows installed and local versions plus next upgrade target", async () => {
    await runVersionCommand(
      { repo: tmpDir, installedVersion: "0.0.13" },
      { changelogPath }
    );

    const output = stdout();
    expect(output).toContain("Installed CLI version: 0.0.13");
    expect(output).toContain("Local repo version");
    expect(output).toContain("Next upgrade target: 0.0.11");
    expect(output).toContain("Run: dev upgrade 0.0.11");
  });

  it("keeps working when local version file is missing", async () => {
    fs.rmSync(path.join(tmpDir, "devrouter.yaml"), { force: true });

    await runVersionCommand(
      { repo: tmpDir, installedVersion: "0.0.13" },
      { changelogPath }
    );

    const output = stdout();
    expect(output).toContain("Installed CLI version: 0.0.13");
    expect(output).toContain("Local repo version: unavailable");
    expect(output).toContain("Next upgrade target: unavailable");
  });
});
