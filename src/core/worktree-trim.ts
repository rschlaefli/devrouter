import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withLifecycleOperationLock } from "./reliability-lifecycle";
import type { WorkspaceCleanupReport, WorkspaceCleanupRow } from "./workspace-cleanup";
import {
  byteOrder,
  candidateId,
  canonicalJson,
  identityMismatch,
  isQuiet,
  MANIFEST_KIND,
  type ManifestCandidate,
  matchingReceipt,
  preflightManifestApply,
  ReclaimSkip,
  type ReclaimSkipCode,
  readWorktreeIdentity,
  runVetoCommand,
  validateManifest,
  type WorktreeManifest,
  writeReceipt,
} from "./worktree-reclaim";
import { inspectLocalWorktreeSafety, matchesWorktreePattern } from "./worktree-safety";

/**
 * Trim removes declared, reproducible ignored paths (`worktrees.trim`) from
 * quiet linked worktrees while keeping the worktree, its branch and any
 * runtime. It shares the reclaim manifest format, receipts and outcome classes.
 */

/** Ignored paths as `git status` reports them, without the directory marker. */
function listIgnoredPaths(worktreePath: string): string[] | undefined {
  const result = spawnSync(
    "git",
    [
      "-C",
      worktreePath,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ],
    {
      encoding: "utf-8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error) return undefined;
  return result.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("!! "))
    .map((entry) => entry.slice(3).replace(/\/+$/, ""));
}

function matchingPaths(worktreePath: string, trim: readonly string[]): string[] {
  const ignored = listIgnoredPaths(worktreePath) ?? [];
  return [
    ...new Set(
      ignored.filter((entry) => trim.some((pattern) => matchesWorktreePattern(pattern, entry))),
    ),
  ].sort(byteOrder);
}

/**
 * The trim manifest for a schema-3 cleanup report: every quiet linked tree
 * that is safe once the trim patterns count as disposable, has no runtime
 * evidence or running runtime, and holds at least one existing ignored path
 * matching `patterns.trim`. Forge state is irrelevant.
 */
export function buildTrimManifest(
  report: WorkspaceCleanupReport,
  patterns: { trim: readonly string[]; disposable?: readonly string[] },
  createdAtEpoch: number,
): string {
  if (report.schemaVersion !== 3) throw new Error("a trim manifest needs --all-worktrees");
  const cutoffEpoch = Math.floor(Date.parse(report.cutoff) / 1000);
  const rows: { managed?: WorkspaceCleanupRow; worktreePath: string; codes: string[] }[] = [
    ...report.workspaces.map((row) => ({
      managed: row,
      worktreePath: row.worktreePath,
      codes: row.safety?.codes ?? ["git-error"],
    })),
    ...(report.worktrees ?? []).map((row) => ({
      worktreePath: row.worktreePath,
      codes: row.safety.codes,
    })),
  ];
  const candidates: ManifestCandidate[] = [];
  if (patterns.trim.length > 0) {
    for (const row of rows) {
      if (row.codes.some((code) => ["primary", "locked", "runtime-present"].includes(code))) {
        continue;
      }
      if (row.managed && !["absent", "stopped", "not-found"].includes(row.managed.runtime)) {
        continue;
      }
      const identity = readWorktreeIdentity(row.worktreePath);
      if (!identity || !isQuiet(row, identity.gitDir, cutoffEpoch)) continue;
      const local = inspectLocalWorktreeSafety(row.worktreePath, {
        extraDisposablePatterns: [...(patterns.disposable ?? []), ...patterns.trim],
      });
      if (local.codes.length) continue;
      const paths = matchingPaths(row.worktreePath, patterns.trim);
      if (!paths.length) continue;
      const candidate = {
        ...identity,
        branch: identity.branchRef.slice("refs/heads/".length),
        paths,
        reason: `${paths.length} declared trim path(s), clean, quiet since ${report.cutoff}`,
      };
      candidates.push({ ...candidate, id: candidateId(candidate) });
    }
  }
  candidates.sort(
    (a, b) => byteOrder(a.repo, b.repo) || byteOrder(a.path, b.path) || byteOrder(a.id, b.id),
  );
  const manifest: WorktreeManifest = {
    action: "trim",
    activitySource: "devrouter",
    candidateCount: candidates.length,
    candidates,
    createdAtEpoch,
    kind: MANIFEST_KIND,
    schemaVersion: 1,
  };
  validateManifest(manifest);
  return canonicalJson(manifest);
}

export type TrimSkipCode = ReclaimSkipCode | "nothing-removed";
export type TrimFailureCode = "teardown-failed" | "environment";

export type TrimTargetOutcome = {
  id: string;
  path: string;
  status: "trimmed" | "already-done" | "would-trim" | "skipped" | "failed" | "not-attempted";
  code?: TrimSkipCode | TrimFailureCode;
  reason?: string;
  /** `removed:<path>`, `gone:<path>` or `skipped-<why>:<path>`, in manifest order. */
  steps: string[];
};

export type TrimApplyReport = {
  manifestSha256: string;
  dryRun: boolean;
  targets: TrimTargetOutcome[];
  stoppedEarly: boolean;
};

export type TrimVerdictContext = {
  /** The repository's `worktrees.trim` patterns; a listed path must still match one. */
  patterns: readonly string[];
  /** Reasons the tree must not be trimmed right now; empty means it may be. */
  blockers: (worktreePath: string) => string[];
  /** Whether the tree has activity inside the window; used when no veto command is given. */
  isActive: (worktreePath: string) => boolean;
};

export type TrimApplyDependencies = {
  /** Fresh check context for one repository, built once at apply start. */
  prepare: (repo: string) => TrimVerdictContext;
  runVeto?: (command: string, worktreePath: string) => boolean;
  nowEpoch?: () => number;
  /** The exact-path lifecycle lock; tests may replace it. */
  withLock?: (worktreePath: string, operation: () => Promise<void>) => Promise<void>;
};

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function hasTrackedFiles(worktreePath: string, relative: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "--literal-pathspecs", "ls-files", "-z", "--", relative],
    { encoding: "utf-8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
  );
  // A failed probe is treated as tracked so that nothing is removed on doubt.
  return result.status !== 0 || Boolean(result.error) || result.stdout.length > 0;
}

