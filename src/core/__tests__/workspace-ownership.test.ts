import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workspace from "../workspace";
import { workspaceIdentityCandidates } from "../workspace";
import {
  claimWorkspaceIdentity,
  inspectWorkspaceOwnership,
  listGitWorktrees,
  listWorkspaceOwnership,
  readWorkspaceOwnership,
  removeWorkspaceOwnership,
  resolveGitCommonDir,
  withWorkspaceOwnershipTransaction,
  writeWorkspaceOwnership,
} from "../workspace-ownership";

let repoPath: string;
let worktreePath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-owner-"));
  repoPath = fs.realpathSync.native(repoPath);
  execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "devrouter@example.test"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Devrouter Test"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "test\n");
  execFileSync("git", ["-C", repoPath, "add", "README.md"]);
  execFileSync("git", ["-C", repoPath, "commit", "-q", "-m", "test"]);
  worktreePath = path.join(repoPath, "trees", "feature");
  execFileSync("git", ["-C", repoPath, "worktree", "add", "-q", "-b", "feature", worktreePath]);
  const gitDir = execFileSync("git", ["-C", worktreePath, "rev-parse", "--git-dir"], {
    encoding: "utf-8",
  }).trim();
  fs.writeFileSync(path.join(gitDir, "devrouter-workspace"), "feature\n");
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("workspace ownership storage", () => {
  it("stores one versioned record in the repository common directory", () => {
    const now = "2026-07-15T10:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const record = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    expect(record).toEqual({
      version: 1,
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
      createdAt: now,
      updatedAt: now,
    });
    expect(readWorkspaceOwnership(repoPath, "feature")).toEqual(record);
    expect(listWorkspaceOwnership(repoPath)).toEqual([record]);
    expect(
      fs.existsSync(
        path.join(resolveGitCommonDir(repoPath), "devrouter", "workspaces", "feature.json"),
      ),
    ).toBe(true);
  });

  it("refreshes updatedAt while preserving createdAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-15T10:00:00.000Z");
    writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    vi.setSystemTime("2026-07-15T11:00:00.000Z");
    const refreshed = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "renamed",
      devpodId: "feature",
    });

    expect(refreshed.createdAt).toBe("2026-07-15T10:00:00.000Z");
    expect(refreshed.updatedAt).toBe("2026-07-15T11:00:00.000Z");
    expect(refreshed.branch).toBe("renamed");
  });

  it("rejects workspace or path ownership conflicts", () => {
    writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    expect(() =>
      writeWorkspaceOwnership(worktreePath, {
        workspace: "feature",
        worktreePath: path.join(repoPath, "trees", "other"),
        branch: "feature",
        devpodId: "feature",
      }),
    ).toThrow("already belongs to");
    expect(() =>
      writeWorkspaceOwnership(worktreePath, {
        workspace: "other",
        worktreePath,
        branch: "other",
        devpodId: "other",
      }),
    ).toThrow("already owned by workspace 'feature'");
  });

  it("enforces cross-record path uniqueness inside one repository transaction", () => {
    const ownershipDir = path.join(resolveGitCommonDir(repoPath), "devrouter", "workspaces");
    withWorkspaceOwnershipTransaction(repoPath, (transaction) => {
      expect(fs.existsSync(path.join(ownershipDir, ".lock"))).toBe(true);
      transaction.write({
        workspace: "feature",
        worktreePath,
        branch: "feature",
        devpodId: "feature",
      });
      expect(() =>
        transaction.write({
          workspace: "other",
          worktreePath,
          branch: "other",
          devpodId: "other",
        }),
      ).toThrow("already owned by workspace 'feature'");
    });
  });

  it("removes only the exact workspace record", () => {
    writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    expect(removeWorkspaceOwnership(repoPath, "feature")).toBe(true);
    expect(removeWorkspaceOwnership(repoPath, "feature")).toBe(false);
    expect(readWorkspaceOwnership(repoPath, "feature")).toBeUndefined();
  });

  it("does not remove an ownership record that changed after inspection", () => {
    const expected = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });
    writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "renamed",
      devpodId: "feature",
    });

    expect(
      withWorkspaceOwnershipTransaction(repoPath, (transaction) =>
        transaction.removeIfMatches(expected),
      ),
    ).toBe("changed");
    expect(readWorkspaceOwnership(repoPath, "feature")).toBeDefined();
  });
});

