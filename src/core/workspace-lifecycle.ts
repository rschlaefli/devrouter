import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  inspectDevpodWorkspaceOwnership,
  listDevpodWorkspaces,
  runDevpodWorkspaceAction,
} from "./devpod-workspaces";
import { resolveRepoPath } from "./repo-config";
import { listRoutesForWorktreePaths, removeWorkspaceRoutesForWorktree } from "./route-state";
import {
  isLinkedWorktree,
  resolveWorktreeWorkspace,
  sameWorkspacePath,
  withWorkspaceLifecycleLock,
  wsFromBranch,
} from "./workspace";
import { workspaceEnsure } from "./workspace-ensure";
import {
  type DevpodOwnerStatus,
  type GitWorktree,
  inspectWorkspaceOwnership,
  listGitWorktrees,
  listMissingWorkspaceOwnership,
  listWorkspaceOwnership,
  removeWorkspaceOwnership,
  type WorkspaceOwnerStatus,
  type WorkspaceOwnershipRecord,
} from "./workspace-ownership";

// Workspace lifecycle mutations fail closed: Git, ledger, DevPod source, and
// route evidence must identify the same exact owner before resources change.

export type WorkspaceRow = {
  workspace: string | undefined;
  branch: string | undefined;
  worktreePath: string;
  legacy: boolean;
  ownerStatus: WorkspaceOwnerStatus | undefined;
  devpodStatus: DevpodOwnerStatus;
  routeCount: number;
  hosts: string[];
};

type IdentifiedGitWorktree = GitWorktree & { workspace: string | undefined };

function warnMissingWorkspaceOwnership(repoPath: string): void {
  const missing = listMissingWorkspaceOwnership(repoPath);
  if (missing.length === 0) return;
  process.stderr.write(
    `Warning: ${missing.length} managed workspace owner${missing.length === 1 ? " is" : "s are"} missing. Review: dev workspace gc --repo ${repoPath}\n`,
  );
}

function defaultWorktreePath(mainRepo: string, ws: string): string {
  return path.join(mainRepo, "trees", ws);
}

function assertDefaultWorktreeRootIgnored(mainRepo: string): void {
  const ignored = spawnSync("git", ["-C", mainRepo, "check-ignore", "-q", "--no-index", "trees/"], {
    encoding: "utf-8",
  });
  if (ignored.status !== 0) {
    throw new Error(
      `Default worktree root '${path.join(mainRepo, "trees")}' is not ignored. Add 'trees/' to '${path.join(mainRepo, ".gitignore")}' or use --path.`,
    );
  }
}

function legacyDefaultWorktreePath(mainRepo: string, ws: string): string {
  return path.join(path.dirname(mainRepo), `${path.basename(mainRepo)}-${ws}`);
}

function teardownFallbackPath(mainRepo: string, workspace: string): string {
  const candidates = [
    defaultWorktreePath(mainRepo, workspace),
    legacyDefaultWorktreePath(mainRepo, workspace),
  ];
  const routes = listRoutesForWorktreePaths(candidates);
  const routed = candidates.filter((candidate) => (routes.get(candidate)?.length ?? 0) > 0);
  if (routed.length > 1) {
    throw new Error(
      `Workspace target '${workspace}' has routes for multiple removed worktree paths: ${routed.join(", ")}`,
    );
  }
  return routed[0] ?? candidates[0];
}

function identifyGitWorktrees(mainRepo: string): IdentifiedGitWorktree[] {
  return listGitWorktrees(mainRepo).map((worktree) => ({
    ...worktree,
    workspace: isLinkedWorktree(worktree.path)
      ? resolveWorktreeWorkspace(worktree.path, worktree.branch)
      : undefined,
  }));
}

function oneWorkspaceMatch(
  target: string,
  matches: IdentifiedGitWorktree[],
): IdentifiedGitWorktree | undefined {
  if (matches.length > 1) {
    const details = matches
      .map((match) => `${match.path} (${match.branch ?? "detached"})`)
      .join(", ");
    throw new Error(`Workspace target '${target}' is ambiguous: ${details}`);
  }
  return matches[0];
}

type ResolvedWorkspaceTarget = {
  workspace: string;
  worktreePath: string;
  worktree: IdentifiedGitWorktree | undefined;
  record: WorkspaceOwnershipRecord | undefined;
};

