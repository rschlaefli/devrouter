import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  extractCurrentVersionFromRepoConfig,
  listAvailableUpgradeTargets,
  normalizeVersion,
  readPromptDirectory
} from "../upgrade";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-upgrade-core-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("upgrade core", () => {
  it("normalizes and compares semver values", () => {
    expect(normalizeVersion("v0.0.14")).toBe("0.0.14");
    expect(compareVersions("0.0.10", "0.0.11")).toBeLessThan(0);
    expect(compareVersions("0.0.12", "0.0.11")).toBeGreaterThan(0);
  });

  it("reads current version from .devrouter.yml devrouter.version", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".devrouter.yml"),
      `version: 1
devrouter:
  version: 0.0.10
apps: []
`,
      "utf-8"
    );

    const current = extractCurrentVersionFromRepoConfig(tmpDir);
    expect(current.version).toBe("0.0.10");
  });

  it("discovers prompt files sorted by semantic version", () => {
    const promptsDir = path.join(tmpDir, "upgrade-prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "0.0.12.md"), "Prompt 12\n", "utf-8");
    fs.writeFileSync(path.join(promptsDir, "0.0.10.md"), "Prompt 10\n", "utf-8");
    fs.writeFileSync(path.join(promptsDir, "0.0.11.md"), "Prompt 11\n", "utf-8");

    const releases = readPromptDirectory(promptsDir);
    expect(releases.map((release) => release.version)).toEqual(["0.0.10", "0.0.11", "0.0.12"]);
    expect(releases[1]?.prompt).toContain("Prompt 11");
  });

  it("lists only versions newer than current", () => {
    const releases = [
      { version: "0.0.10", prompt: "Prompt 10", promptPath: "/tmp/0.0.10.md" },
      { version: "0.0.11", prompt: "Prompt 11", promptPath: "/tmp/0.0.11.md" },
      { version: "0.0.12", prompt: "Prompt 12", promptPath: "/tmp/0.0.12.md" }
    ];

    const targets = listAvailableUpgradeTargets("0.0.10", releases);
    expect(targets.map((release) => release.version)).toEqual(["0.0.11", "0.0.12"]);
  });

  it("errors when prompt directory is missing", () => {
    expect(() => readPromptDirectory(path.join(tmpDir, "upgrade-prompts"))).toThrow(
      "Missing upgrade-prompts directory"
    );
  });
});
