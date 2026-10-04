import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyReclaimManifest,
  candidateId,
  canonicalJson,
  MANIFEST_KIND,
  type ManifestCandidate,
  type ReclaimApplyDependencies,
  readManifest,
  readWorktreeIdentity,
  receiptPath,
  selectManifest,
  sha256Hex,
  validateManifest,
} from "../worktree-reclaim";
import type { WorktreeSafetyResult } from "../worktree-safety";

const MANIFEST_PY = path.resolve(
  __dirname,
  "../../../.agents/skills/worktree-reclaim/scripts/manifest.py",
);
const RECLAIM: WorktreeSafetyResult = { verdict: "RECLAIM", codes: [], reasons: [] };

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

function addWorktree(name: string): ManifestCandidate {
  const worktreePath = path.join(repo, "trees", name);
  git(repo, "worktree", "add", "-q", "-b", name, worktreePath);
  const identity = readWorktreeIdentity(worktreePath);
  if (!identity) throw new Error("identity unreadable");
  const candidate = {
    ...identity,
    branch: name,
    reason: "merged change, clean, quiet",
  };
  return { ...candidate, id: candidateId(candidate) };
}

function writeManifest(candidates: ManifestCandidate[], createdAtEpoch = now()): string {
  const sorted = [...candidates].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const file = path.join(root, `manifest-${sorted.length}-${createdAtEpoch}.json`);
  fs.writeFileSync(
    file,
    canonicalJson({
      action: "reclaim",
      activitySource: "devrouter",
      candidateCount: sorted.length,
      candidates: sorted,
      createdAtEpoch,
      kind: MANIFEST_KIND,
      schemaVersion: 1,
    }),
  );
  return file;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function hashOf(file: string): string {
  return sha256Hex(fs.readFileSync(file));
}

function dependencies(
  overrides: Partial<{
    verdict: WorktreeSafetyResult;
    active: boolean;
    failOn: string;
  }> = {},
): ReclaimApplyDependencies & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    prepare: () => ({
      forge: { status: "listed", provider: "github", changes: [] },
      classify: () => overrides.verdict ?? RECLAIM,
      isActive: () => overrides.active ?? false,
    }),
    removeWorktree: async (candidate, verify, steps) => {
      verify();
      if (overrides.failOn === candidate.branch) {
        steps.push("runtime-deleted");
        throw new Error("simulated teardown failure");
      }
      git(candidate.repo, "worktree", "remove", candidate.path);
      steps.push("worktree-removed");
      removed.push(candidate.branch);
    },
  };
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wt-reclaim-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README"), "x\n");
  git(repo, "add", "README");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("reclaim manifests", () => {
  it("reads a skill-created manifest and selects byte-identically to manifest.py", () => {
    const candidates = [addWorktree("alpha"), addWorktree("beta")];
    const rows = path.join(root, "rows");
    fs.writeFileSync(
      rows,
      candidates
        .map((candidate) =>
          [
            candidate.repo,
            candidate.path,
            candidate.branch,
            "SAFE-TO-PURGE",
            candidate.reason,
            "no session",
            "",
            "",
            "",
            candidate.head,
            candidate.branchRef,
            candidate.commonDir,
            candidate.gitDir,
            "",
          ].join("\x1f"),
        )
        .join("\n"),
    );
    const created = spawnSync(
      "python3",
      [
        MANIFEST_PY,
        "create",
        "--rows",
        rows,
        "--created-at-epoch",
        String(now()),
        "--active-within",
        "24h",
        "--active-within-seconds",
        "86400",
        "--all-history",
        "0",
      ],
      { encoding: "utf-8" },
    );
    expect(created.status, created.stderr).toBe(0);
    const file = path.join(root, "skill.json");
    fs.writeFileSync(file, created.stdout);

    const { manifest } = readManifest(file);
    expect(manifest.candidates.map((candidate) => candidate.id)).toEqual(
      candidates.map((candidate) => candidate.id).sort(),
    );
    const sha = hashOf(file);
    const python = spawnSync(
      "python3",
      [MANIFEST_PY, "select", file, "--expected-sha256", sha, "--id", candidates[1].id],
      { encoding: "utf-8" },
    );
    expect(python.status, python.stderr).toBe(0);
    expect(selectManifest(file, sha, [candidates[1].id])).toBe(python.stdout);
  });

  it("rejects tampered identities, order and non-canonical files", () => {
    const [alpha, beta] = [addWorktree("alpha"), addWorktree("beta")];
    const file = writeManifest([alpha, beta]);
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));

    expect(() =>
      validateManifest({ ...parsed, candidates: [{ ...alpha, head: "0".repeat(40) }, beta] }),
    ).toThrow(/does not match its immutable identity/);
    expect(() => validateManifest({ ...parsed, candidates: [beta, alpha] })).toThrow(
      /canonical order/,
    );
    expect(() =>
      validateManifest({ ...parsed, candidates: [{ ...alpha, paths: ["node_modules"] }, beta] }),
    ).toThrow(/only valid in a trim manifest/);
    fs.writeFileSync(file, JSON.stringify(parsed));
    expect(() => readManifest(file)).toThrow(/canonical JSON/);
  });
});

