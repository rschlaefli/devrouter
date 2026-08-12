import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { HostRouteState } from "../types";
import { type DevpodWorkspace, listDevpodWorkspaces } from "./devpod-workspaces";
import { readHostRouteStateReadOnly } from "./host-routes";
import { resolveRepoPath } from "./repo-config";
import { comparableWorkspacePath, sameWorkspacePath } from "./workspace";
import {
  type DevpodOwnerStatus,
  type GitWorktree,
  inspectWorkspaceOwnership,
  listGitWorktrees,
  listWorkspaceOwnership,
  type WorkspaceOwnerStatus,
  type WorkspaceOwnershipRecord,
} from "./workspace-ownership";

const DEFAULT_INACTIVE_FOR = "30d";
const READ_ONLY_GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
const ACTIVITY_SOURCES = [
  "devpod.lastUsed",
  "route.updatedAt",
  "ownership.updatedAt",
  "git.headCommitterDate",
] as const;

export type WorkspaceCleanupActivitySource = (typeof ACTIVITY_SOURCES)[number];
export type WorkspaceCleanupActivityEvidenceStatus =
  | "valid"
  | "not-applicable"
  | "missing"
  | "malformed"
  | "unavailable";

export type WorkspaceCleanupActivityEvidence = {
  source: WorkspaceCleanupActivitySource;
  status: WorkspaceCleanupActivityEvidenceStatus;
  timestamp?: string;
};

export type WorkspaceCleanupActivityStatus = "recent" | "quiet" | "unknown";
export type WorkspaceCleanupCheckoutStatus = "clean" | "dirty" | "missing" | "detached" | "unknown";
export type WorkspaceCleanupRouteStatus = "owned" | "absent" | "conflict" | "unknown";
export type WorkspaceCleanupIntegrationStatus =
  | "merged-exact"
  | "on-target"
  | "patch-equivalent"
  | "not-verified"
  | "unknown";

export type WorkspaceCleanupSuggestion = {
  command: string;
  reason: string;
};

export type WorkspaceCleanupActivityResult = {
  status: WorkspaceCleanupActivityStatus;
  latestTimestamp: string | null;
  contributingEvidence: WorkspaceCleanupActivitySource[];
  evidence: WorkspaceCleanupActivityEvidence[];
};

export type WorkspaceCleanupRow = {
  schemaVersion: 1;
  workspace: string;
  branch: string | null;
  repo: string;
  worktreePath: string;
  devpodId: string;
  ownership: WorkspaceOwnerStatus;
  provider: DevpodOwnerStatus;
  checkout: WorkspaceCleanupCheckoutStatus;
  route: WorkspaceCleanupRouteStatus;
  activity: WorkspaceCleanupActivityStatus;
  cutoff: string;
  latestTimestamp: string | null;
  contributingEvidence: WorkspaceCleanupActivitySource[];
  activityEvidence: WorkspaceCleanupActivityEvidence[];
  integration: WorkspaceCleanupIntegrationStatus;
  eligibleActions: string[];
  suggestions: WorkspaceCleanupSuggestion[];
  reasons: string[];
};

export type WorkspaceCleanupReport = {
  schemaVersion: 1;
  generatedAt: string;
  repoPath: string;
  inactiveFor: string;
  cutoff: string;
  checkMerged: boolean;
  workspaces: WorkspaceCleanupRow[];
};

export type WorkspaceCleanupOptions = {
  repo?: string;
  inactiveFor?: string;
  checkMerged?: boolean;
  now?: Date;
};

export type WorkspaceCleanupGitSnapshot = {
  worktree: GitWorktree;
  checkout: WorkspaceCleanupCheckoutStatus;
  head: string | null;
  committerDate: string | null;
};

export type WorkspaceCleanupIntegrationEvidence = {
  status: WorkspaceCleanupIntegrationStatus;
  headSha?: string;
  reason?: string;
};