describe("workspace identity claims", () => {
  const collidingSource = `feature-${"a".repeat(40)}`;

  function removePersistedIdentity(): void {
    const gitDir = execFileSync("git", ["-C", worktreePath, "rev-parse", "--git-dir"], {
      encoding: "utf-8",
    }).trim();
    fs.rmSync(path.join(gitDir, "devrouter-workspace"), { force: true });
  }

  function claim(
    source = collidingSource,
    providerWorkspaces: { id: string; source: { localFolder: string } }[] = [],
    unavailableRuntimes: string[] = [],
  ) {
    return claimWorkspaceIdentity(worktreePath, {
      source,
      branch: source,
      providerWorkspaces,
      unavailableRuntimes,
    });
  }

  it("reuses agreeing persisted metadata, ledger, and provider evidence", () => {
    const record = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    const claimed = claim("feature", [{ id: "feature", source: { localFolder: worktreePath } }]);
    expect(claimed).toMatchObject({
      ...record,
      updatedAt: expect.any(String),
    });
  });

  it("fails closed when persisted metadata and the ledger disagree", () => {
    const record = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });
    const gitDir = execFileSync("git", ["-C", worktreePath, "rev-parse", "--git-dir"], {
      encoding: "utf-8",
    }).trim();
    fs.writeFileSync(path.join(gitDir, "devrouter-workspace"), "other\n", "utf-8");

    expect(() => claim("feature")).toThrow(
      "Persisted workspace identity 'other' disagrees with owner record 'feature'",
    );
    expect(readWorkspaceOwnership(repoPath, record.workspace)).toEqual(record);
  });

  it("fails closed when a provider registration disagrees with an established owner", () => {
    writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    expect(() =>
      claim("feature", [{ id: "other", source: { localFolder: worktreePath } }]),
    ).toThrow("Workspace runtime 'other' disagrees with owner record 'feature'");
  });

  it("serially allocates distinct identities for colliding branch prefixes", () => {
    removePersistedIdentity();
    const first = claim();

    const secondPath = path.join(repoPath, "trees", "feature-second");
    const secondSource = `feature-${"a".repeat(40)}-two`;
    execFileSync("git", ["-C", repoPath, "worktree", "add", "-q", "-b", secondSource, secondPath]);
    const secondGitDir = execFileSync("git", ["-C", secondPath, "rev-parse", "--git-dir"], {
      encoding: "utf-8",
    }).trim();
    const second = claimWorkspaceIdentity(secondPath, {
      source: secondSource,
      branch: secondSource,
      providerWorkspaces: [],
      unavailableRuntimes: [],
    });

    expect(first.workspace).toBe(workspaceIdentityCandidates(collidingSource)[0]);
    expect(second.workspace).toBe(workspaceIdentityCandidates(secondSource)[1]);
    expect(second.workspace).not.toBe(first.workspace);
    expect(fs.existsSync(path.join(secondGitDir, "devrouter-workspace"))).toBe(true);
  });

  it("uses a fallback when another provider occupies the readable candidate", () => {
    removePersistedIdentity();
    const result = claim(collidingSource, [
      { id: workspaceIdentityCandidates(collidingSource)[0], source: { localFolder: "/other" } },
    ]);

    expect(result.workspace).toBe(workspaceIdentityCandidates(collidingSource)[1]);
    expect(result.devpodId).toBe(result.workspace);
  });

  it("does not claim a new identity when a runtime registry is unreadable", () => {
    removePersistedIdentity();

    expect(() => claim(collidingSource, [], ["devsy"])).toThrow(
      "these runtime registries are unavailable: devsy",
    );
    expect(listWorkspaceOwnership(repoPath)).toEqual([]);
    expect(readWorkspaceOwnership(repoPath, workspaceIdentityCandidates(collidingSource)[0])).toBe(
      undefined,
    );
  });

  it("removes a newly written ledger record when metadata persistence fails", () => {
    removePersistedIdentity();
    const persistSpy = vi.spyOn(workspace, "persistWorkspace").mockImplementation(() => {
      throw new Error("metadata is read-only");
    });

    expect(() => claim()).toThrow("metadata is read-only");
    expect(listWorkspaceOwnership(repoPath)).toEqual([]);
    persistSpy.mockRestore();
  });

  it("recovers a crash after ledger creation by persisting the exact ledger identity", () => {
    removePersistedIdentity();
    const record = writeWorkspaceOwnership(worktreePath, {
      workspace: workspaceIdentityCandidates(collidingSource)[0],
      worktreePath,
      branch: collidingSource,
      devpodId: workspaceIdentityCandidates(collidingSource)[0],
    });

    expect(claim()).toMatchObject({
      ...record,
      updatedAt: expect.any(String),
    });
    expect(
      fs.readFileSync(
        path.join(repoPath, ".git", "worktrees", "feature", "devrouter-workspace"),
        "utf-8",
      ),
    ).toBe(`${record.workspace}\n`);
  });

  it("stops after the bounded candidate set is occupied", () => {
    removePersistedIdentity();
    const candidates = workspaceIdentityCandidates(collidingSource);
    withWorkspaceOwnershipTransaction(repoPath, (transaction) => {
      for (const [index, workspace] of candidates.entries()) {
        transaction.write({
          workspace,
          worktreePath: path.join(repoPath, "trees", `occupied-${index}`),
          branch: null,
          devpodId: workspace,
        });
      }
    });

    expect(() => claim()).toThrow("Could not allocate a collision-safe workspace identity");
    expect(listWorkspaceOwnership(repoPath)).toHaveLength(candidates.length);
  });
});

