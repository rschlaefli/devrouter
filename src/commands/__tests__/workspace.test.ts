import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runWorkspaceDownCommand,
  runWorkspaceEnsureCommand,
  runWorkspaceGcCommand,
  runWorkspaceLsCommand,
  runWorkspaceStopCommand,
  runWorkspaceUpCommand,
} from "../workspace";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-non-git-workspace-test-"));
  fs.writeFileSync(path.join(tmpDir, ".devrouter.yml"), "version: 1\napps: []\n", "utf-8");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("workspace commands outside Git", () => {
  it("fail early with one clear Git-required error", async () => {
    const expected = `Workspace commands require a Git repository: '${tmpDir}'.`;
    const commands = [
      () => runWorkspaceUpCommand("feat/test", { repo: tmpDir }),
      () => runWorkspaceEnsureCommand({ path: tmpDir }),
      () => runWorkspaceLsCommand({ repo: tmpDir }),
      () => runWorkspaceStopCommand("test", { repo: tmpDir }),
      () => runWorkspaceDownCommand("test", { repo: tmpDir }),
      () => runWorkspaceGcCommand({ repo: tmpDir }),
    ];

    for (const command of commands) {
      await expect(Promise.resolve().then(command)).rejects.toThrow(expected);
    }
  });
});