export type WorkspaceCleanupDependencies = {
  listOwnership?: (repoPath: string) => WorkspaceOwnershipRecord[];
  listWorktrees?: (repoPath: string) => GitWorktree[];
  listDevpods?: () => DevpodWorkspace[];
  readRoutes?: () => HostRouteState[];
  readGitSnapshot?: (worktree: GitWorktree) => WorkspaceCleanupGitSnapshot;
  commandRunner?: WorkspaceCleanupCommandRunner;
  inspectOwnership?: (
    record: WorkspaceOwnershipRecord,
    worktrees: GitWorktree[],
    devpods: DevpodWorkspace[] | undefined,
  ) => { ownerStatus: WorkspaceOwnerStatus; devpodStatus: DevpodOwnerStatus };
  inspectIntegration?: (
    repoPath: string,
    snapshot: WorkspaceCleanupGitSnapshot,
    branch: string | null,
    checkMerged: boolean,
  ) => WorkspaceCleanupIntegrationEvidence;
};

export type WorkspaceCleanupCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type WorkspaceCleanupCommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => WorkspaceCleanupCommandResult;

export type WorkspaceCleanupRemoteIdentity = {
  provider: "github" | "gitlab";
  host: string;
  project: string;
};

export type WorkspaceCleanupForgeChange = {
  sourceBranch: string;
  sourceHeadSha: string;
  targetBranch: string;
  baseSha?: string;
  mergeCommitSha?: string;
  merged: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value);
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function validTimestamp(value: unknown): value is string {
  return parseTimestamp(value) !== undefined;
}

const defaultCommandRunner: WorkspaceCleanupCommandRunner = (
  command,
  args,
  input,
): WorkspaceCleanupCommandResult => {
  const environment = command === "git" ? READ_ONLY_GIT_ENV : { ...process.env, LC_ALL: "C" };
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    env: environment,
    ...(input === undefined ? {} : { input }),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
};

function successfulOutput(result: WorkspaceCleanupCommandResult): string | undefined {
  if (result.status !== 0 || result.error) return undefined;
  const output = result.stdout.trim();
  return output.length > 0 ? output : undefined;
}

function gitOutput(
  repoPath: string,
  args: string[],
  commandRunner: WorkspaceCleanupCommandRunner,
): string | undefined {
  return successfulOutput(commandRunner("git", ["-C", repoPath, ...args]));
}