function oneRecordMatch(
  target: string,
  matches: WorkspaceOwnershipRecord[],
): WorkspaceOwnershipRecord | undefined {
  if (matches.length > 1) {
    throw new Error(
      `Workspace target '${target}' is ambiguous: ${matches.map((match) => match.worktreePath).join(", ")}`,
    );
  }
  return matches[0];
}

function resolveWorkspaceTarget(
  mainRepo: string,
  target: string,
  worktrees: IdentifiedGitWorktree[],
  records: WorkspaceOwnershipRecord[],
): ResolvedWorkspaceTarget {
  const requestedWorkspace = wsFromBranch(target);
  if (!requestedWorkspace) {
    throw new Error(`'${target}' does not yield a valid workspace token.`);
  }

  const liveBranchWorktree = oneWorkspaceMatch(
    target,
    worktrees.filter((worktree) => worktree.workspace !== undefined && worktree.branch === target),
  );
  if (liveBranchWorktree) {
    const liveWorkspace = liveBranchWorktree.workspace;
    if (!liveWorkspace) {
      throw new Error(`Live branch '${target}' is not an isolated workspace.`);
    }
    const liveRecord = oneRecordMatch(
      target,
      records.filter((record) => sameWorkspacePath(record.worktreePath, liveBranchWorktree.path)),
    );
    return {
      workspace: liveRecord?.workspace ?? liveWorkspace,
      worktreePath: liveBranchWorktree.path,
      worktree: liveBranchWorktree,
      record: liveRecord,
    };
  }

  const record = records.find((candidate) => candidate.workspace === requestedWorkspace);
  if (record) {
    return {
      workspace: record.workspace,
      worktreePath: record.worktreePath,
      worktree: worktreeForRecord(worktrees, record),
      record,
    };
  }

  const linked = worktrees.filter((worktree) => worktree.workspace !== undefined);
  const worktree =
    oneWorkspaceMatch(
      target,
      linked.filter((candidate) => candidate.workspace === requestedWorkspace),
    ) ??
    oneWorkspaceMatch(
      target,
      linked.filter(
        (candidate) =>
          candidate.branch !== undefined && wsFromBranch(candidate.branch) === requestedWorkspace,
      ),
    );
  const workspace = worktree?.workspace ?? requestedWorkspace;
  return {
    workspace,
    worktreePath: worktree?.path ?? teardownFallbackPath(mainRepo, workspace),
    worktree,
    record: undefined,
  };
}

function worktreeForRecord(
  worktrees: IdentifiedGitWorktree[],
  record: WorkspaceOwnershipRecord,
): IdentifiedGitWorktree | undefined {
  return worktrees.find((candidate) => sameWorkspacePath(candidate.path, record.worktreePath));
}

function devpodForTarget(
  target: ResolvedWorkspaceTarget,
  worktrees: IdentifiedGitWorktree[],
  devpods: ReturnType<typeof listDevpodWorkspaces>,
) {
  if (target.record) {
    const status = inspectWorkspaceOwnership(target.record, worktrees, devpods);
    if (status.ownerStatus === "conflict") {
      throw new Error(
        `Workspace '${target.workspace}' ownership conflicts with live Git or DevPod evidence; no resources were changed.`,
      );
    }
    return status.devpodStatus === "owned"
      ? devpods.find((devpod) => devpod.id === target.record?.devpodId)
      : undefined;
  }

  // Pre-ledger workspaces need the same exact ID+path proof, but have no record
  // whose local persisted token can be inspected.
  const devpodId = target.workspace;
  const ownership = inspectDevpodWorkspaceOwnership(devpods, devpodId, target.worktreePath);
  if (ownership.status === "conflict") {
    throw new Error(ownership.reason);
  }
  return ownership.status === "owned" ? ownership.workspace : undefined;
}

