import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// A workspace token identifies one isolated dev environment (a git worktree + its
// devcontainer/devpod). It namespaces the front host and the proxy upstream so N
// parallel worktrees of the same repo route without colliding. The same token is
// derived deterministically by `wsFromBranch` everywhere — devrouter's runtime
// config, the `--name` passed to devpod, and the `${WORKSPACE}` substitution — so
// the three layers agree by construction.

// Single label of a `*.localhost` host: lowercase alphanumeric with interior hyphens.
const MAX_WORKSPACE_LENGTH = 32;

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

function currentBranch(repoPath: string): string | undefined {
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf-8"
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

/**
 * Resolve the active workspace token for a repo path.
 *
 * Precedence: explicit `override` (the `--workspace` flag) > `DEVROUTER_WORKSPACE`
 * env > auto (linked worktree → branch, or worktree dir basename when detached).
 * The primary checkout resolves to `undefined` (no workspace) so existing
 * single-checkout behavior is unchanged. An empty override/env value forces "no
 * workspace" (escape hatch).
 */
export function resolveWorkspace(repoPath: string, override?: string): string | undefined {
  if (override !== undefined) {
    const trimmed = override.trim();
    return trimmed.length > 0 ? wsFromBranch(trimmed) : undefined;
  }

  const env = process.env.DEVROUTER_WORKSPACE;
  if (env !== undefined) {
    const trimmed = env.trim();
    return trimmed.length > 0 ? wsFromBranch(trimmed) : undefined;
  }

  if (isLinkedWorktree(repoPath)) {
    const branch = currentBranch(repoPath);
    return wsFromBranch(branch ?? path.basename(path.resolve(repoPath)));
  }

  return undefined;
}
