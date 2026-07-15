import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
