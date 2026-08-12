import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRouteState } from "../../types";
import type { DevpodWorkspace } from "../devpod-workspaces";
import {
  buildWorkspaceCleanupReport,
  evaluateWorkspaceActivity,
  parseGitHubChanges,
  parseGitLabChanges,
  parseInactiveFor,
  parseRemoteIdentity,
  type WorkspaceCleanupActivityEvidence,
  type WorkspaceCleanupCommandResult,
  type WorkspaceCleanupDependencies,
  type WorkspaceCleanupGitSnapshot,
} from "../workspace-cleanup";
import type { GitWorktree, WorkspaceOwnershipRecord } from "../workspace-ownership";

const now = new Date("2026-08-12T12:00:00.000Z");
const old = "2026-06-01T12:00:00.000Z";
const recent = "2026-08-12T11:30:00.000Z";
const headSha = "a".repeat(40);
const mergedSha = "b".repeat(40);

function worktree(overrides: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path: "/repo/trees/feature",
    branch: "feature",
    locked: false,
    prunable: false,
    ...overrides,
  };
}

function record(overrides: Partial<WorkspaceOwnershipRecord> = {}): WorkspaceOwnershipRecord {
  return {
    version: 1,
    workspace: "feature",
    worktreePath: "/repo/trees/feature",
    branch: "feature",
    devpodId: "feature",
    createdAt: old,
    updatedAt: old,
    ...overrides,
  };
}

