import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOnboardingPrompt } from "../ai-prompt";
import { loadRepoConfig } from "../repo-config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-ai-prompt-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildOnboardingPrompt", () => {
  it("contains a canonical config skeleton that validates against parser", () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir });
    const skeletonMatch = prompt.match(/Canonical valid skeleton:\n```yaml\n([\s\S]*?)\n```/);
    expect(skeletonMatch).toBeTruthy();

    const skeleton = skeletonMatch?.[1];
    expect(skeleton).toContain("version: 1");

    fs.writeFileSync(path.join(tmpDir, ".devrouter.yml"), `${skeleton}\n`, "utf-8");
    const config = loadRepoConfig(tmpDir);
    expect(config.version).toBe(1);
    expect(config.apps).toEqual([]);
  });

  it("does not contain contradictory file-edit restrictions", () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir });
    expect(prompt).not.toContain("Create/update only REPO_PATH/.devrouter.yml.");
    expect(prompt).toContain("minimal related edits");
  });

  it("includes explicit tcp/tls onboarding sequence guidance", () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir });
    expect(prompt).toContain(
      "If any tcp/postgres app is configured, run `dev up` and `dev tls install` before runtime validation."
    );
  });
});
