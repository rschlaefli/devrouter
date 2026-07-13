import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./file-lock";

// A workspace token identifies one isolated dev environment (a git worktree + its
// devcontainer/devpod). It namespaces the front host and the proxy upstream so N
// parallel worktrees of the same repo route without colliding. The same token is
// derived deterministically by `wsFromBranch` everywhere — devrouter's runtime
// config, the `--id` passed to devpod, and the `${WORKSPACE}` substitution — so
// the three layers agree by construction.

// Single label of a `*.localhost` host: lowercase alphanumeric with interior hyphens.
const MAX_WORKSPACE_LENGTH = 32;
const WORKSPACE_METADATA_FILE = "devrouter-workspace";
const WORKSPACE_LOCK_FILE = "devrouter-workspace.lock";

export function comparableWorkspacePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function sameWorkspacePath(left: string, right: string): boolean {
  return comparableWorkspacePath(left) === comparableWorkspacePath(right);
}

/**
 * Sanitize an arbitrary branch name / slug into a single DNS label suitable for use
 * as a hostname segment. Returns `undefined` when nothing usable remains (so the
 * caller falls back to "no workspace" rather than producing an invalid host).
 */
export function wsFromBranch(branch: string): string | undefined {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_WORKSPACE_LENGTH)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : undefined;
}

/**
 * True only for a *linked* git worktree — not the primary checkout and not a
 * submodule. Both linked worktrees and submodules use a `.git` *file* (vs a
 * directory), so we discriminate on its `gitdir:` target: linked worktrees point
 * into `.git/worktrees/<name>`, submodules into `.git/modules/<name>`.
 */
export function isLinkedWorktree(repoPath: string): boolean {
  const gitPath = path.join(repoPath, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) {
    return false; // directory => primary checkout; anything else => not a worktree
  }
  let content: string;
  try {
    content = fs.readFileSync(gitPath, "utf-8");
  } catch {
    return false;
  }
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) {
    return false;
  }
  const gitdir = match[1].trim().replace(/\\/g, "/");
  return /(^|\/)worktrees\//.test(gitdir);
}

function gitMetadataDir(repoPath: string): string | undefined {
  const gitPath = path.join(repoPath, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return undefined;
  }

  if (stat.isDirectory()) {
    return gitPath;
  }
  if (!stat.isFile()) {
    return undefined;
  }

  const match = fs.readFileSync(gitPath, "utf-8").match(/^gitdir:\s*(.+)$/m);
  if (!match) {
    return undefined;
  }
  return path.resolve(repoPath, match[1].trim());
}

function validatePersistedWorkspace(value: string): string {
  const workspace = value.trim();
  if (!workspace || wsFromBranch(workspace) !== workspace) {
    throw new Error(`invalid persisted workspace identity '${workspace}'`);
  }
  return workspace;
}

/** Read the stable workspace identity stored in this checkout's Git metadata. */
export function readPersistedWorkspace(repoPath: string): string | undefined {
  const gitDir = gitMetadataDir(repoPath);
  if (!gitDir) {
    return undefined;
  }

  const metadataPath = path.join(gitDir, WORKSPACE_METADATA_FILE);
  try {
    return validatePersistedWorkspace(fs.readFileSync(metadataPath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Persist a workspace identity once; later commands must reuse it. */
export function persistWorkspace(repoPath: string, value: string): string {
  const workspace = validatePersistedWorkspace(value);
  const existing = readPersistedWorkspace(repoPath);
  if (existing) {
    if (existing !== workspace) {
      throw new Error(
        `worktree already has persisted workspace identity '${existing}', refusing '${workspace}'`,
      );
    }
    return existing;
  }

  const gitDir = gitMetadataDir(repoPath);
  if (!gitDir) {
    throw new Error(`cannot persist workspace identity: '${repoPath}' is not a Git checkout`);
  }
  fs.writeFileSync(path.join(gitDir, WORKSPACE_METADATA_FILE), `${workspace}\n`, "utf-8");
  return workspace;
}

/** Serialize attach/start/verify/reconcile for one worktree. */
export async function withWorkspaceLifecycleLock<T>(
  repoPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const gitDir = gitMetadataDir(repoPath);
  if (!gitDir) {
    throw new Error(`cannot lock workspace lifecycle: '${repoPath}' is not a Git checkout`);
  }
  const lockPath = path.join(gitDir, WORKSPACE_LOCK_FILE);
  return withFileLock(
    lockPath,
    { activity: "workspace lifecycle", target: `'${repoPath}'` },
    operation,
  );
}

function currentBranch(repoPath: string): string | undefined {
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return undefined;
  }
  const branch = result.stdout.trim();
  if (!branch || branch === "HEAD") {
    return undefined; // detached HEAD
  }
  return branch;
}

function deriveLinkedWorktreeWorkspace(
  repoPath: string,
  linkedWorktreeBranch?: string,
): string | undefined {
  if (linkedWorktreeBranch !== undefined) {
    return wsFromBranch(linkedWorktreeBranch);
  }
  if (!isLinkedWorktree(repoPath)) {
    return undefined;
  }
  const branch = currentBranch(repoPath);
  return wsFromBranch(branch ?? path.basename(path.resolve(repoPath)));
}

/** Resolve a worktree's stable identity without consulting process overrides. */
export function resolveWorktreeWorkspace(
  repoPath: string,
  linkedWorktreeBranch?: string,
): string | undefined {
  return (
    readPersistedWorkspace(repoPath) ??
    deriveLinkedWorktreeWorkspace(repoPath, linkedWorktreeBranch)
  );
}

/**
 * Resolve the active workspace token for a repo path.
 *
 * A persisted identity is authoritative. Explicit or environment overrides may
 * repeat it, but cannot change it. Without persisted metadata, precedence is:
 * explicit `override` > `DEVROUTER_WORKSPACE` > linked-worktree auto detection.
 * The primary checkout resolves to `undefined` (no workspace) so existing
 * single-checkout behavior is unchanged. Without persisted metadata, an empty
 * override/env value forces "no workspace" (escape hatch).
 */
export function resolveWorkspace(repoPath: string, override?: string): string | undefined {
  const persisted = readPersistedWorkspace(repoPath);

  // Without persistence, an explicit empty string forces "no workspace".
  const explicit = override ?? process.env.DEVROUTER_WORKSPACE;
  if (explicit !== undefined) {
    const trimmed = explicit.trim();
    const requested = trimmed.length > 0 ? wsFromBranch(trimmed) : undefined;
    if (persisted && requested !== persisted) {
      throw new Error(
        `requested workspace identity '${requested ?? "(none)"}' does not match persisted workspace identity '${persisted}'`,
      );
    }
    return persisted ?? requested;
  }

  if (persisted) {
    return persisted;
  }
  return deriveLinkedWorktreeWorkspace(repoPath);
}