function route(overrides: Partial<HostRouteState> = {}): HostRouteState {
  return {
    id: "/repo/trees/feature::web",
    name: "web",
    host: "web.feature.localhost",
    protocol: "http",
    repoPath: "/repo/trees/feature",
    port: 3000,
    mode: "proxy",
    workspace: "feature",
    createdAt: old,
    updatedAt: old,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<WorkspaceCleanupGitSnapshot> = {},
): WorkspaceCleanupGitSnapshot {
  return {
    worktree: worktree(),
    checkout: "clean",
    head: headSha,
    committerDate: old,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<WorkspaceCleanupDependencies> = {},
): WorkspaceCleanupDependencies {
  const devpod: DevpodWorkspace = {
    id: "feature",
    source: { localFolder: "/repo/trees/feature" },
  };
  return {
    listOwnership: () => [record()],
    listWorktrees: () => [worktree()],
    listDevpods: () => [devpod],
    readRoutes: () => [route()],
    readGitSnapshot: () => snapshot(),
    inspectOwnership: () => ({ ownerStatus: "present", devpodStatus: "owned" }),
    inspectIntegration: () => ({ status: "not-verified", reason: "synthetic" }),
    ...overrides,
  };
}

function commandResult(stdout = ""): WorkspaceCleanupCommandResult {
  return { status: 0, stdout, stderr: "" };
}

function integrationDependencies(
  forgeOutput: string,
  overrides: Partial<WorkspaceCleanupDependencies> = {},
  sourceRemoteSha = "d".repeat(40),
): WorkspaceCleanupDependencies {
  const targetSha = "e".repeat(40);
  const calls: string[] = [];
  const commandRunner = vi.fn((command: string, args: string[], input?: string) => {
    const rendered = `${command} ${args.join(" ")}`;
    calls.push(rendered);
    if (rendered.includes("config --get remote.origin.url"))
      return commandResult("git@github.com:acme/devrouter.git\n");
    if (rendered.includes("symbolic-ref --quiet --short refs/remotes/origin/HEAD"))
      return commandResult("origin/main\n");
    if (rendered.includes("ls-remote --symref origin HEAD"))
      return commandResult("ref: refs/heads/main\tHEAD\n");
    if (rendered.includes("rev-parse --verify refs/remotes/origin/main"))
      return commandResult(`${targetSha}\n`);
    if (rendered.includes("ls-remote origin refs/heads/main"))
      return commandResult(`${targetSha}\trefs/heads/main\n`);
    if (rendered.includes("merge-base --is-ancestor")) {
      const candidateBase = args[args.length - 2];
      return candidateBase === "c".repeat(40)
        ? commandResult()
        : { status: 1, stdout: "", stderr: "" };
    }
    if (rendered.includes("ls-remote origin refs/heads/feature"))
      return commandResult(`${sourceRemoteSha}\trefs/heads/feature\n`);
    if (command === "gh") return commandResult(forgeOutput);
    if (rendered.includes("rev-list --no-merges")) return commandResult(`${"f".repeat(40)}\n`);
    if (args.includes("diff")) return commandResult("diff --git a/file b/file\n");
    if (command === "git" && args[0] === "patch-id") return commandResult(`${"1".repeat(40)}  -\n`);
    return commandResult(input ? "" : "");
  });
  return dependencies({ commandRunner, ...overrides, inspectIntegration: undefined });
}

describe("workspace cleanup duration and activity", () => {
  it("parses the small dependency-free duration syntax and defaults to 30d", () => {
    expect(parseInactiveFor()).toEqual({ input: "30d", seconds: 30 * 86400 });
    expect(parseInactiveFor("2w")).toEqual({ input: "2w", seconds: 2 * 604800 });
    expect(parseInactiveFor("15m")).toEqual({ input: "15m", seconds: 15 * 60 });
    for (const value of ["0d", "-1d", "1.5d", "1d2h", "30mo", "days"]) {
      expect(() => parseInactiveFor(value)).toThrow("--inactive-for");
    }
  });

  it("uses the newest valid signal and records ties in stable source order", () => {
    const evidence: WorkspaceCleanupActivityEvidence[] = [
      { source: "git.headCommitterDate", status: "valid", timestamp: recent },
      { source: "ownership.updatedAt", status: "valid", timestamp: old },
      { source: "route.updatedAt", status: "valid", timestamp: recent },
      { source: "devpod.lastUsed", status: "missing" },
    ];

    const result = evaluateWorkspaceActivity(evidence, "2026-07-13T12:00:00.000Z");

    expect(result.status).toBe("recent");
    expect(result.latestTimestamp).toBe(recent);
    expect(result.contributingEvidence).toEqual(["route.updatedAt", "git.headCommitterDate"]);
    expect(result.evidence.map((entry) => entry.source)).toEqual([
      "devpod.lastUsed",
      "route.updatedAt",
      "ownership.updatedAt",
      "git.headCommitterDate",
    ]);
  });

  it("reports quiet only with an old valid signal and unknown when confidence is insufficient", () => {
    expect(
      evaluateWorkspaceActivity(
        [
          { source: "devpod.lastUsed", status: "missing" },
          { source: "route.updatedAt", status: "not-applicable" },
          { source: "ownership.updatedAt", status: "valid", timestamp: old },
          { source: "git.headCommitterDate", status: "valid", timestamp: old },
        ],
        "2026-07-13T12:00:00.000Z",
      ).status,
    ).toBe("quiet");
    expect(
      evaluateWorkspaceActivity(
        [
          { source: "devpod.lastUsed", status: "malformed" },
          { source: "route.updatedAt", status: "valid", timestamp: old },
        ],
        "2026-07-13T12:00:00.000Z",
      ).status,
    ).toBe("unknown");
  });
});

describe("workspace cleanup forge parsing", () => {
  it("accepts only supported GitHub/GitLab remote identities", () => {
    expect(parseRemoteIdentity("git@github.com:acme/devrouter.git")).toEqual({
      provider: "github",
      host: "github.com",
      project: "acme/devrouter",
    });
    expect(parseRemoteIdentity("https://gitlab.com/acme/group/devrouter.git")).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      project: "acme/group/devrouter",
    });
    expect(parseRemoteIdentity("https://gitlab.example.test/acme/devrouter.git")).toBeUndefined();
    expect(parseRemoteIdentity("https://example.test/acme/devrouter.git")).toBeUndefined();
    expect(parseRemoteIdentity("https://github.com/acme/devrouter?token=secret")).toEqual({
      provider: "github",
      host: "github.com",
      project: "acme/devrouter",
    });
  });

  it("requires same-repository GitHub and GitLab change evidence", () => {
    const github = parseGitHubChanges(
      [
        {
          repository: { nameWithOwner: "acme/devrouter" },
          headRepository: { nameWithOwner: "acme/devrouter" },
          headRefName: "feature",
          headRefOid: headSha,
          baseRefName: "main",
          baseRefOid: "c".repeat(40),
          state: "MERGED",
          mergedAt: recent,
          mergeCommit: { oid: mergedSha },
        },
        {
          repository: { nameWithOwner: "acme/devrouter" },
          headRepository: { nameWithOwner: "fork/devrouter" },
          headRefName: "feature",
          headRefOid: headSha,
          baseRefName: "main",
          state: "MERGED",
          mergedAt: recent,
        },
      ],
      "acme/devrouter",
      "feature",
    );
    expect(github).toHaveLength(1);
    expect(github?.[0]).toMatchObject({ merged: true, sourceHeadSha: headSha });

    const gitlab = parseGitLabChanges(
      [
        {
          source_project_id: 7,
          target_project_id: 7,
          source_branch: "feature",
          target_branch: "main",
          sha: headSha,
          state: "merged",
          merged_at: recent,
          diff_refs: { base_sha: "c".repeat(40) },
          merge_commit_sha: mergedSha,
        },
      ],
      "acme/devrouter",
      "feature",
    );
    expect(gitlab?.[0]).toMatchObject({ merged: true, sourceHeadSha: headSha });
    expect(parseGitHubChanges({ malformed: true }, "acme/devrouter", "feature")).toBeUndefined();
  });

  it("classifies a same-repository merged head exactly", () => {
    const forgeOutput = JSON.stringify([
      {
        repository: { nameWithOwner: "acme/devrouter" },
        headRepository: { nameWithOwner: "acme/devrouter" },
        headRefName: "feature",
        headRefOid: headSha,
        baseRefName: "main",
        baseRefOid: "c".repeat(40),
        state: "MERGED",
        mergedAt: recent,
        mergeCommit: { oid: mergedSha },
      },
    ]);
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies(forgeOutput, {}, headSha),
    );
    expect(report.workspaces[0].integration).toBe("merged-exact");
    expect(report.workspaces[0].suggestions).toEqual([
      expect.objectContaining({ command: "devrouter workspace down feature --repo /repo" }),
    ]);
  });

  it("treats a missing source remote as unknown", () => {
    const sourceSha = "d".repeat(40);
    const forgeOutput = JSON.stringify([
      {
        repository: { nameWithOwner: "acme/devrouter" },
        headRepository: { nameWithOwner: "acme/devrouter" },
        headRefName: "feature",
        headRefOid: sourceSha,
        baseRefName: "main",
        baseRefOid: "c".repeat(40),
        state: "MERGED",
        mergedAt: recent,
        mergeCommit: { oid: mergedSha },
      },
    ]);
    const baseRunner = integrationDependencies(forgeOutput).commandRunner!;
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies(forgeOutput, {
        commandRunner: (command, args, input) => {
          if (`${command} ${args.join(" ")}`.includes("ls-remote origin refs/heads/feature"))
            return { status: 0, stdout: "", stderr: "" };
          return baseRunner(command, args, input);
        },
      }),
    );
    expect(report.workspaces[0].integration).toBe("unknown");
  });

  it("treats a stale target remote as unknown", () => {
    const baseRunner = integrationDependencies("[]").commandRunner!;
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies("[]", {
        commandRunner: (command, args, input) => {
          if (`${command} ${args.join(" ")}`.includes("ls-remote origin refs/heads/main"))
            return commandResult(`${"f".repeat(40)}\trefs/heads/main\n`);
          return baseRunner(command, args, input);
        },
      }),
    );
    expect(report.workspaces[0].integration).toBe("unknown");
  });

  it("fails closed when the local and remote default targets disagree", () => {
    const baseRunner = integrationDependencies("[]").commandRunner!;
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies("[]", {
        commandRunner: (command, args, input) => {
          if (`${command} ${args.join(" ")}`.includes("ls-remote --symref origin HEAD"))
            return commandResult("ref: refs/heads/release\tHEAD\n");
          return baseRunner(command, args, input);
        },
      }),
    );
    expect(report.workspaces[0].integration).toBe("unknown");
  });

  it("requires exact merge evidence to match the current source and target refs", () => {
    const forgeOutput = JSON.stringify([
      {
        repository: { nameWithOwner: "acme/devrouter" },
        headRepository: { nameWithOwner: "acme/devrouter" },
        headRefName: "feature",
        headRefOid: headSha,
        baseRefName: "release",
        baseRefOid: "c".repeat(40),
        state: "MERGED",
        mergedAt: recent,
        mergeCommit: { oid: mergedSha },
      },
    ]);
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies(forgeOutput, {}, "d".repeat(40)),
    );
    expect(report.workspaces[0].integration).toBe("not-verified");
    expect(report.workspaces[0].suggestions).toEqual([]);
  });

  it("rejects malformed successful patch evidence", () => {
    const sourceSha = "d".repeat(40);
    const forgeOutput = JSON.stringify([
      {
        repository: { nameWithOwner: "acme/devrouter" },
        headRepository: { nameWithOwner: "acme/devrouter" },
        headRefName: "feature",
        headRefOid: sourceSha,
        baseRefName: "main",
        baseRefOid: "c".repeat(40),
        state: "MERGED",
        mergedAt: recent,
        mergeCommit: { oid: mergedSha },
      },
    ]);
    const baseRunner = integrationDependencies(forgeOutput).commandRunner!;
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies(forgeOutput, {
        commandRunner: (command, args, input) => {
          if (command === "git" && args[0] === "patch-id")
            return commandResult("not-a-patch-id  -\n");
          return baseRunner(command, args, input);
        },
      }),
    );
    expect(report.workspaces[0].integration).toBe("not-verified");
  });

  it("rejects partially malformed source commit evidence", () => {
    const sourceSha = "d".repeat(40);
    const forgeOutput = JSON.stringify([
      {
        repository: { nameWithOwner: "acme/devrouter" },
        headRepository: { nameWithOwner: "acme/devrouter" },
        headRefName: "feature",
        headRefOid: sourceSha,
        baseRefName: "main",
        baseRefOid: "c".repeat(40),
        state: "MERGED",
        mergedAt: recent,
        mergeCommit: { oid: mergedSha },
      },
    ]);
    const baseRunner = integrationDependencies(forgeOutput).commandRunner!;
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies(forgeOutput, {
        commandRunner: (command, args, input) => {
          if (`${command} ${args.join(" ")}`.includes("rev-list --no-merges"))
            return commandResult(`${"f".repeat(40)}\nnot-a-sha\n`);
          return baseRunner(command, args, input);
        },
      }),
    );
    expect(report.workspaces[0].integration).toBe("not-verified");
  });

  it("rejects patch equivalence without a verified common base", () => {
    const sourceSha = "d".repeat(40);
    const forgeOutput = JSON.stringify([
      {
        repository: { nameWithOwner: "acme/devrouter" },
        headRepository: { nameWithOwner: "acme/devrouter" },
        headRefName: "feature",
        headRefOid: sourceSha,
        baseRefName: "main",
        baseRefOid: "c".repeat(40),
        state: "MERGED",
        mergedAt: recent,
        mergeCommit: { oid: mergedSha },
      },
    ]);
    const baseRunner = integrationDependencies(forgeOutput).commandRunner!;
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies(forgeOutput, {
        commandRunner: (command, args, input) => {
          if (
            `${command} ${args.join(" ")}`.includes("merge-base --is-ancestor") &&
            args.includes("c".repeat(40))
          )
            return { status: 1, stdout: "", stderr: "" };
          return baseRunner(command, args, input);
        },
      }),
    );
    expect(report.workspaces[0].integration).toBe("not-verified");
  });

  it("classifies a real squash-style merge as patch-equivalent without overclaiming", () => {
    const sourceSha = "d".repeat(40);
    const forgeOutput = JSON.stringify([
      {
        repository: { nameWithOwner: "acme/devrouter" },
        headRepository: { nameWithOwner: "acme/devrouter" },
        headRefName: "feature",
        headRefOid: sourceSha,
        baseRefName: "main",
        baseRefOid: "c".repeat(40),
        state: "MERGED",
        mergedAt: recent,
        mergeCommit: { oid: mergedSha },
      },
    ]);
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies(forgeOutput),
    );
    expect(report.workspaces[0].integration).toBe("patch-equivalent");
    expect(report.workspaces[0].suggestions).toEqual([]);
  });

  it("does not treat failed patch probes as equivalent", () => {
    const sourceSha = "d".repeat(40);
    const forgeOutput = JSON.stringify([
      {
        repository: { nameWithOwner: "acme/devrouter" },
        headRepository: { nameWithOwner: "acme/devrouter" },
        headRefName: "feature",
        headRefOid: sourceSha,
        baseRefName: "main",
        baseRefOid: "c".repeat(40),
        state: "MERGED",
        mergedAt: recent,
        mergeCommit: { oid: mergedSha },
      },
    ]);
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      integrationDependencies(forgeOutput, {
        commandRunner: (command, args) => {
          if (command === "git" && args[0] === "patch-id")
            return { status: 1, stdout: "", stderr: "failed" };
          return (
            integrationDependencies(forgeOutput).commandRunner?.(command, args) ?? commandResult()
          );
        },
      }),
    );
    expect(report.workspaces[0].integration).toBe("not-verified");
  });
});