function assertFullDownPreflight(mainRepo: string, target: ResolvedWorkspaceTarget): void {
  if (sameWorkspacePath(target.worktreePath, mainRepo)) {
    throw new Error("Refusing to remove the primary Git checkout.");
  }
  if (!target.worktree || target.worktree.prunable || !fs.existsSync(target.worktreePath)) return;
  if (target.worktree.locked) {
    throw new Error(
      `Worktree '${target.worktreePath}' is locked; unlock it before workspace down.`,
    );
  }
  const status = spawnSync(
    "git",
    ["-C", target.worktreePath, "status", "--porcelain", "--untracked-files=normal"],
    { encoding: "utf-8" },
  );
  if (status.status !== 0) {
    const detail = [status.error?.message, status.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`git status failed for '${target.worktreePath}': ${detail || "unknown error"}`);
  }
  if (status.stdout.trim()) {
    throw new Error(
      `Worktree '${target.worktreePath}' has uncommitted changes; use --keep-worktree or clean it before workspace down.`,
    );
  }
}

export async function workspaceUp(
  branch: string,
  opts: { path?: string; noDevpod?: boolean; open?: boolean; repoPath?: string } = {},
): Promise<void> {
  const mainRepo = resolveRepoPath(opts.repoPath);
  const ws = wsFromBranch(branch);
  if (!ws) {
    throw new Error(`Branch '${branch}' does not yield a valid workspace token.`);
  }
  const worktreePath = opts.path ? path.resolve(opts.path) : defaultWorktreePath(mainRepo, ws);

  // 1. Create the worktree (idempotent). Try an existing branch first, then create one.
  if (fs.existsSync(worktreePath)) {
    const registered = listGitWorktrees(mainRepo).find((worktree) =>
      sameWorkspacePath(worktree.path, worktreePath),
    );
    if (!registered || sameWorkspacePath(registered.path, mainRepo)) {
      throw new Error(`Existing path '${worktreePath}' is not a linked worktree of '${mainRepo}'.`);
    }
    if (registered.branch !== branch) {
      throw new Error(
        `Existing worktree '${worktreePath}' uses branch '${registered.branch ?? "detached"}', not '${branch}'.`,
      );
    }
    process.stdout.write(`Worktree already exists: ${worktreePath}\n`);
  } else {
    if (!opts.path) {
      assertDefaultWorktreeRootIgnored(mainRepo);
    }
    const add = spawnSync("git", ["-C", mainRepo, "worktree", "add", worktreePath, branch], {
      encoding: "utf-8",
    });
    if (add.status !== 0) {
      const addNew = spawnSync(
        "git",
        ["-C", mainRepo, "worktree", "add", "-b", branch, worktreePath],
        {
          encoding: "utf-8",
        },
      );
      if (addNew.status !== 0) {
        const detail = [add.stderr, addNew.stderr]
          .map((s) => s?.trim())
          .filter(Boolean)
          .join("; ");
        throw new Error(`git worktree add failed: ${detail || "unknown error"}`);
      }
    }
    process.stdout.write(`Created worktree ${worktreePath} (workspace '${ws}')\n`);
  }

  if (opts.noDevpod) {
    warnMissingWorkspaceOwnership(mainRepo);
    process.stdout.write("Skipped environment startup; no routes were changed.\n");
    return;
  }

  const ensured = await workspaceEnsure(worktreePath, { open: opts.open });
  if (ensured.urls.length > 0) {
    process.stdout.write(
      `\nWorkspace '${ensured.workspace}' routes:\n${ensured.urls.map((url) => `  ${url}`).join("\n")}\n`,
    );
  }
}

export function workspaceLs(repoPath?: string): WorkspaceRow[] {
  const mainRepo = resolveRepoPath(repoPath);
  const worktrees = identifyGitWorktrees(mainRepo);
  const records = listWorkspaceOwnership(mainRepo);
  let devpods: ReturnType<typeof listDevpodWorkspaces> | undefined;
  try {
    devpods = listDevpodWorkspaces();
  } catch {
    devpods = undefined;
  }
  const paths = Array.from(
    new Set([
      ...worktrees.map((worktree) => worktree.path),
      ...records.map((record) => record.worktreePath),
    ]),
  );
  const routesByWorktreePath = listRoutesForWorktreePaths(paths);

  const worktreesByPath = new Map(worktrees.map((worktree) => [worktree.path, worktree]));
  const recordsByPath = new Map(records.map((record) => [record.worktreePath, record]));

  return paths.map((worktreePath) => {
    // Attribute routes by exact path, never by token alone. This keeps detached,
    // missing, and same-token cross-repository workspaces separate.
    const worktree = worktreesByPath.get(worktreePath);
    const record = recordsByPath.get(worktreePath);
    const status = record ? inspectWorkspaceOwnership(record, worktrees, devpods) : undefined;
    const matchingDevpods = devpods?.filter((devpod) =>
      sameWorkspacePath(devpod.source.localFolder, worktreePath),
    );
    const wsRoutes = routesByWorktreePath.get(worktreePath) ?? [];
    return {
      workspace: record?.workspace ?? worktree?.workspace,
      branch: worktree?.branch ?? record?.branch ?? undefined,
      worktreePath,
      legacy: !record && worktree?.workspace !== undefined,
      ownerStatus: status?.ownerStatus,
      devpodStatus:
        status?.devpodStatus ??
        (devpods === undefined
          ? ("unknown" as const)
          : matchingDevpods?.length === 0
            ? ("absent" as const)
            : matchingDevpods?.length === 1
              ? ("owned" as const)
              : ("conflict" as const)),
      routeCount: wsRoutes.length,
      hosts: wsRoutes.map((route) => route.host),
    };
  });
}

