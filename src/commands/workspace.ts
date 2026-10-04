import fs from "node:fs";
import path from "node:path";
import { printJSON, printReclaimReport, printWorkspaceCleanupReport } from "../core/output";
import { loadRepoConfig, resolveRepoPath } from "../core/repo-config";
import {
  buildWorkspaceCleanupReport,
  parseInactiveFor,
  prepareReclaimVerdicts,
  prepareTrimChecks,
  type WorkspaceCleanupOptions,
} from "../core/workspace-cleanup";
import { applyWorkspaceGc, inspectWorkspaceGc } from "../core/workspace-gc";
import { settleWorkspaceJournal } from "../core/workspace-journal-settle";
import {
  reclaimWorktreeExactPath,
  workspaceDown,
  workspaceLs,
  workspaceStop,
  workspaceUp,
} from "../core/workspace-lifecycle";
import { resolveGitCommonDir } from "../core/workspace-ownership";
import {
  applyReclaimManifest,
  buildReclaimManifest,
  ReclaimSkip,
  readManifest,
  selectManifest,
  sha256Hex,
} from "../core/worktree-reclaim";
import { applyTrimManifest, buildTrimManifest } from "../core/worktree-trim";
import { resolveGitCheckoutPath } from "./environment-path";

function resolveGitWorkspaceRepo(repoPath?: string): string {
  const resolved = resolveRepoPath(repoPath);
  try {
    resolveGitCommonDir(resolved);
  } catch (error) {
    throw new Error(`Workspace commands require a Git repository: '${resolved}'.`, {
      cause: error,
    });
  }
  return resolved;
}

export async function runWorkspaceUpCommand(
  branch: string,
  options: { path?: string; noDevpod?: boolean; open?: boolean; repo?: string },
): Promise<void> {
  const repoPath = resolveGitWorkspaceRepo(options.repo);
  await workspaceUp(branch, {
    path: options.path,
    noDevpod: options.noDevpod,
    open: options.open,
    repoPath,
  });
}

export function runWorkspaceLsCommand(options: { repo?: string; json?: boolean }): void {
  const repoPath = resolveGitWorkspaceRepo(options.repo);
  const rows = workspaceLs(repoPath);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("No git worktrees found.\n");
    return;
  }
  for (const row of rows) {
    const label = row.workspace ?? "(primary)";
    const ownership = row.ownerStatus ?? (row.legacy ? "legacy" : "unmanaged");
    process.stdout.write(
      `${label}\t${row.branch ?? "-"}\t${ownership}\tdevpod:${row.devpodStatus}\t${row.routeCount} route(s)\t${row.worktreePath}\n`,
    );
  }
}

export function runWorkspaceCleanupCommand(
  options: WorkspaceCleanupOptions & {
    json?: boolean;
    manifest?: boolean;
    output?: string;
    action?: "reclaim" | "trim";
  },
): void {
  const repoPath = resolveGitWorkspaceRepo(options.repo);
  const report = buildWorkspaceCleanupReport({ ...options, repo: repoPath });
  if (options.manifest) {
    const action = options.action ?? "reclaim";
    if (action !== "reclaim" && action !== "trim") {
      throw new Error("--action must be reclaim or trim.");
    }
    if (action === "trim") {
      if (!options.allWorktrees)
        throw new Error("--manifest --action trim requires --all-worktrees.");
    } else if (!options.allWorktrees || !options.checkMerged) {
      throw new Error("--manifest requires --all-worktrees and --check-merged.");
    }
    const createdAtEpoch = Math.floor(Date.now() / 1000);
    const worktrees = fs.existsSync(path.join(repoPath, ".devrouter.yml"))
      ? loadRepoConfig(repoPath).worktrees
      : undefined;
    const manifest =
      action === "trim"
        ? buildTrimManifest(
            report,
            { trim: worktrees?.trim ?? [], disposable: worktrees?.disposable },
            createdAtEpoch,
          )
        : buildReclaimManifest(report, createdAtEpoch);
    if (options.output) {
      fs.writeFileSync(options.output, manifest, { flag: "wx" });
      process.stdout.write(`${sha256Hex(manifest)}  ${options.output}\n`);
    } else {
      process.stdout.write(manifest);
    }
    return;
  }
  if (options.json) {
    printJSON(report);
    return;
  }
  printWorkspaceCleanupReport(report);
}

export async function runWorkspaceDownCommand(
  target: string,
  options: { keepWorktree?: boolean; repo?: string },
): Promise<void> {
  const repoPath = resolveGitWorkspaceRepo(options.repo);
  await workspaceDown(target, {
    keepWorktree: options.keepWorktree,
    repoPath,
  });
}