describe("Git worktree evidence", () => {
  it("parses live and locked worktree metadata", () => {
    execFileSync("git", ["-C", repoPath, "worktree", "lock", worktreePath]);

    expect(listGitWorktrees(repoPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: repoPath, branch: "main", locked: false, prunable: false }),
        expect.objectContaining({
          path: worktreePath,
          branch: "feature",
          locked: true,
          prunable: false,
        }),
      ]),
    );
  });

  it("reports Git-prunable metadata after an out-of-band directory removal", () => {
    fs.rmSync(worktreePath, { recursive: true });

    expect(listGitWorktrees(repoPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: worktreePath,
          branch: "feature",
          locked: false,
          prunable: true,
        }),
      ]),
    );
  });
});

describe("workspace ownership status", () => {
  it("classifies exact Git, token, and DevPod evidence as present", () => {
    const record = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    expect(
      inspectWorkspaceOwnership(record, listGitWorktrees(repoPath), [
        { id: "feature", source: { localFolder: worktreePath } },
      ]),
    ).toMatchObject({ ownerStatus: "present", devpodStatus: "owned" });
  });

  it("keeps Git ownership present when DevPod discovery is unavailable", () => {
    const record = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    expect(inspectWorkspaceOwnership(record, listGitWorktrees(repoPath), undefined)).toMatchObject({
      ownerStatus: "present",
      devpodStatus: "unknown",
    });
  });

  it("classifies removed, locked, and DevPod-conflicting owners without mutation", () => {
    const record = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });
    const liveWorktrees = listGitWorktrees(repoPath);

    expect(
      inspectWorkspaceOwnership(record, liveWorktrees, [
        { id: "feature", source: { localFolder: path.join(repoPath, "trees", "other") } },
      ]).ownerStatus,
    ).toBe("conflict");

    execFileSync("git", ["-C", repoPath, "worktree", "lock", worktreePath]);
    expect(inspectWorkspaceOwnership(record, listGitWorktrees(repoPath), []).ownerStatus).toBe(
      "locked",
    );

    execFileSync("git", ["-C", repoPath, "worktree", "unlock", worktreePath]);
    fs.rmSync(worktreePath, { recursive: true });
    expect(inspectWorkspaceOwnership(record, listGitWorktrees(repoPath), []).ownerStatus).toBe(
      "missing",
    );
  });

  it("keeps a locked owner protected even when Git also marks it prunable", () => {
    const record = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    expect(
      inspectWorkspaceOwnership(
        record,
        [{ path: worktreePath, branch: "feature", locked: true, prunable: true }],
        [],
      ).ownerStatus,
    ).toBe("locked");
  });

  it("treats an existing unregistered path as a conflict instead of missing", () => {
    const record = writeWorkspaceOwnership(worktreePath, {
      workspace: "feature",
      worktreePath,
      branch: "feature",
      devpodId: "feature",
    });

    expect(inspectWorkspaceOwnership(record, [], []).ownerStatus).toBe("conflict");
  });
});
