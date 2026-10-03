import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectLocalWorktreeSafety,
  matchesWorktreePattern,
  normalizeOverridePattern,
} from "../worktree-safety";

describe("matchesWorktreePattern", () => {
  it("matches one segment with * and any depth with **", () => {
    expect(matchesWorktreePattern("apps/*/.next", "apps/web/.next/")).toBe(true);
    expect(matchesWorktreePattern("apps/*/.next", "apps/web/nested/.next")).toBe(false);
    expect(matchesWorktreePattern("**/.next", ".next/")).toBe(true);
    expect(matchesWorktreePattern("**/.next", "apps/web/.next")).toBe(true);
    expect(matchesWorktreePattern("**/*.log", "logs/debug.log")).toBe(true);
    expect(matchesWorktreePattern("**/*.log", "debug.log.bak")).toBe(false);
  });

  it("covers everything beneath a matched path", () => {
    expect(matchesWorktreePattern("**/node_modules", "pkg/node_modules/x/y.js")).toBe(true);
  });

  it("rejects absolute and parent-relative patterns", () => {
    expect(matchesWorktreePattern("/etc", "etc")).toBe(false);
    expect(matchesWorktreePattern("../x", "x")).toBe(false);
  });
});

describe("normalizeOverridePattern", () => {
  it("converts the earlier case syntax to the pattern grammar", () => {
    expect(normalizeOverridePattern("*/apps/*/public/sw.js/")).toBe("**/apps/*/public/sw.js");
    expect(normalizeOverridePattern("*/packages/client/*")).toBe("**/packages/client");
    expect(normalizeOverridePattern("uploads/tmp")).toBe("uploads/tmp");
  });

  it("drops comments, blanks and invalid lines", () => {
    expect(normalizeOverridePattern("# note")).toBeUndefined();
    expect(normalizeOverridePattern("   ")).toBeUndefined();
    expect(normalizeOverridePattern("/abs/path")).toBeUndefined();
    expect(normalizeOverridePattern("*/../escape")).toBeUndefined();
  });
});

describe("inspectLocalWorktreeSafety", () => {
  let repoPath: string;
  let worktreePath: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

  beforeEach(() => {
    repoPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-safety-")));
    execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
    git(repoPath, "config", "user.email", "devrouter@example.test");
    git(repoPath, "config", "user.name", "Devrouter Test");
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "node_modules/\nuploads/\n*.local\n");
    fs.writeFileSync(path.join(repoPath, "README.md"), "test\n");
    git(repoPath, "add", ".");
    git(repoPath, "commit", "-q", "-m", "test");
    worktreePath = path.join(repoPath, "trees", "feature");
    git(repoPath, "worktree", "add", "-q", "-b", "feature", worktreePath);
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("reports a clean worktree with disposable ignored output as safe", () => {
    fs.mkdirSync(path.join(worktreePath, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "node_modules", "pkg", "index.js"), "x");
    fs.writeFileSync(path.join(worktreePath, "empty.local"), "");
    expect(inspectLocalWorktreeSafety(worktreePath).codes).toEqual([]);
  });

  it("reports dirty, untracked and unrecognized ignored state", () => {
    fs.writeFileSync(path.join(worktreePath, "README.md"), "changed\n");
    fs.writeFileSync(path.join(worktreePath, "notes.txt"), "draft");
    fs.mkdirSync(path.join(worktreePath, "uploads"));
    fs.writeFileSync(path.join(worktreePath, "uploads", "photo.png"), "data");
    const safety = inspectLocalWorktreeSafety(worktreePath);
    expect(safety.codes).toEqual(["dirty", "untracked", "ignored-state"]);
    expect(safety.examples["ignored-state"]).toEqual(["uploads"]);
  });

  it("accepts ignored paths named in the repository override", () => {
    fs.mkdirSync(path.join(worktreePath, "uploads"));
    fs.writeFileSync(path.join(worktreePath, "uploads", "photo.png"), "data");
    fs.writeFileSync(
      path.join(repoPath, ".git", "info", "worktree-reclaim-disposable"),
      "*/uploads/\n",
    );
    expect(inspectLocalWorktreeSafety(worktreePath).codes).toEqual([]);
  });

  it("reports detached HEAD, an index lock and an unfinished operation", () => {
    git(worktreePath, "checkout", "-q", "--detach");
    const gitDir = git(worktreePath, "rev-parse", "--absolute-git-dir");
    fs.writeFileSync(path.join(gitDir, "index.lock"), "");
    fs.writeFileSync(
      path.join(gitDir, "MERGE_HEAD"),
      `${git(worktreePath, "rev-parse", "HEAD")}\n`,
    );
    expect(inspectLocalWorktreeSafety(worktreePath).codes).toEqual([
      "detached",
      "index-lock",
      "operation-in-progress",
    ]);
  });

  it("reports initialized submodule state", () => {
    const gitDir = git(worktreePath, "rev-parse", "--absolute-git-dir");
    fs.mkdirSync(path.join(gitDir, "modules", "lib"), { recursive: true });
    expect(inspectLocalWorktreeSafety(worktreePath).codes).toEqual(["submodule"]);
  });

  it("fails closed when the path is not a Git worktree", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-not-git-"));
    try {
      expect(inspectLocalWorktreeSafety(outside).codes).toEqual(["git-error"]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