type WorkspaceLifecycleResult = {
  devpodId?: string;
  freedRoutes: number;
  providerChanged: boolean;
  workspace: string;
};

async function runWorkspaceLifecycle(
  action: "stop" | "down",
  target: string,
  opts: { keepWorktree?: boolean; quiet?: boolean; repoPath?: string } = {},
): Promise<WorkspaceLifecycleResult> {
  const mainRepo = resolveRepoPath(opts.repoPath);
  const worktrees = identifyGitWorktrees(mainRepo);
  const records = listWorkspaceOwnership(mainRepo);
  const resolved = resolveWorkspaceTarget(mainRepo, target, worktrees, records);
  const operation = async (): Promise<WorkspaceLifecycleResult> => {
    const removeWorktree = action === "down" && !opts.keepWorktree;
    const devpodAction = action === "stop" ? "stop" : "delete";
    if (removeWorktree) {
      assertFullDownPreflight(mainRepo, resolved);
    }
    const devpods = listDevpodWorkspaces();
    const devpod = devpodForTarget(resolved, worktrees, devpods);
    if (devpod) {
      runDevpodWorkspaceAction(devpodAction, devpod.id);
    }

    // Free routes only after successful provider mutation. Exact workspace+path
    // scoping prevents same-token workspaces in other repositories from changing.
    const routes = removeWorkspaceRoutesForWorktree(resolved.workspace, resolved.worktreePath);
    if (!opts.quiet) {
      process.stdout.write(
        `Freed ${routes.length} route(s) for workspace '${resolved.workspace}'.\n`,
      );
    }

    if (removeWorktree) {
      if (
        resolved.worktree &&
        !resolved.worktree.prunable &&
        fs.existsSync(resolved.worktreePath)
      ) {
        const rm = spawnSync("git", ["-C", mainRepo, "worktree", "remove", resolved.worktreePath], {
          encoding: "utf-8",
        });
        if (rm.status !== 0) {
          const detail = [rm.error?.message, rm.stderr].filter(Boolean).join("\n").trim();
          throw new Error(
            `git worktree remove failed for '${resolved.worktreePath}': ${detail || "unknown error"}`,
          );
        }
        process.stdout.write(`Removed worktree ${resolved.worktreePath}.\n`);
      }
      if (resolved.record) {
        removeWorkspaceOwnership(mainRepo, resolved.workspace);
      }
    }

    return {
      ...(devpod ? { devpodId: devpod.id } : {}),
      freedRoutes: routes.length,
      providerChanged: Boolean(devpod),
      workspace: resolved.workspace,
    };
  };

  return resolved.worktree && !resolved.worktree.prunable && fs.existsSync(resolved.worktreePath)
    ? withWorkspaceLifecycleLock(resolved.worktreePath, operation)
    : operation();
}

export async function workspaceStop(
  target: string,
  opts: { quiet?: boolean; repoPath?: string } = {},
): Promise<WorkspaceLifecycleResult> {
  return runWorkspaceLifecycle("stop", target, opts);
}

export async function workspaceDown(
  target: string,
  opts: { keepWorktree?: boolean; repoPath?: string } = {},
): Promise<WorkspaceLifecycleResult> {
  return runWorkspaceLifecycle("down", target, opts);
}
