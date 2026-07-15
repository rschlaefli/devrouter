import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAppLsCommand } from "../app-ls";
import { runRepoInspectCommand } from "../repo-inspect";

let tmpDir: string;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-non-git-compat-test-"));
  fs.writeFileSync(
    path.join(tmpDir, ".devrouter.yml"),
    `version: 1
apps:
  - name: web
    host: web.localhost
    protocol: http
    runtime: proxy
    upstream: 127.0.0.1:3000
`,
    "utf-8",
  );
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdout.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("non-Git repository compatibility", () => {
  it("loads app configuration and repository diagnostics without Git metadata", async () => {
    await runAppLsCommand({ repo: tmpDir, json: true });
    await runRepoInspectCommand({ repo: tmpDir, json: true });

    const output = stdout.mock.calls.flat().map(String).join("");
    expect(output).toContain('"name": "web"');
    expect(output).toContain('"devrouter"');
    expect(output).toContain('"valid": true');
    expect(fs.existsSync(path.join(tmpDir, ".git"))).toBe(false);
  });
});
