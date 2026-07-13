import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRepoConfig } from "../../core/repo-config";
import { runRepoInitCommand } from "../repo-init";

let tmpDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-repo-init-test-"));
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runRepoInitCommand", () => {
  it("creates .devrouter.yml with devrouter.version from installed CLI", async () => {
    await runRepoInitCommand({ repo: tmpDir, installedVersion: "0.0.14" });

    const config = loadRepoConfig(tmpDir);
    expect(config.version).toBe(1);
    expect(config.devrouter?.version).toBe("0.0.14");
  });

  it("does not overwrite existing config", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".devrouter.yml"),
      `version: 1
devrouter:
  version: 0.0.13
apps: []
`,
      "utf-8",
    );

    await runRepoInitCommand({ repo: tmpDir, installedVersion: "0.0.14" });

    const config = loadRepoConfig(tmpDir);
    expect(config.devrouter?.version).toBe("0.0.13");
  });
});