describe("applyReclaimManifest", () => {
  it("refuses a wrong hash and a stale manifest before touching anything", async () => {
    const file = writeManifest([addWorktree("alpha")], now() - 2 * 86400);
    const deps = dependencies();
    await expect(
      applyReclaimManifest(
        { manifestFile: file, sha256: "f".repeat(64), maxAgeSeconds: 86400, yes: true },
        deps,
      ),
    ).rejects.toThrow(/SHA-256 mismatch/);
    await expect(
      applyReclaimManifest(
        { manifestFile: file, sha256: hashOf(file), maxAgeSeconds: 86400, yes: true },
        deps,
      ),
    ).rejects.toThrow(/maximum allowed age/);
    expect(deps.removed).toEqual([]);
  });

  it("dry-runs, reclaims with receipts, and treats a rerun as already done", async () => {
    const alpha = addWorktree("alpha");
    const file = writeManifest([alpha]);
    const sha256 = hashOf(file);
    const options = { manifestFile: file, sha256, maxAgeSeconds: 86400 };

    const dry = await applyReclaimManifest({ ...options, yes: false }, dependencies());
    expect(dry.targets.map((target) => target.status)).toEqual(["would-reclaim"]);
    expect(fs.existsSync(alpha.path)).toBe(true);

    const applied = await applyReclaimManifest({ ...options, yes: true }, dependencies());
    expect(applied.targets[0]).toMatchObject({
      status: "reclaimed",
      steps: ["worktree-removed", "branch-deleted"],
    });
    expect(fs.existsSync(alpha.path)).toBe(false);
    expect(git(repo, "branch", "--list", "alpha")).toBe("");
    expect(fs.existsSync(receiptPath(alpha.commonDir, sha256, alpha.id))).toBe(true);

    const rerun = await applyReclaimManifest({ ...options, yes: true }, dependencies());
    expect(rerun.targets.map((target) => target.status)).toEqual(["already-done"]);
  });

  it("skips a tree whose HEAD moved, whose verdict changed, or that a veto denies", async () => {
    const [alpha, beta] = [addWorktree("alpha"), addWorktree("beta")];
    const file = writeManifest([alpha, beta]);
    const options = { manifestFile: file, sha256: hashOf(file), maxAgeSeconds: 86400 };
    git(alpha.path, "commit", "-q", "--allow-empty", "-m", "late work");

    const kept = await applyReclaimManifest(
      { ...options, yes: true },
      dependencies({ verdict: { verdict: "KEEP", codes: ["dirty"], reasons: ["dirty"] } }),
    );
    expect(kept.targets.map((target) => target.code)).toEqual(["stale-identity", "verdict-keep"]);

    const veto = path.join(root, "veto.sh");
    fs.writeFileSync(veto, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const vetoed = await applyReclaimManifest(
      { ...options, vetoCommand: veto, yes: true },
      dependencies(),
    );
    expect(vetoed.targets[1]).toMatchObject({ status: "skipped", code: "veto-denied" });
    expect(fs.existsSync(beta.path)).toBe(true);
  });

  it("stops the batch after a half-finished teardown and names its completed steps", async () => {
    const [alpha, beta] = [addWorktree("alpha"), addWorktree("beta")];
    const file = writeManifest([alpha, beta]);
    const report = await applyReclaimManifest(
      { manifestFile: file, sha256: hashOf(file), maxAgeSeconds: 86400, yes: true },
      dependencies({ failOn: "alpha" }),
    );
    expect(report.stoppedEarly).toBe(true);
    expect(report.targets).toMatchObject([
      { status: "failed", code: "teardown-failed", steps: ["runtime-deleted"] },
      { status: "not-attempted" },
    ]);
    expect(fs.existsSync(beta.path)).toBe(true);
  });

  it("refuses a missing veto command as an environment failure", async () => {
    const file = writeManifest([addWorktree("alpha")]);
    await expect(
      applyReclaimManifest(
        {
          manifestFile: file,
          sha256: hashOf(file),
          maxAgeSeconds: 86400,
          vetoCommand: path.join(root, "missing-veto"),
          yes: true,
        },
        dependencies(),
      ),
    ).rejects.toThrow(/missing or not executable/);
  });
});