function quoteCommandArg(value: string): string {
  return /^[a-zA-Z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function workspaceCommand(
  repoPath: string,
  args: string[],
  beforeRepo: string[] = [],
  afterRepo: string[] = [],
): string {
  return [
    "devrouter",
    "workspace",
    ...args,
    ...beforeRepo,
    "--repo",
    quoteCommandArg(repoPath),
    ...afterRepo,
  ].join(" ");
}

export function parseInactiveFor(value = DEFAULT_INACTIVE_FOR): {
  input: string;
  seconds: number;
} {
  const match = /^(?<amount>[1-9]\d*)(?<unit>[smhdw])$/.exec(value);
  if (!match?.groups) {
    throw new Error(
      "--inactive-for must be a positive integer followed by s, m, h, d, or w (for example 30d).",
    );
  }
  const amount = Number(match.groups.amount);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[
    match.groups.unit as "s" | "m" | "h" | "d" | "w"
  ];
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("--inactive-for is too large.");
  }
  return { input: value, seconds };
}

export function evaluateWorkspaceActivity(
  evidence: WorkspaceCleanupActivityEvidence[],
  cutoff: string,
): WorkspaceCleanupActivityResult {
  const cutoffTime = parseTimestamp(cutoff);
  if (cutoffTime === undefined) {
    throw new Error(`Invalid activity cutoff '${cutoff}'.`);
  }

  const validEvidence = evidence.filter(
    (entry): entry is WorkspaceCleanupActivityEvidence & { timestamp: string } =>
      entry.status === "valid" && validTimestamp(entry.timestamp),
  );
  const latestTime = validEvidence.reduce<number | undefined>(
    (latest, entry) =>
      Math.max(
        latest ?? Number.NEGATIVE_INFINITY,
        parseTimestamp(entry.timestamp) ?? Number.NEGATIVE_INFINITY,
      ),
    undefined,
  );
  const latestTimestamp =
    latestTime === undefined
      ? null
      : (validEvidence.find((entry) => parseTimestamp(entry.timestamp) === latestTime)?.timestamp ??
        null);
  const contributingEvidence = ACTIVITY_SOURCES.filter((source) =>
    validEvidence.some(
      (entry) => entry.source === source && parseTimestamp(entry.timestamp) === latestTime,
    ),
  );

  let status: WorkspaceCleanupActivityStatus = "unknown";
  if (latestTime !== undefined) {
    if (latestTime >= cutoffTime) {
      status = "recent";
    } else if (
      validEvidence.length > 0 &&
      evidence.every(
        (entry) =>
          entry.status === "valid" ||
          entry.status === "not-applicable" ||
          entry.status === "missing",
      )
    ) {
      status = "quiet";
    }
  }

  return {
    status,
    latestTimestamp,
    contributingEvidence,
    evidence: evidence
      .slice()
      .sort(
        (left, right) =>
          ACTIVITY_SOURCES.indexOf(left.source) - ACTIVITY_SOURCES.indexOf(right.source),
      ),
  };
}

function readGitSnapshot(
  worktree: GitWorktree,
  commandRunner: WorkspaceCleanupCommandRunner,
): WorkspaceCleanupGitSnapshot {
  const comparablePath = comparableWorkspacePath(worktree.path);
  if (worktree.prunable || !fs.existsSync(comparablePath)) {
    return { worktree, checkout: "missing", head: null, committerDate: null };
  }

  const head = gitOutput(comparablePath, ["rev-parse", "--verify", "HEAD"], commandRunner);
  if (!head) {
    return { worktree, checkout: "unknown", head: null, committerDate: null };
  }
  const committerDate =
    gitOutput(comparablePath, ["show", "-s", "--format=%cI", "HEAD"], commandRunner) ?? null;
  const statusResult = commandRunner("git", [
    "-C",
    comparablePath,
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  const checkout: WorkspaceCleanupCheckoutStatus =
    worktree.branch === undefined
      ? "detached"
      : statusResult.status !== 0 || statusResult.error
        ? "unknown"
        : statusResult.stdout.trim().length > 0
          ? "dirty"
          : "clean";
  return { worktree, checkout, head, committerDate };
}

export function parseRemoteIdentity(value: string): WorkspaceCleanupRemoteIdentity | undefined {
  let normalized = value.trim();
  normalized = normalized.replace(/^git\+/, "");
  let host: string;
  let project: string;
  const scp = /^git@([^:]+):(.+)$/.exec(normalized);
  if (scp) {
    host = scp[1];
    project = scp[2];
  } else {
    try {
      const url = new URL(normalized);
      host = url.hostname;
      project = url.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  }
  project = project.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !project || project.includes("..") || project.includes(" ")) return undefined;
  const lowerHost = host.toLowerCase();
  if (lowerHost === "github.com" && /^[^/]+\/[^/]+$/.test(project)) {
    return { provider: "github", host: lowerHost, project };
  }
  if (lowerHost === "gitlab.com") {
    return { provider: "gitlab", host: lowerHost, project };
  }
  return undefined;
}

export function parseGitHubChanges(
  value: unknown,
  project: string,
  branch: string,
): WorkspaceCleanupForgeChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: WorkspaceCleanupForgeChange[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const repository = isRecord(item.repository) ? item.repository.nameWithOwner : undefined;
    const headRepository = isRecord(item.headRepository)
      ? item.headRepository.nameWithOwner
      : undefined;
    if (
      repository !== project ||
      headRepository !== project ||
      item.headRefName !== branch ||
      !isSha(item.headRefOid) ||
      typeof item.baseRefName !== "string"
    ) {
      continue;
    }
    const merged = item.state === "MERGED" && validTimestamp(item.mergedAt);
    const mergeCommit =
      isRecord(item.mergeCommit) && isSha(item.mergeCommit.oid) ? item.mergeCommit.oid : undefined;
    const baseSha = isSha(item.baseRefOid) ? item.baseRefOid : undefined;
    changes.push({
      sourceBranch: branch,
      sourceHeadSha: item.headRefOid,
      targetBranch: item.baseRefName,
      ...(baseSha ? { baseSha } : {}),
      ...(mergeCommit ? { mergeCommitSha: mergeCommit } : {}),
      merged,
    });
  }
  return changes;
}

export function parseGitLabChanges(
  value: unknown,
  _project: string,
  branch: string,
): WorkspaceCleanupForgeChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: WorkspaceCleanupForgeChange[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const sourceProjectId = item.source_project_id;
    const targetProjectId = item.target_project_id;
    const sameProject =
      typeof sourceProjectId === "number" &&
      typeof targetProjectId === "number" &&
      sourceProjectId === targetProjectId;
    if (
      !sameProject ||
      item.source_branch !== branch ||
      !isSha(item.sha) ||
      typeof item.target_branch !== "string"
    ) {
      continue;
    }
    const diffRefs = isRecord(item.diff_refs) ? item.diff_refs : undefined;
    const mergeCommitSha = isSha(item.merge_commit_sha) ? item.merge_commit_sha : undefined;
    const baseSha = diffRefs && isSha(diffRefs.base_sha) ? diffRefs.base_sha : undefined;
    changes.push({
      sourceBranch: branch,
      sourceHeadSha: item.sha,
      targetBranch: item.target_branch,
      ...(baseSha ? { baseSha } : {}),
      ...(mergeCommitSha ? { mergeCommitSha } : {}),
      merged: item.state === "merged" && validTimestamp(item.merged_at),
    });
  }
  return changes;
}

function patchIdForRange(
  repoPath: string,
  baseSha: string,
  headSha: string,
  commandRunner: WorkspaceCleanupCommandRunner,
): string | undefined {
  const diff = commandRunner("git", [
    "-C",
    repoPath,
    "diff",
    "--no-ext-diff",
    "--binary",
    baseSha,
    headSha,
  ]);
  if (diff.status !== 0 || diff.error || diff.stdout.length === 0) return undefined;
  const result = commandRunner("git", ["patch-id", "--stable"], diff.stdout);
  if (result.status !== 0 || result.error) return undefined;
  const match = /^([0-9a-f]{40,64})\s+(?:-|[0-9a-f]{40,64})$/i.exec(result.stdout.trim());
  return match?.[1];
}

function hasUniqueSourceCommit(
  repoPath: string,
  baseSha: string,
  headSha: string,
  commandRunner: WorkspaceCleanupCommandRunner,
): boolean {
  const result = gitOutput(
    repoPath,
    ["rev-list", "--no-merges", "--reverse", `${baseSha}..${headSha}`],
    commandRunner,
  );
  if (!result) return false;
  const commits = result
    .split(/\r?\n/)
    .map((sha) => sha.trim())
    .filter((sha) => sha.length > 0);
  return commits.length > 0 && commits.every(isSha) && new Set(commits).size > 0;
}

function parseTargetBranch(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const value = output.trim();
  return value.startsWith("origin/") && value.length > "origin/".length
    ? value.slice("origin/".length)
    : undefined;
}

function parseRemoteDefaultTarget(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(output);
  return match?.[1];
}

function inspectWorkspaceIntegration(
  repoPath: string,
  snapshot: WorkspaceCleanupGitSnapshot,
  branch: string | null,
  checkMerged: boolean,
  commandRunner: WorkspaceCleanupCommandRunner,
): WorkspaceCleanupIntegrationEvidence {
  if (!checkMerged) return { status: "not-verified", reason: "Merged checks were not requested." };
  if (
    !snapshot.head ||
    !branch ||
    snapshot.checkout === "missing" ||
    snapshot.checkout === "unknown"
  ) {
    return { status: "unknown", reason: "Current HEAD or branch evidence is unavailable." };
  }

  const originUrl = gitOutput(repoPath, ["config", "--get", "remote.origin.url"], commandRunner);
  const identity = originUrl ? parseRemoteIdentity(originUrl) : undefined;
  if (!identity) {
    return { status: "unknown", reason: "The origin is missing or uses an unsupported forge." };
  }
  const targetBranch =
    parseTargetBranch(
      gitOutput(
        repoPath,
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        commandRunner,
      ),
    ) ??
    parseRemoteDefaultTarget(
      successfulOutput(
        commandRunner("git", ["-C", repoPath, "ls-remote", "--symref", "origin", "HEAD"]),
      ),
    );
  if (!targetBranch)
    return { status: "unknown", reason: "The origin default target could not be determined." };

  const localTargetSha = gitOutput(
    repoPath,
    ["rev-parse", "--verify", `refs/remotes/origin/${targetBranch}`],
    commandRunner,
  );
  const remoteTargetOutput = successfulOutput(
    commandRunner("git", ["-C", repoPath, "ls-remote", "origin", `refs/heads/${targetBranch}`]),
  );
  const remoteTargetSha = remoteTargetOutput?.split(/\s+/)[0];
  if (!isSha(localTargetSha) || !isSha(remoteTargetSha) || localTargetSha !== remoteTargetSha) {
    return { status: "unknown", reason: "The origin target is missing, stale, or unavailable." };
  }

  const worktreePath = snapshot.worktree.path;
  const ancestry = commandRunner("git", [
    "-C",
    worktreePath,
    "merge-base",
    "--is-ancestor",
    snapshot.head,
    remoteTargetSha,
  ]);
  if (ancestry.status === 0 && !ancestry.error) {
    return {
      status: "on-target",
      headSha: snapshot.head,
      reason: "Current HEAD is an ancestor of the verified-fresh origin target.",
    };
  }

  const sourceRemoteOutput = successfulOutput(
    commandRunner("git", ["-C", repoPath, "ls-remote", "origin", `refs/heads/${branch}`]),
  );
  const sourceRemoteSha = sourceRemoteOutput?.split(/\s+/)[0];
  if (!isSha(sourceRemoteSha)) {
    return {
      status: "unknown",
      reason: "The workspace source branch is missing or unavailable on origin.",
    };
  }

  const forgeChanges: WorkspaceCleanupForgeChange[] = [];
  const forgeCommand =
    identity.provider === "github"
      ? [
          "pr",
          "list",
          "--repo",
          identity.project,
          "--state",
          "all",
          "--head",
          branch,
          "--json",
          "headRefName,headRefOid,baseRefName,baseRefOid,state,mergedAt,repository,headRepository,mergeCommit",
        ]
      : [
          "mr",
          "list",
          "--repo",
          identity.project,
          "--all",
          "--source-branch",
          branch,
          "--output",
          "json",
        ];
  const forge = commandRunner(identity.provider === "github" ? "gh" : "glab", forgeCommand);
  if (forge.status !== 0 || forge.error) {
    return { status: "unknown", reason: "The forge query was unavailable or unauthenticated." };
  }
  try {
    const parsed: unknown = JSON.parse(forge.stdout);
    const changes =
      identity.provider === "github"
        ? parseGitHubChanges(parsed, identity.project, branch)
        : parseGitLabChanges(parsed, identity.project, branch);
    if (!changes) {
      return { status: "unknown", reason: "The forge response was malformed." };
    }
    forgeChanges.push(...changes);
  } catch {
    return { status: "unknown", reason: "The forge response was malformed." };
  }

  const mergedExact = forgeChanges.find(
    (change) =>
      change.merged &&
      change.targetBranch === targetBranch &&
      change.sourceHeadSha.toLowerCase() === snapshot.head?.toLowerCase() &&
      change.sourceHeadSha.toLowerCase() === sourceRemoteSha.toLowerCase(),
  );
  if (mergedExact)
    return {
      status: "merged-exact",
      headSha: snapshot.head,
      reason: "Merged source head exactly matches current HEAD.",
    };

  for (const change of forgeChanges.filter(
    (candidate) =>
      candidate.merged &&
      candidate.targetBranch === targetBranch &&
      candidate.sourceHeadSha.toLowerCase() !== snapshot.head?.toLowerCase(),
  )) {
    if (change.sourceHeadSha.toLowerCase() !== sourceRemoteSha?.toLowerCase()) continue;
    if (
      change.baseSha &&
      change.mergeCommitSha &&
      hasUniqueSourceCommit(worktreePath, change.baseSha, snapshot.head, commandRunner)
    ) {
      const currentPatchId = patchIdForRange(
        worktreePath,
        change.baseSha,
        snapshot.head,
        commandRunner,
      );
      const mergedPatchId = patchIdForRange(
        worktreePath,
        change.baseSha,
        change.mergeCommitSha,
        commandRunner,
      );
      if (!currentPatchId || !mergedPatchId || currentPatchId !== mergedPatchId) continue;
      return {
        status: "patch-equivalent",
        headSha: snapshot.head,
        reason: "All source changes have an equivalent merged patch.",
      };
    }
  }

  return {
    status: "not-verified",
    reason: "Fresh target and forge evidence did not prove integration.",
  };
}

function routeStatus(
  record: WorkspaceOwnershipRecord,
  routes: HostRouteState[] | undefined,
): WorkspaceCleanupRouteStatus {
  if (!routes) return "unknown";
  const matchingPath = routes.filter((route) =>
    sameWorkspacePath(route.repoPath, record.worktreePath),
  );
  if (matchingPath.length === 0) return "absent";
  return matchingPath.every((route) => route.workspace === record.workspace) ? "owned" : "conflict";
}

function buildActivityEvidence(
  record: WorkspaceOwnershipRecord,
  providerStatus: DevpodOwnerStatus,
  provider: DevpodWorkspace | undefined,
  routeEntries: HostRouteState[] | undefined,
  git: WorkspaceCleanupGitSnapshot,
): WorkspaceCleanupActivityEvidence[] {
  const providerEvidence: WorkspaceCleanupActivityEvidence =
    providerStatus === "unknown" || providerStatus === "conflict"
      ? { source: "devpod.lastUsed", status: "unavailable" }
      : providerStatus === "absent"
        ? { source: "devpod.lastUsed", status: "not-applicable" }
        : provider?.lastUsedMalformed
          ? { source: "devpod.lastUsed", status: "malformed" }
          : provider?.lastUsed
            ? validTimestamp(provider.lastUsed)
              ? { source: "devpod.lastUsed", status: "valid", timestamp: provider.lastUsed }
              : { source: "devpod.lastUsed", status: "malformed" }
            : { source: "devpod.lastUsed", status: "missing" };

  const routeTimestamps = routeEntries?.map((route) => route.updatedAt) ?? [];
  const malformedRoute = routeTimestamps.some((timestamp) => !validTimestamp(timestamp));
  const newestRoute = routeTimestamps
    .filter(validTimestamp)
    .sort((left, right) => (parseTimestamp(right) ?? 0) - (parseTimestamp(left) ?? 0))[0];
  const routeEvidence: WorkspaceCleanupActivityEvidence = !routeEntries
    ? { source: "route.updatedAt", status: "unavailable" }
    : routeEntries.length === 0
      ? { source: "route.updatedAt", status: "not-applicable" }
      : malformedRoute
        ? { source: "route.updatedAt", status: "malformed" }
        : newestRoute
          ? { source: "route.updatedAt", status: "valid", timestamp: newestRoute }
          : { source: "route.updatedAt", status: "malformed" };

  const ownerEvidence: WorkspaceCleanupActivityEvidence = validTimestamp(record.updatedAt)
    ? { source: "ownership.updatedAt", status: "valid", timestamp: record.updatedAt }
    : { source: "ownership.updatedAt", status: "malformed" };
  const gitEvidence: WorkspaceCleanupActivityEvidence =
    git.checkout === "missing"
      ? { source: "git.headCommitterDate", status: "not-applicable" }
      : git.committerDate && validTimestamp(git.committerDate)
        ? { source: "git.headCommitterDate", status: "valid", timestamp: git.committerDate }
        : git.checkout === "unknown"
          ? { source: "git.headCommitterDate", status: "unavailable" }
          : { source: "git.headCommitterDate", status: "malformed" };
  return [providerEvidence, routeEvidence, ownerEvidence, gitEvidence];
}

function buildSuggestions(
  repoPath: string,
  record: WorkspaceOwnershipRecord,
  ownership: WorkspaceOwnerStatus,
  provider: DevpodOwnerStatus,
  checkout: WorkspaceCleanupCheckoutStatus,
  route: WorkspaceCleanupRouteStatus,
  activity: WorkspaceCleanupActivityStatus,
  integration: WorkspaceCleanupIntegrationEvidence,
  worktree: GitWorktree | undefined,
  checkMerged: boolean,
): { eligibleActions: string[]; suggestions: WorkspaceCleanupSuggestion[]; reasons: string[] } {
  const reasons: string[] = [];
  const eligibleActions: string[] = [];
  const suggestions: WorkspaceCleanupSuggestion[] = [];
  const gcCommand = workspaceCommand(repoPath, ["gc"], [], ["--yes"]);
  const keepCommand = workspaceCommand(repoPath, ["down", record.workspace], ["--keep-worktree"]);
  const downCommand = workspaceCommand(repoPath, ["down", record.workspace]);
  const routeSafe = route === "owned" || route === "absent";
  const checkoutSafe = checkout === "clean" && !worktree?.locked;
  const providerSafe = provider === "owned";

  if (ownership === "missing") {
    if ((provider === "owned" || provider === "absent") && routeSafe) {
      eligibleActions.push(gcCommand);
      suggestions.push({
        command: gcCommand,
        reason:
          "The exact ownership record is missing from live Git registration; GC will revalidate before deleting eligible runtime evidence.",
      });
    } else {
      reasons.push(
        `GC suggestion suppressed because provider=${provider} or route=${route} is not independently safe.`,
      );
    }
    return { eligibleActions, suggestions, reasons };
  }

  if (ownership !== "present")
    reasons.push(`Destructive suggestions require ownership=present (found ${ownership}).`);
  if (!providerSafe)
    reasons.push(
      `Destructive suggestions require an exact owned DevPod (found provider=${provider}).`,
    );
  if (!routeSafe)
    reasons.push(
      `Destructive suggestions require non-conflicting route evidence (found route=${route}).`,
    );
  if (checkout === "dirty")
    reasons.push("Checkout is dirty; destructive workspace down is blocked.");
  if (checkout === "missing")
    reasons.push("Checkout is missing; the report cannot authorize full down.");
  if (checkout === "detached")
    reasons.push("Checkout is detached; branch identity is not safe for destructive advice.");
  if (checkout === "unknown")
    reasons.push("Checkout state is unknown; destructive advice is suppressed.");
  if (worktree?.locked)
    reasons.push("Git worktree is locked; destructive workspace down is blocked.");

  if (!providerSafe || !routeSafe || !checkoutSafe || ownership !== "present") {
    return { eligibleActions, suggestions, reasons };
  }

  if (integration.status === "merged-exact" && integration.headSha) {
    eligibleActions.push(downCommand);
    suggestions.push({
      command: downCommand,
      reason:
        "Current HEAD is the exact source head of a same-repository merged change; workspace down still revalidates cleanliness, locks, and ownership before deleting runtime and the linked worktree.",
    });
    return { eligibleActions, suggestions, reasons };
  }
  if (integration.status === "patch-equivalent")
    reasons.push("Patch-equivalent integration is advisory and never authorizes full removal.");
  if (integration.status === "unknown" || integration.status === "not-verified")
    reasons.push(`Integration is ${integration.status}; full removal is not suggested.`);
  const activityCleanupAllowed =
    !checkMerged || integration.status === "on-target" || integration.status === "merged-exact";
  if (!activityCleanupAllowed) {
    reasons.push(
      "Cleanup is not suggested because the requested integration check did not provide a verified target or exact merge.",
    );
    return { eligibleActions, suggestions, reasons };
  }
  if (activity === "quiet") {
    eligibleActions.push(keepCommand);
    suggestions.push({
      command: keepCommand,
      reason:
        "Managed workspace has no recent trustworthy activity; this deletes DevPod/runtime data and preserves the worktree and owner record.",
    });
  } else if (activity === "recent") {
    reasons.push("Recent trustworthy activity vetoes a quiet-workspace suggestion.");
  } else {
    reasons.push("Activity is unknown; a quiet-workspace suggestion is suppressed.");
  }
  return { eligibleActions, suggestions, reasons };
}

function buildRow(
  repoPath: string,
  record: WorkspaceOwnershipRecord,
  worktrees: GitWorktree[],
  devpods: DevpodWorkspace[] | undefined,
  routes: HostRouteState[] | undefined,
  snapshot: WorkspaceCleanupGitSnapshot,
  cutoff: string,
  checkMerged: boolean,
  commandRunner: WorkspaceCleanupCommandRunner,
  inspectOwnershipFn: NonNullable<WorkspaceCleanupDependencies["inspectOwnership"]>,
  inspectIntegrationFn: WorkspaceCleanupDependencies["inspectIntegration"],
): WorkspaceCleanupRow {
  const ownershipEvidence = inspectOwnershipFn(record, worktrees, devpods);
  const providerOwnership = devpods?.find(
    (devpod) =>
      devpod.id === record.devpodId &&
      sameWorkspacePath(devpod.source.localFolder, record.worktreePath),
  );
  const matchingRoutes = routes?.filter((route) =>
    sameWorkspacePath(route.repoPath, record.worktreePath),
  );
  const activity = evaluateWorkspaceActivity(
    buildActivityEvidence(
      record,
      ownershipEvidence.devpodStatus,
      providerOwnership,
      matchingRoutes,
      snapshot,
    ),
    cutoff,
  );
  const branch =
    snapshot.checkout === "detached" ? null : (snapshot.worktree.branch ?? record.branch);
  const integration =
    inspectIntegrationFn?.(repoPath, snapshot, branch, checkMerged) ??
    inspectWorkspaceIntegration(repoPath, snapshot, branch, checkMerged, commandRunner);
  const suggestions = buildSuggestions(
    repoPath,
    record,
    ownershipEvidence.ownerStatus,
    ownershipEvidence.devpodStatus,
    snapshot.checkout,
    routeStatus(record, routes),
    activity.status,
    integration,
    snapshot.worktree,
    checkMerged,
  );
  const reasons = [
    `ownership=${ownershipEvidence.ownerStatus}`,
    `provider=${ownershipEvidence.devpodStatus}`,
    `checkout=${snapshot.checkout}`,
    `route=${routeStatus(record, routes)}`,
    `activity=${activity.status}`,
    `integration=${integration.status}`,
    ...(integration.reason ? [integration.reason] : []),
    ...suggestions.reasons,
  ];
  return {
    schemaVersion: 1,
    workspace: record.workspace,
    branch,
    repo: repoPath,
    worktreePath: record.worktreePath,
    devpodId: record.devpodId,
    ownership: ownershipEvidence.ownerStatus,
    provider: ownershipEvidence.devpodStatus,
    checkout: snapshot.checkout,
    route: routeStatus(record, routes),
    activity: activity.status,
    cutoff,
    latestTimestamp: activity.latestTimestamp,
    contributingEvidence: activity.contributingEvidence,
    activityEvidence: activity.evidence,
    integration: integration.status,
    eligibleActions: suggestions.eligibleActions,
    suggestions: suggestions.suggestions,
    reasons: Array.from(new Set(reasons)),
  };
}

export function buildWorkspaceCleanupReport(
  options: WorkspaceCleanupOptions = {},
  dependencies: WorkspaceCleanupDependencies = {},
): WorkspaceCleanupReport {
  const repoPath = resolveRepoPath(options.repo);
  const commandRunner = dependencies.commandRunner ?? defaultCommandRunner;
  const duration = parseInactiveFor(options.inactiveFor);
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - duration.seconds * 1000).toISOString();
  const worktrees = (dependencies.listWorktrees ?? listGitWorktrees)(repoPath);
  const records = (dependencies.listOwnership ?? listWorkspaceOwnership)(repoPath);
  let devpods: DevpodWorkspace[] | undefined;
  try {
    const listDevpods =
      dependencies.listDevpods ?? (options.checkMerged ? listDevpodWorkspaces : undefined);
    devpods = listDevpods?.();
  } catch {
    devpods = undefined;
  }
  let routes: HostRouteState[] | undefined;
  try {
    routes = (dependencies.readRoutes ?? readHostRouteStateReadOnly)();
  } catch {
    routes = undefined;
  }
  const rows = records
    .map((record) => {
      const worktree = worktrees.find((candidate) =>
        sameWorkspacePath(candidate.path, record.worktreePath),
      );
      const snapshot = (
        dependencies.readGitSnapshot ?? ((candidate) => readGitSnapshot(candidate, commandRunner))
      )(
        worktree ?? {
          path: record.worktreePath,
          branch: record.branch ?? undefined,
          locked: false,
          prunable: true,
        },
      );
      return buildRow(
        repoPath,
        record,
        worktrees,
        devpods,
        routes,
        snapshot,
        cutoff,
        Boolean(options.checkMerged),
        commandRunner,
        dependencies.inspectOwnership ??
          ((recordValue, worktreeValues, devpodValues) => {
            const status = inspectWorkspaceOwnership(recordValue, worktreeValues, devpodValues);
            return { ownerStatus: status.ownerStatus, devpodStatus: status.devpodStatus };
          }),
        dependencies.inspectIntegration,
      );
    })
    .sort((left, right) => left.workspace.localeCompare(right.workspace));
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    repoPath,
    inactiveFor: duration.input,
    cutoff,
    checkMerged: Boolean(options.checkMerged),
    workspaces: rows,
  };
}
