import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoPath } from "./repo-config";
import { listRoutesForWorktreePaths, removeWorkspaceRoutesForWorktree } from "./route-state";
import {
  isLinkedWorktree,
  resolveWorktreeWorkspace,
  sameWorkspacePath,
  withWorkspaceLifecycleLock,
  wsFromBranch,
} from "./workspace";
import { listDevpodWorkspaces, workspaceEnsure } from "./workspace-ensure";
import {
  type DevpodOwnerStatus,
  type GitWorktree,
  inspectWorkspaceOwnership,
  listGitWorktrees,
  listWorkspaceOwnership,
  type WorkspaceOwnerStatus,
} from "./workspace-ownership";

// `dev workspace` ties a git worktree, an optional devpod/devcontainer, and the
// per-workspace routes together so an agent can spin up (and tear down) a fully
// isolated, routed copy of a repo in one command. devrouter stays a router: the
// devpod calls are best-effort glue, gated on devpod being installed.

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

function hasDevpod(): boolean {
  const result = spawnSync("devpod", ["version"], { encoding: "utf-8" });
  return result.status === 0;
}

type IdentifiedGitWorktree = GitWorktree & { workspace: string | undefined };

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

export async function workspaceDown(
  target: string,
  opts: { keepWorktree?: boolean; keepDevpod?: boolean; repoPath?: string } = {},
): Promise<{ freedRoutes: number; workspace: string }> {
  const requestedWorkspace = wsFromBranch(target);
  if (!requestedWorkspace) {
    throw new Error(`'${target}' does not yield a valid workspace token.`);
  }

  // Resolve this repo's worktree for the workspace (live entry, else the default
  // path) so route freeing can be scoped to it. Never load the worktree's config,
  // so teardown still works when the worktree/.devrouter.yml is already gone.
  const mainRepo = resolveRepoPath(opts.repoPath);
  const worktrees = identifyGitWorktrees(mainRepo).filter(
    (worktree) => worktree.workspace !== undefined,
  );
  const exactBranchMatch = worktrees.find((worktree) => worktree.branch === target);
  const match =
    exactBranchMatch ??
    oneWorkspaceMatch(
      target,
      worktrees.filter((worktree) => worktree.workspace === requestedWorkspace),
    ) ??
    oneWorkspaceMatch(
      target,
      worktrees.filter(
        (worktree) =>
          worktree.branch !== undefined && wsFromBranch(worktree.branch) === requestedWorkspace,
      ),
    );
  const workspace = match?.workspace ?? requestedWorkspace;
  const worktreePath = match?.path ?? teardownFallbackPath(mainRepo, workspace);

  const teardown = async (): Promise<{ freedRoutes: number; workspace: string }> => {
    // Free routes by the workspace tag AND the worktree path, so a same-named
    // workspace in a different repo is never torn down by this call.
    const routes = removeWorkspaceRoutesForWorktree(workspace, worktreePath);
    process.stdout.write(`Freed ${routes.length} route(s) for workspace '${workspace}'.\n`);

    if (!opts.keepDevpod && hasDevpod()) {
      spawnSync("devpod", ["stop", workspace], { stdio: "inherit" });
    }

    if (!opts.keepWorktree) {
      if (fs.existsSync(worktreePath) && worktreePath !== mainRepo) {
        const rm = spawnSync("git", ["-C", mainRepo, "worktree", "remove", worktreePath], {
          encoding: "utf-8",
        });
        if (rm.status === 0) {
          process.stdout.write(`Removed worktree ${worktreePath}.\n`);
        } else {
          process.stderr.write(
            `Warning: could not remove worktree ${worktreePath}: ${rm.stderr || "unknown error"}\n`,
          );
        }
      }
    }

    return { freedRoutes: routes.length, workspace };
  };

  return match && fs.existsSync(worktreePath)
    ? withWorkspaceLifecycleLock(worktreePath, teardown)
    : teardown();
}
