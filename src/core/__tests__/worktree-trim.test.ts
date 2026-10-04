import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceCleanupReport } from "../workspace-cleanup";
import {
  candidateId,
  canonicalJson,
  MANIFEST_KIND,
  type ManifestCandidate,
  readManifest,
  readWorktreeIdentity,
  receiptPath,
  sha256Hex,
} from "../worktree-reclaim";
import {
  applyTrimManifest,
  buildTrimManifest,
  type TrimApplyDependencies,
  type TrimVerdictContext,
} from "../worktree-trim";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

let root: string;
let repo: string;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function addWorktree(name: string, paths: string[] = []): ManifestCandidate {
  const worktreePath = path.join(repo, "trees", name);
  git(repo, "worktree", "add", "-q", "-b", name, worktreePath);
  const identity = readWorktreeIdentity(worktreePath);
  if (!identity) throw new Error("identity unreadable");
  const candidate = { ...identity, branch: name, paths, reason: "declared trim paths" };
  return { ...candidate, id: candidateId(candidate) };
}

function writeManifest(candidates: ManifestCandidate[], action = "trim"): string {
  const file = path.join(root, `manifest-${action}-${candidates.length}.json`);
  fs.writeFileSync(
    file,
    canonicalJson({
      action,
      activitySource: "devrouter",
      candidateCount: candidates.length,
      candidates: action === "trim" ? candidates : candidates.map(({ paths: _, ...rest }) => rest),
      createdAtEpoch: now(),
      kind: MANIFEST_KIND,
      schemaVersion: 1,
    }),
  );
  return file;
}

function dependencies(
  overrides: { blockers?: string[]; active?: boolean; patterns?: string[] } = {},
): TrimApplyDependencies {
  const context: TrimVerdictContext = {
    patterns: overrides.patterns ?? ["node_modules", "cache-dir", "linked", "outer/**"],
    blockers: () => overrides.blockers ?? [],
    isActive: () => overrides.active ?? false,
  };
  return {
    prepare: () => context,
    withLock: async (_path, operation) => operation(),
  };
}

function options(file: string, yes = true) {
  return {
    manifestFile: file,
    sha256: sha256Hex(fs.readFileSync(file)),
    maxAgeSeconds: 86400,
    yes,
  };
}

function populate(worktree: string, relative: string): void {
  fs.mkdirSync(path.join(worktree, relative), { recursive: true });
  fs.writeFileSync(path.join(worktree, relative, "artifact"), "x\n");
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wt-trim-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README"), "x\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\ncache-dir\nsecrets.env\ntrees\n");
  git(repo, "add", "README", ".gitignore");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildTrimManifest", () => {
  function report(trees: string[]): WorkspaceCleanupReport {
    return {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      repoPath: repo,
      inactiveFor: "14d",
      cutoff: new Date(Date.now() + 60_000).toISOString(),
      checkMerged: false,
      measureSize: false,
      workspaces: [],
      worktrees: trees.map((worktreePath) => ({
        worktreePath,
        branch: path.basename(worktreePath),
        safety: { verdict: "KEEP", codes: ["forge-not-checked"], reasons: [] },
      })),
    };
  }

  it("lists only declared trim paths of trees that stay clean once they are trimmed", () => {
    const plain = addWorktree("plain");
    const withState = addWorktree("with-state");
    const empty = addWorktree("empty");
    populate(plain.path, "node_modules");
    populate(withState.path, "node_modules");
    fs.writeFileSync(path.join(withState.path, "secrets.env"), "keep me\n");
    const trees = [plain.path, withState.path, empty.path];

    const manifest = buildTrimManifest(report(trees), { trim: ["node_modules"] }, now());
    const file = path.join(root, "built.json");
    fs.writeFileSync(file, manifest);
    const { manifest: parsed } = readManifest(file);

    expect(parsed.action).toBe("trim");
    expect(parsed.candidates.map((candidate) => [candidate.branch, candidate.paths])).toEqual([
      ["plain", ["node_modules"]],
    ]);
    expect(fs.existsSync(path.join(plain.path, "node_modules"))).toBe(true);
    expect(readManifestCount(buildTrimManifest(report(trees), { trim: [] }, now()))).toBe(0);
  });

  function readManifestCount(manifest: string): number {
    return (JSON.parse(manifest) as { candidateCount: number }).candidateCount;
  }
});