/** Removes one listed path after re-checking it; records the outcome in `steps`. */
function trimOnePath(
  candidate: ManifestCandidate,
  relative: string,
  patterns: readonly string[],
  steps: string[],
): void {
  const target = path.join(candidate.path, relative);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      steps.push(`gone:${relative}`);
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    steps.push(`skipped-symlink:${relative}`);
    return;
  }
  if (!isInside(fs.realpathSync.native(candidate.path), fs.realpathSync.native(target))) {
    steps.push(`skipped-outside:${relative}`);
    return;
  }
  if (!patterns.some((pattern) => matchesWorktreePattern(pattern, relative))) {
    steps.push(`skipped-undeclared:${relative}`);
    return;
  }
  if (hasTrackedFiles(candidate.path, relative)) {
    steps.push(`skipped-tracked:${relative}`);
    return;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    steps.push(`partial:${relative}`);
    throw error;
  }
  steps.push(`removed:${relative}`);
}

/**
 * Applies an approved trim manifest. Without `yes` it is a dry run that
 * verifies every target and changes nothing. Each target is verified again
 * inside its own lifecycle lock immediately before removal; a changed target
 * is skipped, and an error after removal began stops the batch.
 */
export async function applyTrimManifest(
  options: {
    manifestFile: string;
    sha256: string;
    maxAgeSeconds: number;
    vetoCommand?: string;
    yes: boolean;
  },
  dependencies: TrimApplyDependencies,
): Promise<TrimApplyReport> {
  const { manifest, manifestSha256, now } = preflightManifestApply(
    options,
    "trim",
    dependencies.nowEpoch,
  );
  const runVeto = dependencies.runVeto ?? runVetoCommand;
  const withLock = dependencies.withLock ?? withLifecycleOperationLock;

  const contexts = new Map<string, TrimVerdictContext>();
  const contextFor = (repo: string): TrimVerdictContext => {
    let context = contexts.get(repo);
    if (!context) {
      context = dependencies.prepare(repo);
      contexts.set(repo, context);
    }
    return context;
  };

  const targets: TrimTargetOutcome[] = [];
  const errorCodes = new Set<string>();
  let stoppedEarly = false;
  for (const candidate of manifest.candidates) {
    const outcome: TrimTargetOutcome = {
      id: candidate.id,
      path: candidate.path,
      status: "skipped",
      steps: [],
    };
    targets.push(outcome);
    if (stoppedEarly) {
      outcome.status = "not-attempted";
      continue;
    }
    const listed = candidate.paths ?? [];
    if (
      listed.every((relative) => !exists(path.join(candidate.path, relative))) &&
      matchingReceipt(candidate, manifestSha256)
    ) {
      outcome.status = "already-done";
      continue;
    }

    const verify = (): void => {
      const mismatch = identityMismatch(candidate, readWorktreeIdentity(candidate.path));
      if (mismatch) throw new ReclaimSkip("stale-identity", mismatch);
      const context = contextFor(candidate.repo);
      const blockers = context.blockers(candidate.path);
      if (blockers.length) {
        throw new ReclaimSkip("verdict-keep", `the tree is now blocked (${blockers.join(", ")})`);
      }
      if (options.vetoCommand) {
        if (!runVeto(options.vetoCommand, candidate.path)) {
          throw new ReclaimSkip("veto-denied", "the veto command denied the trim");
        }
      } else if (context.isActive(candidate.path)) {
        throw new ReclaimSkip("active", "activity inside the window");
      }
    };

    try {
      if (!options.yes) {
        verify();
        outcome.status = "would-trim";
        const present = listed.filter((relative) => exists(path.join(candidate.path, relative)));
        outcome.reason = present.length ? `would remove: ${present.join(", ")}` : "nothing present";
        continue;
      }
      await withLock(candidate.path, async () => {
        verify();
        const patterns = contextFor(candidate.repo).patterns;
        for (const relative of listed) trimOnePath(candidate, relative, patterns, outcome.steps);
      });
      if (!outcome.steps.some((step) => step.startsWith("removed:") || step.startsWith("gone:"))) {
        outcome.code = "nothing-removed";
        outcome.reason = "every listed path was skipped";
        continue;
      }
      writeReceipt(candidate, manifestSha256, outcome.steps, now);
      outcome.status = "trimmed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lockHeld =
        outcome.steps.length === 0 &&
        error instanceof Error &&
        !(error instanceof ReclaimSkip) &&
        /gave up after waiting/.test(message);
      if (error instanceof ReclaimSkip || lockHeld) {
        const code = error instanceof ReclaimSkip ? error.code : "lock-unavailable";
        outcome.code = code;
        outcome.reason = message;
        // The same skip twice in a row from an unavailable lock points at a
        // stuck holder, not a stale target.
        if (code === "lock-unavailable" && errorCodes.has(code)) stoppedEarly = true;
        errorCodes.add(code);
        continue;
      }
      outcome.status = "failed";
      outcome.code = outcome.steps.some(
        (step) => step.startsWith("removed:") || step.startsWith("partial:"),
      )
        ? "teardown-failed"
        : "environment";
      outcome.reason = message;
      stoppedEarly = true;
    }
  }
  return { manifestSha256, dryRun: !options.yes, targets, stoppedEarly };
}
