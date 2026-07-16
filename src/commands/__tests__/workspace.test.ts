import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEnsureCommand } from "../ensure";
import { resolveGitCheckoutPath } from "../environment-path";
import { runStopCommand } from "../stop";
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
      () => runWorkspaceLsCommand({ repo: tmpDir }),
      () => runWorkspaceStopCommand("test", { repo: tmpDir }),
      () => runWorkspaceDownCommand("test", { repo: tmpDir }),
      () => runWorkspaceGcCommand({ repo: tmpDir }),
    ];

    for (const command of commands) {
      await expect(Promise.resolve().then(command)).rejects.toThrow(expected);
    }

    const environmentExpected = `Environment commands require a Git repository: '${tmpDir}'.`;
    const environmentCommands = [
      () => runWorkspaceEnsureCommand({ path: tmpDir }),
      () => runEnsureCommand({ path: tmpDir }),
      () => runStopCommand({ path: tmpDir }),
    ];
    for (const command of environmentCommands) {
      await expect(Promise.resolve().then(command)).rejects.toThrow(environmentExpected);
    }
  });

  it("normalizes a nested path to the exact Git checkout root", () => {
    const initialized = spawnSync("git", ["init", "-q", tmpDir], { encoding: "utf-8" });
    expect(initialized.status).toBe(0);
    const nested = path.join(tmpDir, "src", "nested");
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveGitCheckoutPath(nested)).toBe(fs.realpathSync(tmpDir));
  });
});