describe("applyTrimManifest", () => {
  it("dry-runs, trims the declared paths with a receipt, and treats a rerun as done", async () => {
    const alpha = addWorktree("alpha", ["cache-dir", "node_modules"]);
    populate(alpha.path, "node_modules");
    populate(alpha.path, "cache-dir");
    populate(alpha.path, "other");
    const file = writeManifest([alpha]);

    const dry = await applyTrimManifest(options(file, false), dependencies());
    expect(dry.targets[0].status).toBe("would-trim");
    expect(fs.existsSync(path.join(alpha.path, "node_modules"))).toBe(true);

    const applied = await applyTrimManifest(options(file), dependencies());
    expect(applied.targets[0]).toMatchObject({
      status: "trimmed",
      steps: ["removed:cache-dir", "removed:node_modules"],
    });
    expect(fs.existsSync(path.join(alpha.path, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(alpha.path, "other", "artifact"))).toBe(true);
    expect(fs.existsSync(alpha.path)).toBe(true);
    expect(fs.existsSync(receiptPath(alpha.commonDir, options(file).sha256, alpha.id))).toBe(true);

    const rerun = await applyTrimManifest(options(file), dependencies());
    expect(rerun.targets[0].status).toBe("already-done");
  });

  it("keeps tracked files, symlinks and paths that resolve outside the tree", async () => {
    const alpha = addWorktree("alpha", ["cache-dir", "linked", "outer/inner"]);
    const outside = path.join(root, "outside");
    populate(outside, "inner");
    populate(alpha.path, "cache-dir");
    git(alpha.path, "add", "-f", "cache-dir/artifact");
    git(alpha.path, "commit", "-q", "-m", "track");
    fs.symlinkSync(outside, path.join(alpha.path, "linked"));
    fs.symlinkSync(outside, path.join(alpha.path, "outer"));
    const identity = readWorktreeIdentity(alpha.path);
    if (!identity) throw new Error("identity unreadable");
    const moved = { ...alpha, ...identity };
    const file = writeManifest([{ ...moved, id: candidateId(moved) }]);

    const report = await applyTrimManifest(options(file), dependencies());

    expect(report.targets[0].steps).toEqual([
      "skipped-tracked:cache-dir",
      "skipped-symlink:linked",
      "skipped-outside:outer/inner",
    ]);
    expect(report.targets[0].status).toBe("skipped");
    expect(fs.existsSync(path.join(alpha.path, "cache-dir", "artifact"))).toBe(true);
    expect(fs.existsSync(path.join(outside, "inner", "artifact"))).toBe(true);
    expect(fs.lstatSync(path.join(alpha.path, "linked")).isSymbolicLink()).toBe(true);
  });

  it("skips dirty, running and active trees and stale identities", async () => {
    const alpha = addWorktree("alpha", ["node_modules"]);
    const beta = addWorktree("beta", ["node_modules"]);
    populate(alpha.path, "node_modules");
    populate(beta.path, "node_modules");
    const file = writeManifest([alpha, beta]);

    const dirty = await applyTrimManifest(options(file), dependencies({ blockers: ["dirty"] }));
    expect(dirty.targets.map((target) => target.code)).toEqual(["verdict-keep", "verdict-keep"]);
    const running = await applyTrimManifest(
      options(file),
      dependencies({ blockers: ["runtime-running"] }),
    );
    expect(running.targets[0].code).toBe("verdict-keep");
    const active = await applyTrimManifest(options(file), dependencies({ active: true }));
    expect(active.targets.map((target) => target.code)).toEqual(["active", "active"]);

    git(alpha.path, "commit", "-q", "--allow-empty", "-m", "late work");
    const stale = await applyTrimManifest(options(file), dependencies());
    expect(stale.targets.map((target) => [target.status, target.code])).toEqual([
      ["skipped", "stale-identity"],
      ["trimmed", undefined],
    ]);
    expect(fs.existsSync(path.join(alpha.path, "node_modules"))).toBe(true);
    expect(fs.existsSync(path.join(beta.path, "node_modules"))).toBe(false);
  });

  it("refuses a reclaim manifest", async () => {
    const file = writeManifest([addWorktree("alpha", ["node_modules"])], "reclaim");
    await expect(applyTrimManifest(options(file), dependencies())).rejects.toThrow(
      /workspace reclaim/,
    );
  });
});
