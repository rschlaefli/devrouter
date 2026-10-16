import fs from "node:fs";
import path from "node:path";
import {
  applyLeftoverManifest,
  buildLeftoverManifest,
  findDockerLeftovers,
  isLeftoverManifest,
  readDockerInventory,
  readLeftoverContext,
  readLeftoverManifest,
} from "../core/docker-leftovers";
import { withFileLock } from "../core/file-lock";
import { idleSweepPaths, summarizeSweep, writeLastSweep } from "../core/idle-sweep";
import { printJSON, printReclaimReport, printWorkspaceCleanupReport } from "../core/output";
import { superviseLifecycle } from "../core/reliability-lifecycle";
import { loadRepoConfig, resolveRepoPath } from "../core/repo-config";
import {
  buildWorkspaceCleanupReport,
  parseInactiveFor,
  prepareReclaimVerdicts,
  prepareTrimChecks,
  type WorkspaceCleanupOptions,
} from "../core/workspace-cleanup";
import { applyWorkspaceGc, inspectWorkspaceGc } from "../core/workspace-gc";
import {
  buildWorkspaceIdleReport,
  type IdleStopOutcome,
  setIdlePin,
  stopIdleEnvironments,
  type WorkspaceIdleOptions,
  type WorkspaceIdleReport,
} from "../core/workspace-idle";
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

function writeManifestOutput(manifest: string, output?: string): void {
  if (output) {
    fs.writeFileSync(output, manifest, { flag: "wx" });
    process.stdout.write(`${sha256Hex(manifest)}  ${output}\n`);
  } else {
    process.stdout.write(manifest);
  }
}

export function runWorkspaceCleanupCommand(
  options: WorkspaceCleanupOptions & {
    json?: boolean;
    manifest?: boolean;
    output?: string;
    action?: "reclaim" | "trim" | "leftover";
  },
): void {
  const repoPath = resolveGitWorkspaceRepo(options.repo);
  if (options.manifest && options.action === "leftover") {
    const leftovers = findDockerLeftovers(readDockerInventory(), readLeftoverContext(repoPath));
    writeManifestOutput(
      buildLeftoverManifest(repoPath, leftovers, Math.floor(Date.now() / 1000)),
      options.output,
    );
    return;
  }
  const report = buildWorkspaceCleanupReport({ ...options, repo: repoPath });
  if (options.manifest) {
    const action = options.action ?? "reclaim";
    if (action !== "reclaim" && action !== "trim") {
      throw new Error("--action must be reclaim, trim or leftover.");
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
    writeManifestOutput(manifest, options.output);
    return;
  }
  if (options.json) {
    printJSON(report);
    return;
  }
  printWorkspaceCleanupReport(report);
}

export function runWorkspacePinCommand(options: {
  path?: string;
  off?: boolean;
  json?: boolean;
}): void {
  const repoPath = resolveGitCheckoutPath(options.path);
  const protection = setIdlePin(repoPath, !options.off);
  if (options.json) {
    printJSON({ repoPath, ...protection });
    return;
  }
  process.stdout.write(
    protection.pinned
      ? `Pinned '${repoPath}' against idle stop.\n`
      : `Removed the idle pin from '${repoPath}'.\n`,
  );
}

export async function runWorkspaceIdleCommand(
  options: WorkspaceIdleOptions & { stop?: boolean; json?: boolean },
): Promise<void> {
  const query = {
    repo: options.repo ? resolveGitWorkspaceRepo(options.repo) : undefined,
    idleFor: options.idleFor,
  };
  let report: WorkspaceIdleReport;
  let stops: IdleStopOutcome[] = [];
  if (options.stop) {
    const paths = idleSweepPaths();
    fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    // Several stops can outlast the agent interval; one sweep runs at a time.
    const result = await withFileLock(paths.lock, { activity: "idle sweep" }, async () => {
      try {
        const swept = await stopIdleEnvironments(query, (repoPath, assertStopIntent) =>
          superviseLifecycle("stop", repoPath, {}, undefined, { assertStopIntent }),
        );
        writeLastSweep(summarizeSweep(swept.idleFor, swept.stops), paths);
        return swept;
      } catch (error) {
        writeLastSweep(summarizeSweep(options.idleFor ?? "30m", [], error), paths);
        throw error;
      }
    });
    report = result;
    stops = result.stops;
  } else {
    report = buildWorkspaceIdleReport(query);
  }
  if (stops.some((stop) => stop.outcome === "failed")) process.exitCode = 1;
  if (options.json) {
    printJSON(report);
    return;
  }
  for (const warning of report.warnings) process.stderr.write(`Warning: ${warning}\n`);
  if (options.stop) {
    // The launchd agent appends this output every sweep, so only stops are printed.
    for (const stop of stops) {
      const detail = stop.reason ? `: ${stop.reason}` : "";
      process.stdout.write(`${report.generatedAt}\t${stop.outcome}\t${stop.repoPath}${detail}\n`);
    }
    return;
  }
  if (report.rows.length === 0) {
    process.stdout.write("No running managed environments.\n");
    return;
  }
  for (const row of report.rows) {
    const detail = row.reasons.length > 0 ? `\t${row.reasons.join("; ")}` : "";
    process.stdout.write(`${row.status}\t${row.latestActivity ?? "-"}\t${row.repoPath}${detail}\n`);
  }
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
  let leftover = false;
  try {
    leftover = isLeftoverManifest(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    // The validating reader below reports unreadable or malformed files.
  }
  const { raw } = leftover ? readLeftoverManifest(file) : readManifest(file);
  process.stdout.write(`${sha256Hex(raw)}\n`);
}

export function runWorkspaceLeftoverCommand(options: {
  manifest: string;
  sha256: string;
  maxAge?: string;
  yes?: boolean;
  json?: boolean;
}): void {
  const report = applyLeftoverManifest({
    manifestFile: options.manifest,
    sha256: options.sha256,
    maxAgeSeconds: parseInactiveFor(options.maxAge ?? "24h").seconds,
    yes: Boolean(options.yes),
  });
  if (options.json) {
    printJSON(report);
  } else {
    printReclaimReport(
      {
        dryRun: report.dryRun,
        stoppedEarly: false,
        targets: report.targets.map((target) => ({
          ...target,
          path: target.project,
          steps: summarizeLeftoverSteps(target.steps),
        })),
      },
      "remove the leftovers",
    );
    if (!report.dryRun && report.targets.some((target) => target.steps.length)) {
      process.stdout.write(
        "Each removed object is listed in the stack's receipt; use --json for the full list.\n",
      );
    }
  }
  if (report.targets.some((target) => target.status === "failed")) process.exitCode = 1;
}

/**
 * Collapses `removed-container:<id>`-style steps into per-kind counts, such as
 * `removed 7 container(s), 42 volume(s)`, so a stack fits on one table row.
 */
function summarizeLeftoverSteps(steps: string[]): string[] {
  const counts = new Map<string, Map<string, number>>();
  for (const step of steps) {
    const [action, kind] = step.slice(0, step.indexOf(":")).split("-");
    const byKind = counts.get(action) ?? new Map<string, number>();
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    counts.set(action, byKind);
  }
  return [...counts].map(
    ([action, byKind]) =>
      `${action === "gone" ? "already gone" : action} ${[...byKind]
        .map(([kind, count]) => `${count} ${kind}(s)`)
        .join(", ")}`,
  );
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