describe("workspace cleanup report and suggestions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a quiet managed workspace with a keep-worktree suggestion", () => {
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, inactiveFor: "30d" },
      dependencies(),
    );
    const row = report.workspaces[0];

    expect(row).toMatchObject({
      ownership: "present",
      provider: "owned",
      checkout: "clean",
      route: "owned",
      activity: "quiet",
      integration: "not-verified",
    });
    expect(row.suggestions).toEqual([
      expect.objectContaining({
        command: "devrouter workspace down feature --keep-worktree --repo /repo",
      }),
    ]);
    expect(row.suggestions[0].reason).toContain("deletes DevPod/runtime data");
  });

  it("suppresses quiet cleanup for recent, dirty, locked, or conflicting evidence", () => {
    const recentReport = buildWorkspaceCleanupReport(
      { repo: "/repo", now },
      dependencies({
        listDevpods: () => [
          { id: "feature", source: { localFolder: "/repo/trees/feature" }, lastUsed: recent },
        ],
      }),
    );
    expect(recentReport.workspaces[0].suggestions).toEqual([]);
    expect(recentReport.workspaces[0].reasons.join(" ")).toContain("vetoes");

    const dirtyReport = buildWorkspaceCleanupReport(
      { repo: "/repo", now },
      dependencies({ readGitSnapshot: () => snapshot({ checkout: "dirty" }) }),
    );
    expect(dirtyReport.workspaces[0].suggestions).toEqual([]);

    const conflictReport = buildWorkspaceCleanupReport(
      { repo: "/repo", now },
      dependencies({
        inspectOwnership: () => ({ ownerStatus: "conflict", devpodStatus: "conflict" }),
      }),
    );
    expect(conflictReport.workspaces[0].suggestions).toEqual([]);
  });

  it("suggests full down only for exact merged current HEAD and never for patch equivalence", () => {
    const mergedReport = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      dependencies({
        inspectIntegration: () => ({ status: "merged-exact", headSha }),
      }),
    );
    expect(mergedReport.workspaces[0].suggestions).toEqual([
      expect.objectContaining({ command: "devrouter workspace down feature --repo /repo" }),
    ]);

    const patchReport = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      dependencies({
        inspectIntegration: () => ({ status: "patch-equivalent", headSha }),
      }),
    );
    expect(patchReport.workspaces[0].suggestions).toEqual([]);
    expect(patchReport.workspaces[0].reasons.join(" ")).toContain("advisory");
  });

  it("suggests exact GC only when the owner is missing and identity is safe", () => {
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now },
      dependencies({
        inspectOwnership: () => ({ ownerStatus: "missing", devpodStatus: "owned" }),
        readGitSnapshot: () =>
          snapshot({ checkout: "missing", worktree: worktree({ prunable: true }) }),
      }),
    );
    expect(report.workspaces[0].suggestions).toEqual([
      expect.objectContaining({ command: "devrouter workspace gc --repo /repo --yes" }),
    ]);
  });

  it("keeps report generation injectable and mutation-free", () => {
    const readRoutes = vi.fn(() => [route()]);
    const inspectIntegration = vi.fn(
      (_repo, _snapshot, _branch, checkMerged) =>
        ({
          status: checkMerged ? "unknown" : "not-verified",
        }) as const,
    );
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now },
      dependencies({ readRoutes, inspectIntegration }),
    );

    expect(readRoutes).toHaveBeenCalledOnce();
    expect(inspectIntegration).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ head: headSha }),
      "feature",
      false,
    );
    expect(report.checkMerged).toBe(false);
  });

  it("does not run forge or remote probes unless checkMerged is enabled", () => {
    const commandRunner = vi.fn(() => commandResult(""));
    buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: false },
      dependencies({ commandRunner }),
    );
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("leaves provider evidence unknown when the provider check is disabled", () => {
    const inspectOwnership = vi.fn((_record, _worktrees, devpods) => {
      expect(devpods).toBeUndefined();
      return { ownerStatus: "present" as const, devpodStatus: "unknown" as const };
    });
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: false },
      dependencies({ listDevpods: undefined, inspectOwnership }),
    );
    expect(report.workspaces[0].provider).toBe("unknown");
    expect(report.workspaces[0].suggestions).toEqual([]);
  });

  it("suppresses activity cleanup suggestions when an explicit merge check is unverified", () => {
    const report = buildWorkspaceCleanupReport(
      { repo: "/repo", now, checkMerged: true },
      dependencies({
        inspectIntegration: () => ({ status: "not-verified", reason: "synthetic" }),
      }),
    );
    expect(report.workspaces[0].suggestions).toEqual([]);
    expect(report.workspaces[0].reasons.join(" ")).toContain("integration check");
  });
});