export async function runWorkspaceStopCommand(
  target: string,
  options: { repo?: string },
): Promise<void> {
  const repoPath = resolveGitWorkspaceRepo(options.repo);
  await workspaceStop(target, { repoPath });
}

export function runWorkspaceGcCommand(options: {
  repo?: string;
  json?: boolean;
  yes?: boolean;
}): void {
  const repoPath = resolveGitWorkspaceRepo(options.repo);
  const plan = inspectWorkspaceGc(repoPath);
  const report = options.yes ? applyWorkspaceGc(plan) : plan;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Workspace GC ${report.mode}: ${report.summary.eligible} eligible, ${report.summary.blocked} blocked, ${report.summary.cleaned} cleaned, ${report.summary.errors} error(s).\n`,
    );
    for (const candidate of report.candidates) {
      process.stdout.write(
        `${candidate.workspace}\t${candidate.kind}\t${candidate.ownerStatus ?? "legacy"}\t${candidate.eligible ? "eligible" : "blocked"}\t${candidate.worktreePath}\n`,
      );
    }
    if (!options.yes && report.summary.eligible > 0) {
      process.stdout.write("Dry run only. Re-run with --yes to apply eligible cleanup.\n");
    }
  }
  if (report.summary.errors > 0) process.exitCode = 1;
}

export async function runWorkspaceJournalSettleCommand(options: {
  path?: string;
  json?: boolean;
}): Promise<void> {
  const repoPath = resolveGitCheckoutPath(options.path);
  const result = await settleWorkspaceJournal(repoPath);
  if (options.json) {
    printJSON(result);
    return;
  }
  const workspaceLabel = result.workspace ? ` (workspace '${result.workspace}')` : "";
  if (result.status === "already-settled") {
    process.stdout.write(
      `Journal operation ${result.operationId} is already settled${workspaceLabel}.\n`,
    );
    return;
  }
  process.stdout.write(
    `Settled journal operation ${result.operationId} (was ${result.priorStatus})${workspaceLabel}; ensure and stop may proceed.\n`,
  );
}

export function runWorkspaceManifestHashCommand(file: string): void {
  const { raw } = readManifest(file);
  process.stdout.write(`${sha256Hex(raw)}\n`);
}

export function runWorkspaceManifestSelectCommand(
  file: string,
  options: { expectedSha256: string; id: string[] },
): void {
  process.stdout.write(selectManifest(file, options.expectedSha256, options.id));
}

export async function runWorkspaceReclaimCommand(options: {
  manifest: string;
  sha256: string;
  maxAge?: string;
  inactiveFor?: string;
  vetoCommand?: string;
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  const inactiveFor = parseInactiveFor(options.inactiveFor ?? "24h").input;
  const report = await applyReclaimManifest(
    {
      manifestFile: options.manifest,
      sha256: options.sha256,
      maxAgeSeconds: parseInactiveFor(options.maxAge ?? "24h").seconds,
      vetoCommand: options.vetoCommand,
      yes: Boolean(options.yes),
    },
    {
      prepare: (repo) => prepareReclaimVerdicts(repo, inactiveFor),
      removeWorktree: (candidate, verify, afterRemove, steps) =>
        reclaimWorktreeExactPath(candidate.repo, candidate.path, verify, afterRemove, steps),
    },
  );
  if (options.json) {
    printJSON(report);
  } else {
    printReclaimReport(report);
  }
  if (report.stoppedEarly || report.targets.some((target) => target.status === "failed")) {
    process.exitCode = 1;
  }
}

export async function runWorkspaceTrimCommand(options: {
  manifest: string;
  sha256: string;
  maxAge?: string;
  inactiveFor?: string;
  vetoCommand?: string;
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  const inactiveFor = parseInactiveFor(options.inactiveFor ?? "14d").input;
  const report = await applyTrimManifest(
    {
      manifestFile: options.manifest,
      sha256: options.sha256,
      maxAgeSeconds: parseInactiveFor(options.maxAge ?? "24h").seconds,
      vetoCommand: options.vetoCommand,
      yes: Boolean(options.yes),
    },
    { prepare: (repo) => prepareTrimChecks(repo, inactiveFor) },
  );
  if (options.json) {
    printJSON(report);
  } else {
    printReclaimReport(report, "trim");
  }
  if (report.stoppedEarly || report.targets.some((target) => target.status === "failed")) {
    process.exitCode = 1;
  }
}
