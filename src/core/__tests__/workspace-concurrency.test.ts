import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceIdentityCandidates } from "../workspace";

const temporaryRepos: string[] = [];

afterEach(() => {
  for (const repoPath of temporaryRepos.splice(0)) {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

function startWorkspaceUp(repoPath: string, branch: string) {
  const fixture = path.join(__dirname, "fixtures", "workspace-up-create-only.ts");
  const child = spawn(process.execPath, ["--import", "tsx", fixture, repoPath, branch], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (stdout.includes("ready")) resolveReady();
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`workspace-up fixture exited ${code}: ${stderr}`));
    });
  });
  return { child, ready, exited };
}

function worktreePathsByBranch(repoPath: string): Map<string, string> {
  const output = execFileSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    encoding: "utf-8",
  });
  const result = new Map<string, string>();
  let worktreePath: string | undefined;
  for (const line of `${output}\n`.split("\n")) {
    if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length);
    if (line.startsWith("branch refs/heads/") && worktreePath) {
      result.set(line.slice("branch refs/heads/".length), worktreePath);
    }
    if (line === "") worktreePath = undefined;
  }
  return result;
}

describe("parallel workspace creation", () => {
  it("serializes colliding default paths across separate processes", async () => {
    const repoPath = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-workspace-concurrency-")),
    );
    temporaryRepos.push(repoPath);
    execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
    execFileSync("git", ["-C", repoPath, "config", "user.email", "devrouter@example.test"]);
    execFileSync("git", ["-C", repoPath, "config", "user.name", "Devrouter Test"]);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "trees/\n", "utf-8");
    fs.writeFileSync(path.join(repoPath, "README.md"), "test\n", "utf-8");
    execFileSync("git", ["-C", repoPath, "add", ".gitignore", "README.md"]);
    execFileSync("git", ["-C", repoPath, "commit", "-q", "-m", "test"]);

    const prefix = `rs/${"parallel-workspace-prefix-".repeat(2)}`;
    const firstBranch = `${prefix}one`;
    const secondBranch = `${prefix}two`;
    expect(workspaceIdentityCandidates(firstBranch)[0]).toBe(
      workspaceIdentityCandidates(secondBranch)[0],
    );

    const first = startWorkspaceUp(repoPath, firstBranch);
    const second = startWorkspaceUp(repoPath, secondBranch);
    await Promise.all([first.ready, second.ready]);
    first.child.stdin.end();
    second.child.stdin.end();
    await Promise.all([first.exited, second.exited]);

    const paths = worktreePathsByBranch(repoPath);
    const firstPath = paths.get(firstBranch);
    const secondPath = paths.get(secondBranch);
    expect(firstPath).toBeDefined();
    expect(secondPath).toBeDefined();
    expect(firstPath).not.toBe(secondPath);
    expect([firstPath, secondPath]).toContain(
      path.join(repoPath, "trees", workspaceIdentityCandidates(firstBranch)[0]),
    );
  });
});
