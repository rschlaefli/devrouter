import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpgradeCommand } from "../upgrade";
import { runVersionCommand } from "../version";

let tmpDir: string;
let promptsDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function writeRepoConfig(version: string): void {
  fs.writeFileSync(
    path.join(tmpDir, ".devrouter.yml"),
    `version: 1
devrouter:
  version: ${version}
apps: []
`,
    "utf-8",
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-upgrade-command-test-"));
  promptsDir = path.join(tmpDir, "upgrade-prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(path.join(promptsDir, "0.0.10.md"), "Prompt for 0.0.10\n", "utf-8");
  fs.writeFileSync(path.join(promptsDir, "0.0.11.md"), "Prompt for 0.0.11\n", "utf-8");
  fs.writeFileSync(path.join(promptsDir, "0.0.12.md"), "Prompt for 0.0.12\n", "utf-8");
  writeRepoConfig("0.0.10");
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
    await runUpgradeCommand({ repo: tmpDir }, { promptsDir });

    const output = stdout();
    expect(output).toContain("Current version: 0.0.10");
    expect(output).toContain("- 0.0.11  <- next");
    expect(output).toContain("- 0.0.12");
  });

  it("prints target adaptation prompt and further version", async () => {
    await runUpgradeCommand({ repo: tmpDir, targetVersion: "0.0.11" }, { promptsDir });

    const output = stdout();
    expect(output).toContain("Target version: 0.0.11");
    expect(output).toContain("Prompt for 0.0.11");
    expect(output).toContain("Further version available: 0.0.12");
  });

  it("rejects target versions that are not newer", async () => {
    await expect(
      runUpgradeCommand({ repo: tmpDir, targetVersion: "0.0.10" }, { promptsDir }),
    ).rejects.toThrow("is not newer than current version");
  });

  it("shows no targets when local version is newer than available prompt files", async () => {
    writeRepoConfig("0.10.0");

    await runUpgradeCommand({ repo: tmpDir }, { promptsDir });

    const output = stdout();
    expect(output).toContain("Current version: 0.10.0");
    expect(output).toContain("No newer upgrade targets are available.");
  });

  it("fails with remediation when devrouter.version is missing", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".devrouter.yml"),
      `version: 1
apps: []
`,
      "utf-8",
    );

    await expect(runUpgradeCommand({ repo: tmpDir }, { promptsDir })).rejects.toThrow(
      "is missing devrouter.version",
    );
  });
});

describe("runVersionCommand", () => {
  it("shows installed and local versions plus next upgrade target", async () => {
    await runVersionCommand({ repo: tmpDir, installedVersion: "0.0.13" }, { promptsDir });

    const output = stdout();
    expect(output).toContain("Installed CLI version: 0.0.13");
    expect(output).toContain("Local repo version");
    expect(output).toContain("Next upgrade target: 0.0.11");
    expect(output).toContain("Run: devrouter upgrade 0.0.11");
  });

  it("fails fast when local devrouter.version is unavailable", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".devrouter.yml"),
      `version: 1
apps: []
`,
      "utf-8",
    );

    await expect(
      runVersionCommand({ repo: tmpDir, installedVersion: "0.0.13" }, { promptsDir }),
    ).rejects.toThrow("missing devrouter.version");
  });
});
